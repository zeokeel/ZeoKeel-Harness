package portal

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// 品牌标记形态(2026-10-21:品牌真源更换,回落不再是内联手抄几何):
//   - 渠道配了 logo → <span class="mark"><picture>…</picture></span>
//   - 未配 logo     → 两个变体各自成块(每块本身就是一个 .mark):
//     <span class="mark mark-light"><img alt="" src="data:image/svg+xml;base64,…"></span>
//     <span class="mark mark-dark">…</span>
//
// 两块由 CSS 按 prefers-color-scheme 显隐;data URI 解码后与 brands/official/*
// 逐字节对拍。
// ---------------------------------------------------------------------------
var (
	// markLightRe/markDarkRe 抓回落变体的 data URI(捕获组 1 = 完整 data URI)。
	markLightRe = regexp.MustCompile(`<span class="mark mark-light"><img alt="" src="(data:image/svg\+xml;base64,[^"]+)"></span>`)
	markDarkRe  = regexp.MustCompile(`<span class="mark mark-dark"><img alt="" src="(data:image/svg\+xml;base64,[^"]+)"></span>`)
	// channelMarkRe 抓渠道 logo 形态(LogoURL 非空时唯一的 .mark)。
	channelMarkRe = regexp.MustCompile(`(?s)<span class="mark"><picture>.*?</picture></span>`)
	// schemeAnyRe 抓所有 prefers-color-scheme 块,返回 (scheme, body)。
	// 变体显隐必须与 token 集**同一条件**;两处规则在文件里可以分块声明
	// (CSS 不接受把后面的选择器写进前面的块而不被后面的默认值覆盖),
	// 所以对拍的是"用了哪条查询",而不是"在不在同一个块里"。
	schemeAnyRe = regexp.MustCompile(`(?s)@media \(prefers-color-scheme: (light|dark)\)\{(.*?)\n  \}`)
)

// schemeOf 返回包含 needle 的那条媒体查询名(light/dark);找不到即 fatal。
func schemeOf(t *testing.T, html, needle, what string) string {
	t.Helper()
	for _, m := range schemeAnyRe.FindAllStringSubmatch(html, -1) {
		if strings.Contains(m[2], needle) {
			return m[1]
		}
	}
	t.Fatalf("CSS 里找不到 %s(needle=%q)", what, needle)
	return ""
}

// 门户渲染的数据(渠道内容)必须全部转义:渠道配置里的尖括号/引号不得变成标签。
// 内容来源虽是构建期可信的私有仓,但"可信"不等于"可以拼接进 HTML"。
func TestRenderEscapesChannelContent(t *testing.T) {
	html := Render(View{
		Name:      `<script>alert(1)</script>`,
		Tagline:   `" onload="evil()`,
		Welcome:   `<img src=x onerror=alert(2)>`,
		AdminURL:  "/admin/",
		Version:   `1.0.0">&lt;`,
		LogoURL:   `javascript:alert(3)`, // 属性上下文:html/template 会替换为 #ZgotmplZ
		Downloads: []Platform{{Name: `<b>Win</b>`, Meta: `x`, URL: `" onmouseover="x`}},
	})

	if strings.Contains(html, "<script>alert(1)</script>") {
		t.Fatal("名称未转义")
	}
	// 文本上下文里 `<` 必须变成 &lt;:此时整串只是纯文本,不构成标签。
	// 注意不能直接断言 `!strings.Contains(html, "<img")` —— 模板本身的
	// logo 分支就含 <img(结构,非注入),要断言的是**注入串**的转义形态。
	if !strings.Contains(html, "&lt;img src=x onerror=alert(2)&gt;") {
		t.Fatal("欢迎语应转义后原样显示")
	}
	if strings.Contains(html, `<img src=x onerror=alert(2)>`) {
		t.Fatal("欢迎语未转义(可直接注入标签)")
	}
	// 属性上下文里引号必须转义,否则可以闭合属性注入 onload
	if strings.Contains(html, `onload="evil()`) {
		t.Fatal("标语里的引号未转义(可闭合属性)")
	}
	if !strings.Contains(html, "&quot;") && !strings.Contains(html, "&#34;") {
		t.Fatal("标语中的引号应被转义")
	}
	if strings.Contains(html, "<b>Win</b>") {
		t.Fatal("平台名未转义")
	}
	// 转义后的形态应当出现(证明内容确实被渲染而不是被吞掉)
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Fatal("名称应被转义后渲染")
	}
}

