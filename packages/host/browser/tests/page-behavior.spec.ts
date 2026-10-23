/**
 * Page-side behaviour tests (2026-10-23 batch 3 audit P2-1).
 *
 * The repo's unit tests stub every CDP response, so the actual page logic
 * (`LOCATOR_PROBE`, `selectPageScript`) had ZERO coverage — six mutations of it
 * stayed green. These tests run the EXACT scripts the runtime sends, inside a
 * jsdom realm, so the behaviour is measured instead of assumed:
 *
 * - locator matching (text exact vs substring, role case, xpath, href),
 * - the unique-selector rule (a node inside a shadow root must NOT be addressed
 *   by a light-DOM selector — that used to click a different element),
 * - `$`-pattern safety in `locatorProbe` (`$&`, `$'`, `` $` ``, `$$`),
 * - select semantics (duplicate label/value fail loud, clear → count 0,
 *   single-select with several targets refused).
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { locatorProbe, type TargetSpec } from '../src/locator.ts'
import { selectPageScript } from '../src/runtime.ts'

interface Page {
  readonly dom: JSDOM
  readonly window: JSDOM['window']
  run<T = unknown>(script: string): T
}

function page(html: string): Page {
  const dom = new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`, {
    url: 'https://example.com/app',
    runScripts: 'outside-only',
  })
  const window = dom.window as JSDOM['window'] & { CSS?: { escape?: (value: string) => string } }
  // jsdom does not ship CSS.escape in older versions; the probe needs it for ids.
  if (window.CSS === undefined) window.CSS = {} as never
  if (window.CSS.escape === undefined) {
    window.CSS.escape = (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`)
  }
  return { dom, window, run: <T,>(script: string): T => window.eval(script) as T }
}

interface ProbeResult {
  count: number
  selector: string | null
  candidates?: string[]
  error?: string
}

function probe(target: Page, spec: TargetSpec): ProbeResult {
  return JSON.parse(target.run<string>(locatorProbe(spec))) as ProbeResult
}

describe('LOCATOR_PROBE: matching semantics', () => {
  const html = `
    <div id="wrap">
      <button id="save">Save changes</button>
      <button id="other" aria-label="Other">Other</button>
      <a id="checkout" href="/cart/checkout?step=1">Checkout</a>
      <div role="BUTTON" id="shout">SHOUT</div>
      <select id="plain"><option value="1">Red</option><option value="2">Blue</option></select>
    </div>
    <script>window.__x = 1</script>`

  it('text: unquoted is normalized substring, quoted is exact', () => {
    const target = page(html)
    expect(probe(target, { kind: 'text', text: 'save CHANGES', exact: false }).selector).toBe('#save')
    // Case-sensitive exactness: 'Save changes' matches, 'save changes' does not.
    expect(probe(target, { kind: 'text', text: 'Save changes', exact: true }).selector).toBe('#save')
    expect(probe(target, { kind: 'text', text: 'save changes', exact: true }).count).toBe(0)
    // Substring ('Save') is not exact.
    expect(probe(target, { kind: 'text', text: 'Save', exact: true }).count).toBe(0)
  })

  it('text: deepest match wins (a matching <body> does not shadow the button)', () => {
    const target = page(html)
    expect(probe(target, { kind: 'text', text: 'Other', exact: false }).selector).toBe('#other')
  })

  it('role: matches case-insensitively and honours the accessible name', () => {
    const target = page(html)
    expect(probe(target, { kind: 'role', role: 'BUTTON', name: undefined, nameExact: true }).count).toBe(3)
    expect(probe(target, { kind: 'role', role: 'button', name: 'Save changes', nameExact: true }).selector).toBe('#save')
    expect(probe(target, { kind: 'role', role: 'button', name: 'save', nameExact: false }).selector).toBe('#save')
    // The explicit role="BUTTON" element is included, not dropped by case.
    expect(probe(target, { kind: 'role', role: 'button', name: 'SHOUT', nameExact: true }).selector).toBe('#shout')
  })

  it('href: substring match over links only', () => {
    const target = page(html)
    expect(probe(target, { kind: 'href', needle: '/checkout' }).selector).toBe('#checkout')
    expect(probe(target, { kind: 'href', needle: '/missing' }).count).toBe(0)
  })

  it('xpath: resolves elements and reports zero matches', () => {
    const target = page(html)
    expect(probe(target, { kind: 'xpath', expression: '//button[@id="save"]' }).selector).toBe('#save')
    expect(probe(target, { kind: 'xpath', expression: '//button[@id="nope"]' }).count).toBe(0)
  })

  it('ambiguous matches carry readable candidates', () => {
    const target = page(html)
    const result = probe(target, { kind: 'role', role: 'button', name: undefined, nameExact: true })
    expect(result.count).toBe(3)
    expect(result.selector).toBeNull()
    expect(result.candidates).toHaveLength(3)
  })

  it('a node inside a shadow root is NOT addressable by a light-DOM selector', () => {
    const target = page('<div id="host"></div><button id="light">Other</button>')
    const host = target.window.document.getElementById('host')!
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<button id="inner">Sign in</button>'
    const result = probe(target, { kind: 'text', text: 'Sign in', exact: false })
    expect(result.count).toBe(1)
    // The generated selector would resolve to #light in the light DOM, so the
    // probe must refuse instead of handing back a selector that clicks elsewhere.
    expect(result.selector).toBeNull()
  })

  it('`$`-patterns in the model text cannot rewrite the probe source', () => {
    const target = page('<button id="cash">Price $&amp; $` $1 $$</button>')
    for (const text of ["$'", '$`', '$&', '$$', '$1']) {
      // Compiles (no placeholder survives) and looks for the literal text.
      const result = probe(target, { kind: 'text', text, exact: false })
      expect(typeof result.count).toBe('number')
      expect(result.error).toBeUndefined()
    }
    const literal = probe(target, { kind: 'text', text: 'Price $& $` $1 $$', exact: false })
    expect(literal.selector).toBe('#cash')
  })
})

describe('selectPageScript: selection semantics', () => {
  const html = `<select id="s">
      <option value="1">Red</option>
      <option value="2">Blue</option>
      <option value="3">Red</option>
    </select>
    <select id="m" multiple>
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
      <option value="c">Gamma</option>
    </select>`

  interface SelectResult { error?: string, selected?: string[], count?: number }

  it('selects by unique label and by value', () => {
    const target = page(html)
    expect(target.run<SelectResult>(selectPageScript('#s', { label: 'Blue' }))).toMatchObject({ selected: ['2'], count: 1 })
    expect(target.run<SelectResult>(selectPageScript('#s', { value: '1' }))).toMatchObject({ selected: ['1'], count: 1 })
  })

  it('fails loud on a duplicated label or value (never silently picks the first)', () => {
    const target = page(html)
    const label = target.run<SelectResult>(selectPageScript('#s', { label: 'Red' }))
    expect(label.error).toContain('ambiguous')
    expect(label.selected).toBeUndefined()
    const duplicate = target.run<SelectResult>(selectPageScript('#s', { label: 'red' }))
    expect(duplicate.error).toContain('ambiguous')
  })

  it('clear resets a single select to no selection (count 0, selectedIndex -1)', () => {
    const target = page(html)
    const result = target.run<SelectResult>(selectPageScript('#s', { clear: true }))
    expect(result).toMatchObject({ selected: [], count: 0 })
    expect(target.window.document.getElementById('s')!.selectedIndex).toBe(-1)
  })

  it('multi-select accepts several targets; a single select refuses more than one', () => {
    const target = page(html)
    expect(target.run<SelectResult>(selectPageScript('#m', { value: ['a', 'c'] }))).toMatchObject({ selected: ['a', 'c'], count: 2 })
    const refused = target.run<SelectResult>(selectPageScript('#s', { index: [0, 1] }))
    expect(refused.error).toContain('not multiple')
  })

  it('reports out-of-range indexes and missing options instead of succeeding', () => {
    const target = page(html)
    expect(target.run<SelectResult>(selectPageScript('#s', { index: 9 })).error).toContain('out of range')
    expect(target.run<SelectResult>(selectPageScript('#s', { value: 'zz' })).error).toContain('not found by value')
    expect(target.run<SelectResult>(selectPageScript('#s', { label: 'Nope' })).error).toContain('not found by label')
  })

  it('dispatches input + change events', () => {
    const target = page(html)
    let changes = 0
    const select = target.window.document.getElementById('s')!
    select.addEventListener('change', () => { changes += 1 })
    select.addEventListener('input', () => { changes += 1 })
    target.run<SelectResult>(selectPageScript('#s', { label: 'Blue' }))
    expect(changes).toBe(2)
  })
})
