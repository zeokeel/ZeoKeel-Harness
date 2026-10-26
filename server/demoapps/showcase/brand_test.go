package main

// 品牌标识的回归判据（2026-10-26 事故之后加的）。
//
// 演示应用的顶栏（web/index.html）与 403 页（本包的 brandMarkup）**不再画**品牌
// 几何，而是引用应用资源 web/static/brand-day.svg 与 web/static/brand-night.svg ——
// 这两份文件必须是品牌真源 brands/official/logo.svg 与 logo-dark.svg 的**逐字节
// 副本**（AGENTS.md：品牌几何唯一真源；every brand mark derived from it）。
//
// 为什么要有这条判据：旧实现把"圆角方块 + 括号 + 连接线 + 两个节点圆"的几何手抄
// 在 index.html 与 main.go 两处；公开仓 2026-10-21 换品牌后没人再动它 ⇒ 演示应用
// 里显示的仍是上一个项目的 mark，而所有门禁都是绿的（它们只看得到"页面上有 SVG"）。
// 同族事故：私有渠道仓里的公共渠道素材没跟上品牌变更（服务端门户/管理后台因此
// 显示旧 logo），那条现在由 scripts/lib/check-channel-json.mjs 在打包期拦。
//
// 这条判据为什么住在这个包：`server/Makefile` 的 GO_DIRS 含 `demoapps`，
// `go test ./...` / `make test-server` 都会跑到它，而品牌真源在仓库根 —— 从本包
// 目录（server/demoapps/showcase）往上三级就是仓库根。

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoRoot 是仓库根（本包目录 = server/demoapps/showcase）。
func repoRoot() string {
	return filepath.Join("..", "..", "..")
}

// readRepoFile 读仓库内相对路径；读不到直接判红（判据读不到输入 = 不能算通过）。
func readRepoFile(t *testing.T, rel string) []byte {
	t.Helper()
	path := filepath.Join(repoRoot(), filepath.FromSlash(rel))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读不到 %s（判据的输入缺失，不能静默跳过）：%v", rel, err)
	}
	return data
}

// TestDemoAppBrandMarkIsByteCopyOfAuthority 钉死"应用里的品牌标识 = 品牌真源字节"。
//
// 双色对（AGENTS.md）：白天面 = logo.svg（白底 + 全彩 mark），夜间面 =
// logo-dark.svg（黑底 + 同一 mark）。两份都必须是逐字节副本 —— 不重画、不简化、
// 不重新导出。
func TestDemoAppBrandMarkIsByteCopyOfAuthority(t *testing.T) {
	cases := []struct {
		asset     string
		authority string
	}{
		{"server/demoapps/showcase/web/static/brand-day.svg", "brands/official/logo.svg"},
		{"server/demoapps/showcase/web/static/brand-night.svg", "brands/official/logo-dark.svg"},
	}
	for _, tc := range cases {
		got := readRepoFile(t, tc.asset)
		want := readRepoFile(t, tc.authority)
		if !bytes.Equal(got, want) {
			t.Fatalf("%s 必须是品牌真源 %s 的逐字节副本（实际 %d 字节，真源 %d 字节）：\n"+
				"修法=用真源文件原样覆盖该资源，不要手工编辑、不要重新导出、不要自创几何。",
				tc.asset, tc.authority, len(got), len(want))
		}
	}
}

// TestBrandMarkupReferencesAuthorityAssets 钉死 403 页（brandMarkup）与顶栏同源。
//
// 403 页不是 index.html 那张页面（它由本包自己拼 HTML），品牌标识必须走同一对打包
// 资源；一旦有人图省事又在这里内联几何，就会立刻变成第二份真源。
func TestBrandMarkupReferencesAuthorityAssets(t *testing.T) {
	markup := brandMarkup("mark mark-lg")
	for _, ref := range []string{"/static/brand-day.svg", "/static/brand-night.svg"} {
		if !strings.Contains(markup, ref) {
			t.Fatalf("403 页的 brandMarkup 必须引用 %s，实际：%s", ref, markup)
		}
	}
	for _, handDrawn := range []string{"<path", "<g ", "<rect"} {
		if strings.Contains(markup, handDrawn) {
			t.Fatalf("403 页不得内联手绘几何（命中 %q）：%s", handDrawn, markup)
		}
	}
}