// 渠道未配置时的兜底:空字段不产生空区块(门户不应出现"undefined"或空标题)。
//
// 2026-09-13(R7 srvcore-5):本用例原来断言 `!strings.Contains(html, "class=\"empty\"")`,
// 而模板在无下载项时渲染的是 `<div class="empty rise" …>` —— `class="empty"`
// 根本不是它的子串,`t.Fatal` 分支不可达(恒真),注释还写着"应直接省略下载区",
// 与模板真实行为(渲染空态提示)相反。现在按产品真实意图断言**空态**:
// 断言改查真实片段与文案,注释同步。
func TestRenderOmitsEmptyBlocks(t *testing.T) {
	html := Render(View{Name: "ZeoKeel", AdminURL: "/admin/"})
	if strings.Contains(html, "{{") || strings.Contains(html, "undefined") {
		t.Fatalf("模板未正确执行: %s", html[:200])
	}
	// 空字段不产生区块:没有标语/欢迎语时不留空标签。
	if strings.Contains(html, `class="tagline"`) || strings.Contains(html, `class="welcome"`) {
		t.Fatal("空标语/欢迎语不应渲染空区块")
	}
	// 无 Downloads 时渲染**空态提示**(而不是空表/坏链接)。
	if !strings.Contains(html, `class="empty rise"`) {
		t.Fatal("未提供 Downloads 时应渲染空态区块")
	}
	if !strings.Contains(html, "本服务端暂未提供客户端安装包") {
		t.Fatal("空态区块应带可读文案")
	}
	// 空态是唯一形态:不得同时出现下载网格。
	if strings.Contains(html, `class="dl`) {
		t.Fatal("无下载项时不得渲染下载卡片")
	}
}

// 有下载项时渲染按钮,地址原样透传(服务端拼好的绝对/相对地址)。
func TestRenderDownloads(t *testing.T) {
	html := Render(View{
		Name: "ZeoKeel", AdminURL: "/admin/",
		Downloads: []Platform{
			{Name: "Windows", Meta: "x64 · .exe", URL: "/updates/client/a.exe"},
			{Name: "macOS", Meta: "该平台暂无可用安装包"},
		},
	})
	if !strings.Contains(html, `href="/updates/client/a.exe"`) {
		t.Fatal("可下载平台应渲染链接")
	}
	// 无 URL 的平台渲染为不可用态(span + off),不给坏链接
	if strings.Contains(html, `href=""`) {
		t.Fatal("不可用平台不应渲染空链接")
	}
	// 下载徽标必须是**内联 SVG**,不能用文字箭头:文字符号(U+2193)不在系统字体
	// 主字集里,回退字形实测被渲染成歪斜的"¡"状残字(2026-09-14 真机截图发现)。
	if !strings.Contains(html, "<svg") {
		t.Fatal("下载徽标应使用内联 SVG 箭头")
	}
	if strings.Contains(html, "↓") {
		t.Fatal("下载徽标不得使用文字箭头(字体回退会渲染成残字)")
	}
}

