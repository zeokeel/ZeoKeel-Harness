import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slot runtime props into this compilation face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the layout-owned `sidebar` row and the brand slot
// contracts into SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: declares the conversation hero brand-mark slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: declares the settings-page `settings.section` slot contract
// (the About section occupant).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BraceMark, BrandName } from './Brand.tsx'
import { AboutSection, OverlayBadge, applyBrandTheme, injectBrandShellStyles } from './brand-shell.tsx'
import { brandTileSvg } from './channel-geometry.ts'
import { setActiveLocale, t } from './locales.ts'

/** Stable Cordis plugin name for the branding client half. */
export const name = 'zeokeel-branding-client'

/** Services required: the slot registry for the brand holes, plus the theme runtime. */
export const inject = ['slots', 'theme', 'locale']

/**
 * Browser favicon artwork: the full **day tile** from the single brand
 * authority (`brands/official/logo.svg` — white rounded square + full-colour
 * gradient mark), inlined as a data URI so no server static override is
 * needed — the upstream `/favicon.svg` (DeepSeek fish) is served by
 * dsh-web-frontend and cannot be patched from this profile layer.
 *
 * 2026-10-21：favicon 用**完整日间 tile**（不是 mark-only）—— 浏览器标签页背景
 * 不受页面主题影响，透明 mark 在浅色标签栏里会掉色；tile 由 `logo.svg` 原样提供。
 */
const FAVICON_SVG = brandTileSvg()

/**
 * Replace every `<link rel=icon>` href with the day brand tile.
 *
 * 2026-09-12：原先那段"改 manifest 的 icons[].src"是**死代码**（改的是
 * `fetch()` 解析出来的副本，浏览器读的是它自己那次请求；改完既不写回也没人消费），
 * 已删除。桌面端的 `/favicon.svg` 与 `/manifest.webmanifest` 现在由 host 的 exact
 * 路由覆盖（`packages/host/desktop/src/brand-web-route.ts`）；纯 web 形态
 * （`dsh web`，非交付形态）仍会拿到上游 dist 的 manifest —— 那是上游前端包的分发
 * 内容，本包无权覆盖，这里也不假装能覆盖。
 */
function installFavicon(): void {
  const href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    link.href = href
  }
}

/**
 * Register the ZeoKeel brand surfaces for the web UI: the brand mark at the
 * upstream brand slots (sidebar mark/name, hero mark) and the browser
 * favicon. These slots are single/root and unoccupied in the web
 * composition (the official brand package is not present), so these
 * registrations are the only occupants.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  // The About copy is locale-aware. Dictionaries read a module-local value, so
  // follow the service here (every slot outlet re-renders on a switch, which
  // re-evaluates `t()` at the new language).
  ctx.effect(() => {
    const locale = ctx.locale as unknown as {
      getLocale?: () => { active?: unknown }
      subscribe?: (listener: () => void) => () => void
    }
    const sync = (): void => {
      try {
        const active = locale.getLocale?.()?.active
        if (typeof active === 'string') setActiveLocale(active)
      } catch { /* keep the last known locale */ }
    }
    sync()
    if (typeof locale.subscribe !== 'function') return () => {}
    return locale.subscribe(sync)
  }, 'zeokeel-branding: follow active locale')
  ctx.effect(
    () => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
      name: 'sidebar.brand.mark',
    }, BraceMark)),
    'zeokeel-branding: sidebar brand mark',
  )
  ctx.effect(
    () => ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
      name: 'sidebar.brand.name',
    }, BrandName)),
    'zeokeel-branding: sidebar brand name',
  )
  ctx.effect(
    () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
      name: 'conversation.hero.brand.mark',
    }, BraceMark)),
    'zeokeel-branding: hero brand mark',
  )

  ctx.effect(() => {
    installFavicon()
    return () => { /* favicon reverts on the next navigation */ }
  }, 'zeokeel-branding: favicon')

  // --- Brand shell surfaces (merged from the retired @zeokeel/dsh-shell) ---

  ctx.effect(() => {
    injectBrandShellStyles()
    // The theme layer disposer teardowns the token override on disposal.
    return applyBrandTheme(ctx) ?? (() => {})
  }, 'zeokeel-branding: shell styles + theme tokens')

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'zeokeel-badge',
    }, OverlayBadge)),
    'zeokeel-branding: overlay badge',
  )

  ctx.effect(
    () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'zeokeel-about',
      order: 900,
      // A thunk, like the sibling sections: the settings shell re-evaluates it
      // per render, so the nav row follows the language (a static string kept
      // the English label in a Chinese UI — 2026-09-16 R9 audit).
      label: () => t('about.sectionLabel'),
    }, AboutSection)),
    'zeokeel-branding: about section',
  )
}
