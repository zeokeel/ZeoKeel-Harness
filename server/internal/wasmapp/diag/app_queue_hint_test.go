package diag

// 生产化评审（2026-10-22，三视角）：429 的提示必须说**这个应用**的生效上限，
// 而不是全局默认值。[应用开发者] 被单独降额（app_running=1）时，若提示仍写默认 2 路，
// 作者会按错误并发模型调优；[管理员] 也无法解释"为什么这个应用总在排队"。

import (
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/applimits"
)

// TestHintsForAppUsesEffectiveQueueAxes：传了应用生效四轴 ⇒ 首条 429 提示必须用它。
func TestHintsForAppUsesEffectiveQueueAxes(t *testing.T) {
	global := applimits.Defaults() // 默认 4/32/2/4
	axes := limits.Axes{AppRunning: 1, AppQueue: 2, UserPerAppRunning: 1, UserPerAppQueued: 2}
	hints := HintsForApp(string(apperr.CodeAppQueueFull), 0, global, axes)
	if len(hints) == 0 {
		t.Fatal("429 必须有提示")
	}
	got := hints[0]
	for _, want := range []string{"本应用生效上限", "每应用队列 2", "在跑 1 个"} {
		if !strings.Contains(got, want) {
			t.Fatalf("首条提示必须含 %q（应用生效值），实际：%s", want, got)
		}
	}
	// 反面对照：默认值文案（"每应用队列 32"）不能出现在首条里 —— 否则说明还是全局默认。
	if strings.Contains(got, "每应用队列 32") {
		t.Fatalf("首条提示仍回显全局默认队列 32：%s", got)
	}
}

// TestHintsForLimitsStaysGlobalWithoutAxes：没有应用生效值时保持全局默认文案（兼容路径）。
func TestHintsForLimitsStaysGlobalWithoutAxes(t *testing.T) {
	global := applimits.Defaults()
	hints := HintsForLimits(string(apperr.CodeAppQueueFull), 0, global)
	if len(hints) == 0 {
		t.Fatal("429 必须有提示")
	}
	if strings.Contains(hints[0], "本应用生效上限") {
		t.Fatalf("没有应用生效值时不应用应用级文案：%s", hints[0])
	}
}
