package serverstore

// F-39 / F-18（能力中心审计 2026-10-26，P3）的判据：
//
//   · F-39 `app_releases.quality` 的取值域在 Go 侧（SetReleaseQuality 的唯一写入口）
//     与 SQL 侧（迁移 0090 的 CHECK）各判一次 —— 修前两边都没有；
//   · F-18 `app_grants` 必须有 `(grantee_type, grantee)` 索引，且索引列序与
//     `AccessibleAppIDs` 的等值谓词一致（否则热路径仍然全表扫）。
//
// 这两条只看"代码/迁移的声明面"就能判（不需要 PG）：取值域校验发生在任何 DB 调用
// 之前，索引判据是迁移正文与查询谓词的对拍。DB 层的真正生效由迁移测试覆盖。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestQualityValueDomainIsEnforced(t *testing.T) {
	// 合法值：'' / official / featured（0037 语义：official 与 featured 互斥，但取值域相同）。
	for _, q := range []string{QualityNone, QualityOfficial, QualityFeatured} {
		if !ValidReleaseQuality(q) {
			t.Fatalf("ValidReleaseQuality(%q) = false, want true", q)
		}
	}
	// 非法值：任何其他字符串 —— 修前 SetReleaseQuality 会把它写进库（F-39）。
	for _, q := range []string{"magic", "Official", "featured ", " official", "0"} {
		if ValidReleaseQuality(q) {
			t.Fatalf("ValidReleaseQuality(%q) = true, want false", q)
		}
	}
	// 唯一写入口必须在碰 DB 之前拒绝（传 nil db 证明它没有走到 Exec）。
	if err := SetReleaseQuality(nil, AppKindSkill, "x", "1.0.0", "magic"); err == nil {
		t.Fatal("SetReleaseQuality 接受了非法质量标记（F-39 回归：脏值会静默落库，徽章永不命中）")
	}
}

func TestMigration0090DeclaresGrantsIndexAndQualityCheck(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("migrations-pg",
		"0090_app_grants_grantee_index_and_quality_check.sql"))
	if err != nil {
		t.Fatalf("读取迁移 0090: %v", err)
	}
	sql := strings.Join(strings.Fields(string(raw)), " ")

	// F-18：索引本体 + 列序（与 AccessibleAppIDs 的 `grantee_type = ?` 等值 +
	// `grantee IN (…)` 收窄一致）。
	if !strings.Contains(sql, "CREATE INDEX IF NOT EXISTS idx_app_grants_grantee_lower ON app_grants (grantee_type, lower(grantee))") {
		t.Fatalf("迁移 0090 缺少 app_grants(grantee_type, lower(grantee)) 表达式索引（F-18）")
	}
	// F-39：取值域 CHECK（NOT VALID：存量不回溯，新写入立即受约束）。
	if !strings.Contains(sql, "app_releases_quality_check") ||
		!strings.Contains(sql, "CHECK (quality IN ('', 'official', 'featured')) NOT VALID") {
		t.Fatalf("迁移 0090 缺少 quality 取值域 CHECK（F-39）")
	}

	// 判据自证：AccessibleAppIDs 的谓词必须与索引列同序（换个顺序就该重估索引）。
	apps, err := os.ReadFile("apps.go")
	if err != nil {
		t.Fatalf("读取 apps.go: %v", err)
	}
	src := string(apps)
	if !strings.Contains(src, "grantee_type = 'user' AND lower(grantee) = lower(?)") ||
		!strings.Contains(src, "grantee_type = 'group' AND lower(grantee) IN (") {
		t.Fatalf("AccessibleAppIDs 的谓词形状变了（不再按 grantee_type 等值 + grantee IN 收窄），" +
			"请同步重估迁移 0090 的索引列序（F-18）")
	}
}
