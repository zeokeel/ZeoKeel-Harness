package portal

import (
	_ "embed"
	"encoding/base64"
)

// 门户回落的品牌素材 = **权威文件的逐字节副本**。
//
// brands/official/logo.svg / logo-dark.svg 是唯一几何真源(AGENTS.md 品牌铁律:
// 任何 logo/品牌标记都必须派生自 brands/official/logo.svg —— never invented,
// never hand-drawn, never a text glyph)。这里不重画、不简化、不重新导出,只做
// 字节级复制;`TestEmbeddedBrandAssetsMatchAuthority` 在仓库内运行时把两份
// 嵌入式副本与权威文件逐字节对拍,上游改了 logo 而这里没同步就当场红。
//
// 为什么整文件嵌入 + data URI,而不是把 SVG 内联进 HTML:
//
//   - 内联 SVG 需要逐属性抄写几何(方块/圆/6 条渐变路径),历史上正是这种
//     "手抄几何"漂移成了第二份真源(旧版把括号标记抄进 brandMarkSVGTemplate,
//     最终与权威文件失配)。整文件嵌入后不存在派生差异。
//   - 权威文件自带 1254 定尺寸、圆角方块底与 6 条 linearGradient;作为 <img>
//     的源可由浏览器按 object-fit 缩放,不需要改写 viewBox/尺寸属性。
//   - 门户 CSP 已放开 `img-src 'self' data:`(见 cmd/server),data URI 可直接渲染。
//
// 双色对(AGENTS.md):logo.svg = 白底(rx=180) + 全彩渐变标记;logo-dark.svg =
// 同一标记、黑色底。两份文件当前唯一差异就是方块 fill —— 门户按
// prefers-color-scheme 让 CSS 选边(浅色偏好用 logo.svg,深色/未声明偏好用
// logo-dark.svg),绝不发明第三种配色。
//
//go:embed brand-assets/logo.svg
var brandLogoLightSVG []byte

//go:embed brand-assets/logo-dark.svg
var brandLogoDarkSVG []byte

// 两个 data URI 直接进模板的 <img src>(纯 base64,不含 HTML 特殊字符)。
var (
	brandLogoLightURI = svgDataURI(brandLogoLightSVG)
	brandLogoDarkURI  = svgDataURI(brandLogoDarkSVG)
)

// svgDataURI 把 SVG 字节编码成 data URI。
//
// 用 base64 而不是百分号编码:base64 字符集 [A-Za-z0-9+/=] 不含引号/尖括号/
// 百分号,放进属性值不需要任何再转义(也是最小的体积膨胀选择)。
func svgDataURI(svg []byte) string {
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString(svg)
}
