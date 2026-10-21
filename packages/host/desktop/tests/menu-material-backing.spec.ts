/**
 * 菜单卡片"页面变透明"的回归护栏（2026-10-18 现场反馈，2.8.2 正式版）。
 *
 * 现象：打开侧栏「视图选项」等菜单时，卡片像一层透明膜 —— 下面的会话列表/桌面
 * 直接透上来（用户描述"页面变透明"）。
 *
 * 机制（真机 AB 见同目录 `menu-backing-computed-probe.mjs`）：
 *  - 上游 MenuSurface 的材质是 `--dsw-menu-surface-fill`（亮色 alpha .58 / 暗色 .45）
 *    + `backdrop-filter: var(--dsw-menu-backdrop-filter)`；
 *  - `backdrop-filter` 只采样**页面自身**的绘制结果，而我们的窗口刻意让出原生材质
 *    （darwin `transparent` + vibrancy，win32 `backgroundColor:#00000000` + mica），
 *    左栏 surface 也是 transparent。透明合成面上没有实底时 Chromium 不再产出模糊，
 *    卡片只剩半透明填充；
 *  - 上游为此在 MenuSurface 里额外 portal 一个 `[data-menu-backing]`（bg-base 实底、
 *    `z-index:-1`，页面内容之下、原生材质之上），但它的 CSS **只在
 *    `html[data-platform='darwin']` 打开** —— 那是上游 Electron preload 打的标记，
 *    我们的壳用 `data-dsh-desktop-mode` / `data-dsh-desktop-platform` 标记自己，
 *    所以这条兜底从未生效。
 *
 * 本组判据钉住五件事：
 *  1. 我们的样式表按 desktop 自己的模式标记打开同一个背板，且**不**限定 darwin
 *     （win32 的 mica 与 darwin 的 vibrancy 是同一条链路）；
 *  2. 背板是 bg-base 实底（两套主题 alpha=1），位置用上游同款 CSS anchor 跟随菜单；
 *  3. 上游机制仍在：MenuSurface 真的 portal `[data-menu-backing]`、CSS 默认隐藏、
 *     只有 darwin 打开、底色同为 bg-base —— 上游换机制时这里变红而不是静默失效；
 *  4. 前提仍成立：菜单材质仍是"半透明 + backdrop-filter"，窗口仍透明/原生材质，
 *     左栏仍 transparent（前提消失时，"修的是什么"要重新评估）；
 *  5. 反假绿：删掉我们的规则，解析必须抛错（不是空转通过）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import type { DesktopShellSpec } from '../src/runtime.ts'
import { installAdvancedStyles } from '../src/client/styles.ts'
import { advancedWindowOptions } from '../src/window-options.ts'

/** 桌面包根（`tests/` 的上一级）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 仓库根（`tests/` 往上三层）。 */
const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** 上游调色板（token 真源）。 */
const PLATFORM_CSS = join(
  WORKSPACE_ROOT, 'deepseek-harness', 'packages', 'client', 'ui-theme', 'src', 'styles', 'design-platform.css',
)
/** 上游 elevation / backdrop-filter token。 */
const SHADOW_CSS = join(
  WORKSPACE_ROOT, 'deepseek-harness', 'packages', 'client', 'ui-theme', 'src', 'styles', 'gradient-shadow-text.css',
)
/** 上游菜单材质的 CSS-module 源（随包安装的产物，与 CI 安装的是同一份）。 */
const MENU_CSS = join(
  PACKAGE_ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'MenuSurface.module.css',
)
/** 上游菜单实现（证明 `[data-menu-backing]` 真的被 portal 到 body）。 */
const MENU_JS = join(
  PACKAGE_ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js',
)

/** 修复规则：只用我们自己的稳定 attribute，不写上游哈希类名。 */
const BACKING_SELECTOR = 'body[data-dsh-desktop-mode="advanced"] [data-menu-backing]'
/** 触发背板的上游 attribute（MenuSurface 固定渲染它）。 */
const BACKING_ATTRIBUTE = '[data-menu-backing]'