// TestDemoAppBrandMarkWiring 钉死"两份素材真的会被打包/直出"这条接线。
//
// 页面引用了 /static/brand-day.svg 只是第一步：资源还必须被
//   - 本地构建入口 `server/scripts/build-demo-apps.sh`，以及
//   - 镜像构建 `server/Dockerfile` 的 demoassets 阶段
//
// 登记进 pack-assets.mjs 的清单。少一处就是"本地预览有品牌、镜像里没有"或反过来，
// 而两边都不会报错（页面上只是一个 404 的 <img>）。
func TestDemoAppBrandMarkWiring(t *testing.T) {
	dayRef := "/static/brand-day.svg"
	nightRef := "/static/brand-night.svg"
	for _, rel := range []string{
		"server/demoapps/showcase/web/index.html",
		"server/demoapps/showcase/main.go",
	} {
		text := string(readRepoFile(t, rel))
		for _, ref := range []string{dayRef, nightRef} {
			if !strings.Contains(text, ref) {
				t.Fatalf("%s 必须引用 %s（应用页面上的品牌标识只能来自打包好的真源副本）", rel, ref)
			}
		}
	}

	// 打包清单（两处必须都有）：映射形态是 `<源路径>=static/brand-day.svg`。
	for _, rel := range []string{
		"server/scripts/build-demo-apps.sh",
		"server/Dockerfile",
	} {
		text := string(readRepoFile(t, rel))
		for _, name := range []string{"brand-day.svg", "brand-night.svg"} {
			if !strings.Contains(text, "static/"+name) {
				t.Fatalf("%s 没有把 %s 登记进 pack-assets 清单：素材不会被装进应用资源，"+
					"页面上的 <img> 会 404（本地与镜像两侧的清单必须逐项一致）", rel, name)
			}
		}
	}
}

// TestDemoAppsCarryNoHandDrawnBrandGeometry 钉死"演示应用里不许再出现手绘品牌几何"。
//
// 扫描面 = 整个 server/demoapps 树的文本文件（新增的演示应用同样适用）。禁的是
// 旧几何的特征串：一对括号的两条 path、那套 1.25× 平移，以及它配套的 CSS 变量。
// 需要新几何时正确做法是从 brands/official/* 复制一份资源，而不是在这里抄路径。
func TestDemoAppsCarryNoHandDrawnBrandGeometry(t *testing.T) {
	// 特征串刻意拼出来：本文件自己就在扫描面里，写字面量会自伤。
	banned := []struct {
		needle string
		why    string
	}{
		{"M 334" + " 409", "旧 logo 的左侧括号 path（手绘几何）"},
		{"M 920" + " 409", "旧 logo 的右侧括号 path（手绘几何）"},
		{"translate(627 627) scale(1.25)" + " translate(-627 -627)", "旧 logo 的 1.25× 平移"},
		{"--mark" + "-ink", "旧 logo 的 CSS 变量（几何颜色被抄进样式表）"},
	}
	root := filepath.Join(repoRoot(), "server", "demoapps")
	var scanned int
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		switch strings.ToLower(filepath.Ext(path)) {
		case ".go", ".html", ".css", ".js", ".json", ".md", ".yml", ".yaml":
		default:
			return nil
		}
		if filepath.Base(path) == "brand_test.go" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		scanned++
		text := string(data)
		for _, b := range banned {
			if strings.Contains(text, b.needle) {
				rel, _ := filepath.Rel(repoRoot(), path)
				t.Fatalf("%s 里出现了%s（%q）：演示应用的品牌标识必须引用 "+
					"web/static/brand-{day,night}.svg（品牌真源的逐字节副本），不得再手绘",
					filepath.ToSlash(rel), b.why, b.needle)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("扫描 %s 失败：%v", root, err)
	}
	if scanned == 0 {
		t.Fatalf("扫描面为空（%s）：判据没扫到任何文件，等于没跑", root)
	}
}
