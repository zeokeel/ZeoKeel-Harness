/**
 * jsdom behaviour tests for the frame click script (2026-10-23 frame audit P2-1).
 *
 * The runtime test used to stub the CDP result `'disabled'`, so deleting the
 * page-side `el.disabled` guard stayed green. These run the exact exported
 * expression against a real element.
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { frameClickExpression } from '../src/runtime.ts'

function page(html: string, selector: string): { window: JSDOM['window'], run: () => unknown } {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://example.com/app', runScripts: 'outside-only' })
  dom.window.Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) } as DOMRect
  }
  dom.window.Element.prototype.scrollIntoView = function (): void {}
  return { window: dom.window, run: () => dom.window.eval(frameClickExpression(selector)) }
}

describe('frameClickExpression', () => {
  it('returns disabled for a disabled button (the page-side guard really runs)', () => {
    const target = page('<button id="off" disabled>off</button>', '#off')
    expect(target.run()).toBe('disabled')
  })

  it('clicks an enabled button', () => {
    const target = page('<button id="ok">ok</button>', '#ok')
    let clicks = 0
    target.window.document.getElementById('ok')!.addEventListener('click', () => { clicks += 1 })
    expect(target.run()).toBe('clicked')
    expect(clicks).toBe(1)
  })

  it('reports not-found for a missing element and resolves inside a shadow root', () => {
    const missing = page('<div></div>', '#nope')
    expect(missing.run()).toBe('not-found')
    const shadow = page('<div id="host"></div>', '#host >>> button')
    const root = shadow.window.document.getElementById('host')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<button id="in">in</button>'
    expect(shadow.run()).toBe('clicked')
  })
})
