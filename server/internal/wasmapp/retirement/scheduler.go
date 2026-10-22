// Package retirement 是 WASM 应用**退役真删**的后台作业（设计契约
// docs/planning/2026-10-22-wasm-lifecycle-redesign.md §5.5；审计 2026-10-22 C-01）。
//
// 为什么必须有它（审计 C-01 的原缺陷）：冻结/删除的承诺是「只读快照 + 保留期 + 到期
// 真删」，而 UI、测试、审计链、作者可读的 limits 表四处都在承诺这件事，代码里却
// 自己写着"当前未实现" —— 冻结于是等于**永久封存**。合规场景（员工数据删除义务）
// 以为已履约、实际未履约，反向也危险（"反正到期会删"→ 不另做备份）。
//
// 本作业是那条承诺的**唯一执行者**，判据全部 fail-closed：
//
//	kind='wasm_app' AND deleted_at IS NOT NULL AND purged_at IS NULL
//	        AND purge_after <= now AND **snapshot_at IS NOT NULL**
//
// 最后一条是硬条件：没有成功快照的应用**永远不删**（本轮跳过并计入错误，运维面可见）。
// 删除动作本身 = `os.RemoveAll(<data_root>/apps/<app_id>)`（db/assets/snapshots 一并删）
// → 置 `purged_at` + 清当前指针 → 写审计 `wasm_app_purge`（actor=system）。
// 元数据（apps/releases/deployments）**一字不删**：它们是真删之后唯一还能回答
// "这个应用曾经存在过吗、谁在什么时候部署过什么"的东西。
//
// 自记账（Runs/Errors/LastRunAt/LastError）与登记（cmd/server/scheduler_status.go 的
// 名字 `wasm_retirement`）不是可选项：没有读数的后台作业停摆时与"本来就没活干"
// 在运维面上同形（审计 C-14 就是同一个病）。
package retirement

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/zeokeel/zeokeel-harness/server/internal/serverstore"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/lifecycle"
)

// DefaultTick 是调度间隔：**每日一轮**（保留期以天为单位，更密的轮次没有意义，
// 只会把"同一批未到期候选"反复查一遍）。
const DefaultTick = 24 * time.Hour

// DefaultBatchLimit 是一轮最多处理多少个应用（防一轮把磁盘 IO 打满；
// 未处理完的候选下一轮继续，判据不变）。
const DefaultBatchLimit = 100

// auditAction 是真删的审计动作名（与既有 wasm_app_* 命名一致）。
const auditAction = "wasm_app_purge"

// auditActor 是调度器写审计的**执行者**（系统动作：没有人按下这个按钮）。
const auditActor = "system"

// Options 是调度器的依赖。全部由装配层注入（本包不读环境变量、不建连接）。
type Options struct {
	DB       *sql.DB
	DataRoot string
	Tick     time.Duration
	// Now 缺省 time.Now（用例注入固定时钟，断言"未到期不删"）。
	Now func() time.Time
	// Logger 缺省 log.Printf；README: 每条真删都要有一行可 grep 的日志。
	Logger func(format string, args ...any)
	// BatchLimit 缺省 DefaultBatchLimit。
	BatchLimit int
	// Audit 缺省 serverstore.AuditLogApp（可注入以断言 actor/action/detail）。
	Audit func(appID, username, action, detail string) error
}

// Scheduler 是退役真删作业（实现 cmd/server 的 observableScheduler 面：
// Start/Started/StartedAt/Runs/Errors/LastRunAt/LastError/Tick）。
//
// 读数口径（有意与其它调度器区分，且在方法注释里写明 —— 运维读到的数字必须能对得上）：
//   - Runs = 已执行的**轮**数；
//   - Errors = 处置**失败/被跳过的应用**数（不是轮数）：一个应用一次真删是一个独立的
//     不可逆动作，"这一轮里有 3 个应用没删掉"比"有 1 轮不干净"更能定位问题。
type Scheduler struct {
	opt Options

	mu        sync.Mutex
	started   bool
	startedAt time.Time
	runs      int64
	errors    int64
	lastRunAt time.Time
	lastError string
	// 最近一轮的积压快照（/admin/runtime 的 purge 段；PurgeBacklog 只读副本）。
	lastBlocked        []string
	lastCleanupPending int

	stop chan struct{}
}

