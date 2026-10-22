package runtime

// 2026-10-22 审计 A7 的判据：响应体/协议帧超限的错误必须同时写出**三层上限**
// （8 MiB 总输出闸门 / 1 MiB 单帧 / 168 KiB 保证可交付），并以 168 KiB 给动作。
// 旧文案只报前两档，作者按 8 MiB 设计却撞在 1 MiB/168 KiB 上。
//
// 变异方式：把 outputOverrunError 的 details 三键删掉一个 / 文案里去掉 168 KiB ⇒ 本条红。

import (
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/abi"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/apperr"
)

func TestOutputOverrunErrorCarriesThreeLimits(t *testing.T) {
	e := outputOverrunError("应用输出超过总上限 8 MiB（单帧上限 1 MiB，保证可交付 168 KiB）", "total")
	if e == nil {
		t.Fatal("outputOverrunError 返回 nil")
	}
	if e.Code != apperr.CodeRuntimeOutputOverrun {
		t.Fatalf("code = %s，want %s", e.Code, apperr.CodeRuntimeOutputOverrun)
	}
	cases := []struct {
		key  string
		want int
	}{
		{"total_output_limit_bytes", limits.AppResponseBodyMaxBytes},
		{"frame_limit_bytes", abi.MaxFrameBytes},
		{"deliverable_payload_bytes", abi.MaxResponseBodyBytes},
	}
	for _, c := range cases {
		got, ok := e.Details[c.key]
		if !ok {
			t.Fatalf("details 缺 %s（作者拿不到可操作的数字）：%+v", c.key, e.Details)
		}
		if n, _ := got.(int); n != c.want {
			t.Fatalf("details[%s] = %v，want %d", c.key, got, c.want)
		}
	}
	if got, _ := e.Details["layer"].(string); got != "total" {
		t.Fatalf("layer = %q，want total", got)
	}
	if len(e.Hints) < 2 {
		t.Fatalf("hints 至少两条（168 KiB 动作 + 三层口径说明），实际 %d", len(e.Hints))
	}
	joined := strings.Join(e.Hints, "\n")
	if !strings.Contains(joined, "168 KiB") {
		t.Fatalf("hints 必须以**保证可交付** 168 KiB 为动作口径：%s", joined)
	}
}
