import { afterEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { BrandName, BraceMark } from '../src/client/Brand.tsx'
import { AboutSection, OverlayBadge, applyBrandTheme } from '../src/client/brand-shell.tsx'
import { BRAND_MARK_SVG } from '../src/client/channel-geometry.ts'

/** Props the brand components actually carry (children text, inline styles, injected SVG). */
type BrandElement = ReactElement<{
  children?: ReactNode
  style?: Record<string, unknown>
  dangerouslySetInnerHTML?: { __html?: string }
}>

/**
 * 2026-09-17 S08-04 审计：本包没有 react-dom / test renderer 依赖（也不能为一个
 * 断言去动根 yarn.lock），所以"渲染"= 调用**真实组件函数**并遍历它返回的元素树
 * —— 与本文件其余用例同一写法。版本标签的三个被测点（`version` 判空守卫、
 * `v${version}` 前缀、成对 token 样式）都落在返回的 props 上，因此这三处任一被
 * 改坏都会让下面的断言变红（旧用例只对自己造的节点做断言 + 对
 * `BrandName.toString()` 做子串 grep，改坏任何一处都仍然全绿）。
 */
function elementsOf(node: ReactNode, out: BrandElement[] = []): BrandElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child as ReactNode, out)
    return out
  }
  if (!isValidElement(node)) return out
  const element = node as BrandElement
  out.push(element)
  return elementsOf(element.props.children, out)
}

/** The authoritative mark-only SVG injected by the brand mark (never re-drawn here). */
function glyphHtmlOf(node: ReactNode): string {
  for (const element of elementsOf(node)) {
    const html = element.props.dangerouslySetInnerHTML?.__html
    if (typeof html === 'string' && html.includes('<svg')) return html
  }
  throw new Error('brand mark must inject the authoritative mark-only SVG')
}

function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(child => textOf(child as ReactNode)).join('')
  if (isValidElement(node)) return textOf((node as BrandElement).props.children)
  return node === null || node === undefined || typeof node === 'boolean' ? '' : String(node)
}

describe('branding BrandName version label', () => {
  const VERSION_KEY = 'ZEOKEEL_PRODUCT_VERSION'
  // 生产环境里由构建期 define 注入；vitest 跑的是源码，所以直接改 process.env。
  const previous = process.env[VERSION_KEY]

  afterEach(() => {
    if (previous === undefined) delete process.env[VERSION_KEY]
    else process.env[VERSION_KEY] = previous
  })

  it('renders the v-prefixed version pill with the inverted brand tokens', () => {
    process.env[VERSION_KEY] = '1.2.3'
    const tree = BrandName()
    expect(textOf(tree)).toBe('ZeoKeelv1.2.3')
    const pill = elementsOf(tree).find(element => element.props.children === 'v1.2.3')
    expect(pill, 'the version pill must be rendered next to the product name').toBeDefined()
    // 胶囊取反色墨：`--dsw-alias-label-primary` / `-inverted` 是上游成对存在的
    // token；被替换掉的 `--dsw-alias-fg-primary` / `--dsw-alias-bg-base` 上游
    // 根本没有 ⇒ 暗色下黑底黑字。
    expect(pill!.props.style).toMatchObject({
      color: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
      backgroundColor: 'var(--dsw-alias-label-primary, #000000)',
    })
  })

  it('omits the version pill when ZEOKEEL_PRODUCT_VERSION is unset or empty', () => {
    delete process.env[VERSION_KEY]
    expect(textOf(BrandName())).toBe('ZeoKeel')
    // 构建期 define 也可能注入空串：空版本号不得渲染出一个孤零零的 "v"。
    process.env[VERSION_KEY] = ''
    expect(textOf(BrandName())).toBe('ZeoKeel')
    expect(elementsOf(BrandName()).filter(element => element.props.children === 'v')).toEqual([])
  })

  it('renders the mark-only artwork: transparent, full colour, no token inversion', () => {
    const tree = BraceMark({ size: 20 })
    // 槽位容器只负责尺寸与裁剪：没有底色、没有前景色（mark 自带 6 个渐变，
    // 用 token / currentColor 染色就等于制造第三色变体）。
    expect(tree.props.style).toMatchObject({ width: 20, height: 20 })
    expect(tree.props.style).not.toHaveProperty('backgroundColor')
    expect(tree.props.style).not.toHaveProperty('color')
    // 注入的就是权威常量本身（不是在这里重画几何）。
    const html = glyphHtmlOf(tree)
    expect(html).toBe(BRAND_MARK_SVG)
    expect(html.match(/<linearGradient\b/gu)).toHaveLength(6)
    expect(html).toContain('url(#id0)')
    // mark-only = 去掉 tile rect 的 logo.svg：透明底，且无 currentColor。
    expect(html).not.toContain('<rect')
    expect(html).not.toContain('currentColor')
    // 1254 画布按槽位尺寸缩放（保留文件原始 width/height 属性）。
    const scaled = elementsOf(tree).find(element =>
      typeof element.props.style?.transform === 'string'
      && String(element.props.style.transform).includes('scale('))
    expect(scaled, 'the injected 1254 canvas must be scaled to the slot size').toBeDefined()
    expect(String(scaled!.props.style?.transform)).toContain(String(20 / 1254))
  })
})

describe('branding brand shell surfaces (merged from @zeokeel/dsh-shell)', () => {
  it('OverlayBadge renders the product name', () => {
    const node = OverlayBadge()
    const texts = JSON.stringify(node.props.children)
    expect(texts).toContain('ZeoKeel Harness')
  })

  it('AboutSection renders the product name and package identity', () => {
    const node = AboutSection()
    const texts = JSON.stringify(node.props.children)
    expect(texts).toContain('ZeoKeel Harness')
    expect(texts).toContain('@zeokeel/dsh-branding')
  })

  it('applyBrandTheme calls theme.overrideTokens with the brand layer', () => {
    const overrideTokens = vi.fn(() => () => {})
    const ctx = { get: vi.fn(() => ({ overrideTokens })) }
    applyBrandTheme(ctx)
    expect(ctx.get).toHaveBeenCalledWith('theme')
    expect(overrideTokens).toHaveBeenCalledWith('zeokeel-brand', {
      '--dsw-alias-brand-primary': { light: '#0e8a6a', dark: '#34c79c' },
    })
  })

  it('applyBrandTheme degrades gracefully when the theme service is absent', () => {
    const ctx = { get: vi.fn(() => undefined) }
    expect(() => applyBrandTheme(ctx)).not.toThrow()
  })
})