// 全部平台都拿不到安装包时,不能再说"下载 → 安装 → 登录"(让访客下载不到东西
// 是空话),也不该摆三张一模一样的"暂无"死卡 —— 换一块说清原因的提示;
// 有一条可用就照常显示卡片。
func TestRenderLeadOnlyWhenDownloadable(t *testing.T) {
	allOff := Render(View{Name: "ZeoKeel", AdminURL: "/admin/", Downloads: []Platform{
		{Name: "Windows", Meta: "该平台暂无可用安装包"},
		{Name: "macOS", Meta: "该平台暂无可用安装包"},
	}})
	if strings.Contains(allOff, "用企业账号登录") {
		t.Fatal("无任何可用安装包时不应显示下载引导")
	}
	if !strings.Contains(allOff, `class="empty`) {
		t.Fatal("全部平台不可用时应显示统一提示,而不是三张死卡")
	}
	if strings.Contains(allOff, "该平台暂无可用安装包") {
		t.Fatal("全部平台不可用时不应再逐张渲染不可用卡片")
	}
	oneOn := Render(View{Name: "ZeoKeel", AdminURL: "/admin/", Downloads: []Platform{
		{Name: "Windows", Meta: "x64 · .exe", URL: "/updates/client/a.exe"},
		{Name: "macOS", Meta: "该平台暂无可用安装包"},
	}})
	if !strings.Contains(oneOn, "用企业账号登录") {
		t.Fatal("有可用安装包时应显示下载引导")
	}
	// 部分可用时,不可用平台仍按卡片呈现(让访客知道该平台确实没有,而不是漏了)
	if !strings.Contains(oneOn, `class="dl off`) {
		t.Fatal("部分可用时应保留不可用平台的占位卡片")
	}
}

// 2026-09-14 产品约定:门户访客是普通员工,首屏第一动作必须是**下载客户端**,
// 管理后台入口不得出现在首屏(员工会点进去看到自己无法使用的管理登录页)。
//
// 这条测试守护的是"分流"而不是"文案":既要求下载区在管理链接之前,也要求
// 页面不再有任何按钮式管理入口(管理员仍可从页脚低调进入,直接访问 /admin/ 亦可)。
func TestRenderDownloadFirstAndNoAdminCallToAction(t *testing.T) {
	html := Render(View{
		Name: "ZeoKeel", Tagline: "企业级 AI 办公智能体平台",
		Welcome:  "统一接入企业内网 AI 能力。",
		AdminURL: "/admin/", Version: "2.7.2",
		Downloads: []Platform{
			{Name: "Windows", Meta: "x64 · .exe 安装程序", URL: "/updates/client/a.exe"},
			{Name: "macOS", Meta: "Apple 芯片 (M 系列) · .dmg 磁盘映像", URL: "/updates/client/a.dmg"},
			{Name: "Linux", Meta: "x64 · .AppImage / .deb", URL: "/updates/client/a.AppImage"},
		},
	})

	dl := strings.Index(html, "客户端下载")
	admin := strings.Index(html, `href="/admin/"`)
	if dl < 0 {
		t.Fatal("门户必须渲染下载区")
	}
	if admin < 0 {
		t.Fatal("管理员入口应从页脚进入(缺链接会让运维找不到后台)")
	}
	if dl > admin {
		t.Fatal("下载区必须在管理入口之前(首屏给员工,不给管理登录)")
	}
	// 按钮式入口已移除:页面里不再有 .btn 系列样式/文案,管理入口只剩一处页脚链接。
	if strings.Contains(html, "进入管理后台") || strings.Contains(html, "btn-primary") {
		t.Fatal("管理后台不得再作为首屏按钮出现")
	}
	if n := strings.Count(html, `href="/admin/"`); n != 1 {
		t.Fatalf("管理入口应只保留页脚一处,实际 %d 处", n)
	}
	// 页脚不写渠道名(2026-09-14 用户要求):访客是员工,内部渠道标识对他们是噪音,
	// 也没必要让他们知道本部署跑在哪条发布线上。渠道标识曾用 <code> 渲染。
	if strings.Contains(html, "<code>") {
		t.Fatal("页脚不得渲染渠道标识")
	}
	// 下载按钮必须带「下载」文字:无字圆点在窄屏宽行卡片里不像按钮(2026-09-14 用户指出)。
	if !strings.Contains(html, ">下载</span>") {
		t.Fatal("下载按钮应带文字标签")
	}
}

