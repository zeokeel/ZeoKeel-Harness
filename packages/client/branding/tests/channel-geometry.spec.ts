/**
 * Brand-asset drift guard.
 *
 * `src/client/channel-geometry.ts` is the ONLY place the client surfaces read the
 * authoritative artwork from. The constants must stay verbatim copies of the
 * single authority (`brands/official/logo.svg` / `logo-dark.svg`; mark-only =
 * the day logo minus its tile `<rect>`), so a change to the brand folder cannot
 * leave the shipped surfaces drawing stale artwork.
 *
 * 2026-10-21: the retired brace/connector mark was replaced by the gradient wave
 * mark, so the old assertions (brace paths / stroke-width 40 / 1.25× transform /
 * dual-colour `currentColor` inversion) are gone. What is pinned now:
 *  - the day and dark full logos are the checked-in files verbatim;
 *  - the mark-only string is exactly the day logo with the tile `<rect>` removed
 *    (transparent, no tile fill, no `<rect>`);
 *  - the mark keeps its own colour (six gradients + a solid cyan path), i.e. it is
 *    never flattened to `currentColor` / a single fill;
 *  - day and dark differ ONLY in the tile fill.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BRAND_MARK_SVG,
  BRAND_MARK_VIEWBOX,
  BRAND_TILE_RADIUS,
  BRAND_TILE_SIZE,
  BRAND_TILE_SVG,
  BRAND_TILE_SVG_DARK,
  BRAND_TILE_VIEWBOX,
  brandMarkSvg,
  brandTileSvg,
  brandTileSvgDark,
} from '../src/client/channel-geometry.ts'

const REPO_ROOT = new URL('../../../..', import.meta.url)
const daySvg = readFileSync(new URL('brands/official/logo.svg', REPO_ROOT), 'utf8')
const darkSvg = readFileSync(new URL('brands/official/logo-dark.svg', REPO_ROOT), 'utf8')

/** Whitespace-insensitive comparison (the constants keep the file's line layout). */
const norm = (value: string): string => value.replace(/\s+/gu, ' ').trim()

/** The tile `<rect>` line — the only element the mark-only artwork drops. */
const TILE_RECT_LINE = /^[ \t]*<rect\b[^>]*\/>[ \t]*\r?\n/mu

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`, 'u').exec(tag)?.[1]
}

/** Rewrite the tile `<rect>` fill so day and dark compare identical elsewhere. */
const withTileFillNormalised = (svg: string): string =>
  svg.replace(/(<rect\b[^>]*\bfill=")[^"]*(")/u, '$1#TILE$2')

describe('brand artwork derives from brands/official/', () => {
  it('inlines the checked-in day logo verbatim (whitespace-insensitive)', () => {
    expect(norm(BRAND_TILE_SVG)).toBe(norm(daySvg))
    expect(norm(brandTileSvg())).toBe(norm(daySvg))
  })

  it('inlines the checked-in dark logo verbatim (whitespace-insensitive)', () => {
    expect(norm(BRAND_TILE_SVG_DARK)).toBe(norm(darkSvg))
    expect(norm(brandTileSvgDark())).toBe(norm(darkSvg))
  })

  it('mark-only constant is exactly the day logo with its tile <rect> removed', () => {
    expect(norm(BRAND_MARK_SVG)).toBe(norm(daySvg.replace(TILE_RECT_LINE, '')))
    expect(norm(brandMarkSvg())).toBe(norm(BRAND_MARK_SVG))
  })

  it('mark-only artwork is transparent: no tile rect and no tile fill', () => {
    expect(BRAND_MARK_SVG).not.toMatch(/<rect\b/u)
    expect(BRAND_MARK_SVG).not.toContain('fill="#FFFFFF"')
    expect(BRAND_MARK_SVG).not.toContain('fill="#000000"')
    expect(BRAND_MARK_SVG).not.toContain('background')
  })

  it('mark keeps its own colour: six gradients + a solid fill, never currentColor', () => {
    expect(BRAND_MARK_SVG.match(/<linearGradient\b/gu)).toHaveLength(6)
    const fills = [...BRAND_MARK_SVG.matchAll(/fill="([^"]+)"/gu)].map(match => match[1]!)
    const gradientRefs = fills.filter(fill => fill.startsWith('url(#')).length
    expect(gradientRefs).toBeGreaterThanOrEqual(4)
    expect(new Set(fills).size).toBeGreaterThanOrEqual(3)
    expect(BRAND_MARK_SVG).toContain('#37E7FE')
    expect(BRAND_MARK_SVG).not.toContain('currentColor')
    // Every referenced gradient id is defined inside the string (self-contained).
    const defined = new Set([...BRAND_MARK_SVG.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]!))
    for (const match of BRAND_MARK_SVG.matchAll(/url\(#([^)]+)\)/gu)) {
      expect(defined.has(match[1]!)).toBe(true)
    }
  })

  it('day and dark logos differ only in the tile fill (same mark colours)', () => {
    expect(norm(withTileFillNormalised(darkSvg))).toBe(norm(withTileFillNormalised(daySvg)))
    expect(daySvg).toContain('fill="#FFFFFF"')
    expect(darkSvg).toContain('fill="#000000"')
    expect(norm(darkSvg.replace(TILE_RECT_LINE, ''))).toBe(norm(daySvg.replace(TILE_RECT_LINE, '')))
  })

  it('carries the approved gradient mark transform (not the retired 1.25× braces)', () => {
    expect(BRAND_MARK_SVG).toContain('scale(0.10709006)')
    expect(BRAND_MARK_SVG).toContain('translate(627.00 627.00)')
    expect(BRAND_MARK_SVG).toContain('translate(-5943.7880 -4987.8288)')
    expect(BRAND_MARK_SVG).not.toContain('scale(1.25)')
    expect(BRAND_TILE_SVG).toContain('scale(0.10709006)')
  })

  it('viewBox, tile size and corner radius match the authoritative artwork', () => {
    const rect = /<rect\b[^>]*\/>/u.exec(daySvg)?.[0] ?? ''
    expect(Number(attr(rect, 'width'))).toBe(BRAND_TILE_SIZE)
    expect(Number(attr(rect, 'height'))).toBe(BRAND_TILE_SIZE)
    expect(Number(attr(rect, 'rx'))).toBe(BRAND_TILE_RADIUS)
    expect(BRAND_TILE_VIEWBOX).toBe(`0 0 ${String(BRAND_TILE_SIZE)} ${String(BRAND_TILE_SIZE)}`)
    expect(BRAND_MARK_VIEWBOX).toBe(BRAND_TILE_VIEWBOX)
  })
})
