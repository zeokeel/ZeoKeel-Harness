package marketplace

// F-13（能力中心审计 2026-10-26，P2）：审核落定必须只有**一份实现**。
//
// 修前：`serverstore.ReviewPending` 号称「三面唯一实现」，实际只有市场渠道
// （本包的 review.go）调它；组织共享库（sharedskills.decide）与组织预设
// （agentshare.decide/decideVersioned）各手写一份「SetReleaseStatusForReview*
// + RecomputeAppProjection」。三份实现的漂移面就是审计记的账：一面记得重算
// 投影、另一面忘记；一面把下架冻结做成 check-then-act、另一面写进 WHERE。
//
// 修后：三条审核面全部改调 `serverstore.ReviewPending`，本判据用**源码扫描**
// 钉住这条纪律（判据形式与仓内 `limits_gen_test.go` / `compose_env_test.go`
// 的"唯一实现/接线"扫描同款）：
//   1. 三个审核入口的源文件里**不得**再出现 `serverstore.SetReleaseStatusForReview`;
//   2. 三个审核入口都必须出现 `serverstore.ReviewPending(`;
//   3. 删除路径（remove/removeVersioned）里的 `RecomputeAppProjection` 不受限
//      —— 删除是另一条写路径，不属于"审核落定"。
//
// 变异验证：把任一 decide 改回直接调 `SetReleaseStatusForReviewIfWritable`
// ⇒ 判据 1 红（字符串在非测试源码里出现）。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReviewHasSingleImplementation(t *testing.T) {
	sources := map[string]string{
		"sharedskills/routes.go": filepath.Join("..", "sharedskills", "routes.go"),
		"agentshare/routes.go":   filepath.Join("..", "agentshare", "routes.go"),
		"marketplace/review.go":  "review.go",
	}
	for label, path := range sources {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("读取 %s: %v", label, err)
		}
		src := string(raw)
		if strings.Contains(src, "serverstore.SetReleaseStatusForReview") {
			t.Fatalf("%s 里仍有直接的状态落定调用（serverstore.SetReleaseStatusForReview*）—— "+
				"F-13 要求审核落定只走 serverstore.ReviewPending（唯一实现：状态 + 下架冻结 + "+
				"投影重算一次完成）。", label)
		}
		if !strings.Contains(src, "serverstore.ReviewPending(") {
			t.Fatalf("%s 里没有 serverstore.ReviewPending 调用 —— 审核路径必须走唯一实现（F-13）。", label)
		}
	}
}