// 渠道配了深浅两版 logo 时必须按主题下发**对应那一版**(AGENTS.md:浅色面
// logo.svg / 深色面 logo-dark.svg,不得用同一版硬顶)。门户跟随系统深浅色,
// 所以用 <picture> 的 <source media="(prefers-color-scheme: dark)"> 让浏览器
// 自己挑 —— 服务端渲染时并不知道访客用哪个主题。
func TestRenderLogoThemeVariants(t *testing.T) {
	const light, dark = "/api/client/v2/channel/logo", "/api/client/v2/channel/logo-dark"
	both := Render(View{Name: "ZeoKeel", AdminURL: "/admin/", LogoURL: light, LogoDarkURL: dark})
	if !strings.Contains(both, "prefers-color-scheme: dark") {
		t.Fatal("深色主题应切换到暗色版 logo")
	}
	if !strings.Contains(both, `srcset="`+dark+`"`) {
		t.Fatal("暗色版应以 srcset 下发")
	}
	if !strings.Contains(both, `src="`+light+`"`) {
		t.Fatal("浅色版仍是默认 img 源")
	}
	// 渠道没做暗色版(LogoDarkURL 为空)时不得给出会 404 的 source
	onlyLight := Render(View{Name: "ZeoKeel", AdminURL: "/admin/", LogoURL: light})
	if strings.Contains(onlyLight, "prefers-color-scheme: dark") {
		t.Fatal("渠道未配暗色版时不应渲染 dark source")
	}
	if !strings.Contains(onlyLight, `src="`+light+`"`) {
		t.Fatal("只有浅色版时应照常渲染")
	}
	// 完全没配 logo:回落到**权威 SVG 文件本身**(两个 data URI 变体),
	// 且不得引用任何渠道 logo 地址(否则访客会拿到 404)。
	noLogo := Render(View{Name: "ZeoKeel", AdminURL: "/admin/"})
	if strings.Contains(noLogo, "/api/client/v2/channel/logo") {
		t.Fatal("未配 logo 时不应引用渠道 logo 地址")
	}
	if !markLightRe.MatchString(noLogo) || !markDarkRe.MatchString(noLogo) {
		t.Fatal("未配 logo 时应回落到官方双色标记(两个内嵌变体)")
	}
}

// 下载区之后必须有功能说明(员工据此判断"装完能干什么"),且顺序在下载之后。
func TestRenderFeatures(t *testing.T) {
	html := Render(View{
		Name: "ZeoKeel", AdminURL: "/admin/",
		Downloads: []Platform{{Name: "Windows", Meta: "x64 · .exe", URL: "/updates/client/a.exe"}},
	})

	feat := strings.Index(html, "客户端功能")
	if feat < 0 {
		t.Fatal("门户应渲染客户端功能说明")
	}
	if feat < strings.Index(html, "客户端下载") {
		t.Fatal("功能说明应排在下载区之后(先让访客拿到客户端)")
	}
	for _, f := range featureList() {
		if !strings.Contains(html, f.Title) || !strings.Contains(html, f.Detail) {
			t.Fatalf("功能项 %q 未渲染", f.Title)
		}
	}
}

// decodeSVGDataURI 解码回落标记里的 SVG data URI,返回原始 SVG 字节。
func decodeSVGDataURI(t *testing.T, uri string) []byte {
	t.Helper()
	const prefix = "data:image/svg+xml;base64,"
	if !strings.HasPrefix(uri, prefix) {
		t.Fatalf("回落标记的 img 源应以 %q 开头,实际: %q", prefix, preview(uri))
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(uri, prefix))
	if err != nil {
		t.Fatalf("data URI 的 base64 负载无法解码: %v", err)
	}
	return raw
}

// fallbackVariant 从渲染结果里取出指定配色变体,解码成 SVG 字节。
func fallbackVariant(t *testing.T, html, name string, re *regexp.Regexp) []byte {
	t.Helper()
	m := re.FindStringSubmatch(html)
	if m == nil {
		t.Fatalf("门户未渲染 %s 变体(回落的双色标记缺一半): %q", name, preview(html))
	}
	return decodeSVGDataURI(t, m[1])
}

