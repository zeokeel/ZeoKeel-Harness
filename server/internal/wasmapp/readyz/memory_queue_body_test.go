package readyz_test

// 生产级评审（2026-10-22 管理员视角 P1-3）：**"排队请求体"必须进内存账**。
//
// 缺陷形态（评审证据 readyz.go:1107-1158 / serve.go:352-368 / applimits.go:403）：
// 服务端在准入之前就把请求体读进内存（1 MiB/请求），而 `app_queue` 的合法上界是 4096
// ⇒ 4096 × 1 MiB ≈ 4 GiB 已读字节可以合法地挂在队列里；而这里的内存账只有
// 实例池 + 编译峰值 + 上传峰值 + 缓存驻留 + 应用库页缓存这五笔 ⇒ `/readyz` 的
// `mem_budget_ok` 仍然给绿，OOM 前没有任何水位预警。
//
// 判据（每条都实跑过变异）：
//   - 账上这一笔 == 运行期判据那个常量（limits.WasmQueueBodyBytesMax），不是按应用
//     队列长度乘出来的理论值；
//   - 总账**包含**它（删掉 ⇒ 本用例红）；
//   - 它能把"五笔账放行、加上它才被拒"的那台机器判红（说明它真的进了判定，
//     而不是挂在结构体上只做展示）。

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/readyz"
)

// TestMemoryBudgetCarriesQueueBodyFromTheSameSource：账上的排队体 == 运行期硬上界常量。
//
// 变异：把 DefaultMemoryPlan 的 QueueBodyBytes 改成别的数（或改成 4096 × 1 MiB 的理论
// 乘积）⇒ 本用例红 —— 账与判据必须同源同值，否则"账上放得下"与"实际放得下"会分叉。
func TestMemoryBudgetCarriesQueueBodyFromTheSameSource(t *testing.T) {
	if got := readyz.DefaultMemoryPlan().QueueBodyBytes; got != limits.WasmQueueBodyBytesMax {
		t.Fatalf("默认档的排队体预算 = %d，want limits.WasmQueueBodyBytesMax = %d",
			got, limits.WasmQueueBodyBytesMax)
	}
	b := readyz.ComputeMemoryBudget(8 << 30)
	if b.QueueBody != limits.WasmQueueBodyBytesMax {
		t.Fatalf("账面排队体 = %d，want %d", b.QueueBody, limits.WasmQueueBodyBytesMax)
	}
	if b.QueueBody == 0 {
		t.Fatal("这一笔不得为 0（0 等于没算）")
	}
	// 总账必须包含它（漏掉一段和等于没算，是同一个缺陷的两种写法）。
	if want := b.Instances + b.CompilePeak + b.UploadPeak + b.CacheResident + b.AppDBCache + b.QueueBody; b.Total != want {
		t.Fatalf("总账 = %d，want %d（六笔之和，含排队体 %d）", b.Total, want, b.QueueBody)
	}
	// JSON 契约：管理端预览/探针读的是字段名，改名等于让前端静默少一笔。
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatalf("序列化: %v", err)
	}
	if !strings.Contains(string(raw), `"queue_body_bytes"`) {
		t.Fatalf("JSON 里必须有 queue_body_bytes 字段：%s", raw)
	}
}

// TestZeroPlanQueueBodyFallsBackToDefault：只填部分字段时这一笔也必须算出来
// （与其余五笔同一条"零值回落默认"纪律）。
//
// 变异：把 withDefaults 里的 QueueBodyBytes 回落删掉 ⇒ 本用例红（账上会缺 256 MiB）。
func TestZeroPlanQueueBodyFallsBackToDefault(t *testing.T) {
	only := readyz.MemoryPlan{Profile: "partial", Instances: 1}
	b := readyz.ComputeMemoryBudgetFor(8<<30, only)
	if b.QueueBody != limits.WasmQueueBodyBytesMax {
		t.Fatalf("未填 QueueBodyBytes 时必须回落默认 %d，得到 %d（这一笔会被静默算成 0）",
			limits.WasmQueueBodyBytesMax, b.QueueBody)
	}
}

// TestQueueBodyFlipsBudgetVerdict 是"删掉该项 ⇒ 用例红"的对照判据：
//
// 构造一台**只差这一笔**的机器 —— 五笔账（实例池+编译峰值+上传峰值+缓存驻留+页缓存）
// 按 70% 水位放行，加上排队体之后就超了。这正是评审现场"账绿、进程却可能 OOM"的形态；
// 若把 QueueBody 从 Total 里去掉（或恒为 0），本用例会退回"放行"并直接红。
func TestQueueBodyFlipsBudgetVerdict(t *testing.T) {
	// 默认档五笔账（不含排队体）与它的水位：
	const available = int64(4 << 30) // 4 GiB 可用内存 ⇒ 水位 4 GiB × 70% = 2867 MiB
	plan := readyz.DefaultMemoryPlan()
	plan.QueueBodyBytes = 0 // 交给 withDefaults 填默认值（= limits 常量）
	b := readyz.ComputeMemoryBudgetFor(available, plan)

	fiveAccounts := b.Instances + b.CompilePeak + b.UploadPeak + b.CacheResident + b.AppDBCache
	if fiveAccounts > b.Limit {
		t.Fatalf("前置：五笔账 %d MiB 在水位 %d MiB 之上，本用例断言不到排队体那一笔",
			fiveAccounts>>20, b.Limit>>20)
	}
	if b.OK {
		t.Fatalf("五笔账 %d MiB 放行、加上排队体 %d MiB 之后必须判失败：total=%d MiB limit=%d MiB",
			fiveAccounts>>20, b.QueueBody>>20, b.Total>>20, b.Limit>>20)
	}
	if !b.Known {
		t.Fatal("可用内存已知 ⇒ known 必须为 true")
	}

	// 复现评审现场的乘积：4096 × 1 MiB ≈ 4 GiB。账上的这一笔**远小于**它 ——
	// 因为运行期的硬上界是 limits.WasmQueueBodyBytesMax，而不是"每应用队列 × 请求体上限"。
	legalMaxProduct := int64(4096) * int64(limits.AppRequestBodyMaxBytes)
	if b.QueueBody >= legalMaxProduct {
		t.Fatalf("账面排队体 %d 不应达到合法配置乘积 %d（那说明又把理论乘积当成了上界）",
			b.QueueBody, legalMaxProduct)
	}
	if b.QueueBody*2 > legalMaxProduct/4 {
		t.Fatalf("账面排队体 %d 过大：它必须把 %d 的乘积牢牢封在账外", b.QueueBody, legalMaxProduct)
	}
}
