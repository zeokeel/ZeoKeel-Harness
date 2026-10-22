package appserver

// 2026-10-22 审计 A4 的判据：等待冷编译/冷加载槽位失败时，错误必须**区分"平台排队"与
// "调用方取消"**，并带出排队深度。旧实现复用 MODULE_KILLED +「请求已取消」，作者会去
// 改自己的代码；变异方式：把 acquireCompileSlot 的错误码改回 MODULE_KILLED ⇒ 本条红。

import (
	"context"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/assets"
)

func TestModuleCache_QueueWaitIsPlatformQueueNotCancellation(t *testing.T) {
	c := newModuleCache()
	if cap(c.compileSem) == 0 {
		t.Fatal("compileSem 容量为 0（构造失败）")
	}
	// 占满唯一槽位，模拟"平台正在给别的应用冷编译"。
	c.compileSem <- struct{}{}
	defer func() { <-c.compileSem }()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 等待方一定会走到 ctx.Done()

	// ① 冷加载路径
	_, release, aerr := c.acquireSet(ctx, moduleKey{AppID: "demo", Version: "1.0.0", ReleaseID: 1},
		func(context.Context) (*assets.Set, *apperr.Error) {
			t.Fatal("槽位未取到就不应调用 loader")
			return nil, nil
		})
	if release != nil {
		release()
	}
	requireQueued(t, aerr, "加载")

	// ② 冷编译路径
	_, release2, aerr2 := c.acquire(ctx, moduleKey{AppID: "demo2", Version: "1.0.0", ReleaseID: 2},
		func(context.Context) (compiledResult, *apperr.Error) {
			t.Fatal("槽位未取到就不应调用 loader")
			return compiledResult{}, nil
		})
	if release2 != nil {
		release2()
	}
	requireQueued(t, aerr2, "编译")
}

func requireQueued(t *testing.T, e *apperr.Error, phase string) {
	t.Helper()
	if e == nil {
		t.Fatal("等待槽位失败时必须返回错误（不能假装成功）")
	}
	if e.Code != apperr.CodeModuleLoadQueued {
		t.Fatalf("等待槽位失败的错误码 = %s，want %s（平台排队不能报成调用方取消）", e.Code, apperr.CodeModuleLoadQueued)
	}
	if got := e.Status(); got != 503 {
		t.Fatalf("HTTP 状态 = %d，want 503（稍后重试可恢复）", got)
	}
	if depth, ok := e.Details["queue_depth"]; !ok {
		t.Fatalf("details 缺 queue_depth（作者无法判断是平台排队还是自己的问题）：%+v", e.Details)
	} else if n, _ := depth.(int64); n < 1 {
		t.Fatalf("queue_depth = %v，至少包含当前这一个等待者", depth)
	}
	if got, _ := e.Details["phase"].(string); got != phase {
		t.Fatalf("phase = %q，want %q", got, phase)
	}
	if len(e.Hints) == 0 {
		t.Fatal("平台排队错误必须带可操作 hint（第一消费者是 AI/作者）")
	}
}
