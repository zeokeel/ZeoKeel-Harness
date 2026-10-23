/**
 * Programming-mode bridge tests (2026-10-23 browser_run).
 */
import { describe, expect, it, vi } from 'vitest'
import { createProgramBridge, PROGRAM_FORBIDDEN_HELPERS, PROGRAM_HELPERS, programErrorText, truncateProgramResult } from '../src/program.ts'

describe('program helpers', () => {
  it('is an explicit whitelist that maps to existing tools and excludes dangerous names', () => {
    const names = Object.keys(PROGRAM_HELPERS)
    expect(names.length).toBeGreaterThan(10)
    for (const name of PROGRAM_FORBIDDEN_HELPERS) expect(names).not.toContain(name)
    for (const tool of Object.values(PROGRAM_HELPERS)) expect(tool.startsWith('browser_')).toBe(true)
  })

  it('counts failed calls too and enforces the call limit', async () => {
    const invoke = vi.fn(async () => { throw new Error('policy') })
    const bridge = createProgramBridge(invoke, { deadlineAt: Date.now() + 60_000, maxCalls: 2 })
    await expect(bridge.browser.navigate()).rejects.toBeTruthy()
    await expect(bridge.browser.navigate()).rejects.toBeTruthy()
    await expect(bridge.browser.navigate()).rejects.toThrow(/call limit/u)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('is frozen (a script cannot replace helpers)', () => {
    const bridge = createProgramBridge(async () => null, { deadlineAt: Date.now() + 60_000, maxCalls: 5 })
    expect(Object.isFrozen(bridge.browser)).toBe(true)
  })
})

describe('program result/error shaping', () => {
  it('keeps results JSON-valid and truncates at the cap', () => {
    expect(truncateProgramResult({ a: 1 })).toEqual({ value: { a: 1 }, truncated: false })
    const big = truncateProgramResult('x'.repeat(300 * 1024))
    expect(big.truncated).toBe(true)
    expect(typeof big.value).toBe('string')
    expect(() => truncateProgramResult(BigInt(1))).toThrow(/serializable/u)
  })

  it('keeps only the first line of an error (no source lines in stacks)', () => {
    const text = programErrorText(new Error('boom\n  at secret=abc123'), value => value.replace('abc123', '****'))
    expect(text).toBe('boom')
  })
})