/** 真实上游样式表（去注释：注释里的 `--x:` 会污染 token 解析）。 */
const platformCss = readFileSync(PLATFORM_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
const shadowCss = readFileSync(SHADOW_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
const menuCss = readFileSync(MENU_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
const menuJs = readFileSync(MENU_JS, 'utf8')

/** 取高级外壳样式表文本（与 `client-environment.spec.ts` / 模态护栏相同的 document 替身姿势）。 */
function advancedStyles(): string {
  let css = ''
  const style = {
    dataset: {} as Record<string, string>,
    get textContent() { return css },
    set textContent(value: string) { css = value },
    remove: (): void => {},
  }
  vi.stubGlobal('document', { createElement: () => style, head: { appendChild: (): void => {} } })
  try {
    installAdvancedStyles()()
  }
  finally {
    vi.unstubAllGlobals()
  }
  return css.replace(/\/\*[\s\S]*?\*\//gu, '')
}

/** 取出一个规则的原文（`selector` 不含 `{`；选择器与 `{` 之间只允许空白）。 */
function ruleText(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing rule: ${selector}`)
  const open = css.indexOf('{', start + selector.length)
  if (open < 0 || !/^\s*$/u.test(css.slice(start + selector.length, open))) {
    throw new Error(`ambiguous rule: ${selector}`)
  }
  const close = css.indexOf('}', open)
  return css.slice(start, close + 1)
}

/** 取出一个规则的声明体。 */
function declarationBlock(css: string, selector: string): string {
  const text = ruleText(css, selector)
  return text.slice(text.indexOf('{') + 1, -1)
}

/** 取一条声明的值。 */
function declaration(block: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'u').exec(block)
  if (match === null) throw new Error(`missing declaration: ${property}`)
  return match[1]!.trim()
}

/**
 * 取"独立成条"的规则（行首就是该选择器）。
 *
 * 同一个选择器还会出现在选择器列表里（如 `.surface,\n.backing { border-radius }`），
 * 裸串会先命中那里；行首锚定 + `lastIndexOf` 只命中后面那条独立规则。
 */
function standaloneRule(css: string, selector: string): string {
  const at = css.lastIndexOf(`\n${selector} {`)
  if (at < 0) throw new Error(`missing standalone rule: ${selector}`)
  return declarationBlock(css.slice(at + 1), selector)
}

/** design-platform.css 的块级 token 表；暗色表以亮色表为底再被暗色块覆盖。 */
function palettes(css: string): { light: Map<string, string>, dark: Map<string, string> } {
  const light = new Map<string, string>()
  const dark = new Map<string, string>()
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const target = block[1]!.includes('data-ds-dark-theme') ? dark : light
    for (const token of block[2]!.matchAll(/(--dsw-[a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
      target.set(token[1]!, token[2]!.trim())
    }
  }
  return { light, dark: new Map([...light, ...dark]) }
}

/** 递归解引用 `var(--x)`（token 不存在时取 var() 的 fallback）。 */
function resolveToken(tokens: Map<string, string>, name: string, depth = 0): string | undefined {
  if (depth > 8) return undefined
  const value = tokens.get(name)
  if (value === undefined) return undefined
  const nested = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/u.exec(value)
  if (nested === null) return value
  return resolveToken(tokens, nested[1]!, depth + 1) ?? nested[2]?.trim()
}

/** 把一个声明值解析成具体颜色（字面量原样返回）。 */
function resolveValue(tokens: Map<string, string>, declared: string): string {
  const token = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)$/u.exec(declared)
  if (token === null) return declared
  return resolveToken(tokens, token[1]!) ?? token[2]?.trim() ?? declared
}

/** 颜色 alpha：只认上游调色板会出现的形态，其它一律抛（避免解析失败被当成"通过"）。 */
function alpha(value: string): number {
  const text = value.trim().toLowerCase()
  if (text === 'transparent') return 0
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text)
  if (hex !== null) {
    const digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) {
      return digits.length === 4 ? Number.parseInt(digits[3]! + digits[3]!, 16) / 255 : 1
    }
    if (digits.length === 6) return 1
    if (digits.length === 8) return Number.parseInt(digits.slice(6), 16) / 255
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/u.exec(text)
  if (fn !== null) return fn[4] === undefined ? 1 : Number(fn[4])
  throw new Error(`unsupported color: ${value}`)
}

/** 窗口构造参数的前提（官方 spec，供 "窗口仍为原生材质让路" 判据使用）。 */
const shellSpec: DesktopShellSpec = {
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/',
  productName: 'ZeoKeel Harness',
  windowTitle: 'ZeoKeel Harness',
  iconPath: '/tmp/app-icon.png',
  trayIcons: {
    templatePath: '/tmp/tray-iconTemplate.png',
    bluePath: '/tmp/tray-icon-blue.png',
  },
  readLocalePreference: () => undefined,
  readThemeSource: () => 'system',
  requestQuit: () => {},
}

describe('menu material backing over native window materials (2.8.2 transparency report)', () => {
  const css = advancedStyles()
  const { light, dark } = palettes(platformCss)

  it('enables the upstream menu backing for every desktop platform, not only darwin', () => {
    // 选择器绝不能带 darwin / data-platform：win32 的 mica 是同一个透明窗口路径，
    // 只修 macOS 等于把用户报告的平台（Windows）留在原地。
    expect(BACKING_SELECTOR).not.toContain('darwin')
    expect(css).not.toMatch(/\[class[$^*]=/u)
    const block = declarationBlock(css, BACKING_SELECTOR)
    expect(declaration(block, 'display')).toBe('block')
    expect(declaration(block, 'position')).toBe('fixed')
    // 与菜单 surface 的 anchor-name 同名；四件套缺一项背板就不跟随菜单。
    expect(declaration(block, 'position-anchor')).toBe('var(--dsh-menu-anchor)')
    expect(declaration(block, 'top')).toBe('anchor(top)')
    expect(declaration(block, 'left')).toBe('anchor(left)')
    expect(declaration(block, 'width')).toBe('anchor-size(width, 0px)')
    expect(declaration(block, 'height')).toBe('anchor-size(height, 0px)')
    // 背板在页面内容之下、原生材质之上；不许吃指针事件。
    expect(declaration(block, 'z-index')).toBe('-1')
    expect(declaration(block, 'pointer-events')).toBe('none')
  })

  it('paints the backing with the opaque base surface in both themes', () => {
    const block = declarationBlock(css, BACKING_SELECTOR)
    const background = declaration(block, 'background')
    expect(background).toBe('var(--dsw-alias-bg-base)')
    for (const theme of [light, dark]) {
      expect(alpha(resolveValue(theme, background))).toBe(1)
    }
    // 反假绿：两套主题解引用必须不同（解析失败会得到同一个字面量）。
    expect(resolveValue(light, background)).not.toBe(resolveValue(dark, background))
  })

  it('targets the exact attribute upstream renders, and upstream still portals it to body', () => {
    expect(BACKING_ATTRIBUTE).toBe('[data-menu-backing]')
    // MenuSurface 的 JSX 固定带 `data-menu-backing`，且 useLayoutEffect 把它挂到 body：
    // 我们只用 CSS 开显示，不改上游实现。上游若改成别的承载方式，这里先红。
    expect(menuJs).toContain('"data-menu-backing": ""')
    expect(menuJs).toContain('document.body.appendChild(backingRef.current)')
  })

  it('keeps the upstream backing hidden by default and darwin-gated (our rule adds the missing platforms)', () => {
    // 上游默认 `display:none`；只有 darwin 打开。这正是"我们的壳不打 data-platform，
    // 于是兜底从未生效"的 mechanical 证据。
    const hidden = standaloneRule(menuCss, '.backing')
    expect(declaration(hidden, 'display')).toBe('none')
    const darwin = declarationBlock(menuCss, "html[data-platform='darwin']) .backing")
    expect(declaration(darwin, 'display')).toBe('block')
    expect(declaration(darwin, 'background')).toBe('var(--dsw-alias-bg-base)')
    // 上游的启用条件里必须仍是 data-platform=darwin（我们无法依赖它覆盖 win32/linux）。
    expect(menuCss).toContain("html[data-platform='darwin']")
  })

  it('pins the premise: the menu material is still translucent + backdrop-filtered', () => {
    const material = standaloneRule(menuCss, '.material')
    expect(declaration(material, 'background')).toBe('var(--dsw-menu-surface-fill)')
    expect(declaration(material, 'backdrop-filter')).toBe('var(--dsw-menu-backdrop-filter)')
    expect(declaration(material, 'z-index')).toBe('-1')
    // token 必须仍是半透明：换成实底后这条修复就失去意义（也说明菜单设计变了）。
    for (const theme of [light, dark]) {
      const fill = resolveValue(theme, 'var(--dsw-menu-surface-fill)')
      expect(alpha(fill)).toBeGreaterThan(0)
      expect(alpha(fill)).toBeLessThan(1)
    }
    // 模糊 token 仍是真 blur（上游哪天关掉模糊，菜单变实底，评估要重来）。
    expect(shadowCss).toMatch(/--dsw-menu-backdrop-filter:\s*blur\(/u)
    // 关键：darwin 的 --dsw-specific-menu 实底覆盖**不**作用于 MenuSurface；
    // MenuSurface 读 --dsw-menu-surface-fill ⇒ 没有背板时菜单在任何平台都半透明。
    expect(menuCss).not.toContain('--dsw-specific-menu')
  })

  it('pins the premise: the window still yields to native material and the sidebar is still transparent', () => {
    const darwin = advancedWindowOptions(shellSpec, {} as NativeImage, 'darwin')
    expect(darwin).toEqual(expect.objectContaining({
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
    }))
    const win32 = advancedWindowOptions(shellSpec, {} as NativeImage, 'win32')
    expect(win32).toEqual(expect.objectContaining({
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',
    }))
    const sidebar = declarationBlock(css, '.dshDesktopSidebarSurface')
    expect(alpha(resolveValue(light, declaration(sidebar, 'background')))).toBe(0)
    expect(declaration(sidebar, '--dsw-specific-sidebar-fill')).toBe('transparent')
  })

  it('the extractor is not vacuous: deleting the rule throws here', () => {
    const without = css.replace(ruleText(css, BACKING_SELECTOR), '')
    expect(without).not.toBe(css)
    expect(() => declarationBlock(without, BACKING_SELECTOR)).toThrow(/missing rule/u)
  })
})