// readAuthority 读品牌真源;模块副本(无 brands/)里 Skip,与旧用例口径一致。
func readAuthority(t *testing.T, file string) []byte {
	t.Helper()
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "brands", "official", file))
	if err != nil {
		// 只在仓库根可见时可跑(module-only 副本里没有 brands/)。
		t.Skipf("brands/official/%s 不可见(%v):请在仓库内运行 go test", file, err)
	}
	return src
}

// preview 截断长 HTML 便于失败信息可读。
func preview(s string) string {
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}

// ---------------------------------------------------------------------------
// 品牌标记(2026-10-21:品牌真源更换,旧括号几何退役)
//
// 回落标记不再内联手抄几何,而是把 brands/official/logo.svg 与 logo-dark.svg
// **逐字节复制**进 server/internal/portal/brand-assets/ 后用 //go:embed 下发
// (见 brandassets.go)。因此断言从"逐属性对拍内联几何"升级为:
//   1) 内嵌副本 == 权威文件(逐字节);
//   2) 门户渲染的两个 data URI 解码后 == 两份权威文件(逐字节);
//   3) 两个变体的方块底色/渐变填充与权威文件一致(白底 vs 黑底,同一全彩标记)。
// 手抄漂移、颜色写反、忘了同步上游 logo 都会当场红。
// ---------------------------------------------------------------------------

// 内嵌的两份素材必须与品牌真源逐字节相同(禁止手改、禁止重新导出)。
func TestEmbeddedBrandAssetsMatchAuthority(t *testing.T) {
	for _, c := range []struct {
		file     string
		embedded []byte
	}{
		{"logo.svg", brandLogoLightSVG},
		{"logo-dark.svg", brandLogoDarkSVG},
	} {
		authority := readAuthority(t, c.file)
		if !bytes.Equal(c.embedded, authority) {
			t.Fatalf("内嵌的 brand-assets/%s 与 brands/official/%s 不是逐字节相同(内嵌 %d 字节,权威 %d 字节):请用 cp 重新复制权威文件,禁止手改",
				c.file, c.file, len(c.embedded), len(authority))
		}
	}
}

// 门户回落的两个变体必须**逐字节派生**自权威文件:浅色面 = logo.svg,
// 深色面 = logo-dark.svg(AGENTS.md 品牌双色对),且不得是文字字形/手绘几何。
func TestRenderBrandMarkDerivesFromOfficialLogo(t *testing.T) {
	official := readAuthority(t, "logo.svg")
	officialDark := readAuthority(t, "logo-dark.svg")

	html := Render(View{Name: "Acme", AdminURL: "/admin/"})
	light := fallbackVariant(t, html, "mark-light", markLightRe)
	dark := fallbackVariant(t, html, "mark-dark", markDarkRe)

	// 1) 解码 data URI 后与权威文件逐字节相同 ⇒ 不存在第二份几何真源。
	if !bytes.Equal(light, official) {
		t.Fatalf("mark-light 变体必须逐字节等于 brands/official/logo.svg(白底 + 全彩渐变标记)")
	}
	if !bytes.Equal(dark, officialDark) {
		t.Fatalf("mark-dark 变体必须逐字节等于 brands/official/logo-dark.svg(黑底 + 同一标记)")
	}
	// 2) 两版确实不同(权威文件唯一差异是方块底色),否则主题切换没有意义。
	if bytes.Equal(light, dark) {
		t.Fatal("两个变体完全相同:浅色/深色主题切换失去意义(必须用 logo.svg / logo-dark.svg)")
	}
	// 3) 品牌铁律:不得出现文字字形(旧回落是首字母/字面量 P)与 <text> 节点。
	for _, glyph := range []string{">A<", ">H<", ">P<", ">a<", ">p<", "<text"} {
		if strings.Contains(string(light), glyph) || strings.Contains(string(dark), glyph) {
			t.Fatalf("品牌标记出现文字字形 %q(品牌铁律禁止)", glyph)
		}
	}
	// 4) 标记由 <img alt=""> 承载(装饰性图片),不是内联手抄的 SVG 几何。
	if !strings.Contains(html, `<span class="mark mark-light"><img alt="" src="data:image/svg+xml;base64,`) {
		t.Fatalf("回落标记应以 <img alt=\"\"> 下发权威素材: %q", preview(html))
	}
}

