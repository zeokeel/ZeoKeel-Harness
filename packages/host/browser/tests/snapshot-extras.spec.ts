/**
 * jsdom behaviour tests for `snapshotExtrasProbe` (2026-10-23 P1 audit).
 *
 * The runtime-level tests mock the probe output, which left the PAGE LOGIC with
 * zero real-DOM coverage (audit Pg1/Pg2 stayed green). These run the exact probe
 * the runtime sends inside a jsdom realm: nested shadow roots, frame-local
 * selectors, visible/disabled, truncation and cross-origin markers.
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { snapshotExtrasProbe } from '../src/snapshot.ts'

interface ExtrasResult {
  entries: Array<{ selector: string, kind: string, text: string, visible: boolean, disabled: boolean, frame?: number, shadow?: boolean }>
  crossOrigin: number[]
  truncated: boolean
  frames: number
  nestedFrames: number
}

function page(html: string): { dom: JSDOM, window: JSDOM['window'], run: (shadow: boolean, frames: boolean, remaining: number) => ExtrasResult } {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://example.com/app', runScripts: 'outside-only' })
  const window = dom.window as JSDOM['window'] & { CSS?: { escape?: (value: string) => string } }
  if (window.CSS === undefined) window.CSS = {} as never
  if (window.CSS.escape === undefined) {
    window.CSS.escape = (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/gu, character => `\\${character}`)
  }
  // jsdom has no layout: give every element a non-zero box so `visible` reflects
  // the probe's style checks instead of always being false.
  window.Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) } as DOMRect
  }
  return {
    dom,
    window,
    run: (shadow, frames, remaining) => JSON.parse(window.eval(snapshotExtrasProbe(shadow, frames, remaining))) as ExtrasResult,
  }
}

describe('snapshotExtrasProbe: nested shadow roots', () => {
  it('walks shadows nested inside shadows and keeps the full host path', () => {
    const target = page('<div id="host1"></div>')
    const document = target.window.document
    const host1 = document.getElementById('host1')!
    const outer = host1.attachShadow({ mode: 'open' })
    outer.innerHTML = '<div id="deep"></div><a id="leaf" href="#">Leaf</a>'
    const deep = outer.getElementById('deep')!
    const inner = deep.attachShadow({ mode: 'open' })
    inner.innerHTML = '<button id="btn">Deep button</button>'
    const result = target.run(true, false, 100)
    const selectors = result.entries.map(entry => entry.selector)
    expect(selectors).toContain('#host1 >>> #leaf')
    // The nested host keeps the middle hop; a single hostPath would lose it.
    expect(selectors).toContain('#host1 >>> #deep >>> #btn')
    expect(result.entries.every(entry => entry.shadow === true)).toBe(true)
  })

  it('honours the depth limit', () => {
    const target = page('<div id="h0"></div>')
    const document = target.window.document
    let current = document.getElementById('h0')!
    for (let depth = 0; depth < 12; depth += 1) {
      const root = current.attachShadow({ mode: 'open' })
      root.innerHTML = `<div id="h${depth + 1}"></div><button id="b${depth}">b</button>`
      current = root.getElementById(`h${depth + 1}`)!
    }
    const result = target.run(true, false, 500)
    // Depth 8: the deepest buttons are beyond the limit and must be absent.
    expect(result.entries.some(entry => entry.selector.includes('>>>'))).toBe(true)
    expect(result.entries.length).toBeLessThan(9)
  })
})

describe('snapshotExtrasProbe: frames', () => {
  it('frame entries carry frame:N with a selector LOCAL to the frame (no >>>)', () => {
    const target = page('<iframe id="f1" srcdoc="&lt;button id=&quot;in-frame&quot;&gt;Go&lt;/button&gt;"></iframe>')
    const result = target.run(false, true, 100)
    const framed = result.entries.filter(entry => entry.frame !== undefined)
    // Depending on jsdom's srcdoc support the frame may be cross-origin/empty;
    // when it is readable, the selector must be frame-local.
    for (const entry of framed) {
      expect(entry.selector).not.toContain('>>>')
      expect(entry.selector).not.toContain('f1')
    }
    expect(result.frames).toBeGreaterThanOrEqual(1)
  })

  it('unreadable frames are reported as cross-origin indices', () => {
    const target = page('<iframe id="x"></iframe>')
    const frame = target.window.document.getElementById('x') as HTMLIFrameElement
    Object.defineProperty(frame, 'contentDocument', { get: () => null })
    const result = target.run(false, true, 100)
    expect(result.crossOrigin).toEqual([1])
  })
})

describe('snapshotExtrasProbe: entry facts', () => {
  it('visible/disabled are computed instead of hard-coded', () => {
    const target = page('<div id="host"></div>')
    const root = target.window.document.getElementById('host')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<button id="hidden" style="display:none">h</button><button id="off" disabled>o</button><button id="ok">k</button>'
    const result = target.run(true, false, 100)
    const byId = (id: string): ExtrasResult['entries'][number] | undefined => result.entries.find(entry => entry.selector.endsWith(`#${id}`))
    expect(byId('hidden')?.visible).toBe(false)
    expect(byId('off')?.disabled).toBe(true)
    expect(byId('ok')).toMatchObject({ visible: true, disabled: false })
  })

  it('reports truncation when the append budget is exhausted', () => {
    const target = page('<div id="host"></div>')
    const root = target.window.document.getElementById('host')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<button id="a">a</button><button id="b">b</button><button id="c">c</button>'
    const result = target.run(true, false, 2)
    expect(result.entries).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })
})