// NewScheduler 构造调度器（不启动；Start 才起后台循环）。
func NewScheduler(opt Options) *Scheduler {
	if opt.Tick <= 0 {
		opt.Tick = DefaultTick
	}
	if opt.Now == nil {
		opt.Now = func() time.Time { return time.Now().UTC() }
	}
	if opt.Logger == nil {
		opt.Logger = log.Printf
	}
	if opt.BatchLimit <= 0 {
		opt.BatchLimit = DefaultBatchLimit
	}
	if opt.Audit == nil {
		opt.Audit = func(appID, username, action, detail string) error {
			return serverstore.AuditLogApp(opt.DB, appID, username, action, detail)
		}
	}
	return &Scheduler{opt: opt, stop: make(chan struct{})}
}

// RunResult 是一轮的处置结果（用例与日志共用）。
type RunResult struct {
	// Purged 是**本轮**成功完成两阶段真删的应用（顺序与候选顺序一致）。
	Purged []string
	// Cleaned 是"上一轮已置 purged_at、本轮补删数据目录"的应用（清理重试成功）。
	Cleaned []string
	// Failed 是处置失败的应用 → 原因。
	Failed map[string]string
	// Blocked 是"到期但没有成功快照"因此被跳过的应用（fail-closed：不删数据）。
	Blocked []string
	// CleanupPending 是"已 purged、但数据目录还没清干净"的应用数（本轮清理候选数）。
	// 与 Cleaned 区分：Cleaned 是本轮成功清掉的，CleanupPending 反映还有多少在等重试。
	CleanupPending int
}

// Start 启动后台循环：**先跑一轮**（覆盖停机期间到期的应用，与其他调度器同范式），
// 之后每 Tick 一次；ctx 取消即退出。
func (s *Scheduler) Start(ctx context.Context) {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.startedAt = s.opt.Now()
	s.mu.Unlock()

	go s.loop(ctx)
}

// loop 是后台循环（Start 之后只在测试里通过 TryRun 直接驱动）。
func (s *Scheduler) loop(ctx context.Context) {
	s.TryRun(ctx)
	ticker := time.NewTicker(s.opt.Tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-ticker.C:
			s.TryRun(ctx)
		}
	}
}

// Stop 停止后台循环（幂等；测试与平台 Close 用）。
func (s *Scheduler) Stop() {
	select {
	case <-s.stop:
	default:
		close(s.stop)
	}
}

// finishPurgeCleanup 执行真删的第二阶段：删数据目录 → 记 data_cleaned_at → 写审计。
//
// firstPhase=true 表示 purged_at 是**本轮刚提交**的（日志/审计文案用"真删完成"）；
// false 表示补清理（上一轮已置 purged_at，本轮只补删盘与记账）。
// 返回被删除的目录（审计要写"删了什么"）。
func (s *Scheduler) finishPurgeCleanup(ctx context.Context, appID string, now time.Time, firstPhase bool) (string, error) {
	dir, err := lifecycle.RemoveAppData(s.opt.DataRoot, appID)
	if err != nil {
		return "", err
	}
	if err := serverstore.MarkWasmAppDataCleaned(ctx, s.opt.DB, appID, now); err != nil {
		return "", fmt.Errorf("记录数据目录已清理失败: %w", err)
	}
	detail := "真删完成：数据目录已删除（" + dir + "），元数据与部署历史保留作审计 tombstone"
	if !firstPhase {
		detail = "真删补清理完成：上一轮已置 purged_at，本轮删除残留数据目录（" + dir + "）"
	}
	if aerr := s.opt.Audit(appID, auditActor, auditAction, detail); aerr != nil {
		// 数据已经没了，回滚不可能；但必须让运维看见"这次真删没有审计行"。
		return "", fmt.Errorf("真删成功但审计写入失败: %w", aerr)
	}
	return dir, nil
}

