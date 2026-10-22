//go:build apps

package main

// 管理面运行读数的**生产接线**判据（反证 R2-P2-1）：
// /admin/runtime 的 queue/schedulers/app_limits/purge 段在 handler 侧有桩测试，
// 但装配侧零引用 ⇒ 删掉 cmd/server 里那几行注入，整段管理面消失而单测全绿。
// 本用例读**生产装配源码**并要求每个钩子都在（源码级判据与既有 routes_source_test 同纪律）。

import (
	"os"
	"strings"
	"testing"
)

func TestWasmRuntimeObservabilityHooksAreWired(t *testing.T) {
	b, err := os.ReadFile("wasmapp.go")
	if err != nil {
		t.Fatalf("读 wasmapp.go: %v", err)
	}
	src := string(b)
	wants := []string{
		"QueueStats:   scheduler.Stats",
		"QueueApps:    scheduler.AppWatermarks",
		"AppLimitsCount: scheduler.AppLimitOverrideCount",
		"AppLimitsEffective: func(appID string) (limits.Axes, bool) {",
		"PurgeBacklog: retirementSched.PurgeBacklog",
		"SchedulerStatus: func() []wasmapi.SchedulerStatusView {",
		"retirementSched.Start(ctx)",
	}
	for _, want := range wants {
		if !strings.Contains(src, want) {
			t.Errorf("管理面运行读数接线缺失：%q（删除/改名会让 /admin/runtime 整段消失而其它用例全绿）", want)
		}
	}
}
