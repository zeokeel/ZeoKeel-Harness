/**
 * Restricted executor tests (decision B, 2026-10-23). The program world is built
 * INSIDE the vm context, so prototype/constructor walks must reach the context
 * Function (whose string constructor is disabled), never the host one.
 */
import { describe, expect, it, vi } from 'vitest'
import { createRestrictedExecutor } from '../src/program-restricted.ts'

const NAMES = ['open', 'click', 'tick'] as const

function executor(invoke: (helper: string, args: unknown[]) => Promise<unknown> = async () => 'ok') {
  return createRestrictedExecutor([...NAMES], invoke)
}

describe('restricted executor', () => {
  it('exposes only the bridge and console, and captures result/console', async () => {
    const invoke = vi.fn(async (helper: string) => (helper === 'tick' ? 42 : 'ok'))
    const outcome = await executor(invoke).run('console.log("hi"); const value = await browser.tick(); return { value }')
    expect(outcome.result).toEqual({ value: 42 })
    expect(outcome.console).toContain('log: hi')
    expect(invoke).toHaveBeenCalledWith('tick', [])
  })

  it('host functions are unreachable: constructor walks hit the context Function', async () => {
    // 1) the bridge method itself (created in the context by bootstrap).
    await expect(executor().run('return browser.open.constructor("return 1")()')).rejects.toThrow(/Code generation from strings disallowed/u)
    // 2) console methods are context functions too.
    await expect(executor().run('return console.log.constructor("return 1")()')).rejects.toThrow(/Code generation from strings disallowed/u)
    // 3) prototype walks stay in the context realm.
    // The prototype chain resolves to the context Object (not the host Function),
    // so calling it cannot construct code: any rejection proves no escape.
    await expect(executor().run('return Object.getPrototypeOf(browser).constructor("return 1")()')).rejects.toBeTruthy()
    await expect(executor().run('return ({}).constructor.constructor("return 1")()')).rejects.toThrow(/Code generation from strings disallowed/u)
  })

  it('concatenated capability probes find nothing (no host globals)', async () => {
    const probe = await executor().run(`const p = 'pro' + 'cess'; const f = 'fet' + 'ch'; const r = 're' + 'quire';
      return { proc: typeof globalThis[p], fetch: typeof globalThis[f], require: typeof globalThis[r], version: typeof globalThis[p]?.version }`)
    expect(probe.result).toEqual({ proc: 'undefined', fetch: 'undefined', require: 'undefined', version: 'undefined' })
  })

  it('dynamic import without a module callback is refused', async () => {
    await expect(executor().run('return await import("node:fs")')).rejects.toBeTruthy()
  })

  it('legal programs may contain https URLs and capability-looking words', async () => {
    const invoke = async () => 'ok'
    const outcome = await executor(invoke).run(`const url = 'https://a.example/x';
      const text = 'process imports fetch data';
      return { url, text }`)
    expect(outcome.result).toEqual({ url: 'https://a.example/x', text: 'process imports fetch data' })
  })

  it('a synchronous infinite loop is bounded by the vm timeout', async () => {
    const fast = createRestrictedExecutor([...NAMES], async () => 'ok', 50)
    await expect(fast.run('while (true) {}')).rejects.toThrow(/timed out|Script execution/u)
  })
})