// TryRun 执行一轮真删处置，返回本轮结果（导出给用例与手工运维调用）。
//
// 顺序（不可交换）：查候选 → 逐个"事务内锁行重校验并先置 purged_at（终态）→ 再删数据目录目录 → 记 data_cleaned_at → 审计"，
// 最后补清理上一轮未清干净的应用。
// 磁盘删除失败 ⇒ **不置 purged_at**（否则元数据会说"数据已清除"而数据还在，这是
// 本设计最不能出现的不一致：purged 之后 restore/export 一律 410）。
func (s *Scheduler) TryRun(ctx context.Context) RunResult {
	now := s.opt.Now()
	res := RunResult{Failed: map[string]string{}}

	// ① 先补快照（设计 §5.4「快照失败 → snapshot_error 落库、调度器重试」）。
	//
	// 顺序有意放在真删之前：删除的硬前置条件就是 snapshot_at 非空。快照失败的应用
	// 在冻结那一刻被"放行"（不阻断冻结），如果没有人重试，它会永久卡在"到期但删不掉"
	// —— 那正是 C-01 假承诺的另一种形态。重试成功后同一次运行就可能满足真删条件
	// （下面的候选查询会看到它）。
	s.retrySnapshots(ctx, now, &res)

	cands, err := serverstore.PurgeCandidates(ctx, s.opt.DB, now, s.opt.BatchLimit)
	if err != nil {
		s.recordRun(failedCount(res), "查询真删候选失败: "+err.Error())
		return res
	}
	for _, cand := range cands {
		// 第一阶段：事务内锁行 + 重校验资格 + 置 purged_at（终态）。
		// 与 restore 的互斥由行锁保证：恢复先提交 ⇒ 这里 false（不删盘）；
		// 这里先提交 ⇒ 恢复看到 purged_at ⇒ 410。旧实现先删盘后置位且不校验
		// deleted_at，二者并发会删掉刚恢复的数据（2026-10-22 生产评审 P0）。
		ok, berr := serverstore.BeginWasmAppPurge(ctx, s.opt.DB, cand.AppID, now)
		if berr != nil {
			res.Failed[cand.AppID] = "标记 purged 失败（未删任何数据，下轮重试）: " + berr.Error()
			continue
		}
		if !ok {
			// 已被恢复/已清除/不再满足条件：本轮跳过，不做任何磁盘操作。
			continue
		}
		dir, ferr := s.finishPurgeCleanup(ctx, cand.AppID, now, true)
		if ferr != nil {
			// purged_at 已提交（不可恢复），但数据目录可能还在 ⇒ 下一轮由
			// PurgeCleanupCandidates 重试；如实记错误，不谎报"已清除"。
			res.Failed[cand.AppID] = "purged 后清理数据目录失败（下轮重试）: " + ferr.Error()
			continue
		}
		s.opt.Logger("wasm_retirement: purged app=%s dir=%s snapshot=%s purge_after=%s",
			cand.AppID, dir, cand.SnapshotPath, cand.PurgeAfter.Format(time.RFC3339))
		res.Purged = append(res.Purged, cand.AppID)
	}

	// 第二阶段重试：上一轮已提交 purged_at、但进程崩溃/磁盘失败导致目录还在的应用。
	// 两阶段的目的就是让"元数据说清了"与"盘上真的清了"可分别收敛（data_cleaned_at）。
	cleanupIDs, cerr := serverstore.PurgeCleanupCandidates(ctx, s.opt.DB, s.opt.BatchLimit)
	if cerr != nil {
		res.Failed[""] = "查询待清理 purged 应用失败: " + cerr.Error()
	}
	res.CleanupPending = len(cleanupIDs)
	for _, appID := range cleanupIDs {
		if _, ferr := s.finishPurgeCleanup(ctx, appID, now, false); ferr != nil {
			res.Failed[appID] = "补清理已 purged 应用的数据目录失败（下轮重试）: " + ferr.Error()
			continue
		}
		res.Cleaned = append(res.Cleaned, appID)
	}

	// 到期但**没有成功快照**的应用：本轮跳过并计错误（设计 §5.5 原话）。
	// 它们不进 Purged，也不删任何数据 —— 运维必须先修好快照（冻结重试或手工补）。
	blocked, berr := serverstore.PurgeBlockedWasmApps(ctx, s.opt.DB, now)
	if berr != nil {
		res.Failed[""] = "查询快照缺失候选失败: " + berr.Error()
	} else if len(blocked) > 0 {
		res.Blocked = blocked
		for _, appID := range blocked {
			res.Failed[appID] = "到期但没有成功快照（fail-closed：本轮不删数据）"
		}
		s.opt.Logger("wasm_retirement: %d 个应用到期但没有成功快照，已跳过（不删数据）: %v",
			len(blocked), blocked)
	}

	s.mu.Lock()
	s.lastBlocked = append([]string(nil), res.Blocked...)
	s.lastCleanupPending = res.CleanupPending
	s.mu.Unlock()
	s.recordRun(failedCount(res), lastFailure(res))
	return res
}

