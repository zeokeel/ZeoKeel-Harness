/**
 * Behaviour tests for the page-side fetch function (2026-10-23 P4 audit).
 *
 * The runtime tests mock the callFunctionOn reply, leaving the page function —
 * including the `redirect:'error'` promise and the bounded read — untested.
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { PAGE_FETCH_FUNCTION } from '../src/runtime.ts'

interface Reply { status?: number, ok?: boolean, url?: string, contentType?: string, bytes?: number, body?: string | null, truncated?: boolean, bodyOmitted?: boolean }

function run(dom: JSDOM, fetchImpl: (url: string, init: Record<string, unknown>) => Promise<unknown>, payload: Record<string, unknown>): Promise<Reply> {
  const fn = dom.window.eval(`(${PAGE_FETCH_FUNCTION})`) as (payload: unknown) => Promise<string>
  Object.defineProperty(dom.window, 'fetch', { value: fetchImpl, writable: true })
  return fn(payload).then(text => JSON.parse(text) as Reply)
}

const basePayload = { url: 'https://a.example/x', method: 'GET', headers: {}, body: null, timeoutMs: 1_000, textLimit: 8, byteLimit: 1_024 }

function fakeDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://a.example/', runScripts: 'outside-only' })
  // jsdom does not ship TextDecoder/TextEncoder in its realm.
  ;(dom.window as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder
  ;(dom.window as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder
  return dom
}

describe('PAGE_FETCH_FUNCTION', () => {
  it('sets redirect:error (a redirect is refused, not followed)', async () => {
    expect(PAGE_FETCH_FUNCTION).toContain("redirect: 'error'")
    const dom = fakeDom()
    const seen: Array<Record<string, unknown>> = []
    const pending = run(dom, async (_url, init) => {
      seen.push(init)
      if (init['redirect'] !== 'error') return { status: 302, ok: false, url: 'https://evil.example/', headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
      throw new Error('Failed to fetch')
    }, basePayload)
    // redirect:'error' turns the 3xx attempt into a rejection (never followed).
    await expect(pending).rejects.toBeTruthy()
    expect(seen[0]?.['redirect']).toBe('error')
  })

  it('returns metadata only for a non-text response (small content-length, so the byte cap cannot mask it)', async () => {
    const dom = fakeDom()
    const reply = await run(dom, async () => ({
      status: 200, ok: true, url: 'https://a.example/a.bin',
      // Below byteLimit: the ONLY thing that can produce metadata-only here is
      // the content-type classification (audit: a declared-oversize body used to
      // mask a broken `readable` check).
      headers: { get: (name: string) => name === 'content-type' ? 'application/octet-stream' : '100' },
      arrayBuffer: async () => new ArrayBuffer(100),
    }), basePayload)
    expect(reply).toMatchObject({ bodyOmitted: true, body: null, bytes: 100 })
  })

  it('caps the text and flags truncation', async () => {
    const dom = fakeDom()
    const text = 'A'.repeat(20)
    const reply = await run(dom, async () => ({
      status: 200, ok: true, url: 'https://a.example/t',
      headers: { get: (name: string) => name === 'content-type' ? 'text/plain' : String(text.length) },
      body: { getReader: () => { let sent = false; return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode(text) }), cancel: async () => {} } } },
    }), basePayload)
    expect(reply.body).toBe('A'.repeat(8))
    expect(reply.truncated).toBe(true)
    expect(reply.bytes).toBe(20)
  })

  it('refuses a declared oversized body without reading it, and stops an undeclared one at the cap', async () => {
    const dom = fakeDom()
    const declared = await run(dom, async () => ({
      status: 200, ok: true, url: 'https://a.example/big',
      headers: { get: (name: string) => name === 'content-type' ? 'text/plain' : String(4096) },
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
    }), basePayload)
    expect(declared).toMatchObject({ bodyOmitted: true, body: null, bytes: 4096 })
    let cancelled = false
    const streamed = await run(dom, async () => ({
      status: 200, ok: true, url: 'https://a.example/big2',
      headers: { get: (name: string) => name === 'content-type' ? 'text/plain' : null },
      body: { getReader: () => {
        let sent = false
        return {
          read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(2048) }),
          cancel: async () => { cancelled = true },
        }
      } },
    }), basePayload)
    expect(streamed.bodyOmitted).toBe(true)
    expect(cancelled).toBe(true)
  })
})
