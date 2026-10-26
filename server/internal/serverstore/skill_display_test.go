package serverstore

import "testing"

// TestAppToSkillDisplayNameFallback（2026-10-26 D 系列显示修复）:
// 市场技能的展示名回退链必须是 apps.title → 展示版本 title → app_id。
//
// 缺陷形态：appToSkill 只投影 `a.Title`，存量行（旧 git 模式登记时 title 为空）
// 投影出 DisplayName=""，skillJSON 只能拿 name 兜底 —— 管理端卡片因此显示英文
// 目录名，而不是包内 SKILL.md 的中文 title。
func TestAppToSkillDisplayNameFallback(t *testing.T) {
	cases := []struct {
		name         string
		appTitle     string
		releaseTitle string
		want         string
	}{
		{name: "app title 优先(管理员可编辑的展示名)", appTitle: "中文展示名", releaseTitle: "包内标题", want: "中文展示名"},
		{name: "app title 空 → 回退展示版本 title", appTitle: "", releaseTitle: "包内标题", want: "包内标题"},
		{name: "两处都空 → 回落 name", appTitle: "", releaseTitle: "", want: "demo"},
		{name: "仅空白也按空处理", appTitle: "  ", releaseTitle: "包内标题", want: "包内标题"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := appToSkill(
				App{Kind: AppKindSkill, AppID: "demo", Title: tc.appTitle, Channel: AppChannelMarket},
				&Release{Kind: AppKindSkill, AppID: "demo", Version: "1.0.0", Title: tc.releaseTitle},
			)
			if got.DisplayName != tc.want {
				t.Fatalf("DisplayName = %q, want %q", got.DisplayName, tc.want)
			}
		})
	}

	// 没有展示版本时只能回退 App 层(apps.title 空 ⇒ name)。
	got := appToSkill(App{Kind: AppKindSkill, AppID: "demo"}, nil)
	if got.DisplayName != "demo" {
		t.Fatalf("无版本时 DisplayName = %q, want demo", got.DisplayName)
	}
}

// TestAppToSkillDisplayFields：skillJSON 的 quality/source/channel 三个徽章
// 数据源必须由投影层供上（webadmin 按 quality==='featured' 渲染「精选」、
// 按 source==='upload' 渲染「上传包」）。漏投会让这两个徽章恒不出现。
func TestAppToSkillDisplayFields(t *testing.T) {
	got := appToSkill(
		App{Kind: AppKindSkill, AppID: "demo", Title: "中文展示名", Channel: AppChannelMarket},
		&Release{Kind: AppKindSkill, AppID: "demo", Version: "2.0.0", Title: "中文展示名", Quality: "featured"},
	)
	if got.Quality != "featured" {
		t.Fatalf("Quality = %q, want featured", got.Quality)
	}
	// 0052:归档是唯一内容来源 ⇒ 有展示版本即“上传包”。
	if got.Source != "upload" {
		t.Fatalf("Source = %q, want upload", got.Source)
	}
	if got.Channel != AppChannelMarket {
		t.Fatalf("Channel = %q, want market", got.Channel)
	}
}
