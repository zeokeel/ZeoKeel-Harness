package memprofile_test

import (
	"strings"
	"testing"

	"github.com/zeokeel/zeokeel-harness/server/internal/limits"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/memprofile"
	"github.com/zeokeel/zeokeel-harness/server/internal/wasmapp/readyz"
)

// TestDefaultMatchesLimitsConstants：默认档必须与 limits 的编译期常量**逐值一致** ——
// 这是"不设环境变量的部署行为不变"的判据（默认档等于历史行为）。
func TestDefaultMatchesLimitsConstants(t *testing.T) {
	p := memprofile.Default()
	if p.Instances != limits.GlobalInstances {
		t.Fatalf("默认档并发 = %d，limits.GlobalInstances = %d", p.Instances, limits.GlobalInstances)
	}
	if p.InstanceMemoryPages != limits.InstanceMemoryPages {
		t.Fatalf("默认档实例页数 = %d，limits.InstanceMemoryPages = %d", p.InstanceMemoryPages, limits.InstanceMemoryPages)
	}
	if p.ModuleCacheBytes != limits.ModuleCacheMaxBytes {
		t.Fatalf("默认档模块缓存 = %d，limits.ModuleCacheMaxBytes = %d", p.ModuleCacheBytes, limits.ModuleCacheMaxBytes)
	}
}

// TestParse：档位名解析（大小写不敏感、空=默认、未知**报错不回落**）。
func TestParse(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", "default", false},
		{"default", "default", false},
		{"DEFAULT", "default", false},
		{" small ", "small", false},
		{"Large", "large", false},
		{"small-1", "", true},
		{"2gb", "", true},
	}
	for _, tc := range cases {
		got, err := memprofile.Parse(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("Parse(%q) 应报错（未知档位不得静默回落默认）", tc.in)
			}
			if !strings.Contains(err.Error(), memprofile.EnvMemoryProfile) {
				t.Fatalf("Parse(%q) 的错误应点名环境变量：%v", tc.in, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("Parse(%q) 意外报错：%v", tc.in, err)
		}
		if got.Name != tc.want {
			t.Fatalf("Parse(%q) = %q，期望 %q", tc.in, got.Name, tc.want)
		}
	}
}

// TestFromEnv：环境变量取值（含未设置 = 默认档）。
func TestFromEnv(t *testing.T) {
	p, err := memprofile.FromEnv(func(string) string { return "" })
	if err != nil || p.Name != "default" {
		t.Fatalf("未设置环境变量应为默认档：%v %q", err, p.Name)
	}
	p, err = memprofile.FromEnv(func(k string) string {
		if k == memprofile.EnvMemoryProfile {
			return "small"
		}
		return ""
	})
	if err != nil || p.Name != "small" {
		t.Fatalf("应解析出 small：%v %q", err, p.Name)
	}
	if _, err := memprofile.FromEnv(func(string) string { return "huge" }); err == nil {
		t.Fatal("未知档位必须报错")
	}
	if _, err := memprofile.FromEnv(nil); err != nil {
		t.Fatalf("nil getenv 不应报错：%v", err)
	}
}

// TestSmallProfileFitsSmallBox：small 档必须能在**2 GB 级机器**上通过内存账自检
// —— 这是本次改造的直接目的（此前默认档 2550 MiB 必拒）。
//
// ⚠️ 机器图 2026-10-22 由 992 MiB 改为 2 GiB（生产评审 P1-3）：内存账多了"排队请求体"
// 这一笔（256 MiB，= limits.WasmQueueBodyBytesMax，与运行期硬上界同源），small 档账面
// 645 MiB → 901 MiB。992 MiB 的机器（水位 694 MiB）按规则应当判红：645/694 = 93% 本来
// 就没有给 Go 堆/协议缓冲留余量。这里改的是"small 档的目标机器"，不是把这一笔算成 0。
func TestSmallProfileFitsSmallBox(t *testing.T) {
	const available = 2 << 30 // 2 GB 级机器
	small := memprofile.Small()
	plan := readyz.MemoryPlan{
		Profile:             small.Name,
		Instances:           small.Instances,
		InstanceMemoryBytes: small.InstanceMemoryBytes(),
		ModuleCacheBytes:    small.ModuleCacheBytes,
	}
	budget := readyz.ComputeMemoryBudgetFor(available, plan)
	if !budget.OK {
		t.Fatalf("small 档应在 2 GiB 可用内存下通过：total=%dMiB limit=%dMiB",
			budget.Total>>20, budget.Limit>>20)
	}
	// 反向对照：默认档在同一台机器上必须仍然被拒（判据没有放宽，只是档位可选）。
	if def := readyz.ComputeMemoryBudgetFor(available, readyz.DefaultMemoryPlan()); def.OK {
		t.Fatal("默认档不应在 2 GiB 机器上通过（否则说明判据被放宽了）")
	}
}

// TestLargeProfileScalesUp：large 档的并发与缓存都放大（大机器用）。
func TestLargeProfileScalesUp(t *testing.T) {
	def, large := memprofile.Default(), memprofile.Large()
	if large.Instances <= def.Instances {
		t.Fatalf("large 档并发应大于默认档：%d vs %d", large.Instances, def.Instances)
	}
	if large.ModuleCacheBytes <= def.ModuleCacheBytes {
		t.Fatalf("large 档模块缓存应大于默认档：%d vs %d", large.ModuleCacheBytes, def.ModuleCacheBytes)
	}
}
