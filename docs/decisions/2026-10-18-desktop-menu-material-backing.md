# 桌面菜单在原生材质窗口上"变透明"（2.8.2 现场反馈）

- 日期：2026-10-18
- 状态：已修复（`fix/2.8.2-transparent-menu`）
- 影响面：桌面高级外壳（macOS vibrancy / Windows Mica 的透明窗口）
- 用户可见：打开侧栏「视图选项」等菜单时，卡片像一层透明膜，下面的会话列表/桌面直接透上来

## 一、现象与复现条件

现场截图（2.8.2 正式版）：侧栏「视图选项」菜单打开，菜单条目与下面的会话标题**叠在一起**；菜单区域的底色明显是透出来的（会话标题清晰可读，没有被毛玻璃糊掉）。

这不是"整个页面没了"，而是**本该给菜单做底的合成层没有实底**：

1. 上游 `MenuSurface` 的材质是
   `background: var(--dsw-menu-surface-fill)` + `backdrop-filter: var(--dsw-menu-backdrop-filter)`；
   亮色填充 `rgba(248,249,250,.58)`、暗色 `rgba(67,69,74,.45)`，模糊是
   `blur(40px) saturate(150%)`（`ui-theme` 的 `design-platform.css` /
   `gradient-shadow-text.css`）。
2. 桌面壳刻意让出原生材质：macOS `transparent: true` + `vibrancy: 'sidebar'`，Windows
   `backgroundColor: '#00000000'` + `backgroundMaterial: 'mica'`，左栏
   `.dshDesktopSidebarSurface` 也是 `transparent`（`window-options.ts` / `styles.ts`）。
   这套配置在 2.8.1 就已存在，不是 2.8.2 新加的。
3. **透明窗口的合成面上没有不透明像素时，Chromium 不再产出 `backdrop-filter` 模糊**。
   菜单只剩 45–58% 的填充，页面内容/桌面直接透上来。

条件同时成立才会出现：透明/原生材质窗口 + 菜单浮层落在左栏透明区域 + 该机器的合成路径
（macOS vibrancy 或 Windows 11 Mica；软件合成、远程桌面、禁用透明效果、GPU 差异会让
表现不同）⇒ 用户侧就是"偶发"。

## 二、为什么上游的兜底没生效

上游知道这条限制：`MenuSurface` 除了材质 div，还额外 portal 一个
`[data-menu-backing]`（`background: var(--dsw-alias-bg-base)`、
`position: fixed; z-index: -1`，位于页面内容之下、原生材质之上），让模糊重新有实底。
但它的样式只在：

```css
:global(html[data-platform='darwin']) .backing { display: block; ... }
```

下打开。`html[data-platform]` 是**上游 Electron preload** 打的标记
（`ui-primitives` 的 `darwin-desktop.d.ts` 写明："the Electron preload marks
`<html>` with `data-platform='darwin'`; plain web never sets it"）。我们的桌面壳用
`body[data-dsh-desktop-mode]` / `body[data-dsh-desktop-platform]` 标记自己，
**从未设置 `html[data-platform]`** —— 于是这条兜底在所有平台都保持 `display: none`，
Windows 更是根本没有对应规则。

> 2.8.2 的版本关联：缺陷的代码路径**不是 2.8.2 新写的** —— 0.1.7 的 MenuSurface 材质与
> token 已是同一套，窗口/左栏的原生材质配置也与 2.8.1 相同。报告集中在 2.8.2，更可能是
> 该版本的客户端 UI（DSH 0.2.0）与引擎组合让这条潜在路径进入日常使用；具体到某台机器是否
> 可见，取决于上面的合成条件（macOS vibrancy / Windows 11 Mica / 软件合成 / 透明效果开关）。
> 本修复按机制收口，不依赖版本差异。

## 三、修复

`src/client/styles.ts` 里按 desktop 自己的模式标记打开**同一个**背板：

```css
body[data-dsh-desktop-mode="advanced"] [data-menu-backing] {
  display: block;
  position: fixed;
  position-anchor: var(--dsh-menu-anchor);
  top: anchor(top);
  left: anchor(left);
  width: anchor-size(width, 0px);
  height: anchor-size(height, 0px);
  z-index: -1;
  background: var(--dsw-alias-bg-base);
  pointer-events: none;
}
```

- 覆盖 `darwin` / `win32` / `linux`：Mica 与 vibrancy 是同一条"透明窗口"链路；只修 macOS
  等于把 Windows 用户留在原地。
- 位置沿用上游的 CSS anchor（背板与菜单 `surface` 的 `anchor-name` 对齐），不改上游实现、
  不写哈希类名；真机量到背板矩形与菜单矩形逐像素相等（见下）。
- **不**把 `[data-menu-material]` 改成不透明：那会关掉毛玻璃。背板只补"可模糊的底"，
  材质仍是半透明 + 模糊。
- 不在本修复里顺手设置 `html[data-platform]`：那会同时打开上游一整套 darwin 专属外观
  （侧栏按钮、设置面板红绿灯、frame 变量等），属于独立的产品裁决；本修复只补菜单背板。

## 四、证据

1. **真实合成探针**（`tests/menu-backing-computed-probe.mjs`，透明 BrowserWindow +
   上游真实的 MenuSurface CSS + 生产函数产出的样式表）：

   | 形态 | 背板 display | 背板矩形 vs 菜单 | 菜单空白点 alpha |
   | --- | --- | --- | --- |
   | 修复前（2.8.2 形态） | none | — | **148**（透出桌面/页面） |
   | 修复后 | block | 逐像素相等 | **255**（实底，模糊有底） |

   菜单外像素 alpha=0，证明窗口确实是透明的（探针测的是这条链路）。

2. **回归判据**（`tests/menu-material-backing.spec.ts`，7 例）：钉住选择器覆盖三平台、
   背板为 `bg-base` 实底、anchor 四件套、上游 `[data-menu-backing]` 仍被 portal、
   上游默认隐藏/darwin 门控、菜单材质仍半透明 + 带 blur、窗口/左栏仍为原生材质让路；
   删掉规则或换成半透明 token 都会变红。

3. 变异验证：`--mutate=hide-backing` 把规则删掉后探针复现 alpha=148 并打印 DETECTED。

## 五、认账与残留

- 本机只有 Linux/Xvfb：**macOS vibrancy 与 Windows Mica 的真机合成未在本轮复验**。
  探针验的是 Chromium 层的"透明合成面 + `backdrop-filter` + 背板"机制，与平台原生材质
  解耦；仍建议发布前在两种真机上各截一张菜单图。
- 同类风险面：其它直接读 `--dsw-specific-menu` 的半透明浮层（会话停靠面板、定时任务
  菜单等）。它们大多位于不透明的会话列，且不在 2.8.2 的现场路径上；若后续出现在左栏，
  同一背板机制需要扩展。
- 上游 `html[data-platform]` 契约缺口仍在（见 §三最后一条），由后续独立的平台外观裁决处理。
