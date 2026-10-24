/**
 * Behaviour tests for the shared page-side shadow resolver (2026-10-23 P2 audit).
 *
 * The runtime tests only asserted that the page expression CONTAINS the helper;
 * the helper's own logic (compact `>>>` spacing, fail-closed intermediate hops)
 * had no real-DOM coverage — the audit's P2-1 / B2 mutations stayed green.
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { querySnippet } from '../src/runtime.ts'
import { TEXT_SHADOW_QUERY } from '../src/snapshot.ts'

function page(html: string): { window: JSDOM['window'], queryWith: (selector: string) => unknown } {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://example.com/app', runScripts: 'outside-only' })
  return {
    window: dom.window,
    queryWith: (selector: string) => dom.window.eval(`(() => { ${querySnippet(selector)} return el; })()`),
  }
}

describe('shadow resolver: >>> spacing is whitespace-tolerant', () => {
  it('resolves a compact selector with no spaces around >>>', () => {
    const target = page('<div id="status"></div>')
    const root = target.window.document.getElementById('status')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<button id="go">Go</button>'
    expect((target.queryWith('#status>>>button') as { id?: string } | null)?.id).toBe('go')
    // The generated source must really contain \s (a template-escaped `\s`
    // becomes a literal `s`, which split on `s>>>s` and broke compact selectors).
    expect(querySnippet('#status>>>button')).toContain('\\s*>>>\\s*')
  })

  it('resolves a spaced selector as before', () => {
    const target = page('<div id="a"></div>')
    const root = target.window.document.getElementById('a')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<section id="s">x</section>'
    expect((target.queryWith('#a >>> section') as { id?: string } | null)?.id).toBe('s')
  })
})

describe('shadow resolver: fail-closed intermediate hop', () => {
  it('a hop without a shadow root is a hard miss, even when the light DOM has a match', () => {
    // #host has NO shadow root; the light DOM child button must NOT be matched.
    const target = page('<div id="host"><button id="light">light</button></div>')
    expect(target.queryWith('#host>>>button')).toBeNull()
  })
})

describe('text extraction uses the same resolver', () => {
  it('TEXT_SHADOW_QUERY resolves a shadow selector and misses a non-shadow hop', () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="status"></div><div id="plain"></div></body></html>', { url: 'https://example.com/app', runScripts: 'outside-only' })
    const root = dom.window.document.getElementById('status')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<span id="in">inside</span>'
    const hit = dom.window.eval(`(() => { ${TEXT_SHADOW_QUERY} return __query('#status>>>#in'); })()`) as { id?: string } | null
    expect(hit?.id).toBe('in')
    const miss = dom.window.eval(`(() => { ${TEXT_SHADOW_QUERY} return __query('#plain>>>#in'); })()`) as unknown
    expect(miss).toBeNull()
  })
})
