import { createElement } from 'react'
import { BRAND_MARK_SVG, BRAND_TILE_SIZE } from './channel-geometry.ts'

// build-time 版本注入(tsdown define 替换为字符串字面量);浏览器编译面无
// node types,声明最小面的 process 占位。
declare const process: { env: { ZEOKEEL_PRODUCT_VERSION?: string } }

/**
 * 品牌 mark（仅图形、透明底、**自带完整彩色渐变**）。
 *
 * 2026-10-21 品牌真源换成 `brands/official/logo.svg` 的渐变波形 mark 后，这里的
 * 图形不再是"用 token 反色的花括号"，而是直接注入权威 `logo.svg` 去掉方块
 * `<rect>` 后的原样字符串（见 `channel-geometry.ts`）：mark 自带 `linearGradient`
 * 填充，**绝不能**再用 `currentColor` / 设计 token 染色（染了就是第三色变体）。
 *
 * 注入的是 1254×1254 的画布（保留文件原有的 width/height 属性，drift 测试要求
 * mark-only 常量逐字等于 logo.svg 去掉 `<rect>`），因此外面套一层按槽位尺寸缩放
 * 的绝对定位容器：外层固定 `size` 并裁剪，内层按 `size / 1254` 缩放。
 */
function BrandMarkGlyph({ size }: { size: number }) {
  return createElement('span', {
    'aria-hidden': true,
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: BRAND_TILE_SIZE,
      height: BRAND_TILE_SIZE,
      lineHeight: 0,
      transform: `scale(${String(size / BRAND_TILE_SIZE)})`,
      transformOrigin: 'top left',
    },
    dangerouslySetInnerHTML: { __html: BRAND_MARK_SVG },
  })
}

/**
 * Brand mark at the upstream brand slots (`sidebar.brand.mark`,
 * `conversation.hero.brand.mark`): the authoritative full-colour mark only, on
 * a transparent background so it reads on both light and dark surfaces.
 *
 * NOTE: this component is intentionally duplicated from
 * `packages/host/enterprise/src/client/Channel.tsx` (same artwork, same
 * authority): the web profile deploys this package standalone and cross-package
 * client imports are disallowed by the plugin convention. Keep both in sync.
 */
export function BraceMark({ size, className }: { size: number; className?: string | undefined }) {
  return createElement(
    'span',
    {
      className,
      style: {
        display: 'inline-flex',
        flex: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        width: size,
        height: size,
      },
    },
    BrandMarkGlyph({ size }),
  )
}

/**
 * Sidebar brand name occupant. The upstream brand-name container owns
 * typography; this component supplies only the product name text, plus a
 * small product-version label next to it (build-time injected via
 * `process.env.ZEOKEEL_PRODUCT_VERSION` define in tsdown.config.ts).
 */
export function BrandName() {
  const version = process.env.ZEOKEEL_PRODUCT_VERSION as string | undefined
  return createElement(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 700, letterSpacing: '0.3px' } },
    'ZeoKeel',
    version != null && version !== ''
      ? createElement('span', {
          style: {
            fontSize: 10,
            fontWeight: 600,
            lineHeight: 1,
            letterSpacing: '0',
            padding: '2px 5px',
            borderRadius: '4px',
            // 版本号胶囊 = 反色（亮：黑底白字 / 暗：白底黑字）。与 enterprise 的
            // Channel.tsx 同款；`--dsw-alias-fg-primary` 上游不存在 ⇒ 原先暗色下黑底黑字。
            color: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
            backgroundColor: 'var(--dsw-alias-label-primary, #000000)',
            opacity: 0.75,
          },
        }, `v${version}`)
      : null,
  )
}
