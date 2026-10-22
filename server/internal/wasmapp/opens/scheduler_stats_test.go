package opens

// C-14（审计 2026-10-22，P3）：打开计数作业的**自记账**判据。
//
// 现场：这条作业此前是裸启动 —— 既不在 `cmd/server/scheduler_status.go` 的登记表里，
// 也没有 Runs/Errors。作业停摆时看板只是"数字不涨"，与"真的没人用"在运维面上同形。
// 本文件钉住 observableScheduler 面（Start/Started/StartedAt/Runs/Errors/LastRunAt/
// LastError/Tick）在本调度器上的行为：
//
//  1. 未启动：Started=false、StartedAt/LastRunAt 为零值、Runs/Errors=0、Tick=注入值；
//  2. Start 之后：**启动先跑一轮**（Runs>=1）、StartedAt/LastRunAt 非零、成功轮不记错误；
//  3. 失败轮：Errors+1 且 LastError 非空（LastError 是"最近一轮"的快照语义）；
//  4. 重复 Start 不产生第二条后台循环（StartedAt 不被覆盖）。
//
// 变异验证：
//   - 删掉 TryRun 里的 recordRun 调用 ⇒ 第 2/3 条红；
//   - 把 recordRun 记在 run() 之前（先记账再执行）⇒ 第 3 条的 LastError 断言可能绿，
//     但"失败轮 Errors+1"会变成"每次调用都 +1" ⇒ 第 2 条（成功轮 Errors=0）红；
//   - 把 Start 的 `if s.started` 去掉 ⇒ 第 4 条红（StartedAt 被第二次 Start 覆盖）。

import (
	"context"
	"testing"
	"time"
)

func TestSchedulerSelfAccountsRunsAndErrors(t *testing.T) {
	db := testDB(t)
	fixed := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	s := NewScheduler(db, time.Minute, func() time.Time { return fixed })

	// ① 未启动的读数（页面/日志据此区分"还没起来"与"跑过 0 轮"）。
	if s.Started() || !s.StartedAt().IsZero() {
		t.Fatalf("未启动时 Started/StartedAt 不对: started=%v at=%v", s.Started(), s.StartedAt())
	}
	if s.Runs() != 0 || s.Errors() != 0 || !s.LastRunAt().IsZero() || s.LastError() != "" {
		t.Fatalf("未启动时读数应全零: runs=%d errors=%d lastRun=%v lastErr=%q",
			s.Runs(), s.Errors(), s.LastRunAt(), s.LastError())
	}
	if s.Tick() != time.Minute {
		t.Fatalf("Tick() = %v, want 1m（装配登记按它核对）", s.Tick())
	}

	// ② Start 后启动先跑一轮（覆盖停机期间积压的明细）。
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)
	deadline := time.Now().Add(10 * time.Second)
	for s.Runs() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if s.Runs() < 1 {
		t.Fatalf("Start 应先跑一轮: runs=%d", s.Runs())
	}
	if !s.Started() || s.StartedAt().IsZero() {
		t.Fatalf("Start 之后必须如实报已启动: started=%v at=%v", s.Started(), s.StartedAt())
	}
	if s.LastRunAt().IsZero() {
		t.Fatal("每轮结束必须记 LastRunAt（看板按它判陈旧）")
	}
	if s.Errors() != 0 || s.LastError() != "" {
		t.Fatalf("成功的轮次不应计错误: errors=%d lastErr=%q", s.Errors(), s.LastError())
	}

	// ④ 重复 Start：不覆盖 StartedAt、不叠加循环（同款调度器都是"只有第一次生效"）。
	startedAt := s.StartedAt()
	s.Start(ctx)
	if !s.StartedAt().Equal(startedAt) {
		t.Fatalf("重复 Start 不应改写 StartedAt: %v -> %v", startedAt, s.StartedAt())
	}

	// ③ 失败轮：把库关掉，下一轮必然在"查最早明细"处失败 ⇒ Errors+1、LastError 非空。
	// 先记下成功轮的错误数（0），断言增量而不是绝对值。
	db.Close()
	s.TryRun(context.Background())
	if s.Errors() < 1 {
		t.Fatalf("失败的轮次必须计入 Errors: runs=%d errors=%d", s.Runs(), s.Errors())
	}
	if s.LastError() == "" {
		t.Fatal("失败的轮次必须把错误文案落到 LastError（运维唯一可见的错误出口）")
	}
	if s.Runs() < 2 {
		t.Fatalf("失败的轮次同样计入 Runs（它是「跑过」的过程事实）: runs=%d", s.Runs())
	}
}