// PurgeBacklog 返回最近一轮的"到期但删不掉"与"等清理"应用（运维面只读，供
// /admin/runtime 的 purge 段使用；2026-10-22 反证 R2-P2-2：仅 Runs/Errors 只能回答
// "作业跑没跑"，不能回答"哪些应用卡住/待清理"）。
//
// 返回副本，调用方不可修改内部状态；从未跑过 ⇒ 空列表与 0（不是"没有积压"的断言，
// 而是"还没有观测"—— 页面需结合 schedulers 段的 runs 一并读）。
func (s *Scheduler) PurgeBacklog() (blocked []string, cleanupPending int) {
	if s == nil {
		return nil, 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.lastBlocked...), s.lastCleanupPending
}

// retrySnapshots 给"已冻结/已删除但没有成功快照"的应用补一次快照（设计 §5.4 的重试语义）。
//
// 失败只记错误、不阻断本轮其它工作：一个应用的磁盘故障不该让其他到期应用也删不掉。
// 快照失败原因照常写 snapshot_error（运维面唯一可见的错误出口）。
func (s *Scheduler) retrySnapshots(ctx context.Context, now time.Time, res *RunResult) {
	candidates, err := serverstore.SnapshotRetryCandidates(ctx, s.opt.DB, s.opt.BatchLimit)
	if err != nil {
		res.Failed[""] = "查询待补快照候选失败: " + err.Error()
		return
	}
	for _, appID := range candidates {
		snap, serr := lifecycle.Snapshot(ctx, s.opt.DB, s.opt.DataRoot, appID, now)
		if serr != nil {
			// 记录失败原因（下一次重试仍会尝试；真删继续被阻断 —— fail-closed）。
			_ = serverstore.SetWasmAppSnapshot(ctx, s.opt.DB, appID,
				serverstore.WasmSnapshotRecord{Error: serr.Error()})
			res.Failed[appID] = "快照重试失败: " + serr.Error()
			continue
		}
		at := now.UTC()
		if err := serverstore.SetWasmAppSnapshot(ctx, s.opt.DB, appID,
			serverstore.WasmSnapshotRecord{At: &at, Path: snap.Dir}); err != nil {
			res.Failed[appID] = "快照重试成功但记录失败: " + err.Error()
			continue
		}
		s.opt.Logger("wasm_retirement: snapshot retried app=%s dir=%s", appID, snap.Dir)
	}
}

// recordRun 记账一轮（Runs 恒 +1；Errors 只统计失败项数，与 Runs 不同口径，见类型注释）。
func (s *Scheduler) recordRun(failures int64, lastError string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runs++
	s.errors += failures
	s.lastRunAt = s.opt.Now()
	if lastError != "" {
		s.lastError = lastError
	}
}

// failedCount 统计真正失败的应用数（`""` 是"整轮查询失败"的伪键，不计入应用数）。
func failedCount(res RunResult) int64 {
	var n int64
	for appID := range res.Failed {
		if appID != "" {
			n++
		}
	}
	return n
}

// lastFailure 把本轮的第一条失败整理成一行可读文案（LastError 是"最近一轮"的快照）。
func lastFailure(res RunResult) string {
	if len(res.Failed) == 0 {
		return ""
	}
	// 稳定选一条：优先非空 app_id（整轮失败优先报整轮的）。
	if msg, ok := res.Failed[""]; ok {
		return msg
	}
	for _, appID := range append(append([]string{}, res.Purged...), res.Blocked...) {
		if msg, ok := res.Failed[appID]; ok {
			return appID + ": " + msg
		}
	}
	for appID, msg := range res.Failed {
		return appID + ": " + msg
	}
	return ""
}

// ---- observableScheduler 面（cmd/server/scheduler_status.go 只读这几项）----

// Started 报告后台循环是否已启动。
func (s *Scheduler) Started() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// StartedAt 返回启动时刻（零值 = 未启动）。
func (s *Scheduler) StartedAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startedAt
}

// Runs 返回已执行的轮数。
func (s *Scheduler) Runs() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

// Errors 返回处置失败/被跳过（无快照）的**应用**数（不是轮数，见类型注释）。
func (s *Scheduler) Errors() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.errors
}

// LastRunAt 返回最近一轮的结束时刻（零值 = 未跑过）。
func (s *Scheduler) LastRunAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastRunAt
}

// LastError 返回最近一轮的错误文案（空串 = 最近一轮无错）。
func (s *Scheduler) LastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastError
}

// Tick 返回调度间隔。
func (s *Scheduler) Tick() time.Duration { return s.opt.Tick }
