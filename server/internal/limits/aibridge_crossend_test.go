package limits_test

// A2（审计 2026-10-22 功能合理性审计，P2）：**跨端 AI 桥上限**的两份 TS 真值必须与
// Go 侧的 `AIBridgeMaxMessages` / `AIBridgeMessageMaxBytes` 逐值相等。
//
// 现场：这两个上限在 Go 侧只进 limits 表（**零 Go 消费者**），真正的执行值在客户端的
// 两份 TS 里：
//   - 宿主协议 handler：`packages/host/wasm-apps-host/src/ai-chat.ts`
//     （`AI_CHAT_MAX_MESSAGES` / `AI_CHAT_MAX_CONTENT_BYTES`）；
//   - 客户端详情页面板：`packages/client/wasm-apps/src/client/app-ai.ts`
//     （`APP_AI_MESSAGES_MAX` / `APP_AI_MESSAGE_MAX_BYTES`）。
//
// 而既有的跨端判据只对拍 **TS ↔ TS**（`ai-chat-parity.spec.ts`）⇒ 改 Go 常量时文档会变、
// TS 判据全绿、运行时行为不变：文档与行为**静默分叉**（A2 原话）。
//
// 本用例把 Go 侧拉进同一张对拍网：读两个 TS 文件、解析常量字面量、与 limits 常量逐值比。
// **文件不可读/常量缺失一律 fail（不 Skip）**：跳过会让"文件被改名/常量被删"退化成静默通过。
//
// 变异验证：
//   - 把 limits.AIBridgeMaxMessages 改成 32 ⇒ 消息条数两条断言红；
//   - 把 ai-chat.ts 的 AI_CHAT_MAX_MESSAGES 改成 32 ⇒ 对拍红；
//   - 删掉 ai-chat.ts 的常量 ⇒ 解析失败红（不 Skip）；
//   - 把 app-ai.ts 的 APP_AI_MESSAGE_MAX_BYTES 改成 32*1024 ⇒ 对拍红。

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
)

// crossEndConstant 是 TS 侧一个上限常量的声明位置。
type crossEndConstant struct {
	file string
	name string
	// want 是期望值（来自 limits 的 Go 常量）。
	want int64
}

// TestAIBridgeLimitsMatchClientAndHostConstants 对拍 Go 真源与两份 TS 执行值。
func TestAIBridgeLimitsMatchClientAndHostConstants(t *testing.T) {
	repoRoot := filepath.Dir(moduleRootOf(t))
	cases := []crossEndConstant{
		// 宿主协议 handler（应用窗口内 `fetch('/__zeokeel/ai/chat')` 的校验点）。
		{file: "packages/host/wasm-apps-host/src/ai-chat.ts", name: "AI_CHAT_MAX_MESSAGES", want: limits.AIBridgeMaxMessages},
		{file: "packages/host/wasm-apps-host/src/ai-chat.ts", name: "AI_CHAT_MAX_CONTENT_BYTES", want: limits.AIBridgeMessageMaxBytes},
		// 客户端详情页面板（"应用 AI" 的本地前置校验）。
		{file: "packages/client/wasm-apps/src/client/app-ai.ts", name: "APP_AI_MESSAGES_MAX", want: limits.AIBridgeMaxMessages},
		{file: "packages/client/wasm-apps/src/client/app-ai.ts", name: "APP_AI_MESSAGE_MAX_BYTES", want: limits.AIBridgeMessageMaxBytes},
	}
	for _, tc := range cases {
		path := filepath.Join(repoRoot, filepath.FromSlash(tc.file))
		src, err := os.ReadFile(path)
		if err != nil {
			// 不 Skip：这条判据的意义就是"跨端两份值对得上"，读不到就等于对拍网有个洞。
			t.Fatalf("读跨端真值文件失败（判据不能跳过）: %s: %v", tc.file, err)
		}
		got, err := tsConstValue(string(src), tc.name)
		if err != nil {
			t.Fatalf("%s 里解析 %s 失败（常量改名/删除都会让对拍失去对象）: %v", tc.file, tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("跨端上限分叉：%s 的 %s = %d，而 limits 的真源是 %d —— "+
				"改 Go 常量必须同步改 TS（或反过来），否则文档与运行期行为静默分叉（A2）",
				tc.file, tc.name, got, tc.want)
		}
	}
}

// tsConstValue 解析 `export const NAME = <整数字面量>[ * <整数字面量>]` 的数值。
//
// 只支持 TS 里这两份常量实际用的形态（纯整数、或 `16 * 1024` 这种换算），
// 不做通用表达式求值：解析面越窄，"对拍"越不容易变成"猜"。
func tsConstValue(src, name string) (int64, error) {
	// 形如：export const AI_CHAT_MAX_MESSAGES = 64
	// 形如：export const AI_CHAT_MAX_CONTENT_BYTES = 16 * 1024
	re := regexp.MustCompile(`(?m)^\s*(?:export\s+)?const\s+` + regexp.QuoteMeta(name) +
		`\s*=\s*([0-9][0-9_]*)\s*(?:\*\s*([0-9][0-9_]*))?\s*(?:;|//.*)?$`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		return 0, &tsParseError{name: name}
	}
	left, err := strconv.ParseInt(strings.ReplaceAll(m[1], "_", ""), 10, 64)
	if err != nil {
		return 0, err
	}
	if m[2] == "" {
		return left, nil
	}
	right, err := strconv.ParseInt(strings.ReplaceAll(m[2], "_", ""), 10, 64)
	if err != nil {
		return 0, err
	}
	return left * right, nil
}

// tsParseError 是"常量没找到"的可读错误（不要和 IO 错误混在一起）。
type tsParseError struct{ name string }

func (e *tsParseError) Error() string {
	return "找不到形如 `export const " + e.name + " = <整数>[ * <整数>]` 的声明"
}