// 两份权威素材的可验证差异 = 方块底色;共同部分 = 全彩渐变标记。
// 这里钉住:light = 白底(logo.svg)、dark = 黑底(logo-dark.svg),且 6 条
// linearGradient 与渐变填充都还在(不得被压平成单色/currentColor)。
func TestRenderBrandMarkKeepsOfficialTilesAndGradients(t *testing.T) {
	html := Render(View{Name: "Acme", AdminURL: "/admin/"})
	light := fallbackVariant(t, html, "mark-light", markLightRe)
	dark := fallbackVariant(t, html, "mark-dark", markDarkRe)

	const tile = `<rect x="0" y="0" width="1254" height="1254" rx="180" fill="%s"/>`
	for _, c := range []struct {
		name string
		svg  []byte
		fill string
	}{
		{"mark-light(logo.svg)", light, "#FFFFFF"},
		{"mark-dark(logo-dark.svg)", dark, "#000000"},
	} {
		if !strings.Contains(string(c.svg), fmt.Sprintf(tile, c.fill)) {
			t.Fatalf("%s 的圆角方块底应为 %s(权威文件逐字节派生)", c.name, c.fill)
		}
		if n := strings.Count(string(c.svg), "<linearGradient"); n != 6 {
			t.Fatalf("%s 应保留 6 条 linearGradient 渐变(实际 %d 条)", c.name, n)
		}
		if n := strings.Count(string(c.svg), `fill="url(#`); n < 5 {
			t.Fatalf("%s 的渐变填充缺失:只找到 %d 处 fill=\"url(#…)\"", c.name, n)
		}
		// 渐变停靠色(青→蓝→紫系)也必须保留:被压平成单色即红。
		for _, stop := range []string{"#37E7FE", "#0946EF", "#3935FB"} {
			if !strings.Contains(string(c.svg), stop) {
				t.Fatalf("%s 缺少渐变停靠色 %s(标记被改色/压平)", c.name, stop)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 审计 R7-RV-6:门户的默认 token 集是深色底(rgb(8,10,15)),标记必须默认给
// 深色变体(logo-dark.svg),在**同一条 light 查询**里切到浅色变体(logo.svg)。
//
// 本用例钉住的是**选边条件必须与 token 集同源**:本页默认(无媒体查询)是深色
// token,浅色 token 在 @media (prefers-color-scheme: light) 里生效 —— 写反会让
// "未声明偏好"的 UA 拿到深色底 + 深色变体,主题切换形同虚设。
// 变异测试:把两条规则换回 dark 查询 → 第 2 步当场红。
// ---------------------------------------------------------------------------
func TestRenderBrandMarkSwitchesTileColorWithColorScheme(t *testing.T) {
	html := Render(View{Name: "Acme", AdminURL: "/admin/"})

	// 1) 默认(未声明偏好):深色变体(logo-dark.svg)可见,与默认的深色 token 配套。
	if !strings.Contains(html, `.brand .mark.mark-dark{display:flex}`) {
		t.Fatal("默认 token 是深色底,CSS 就必须默认显示深色变体(logo-dark.svg)")
	}
	if !strings.Contains(html, `.brand .mark.mark-light{display:none}`) {
		t.Fatal("CSS 未默认隐藏浅色变体(logo.svg)")
	}
	// 2) 浅色偏好:与 --bg/--fg 等 token **同一条**媒体查询里切到浅色变体。
	tokenScheme := schemeOf(t, html, "--bg:#f7f8fb", "浅色 token 覆盖块")
	if tokenScheme != "light" {
		t.Fatalf("token 集的浅色覆盖应挂在 light 查询上,实际 %q", tokenScheme)
	}
	markScheme := schemeOf(t, html, `.brand .mark.mark-light{display:flex}`, "浅色标记变体的显示规则")
	if markScheme != tokenScheme {
		t.Fatalf("标记选边挂在 %q 查询上,而 token 翻转挂在 %q 上:两者必须同源", markScheme, tokenScheme)
	}
	lightBlock := schemeAnyRe.FindStringSubmatch(html)
	for _, m := range schemeAnyRe.FindAllStringSubmatch(html, -1) {
		if strings.Contains(m[2], `.brand .mark.mark-light{display:flex}`) {
			lightBlock = m
		}
	}
	if !strings.Contains(lightBlock[2], `.brand .mark.mark-dark{display:none}`) {
		t.Fatalf("浅色偏好下未隐藏深色变体: %q", lightBlock[2])
	}
	// 3) 两版都在同一个标记区块里(不是只留一版),且共用 38px 方框与 100% 尺寸规则。
	if !markLightRe.MatchString(html) || !markDarkRe.MatchString(html) {
		t.Fatalf("标记区块应同时含两个配色变体: %q", preview(html))
	}
	if !strings.Contains(html, `.brand .mark{width:38px;height:38px;border-radius:11px;overflow:hidden;flex:0 0 auto;`) {
		t.Fatal("两个变体必须共用 .brand .mark 的 38px 方框规则")
	}
	if !strings.Contains(html, `.brand .mark img{width:100%;height:100%;object-fit:contain;display:block}`) {
		t.Fatal("两个变体必须共用 .brand .mark img 的 100%/100% 尺寸规则")
	}

	// 4) 渠道配了 logo:两个内嵌变体都必须让位给渠道 <img>。
	withLogo := Render(View{Name: "Acme", AdminURL: "/admin/", LogoURL: "/api/client/v2/channel/logo"})
	if markLightRe.MatchString(withLogo) || markDarkRe.MatchString(withLogo) {
		t.Fatalf("配置了渠道 logo 时两个内嵌变体都应被抑制: %q", preview(withLogo))
	}
	if !channelMarkRe.MatchString(withLogo) {
		t.Fatalf("配置了渠道 logo 时应渲染 <span class=\"mark\"><picture>: %q", preview(withLogo))
	}
	if strings.Contains(withLogo, "data:image/svg+xml;base64") {
		t.Fatal("配置了渠道 logo 时不应再下发内嵌素材")
	}
}

// 有 LogoURL 时仍走渠道素材(<img>),不叠加内嵌权威素材(渠道品牌优先于回落)。
func TestRenderUsesChannelLogoWhenConfigured(t *testing.T) {
	html := Render(View{Name: "Acme", AdminURL: "/admin/", LogoURL: "/api/client/v2/channel/logo"})
	m := channelMarkRe.FindString(html)
	if m == "" {
		t.Fatalf("门户未渲染品牌标记区块: %q", preview(html))
	}
	if !strings.Contains(m, `<img src="/api/client/v2/channel/logo"`) {
		t.Fatalf("配置了渠道 logo 时应下发 <img>: %q", m)
	}
	if strings.Contains(html, "data:image/svg+xml;base64") {
		t.Fatalf("配置了渠道 logo 时不应注入内嵌回落素材: %q", preview(html))
	}
}

// 品牌标记区块 CSS 不得再自造渐变方块(旧行为:linear-gradient 假 logo)。
func TestRenderBrandMarkHasNoInventedGradientTile(t *testing.T) {
	html := Render(View{Name: "Acme", AdminURL: "/admin/"})
	if strings.Contains(html, "linear-gradient(140deg") {
		t.Fatal("品牌标记不得使用自造渐变方块(须用权威 SVG / 渠道素材)")
	}
}
