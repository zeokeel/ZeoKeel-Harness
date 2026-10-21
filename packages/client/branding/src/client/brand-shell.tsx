import { createElement } from 'react'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { t } from './locales.ts'

// build-time 版本注入(tsdown define 替换为字符串字面量);浏览器编译面无
// node types,声明最小面的 process 占位。
declare const process: { env: { ZEOKEEL_PRODUCT_VERSION?: string } }

/**
 * Brand shell surfaces for the web UI, merged from the predecessor
 * `@zeokeel/dsh-shell` package (v0.1.1, now retired and rebuilt in-repo):
 * brand theme token override, floating overlay badge, and the About
 * settings section. Everything injects through official client plugin slots
 * (`shell.overlay`, `settings.section`) — no forked upstream code.
 *
 * The predecessor package had no source of truth in this repository; its
 * built `lib/client.js` was reverse-read back into `brand-shell.tsx` so the
 * functionality is migratable going forward (see the 0.1.2 upstream upgrade
 * assessment, §6.4).
 */

/** Theme token override id (matches the old shell's `zeokeel-brand` layer). */
const BRAND_THEME_LAYER = 'zeokeel-brand'

/** Brand-primary tokens, light/dark per the official dual-color rule. */
const BRAND_THEME_TOKENS = {
  '--dsw-alias-brand-primary': { light: '#0e8a6a', dark: '#34c79c' },
}

/**
 * Locally asserted theme service face (the runtime service is provided by
 * the `theme` service from `dsh-client-ui-theme/client`; keep the optional
 * call so an absence degrades gracefully).
 */
type ThemeOverrideFace = Pick<ThemeRuntime, 'overrideTokens'> | undefined

/** Overlay badge + About styling (ported from the old shell's style literal). */
const BRAND_SHELL_CSS = `.zeokeel-badge {
  position: fixed;
  right: 18px;
  bottom: 18px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #0e8a6a) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #0e8a6a) 40%, transparent);
  color: var(--dsw-alias-brand-primary, #0e8a6a);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  pointer-events: auto;
  user-select: none;
}

.zeokeel-badge-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #0e8a6a);
  animation: zeokeel-pulse 2.4s ease-in-out infinite;
}

@keyframes zeokeel-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.zeokeel-about {
  max-width: 520px;
  padding: 4px 0;
}

.zeokeel-about h2 {
  margin: 0 0 8px;
  font-size: 16px;
}

.zeokeel-about p {
  margin: 0 0 12px;
  line-height: 1.6;
  opacity: 0.85;
}

.zeokeel-about dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0;
  font-size: 13px;
}

.zeokeel-about dt {
  font-weight: 600;
  opacity: 0.7;
}

.zeokeel-about dd {
  margin: 0;
  opacity: 0.9;
}
`

const PACKAGE = '@zeokeel/dsh-branding'

/** Inject the shell CSS once per document (idempotent per plugin name). */
export function injectBrandShellStyles(): void {
  if (document.querySelector(`style[data-plugin="${PACKAGE}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PACKAGE
  tag.textContent = BRAND_SHELL_CSS
  document.head.appendChild(tag)
}

/** Override the brand-primary design tokens through the theme runtime. */
export function applyBrandTheme(ctx: { get: (name: string) => unknown }): (() => void) | undefined {
  const theme = ctx.get('theme') as ThemeOverrideFace
  try {
    return theme?.overrideTokens?.(BRAND_THEME_LAYER, BRAND_THEME_TOKENS)
  } catch (error) {
    console.warn('[zeokeel] theme override failed', error)
    return undefined
  }
}

/** Floating brand badge occupant of the root `shell.overlay` slot. */
export function OverlayBadge() {
  return createElement(
    'div',
    { className: 'zeokeel-badge' },
    createElement('span', { className: 'zeokeel-badge-dot', 'aria-hidden': true }),
    createElement('span', null, 'ZeoKeel Harness'),
  )
}

/** About section occupant of the settings page `settings.section` slot. */
export function AboutSection() {
  const version = process.env.ZEOKEEL_PRODUCT_VERSION as string | undefined
  return createElement(
    'div',
    { className: 'zeokeel-about' },
    createElement('h2', null, 'ZeoKeel Harness'),
    createElement('p', null, t('about.description')),
    createElement(
      'dl',
      null,
      createElement('dt', null, t('about.brandPlugin')),
      createElement('dd', null, PACKAGE),
      createElement('dt', null, t('about.productVersion')),
      createElement('dd', null, version != null && version !== '' ? `v${version}` : '—'),
      createElement('dt', null, t('about.uiSurface')),
      createElement('dd', null, t('about.uiSurfaceValue')),
    ),
  )
}
