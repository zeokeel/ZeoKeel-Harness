/**
 * `expectTimeoutMs` clamping (2026-10-23 M2 audit P2-2): the pure helper is the
 * single place that turns the tool argument into a wait, so the tool-budget
 * invariant is testable without fake timers.
 */
import { describe, expect, it } from 'vitest'
import {
  EXPECT_TIMEOUT_DEFAULT_MS,
  EXPECT_TIMEOUT_MAX_MS,
  clampExpectTimeoutMs,
} from '../src/tools.ts'
import { BROWSER_TOOL_TIMEOUT_MS } from '../src/budgets.ts'

describe('clampExpectTimeoutMs', () => {
  it('defaults when absent or non-finite', () => {
    expect(clampExpectTimeoutMs(undefined)).toBe(EXPECT_TIMEOUT_DEFAULT_MS)
    expect(clampExpectTimeoutMs(Number.NaN)).toBe(EXPECT_TIMEOUT_DEFAULT_MS)
    expect(clampExpectTimeoutMs(Number.POSITIVE_INFINITY)).toBe(EXPECT_TIMEOUT_DEFAULT_MS)
  })

  it('never returns less than 1ms', () => {
    expect(clampExpectTimeoutMs(0)).toBe(1)
    expect(clampExpectTimeoutMs(-1)).toBe(1)
    expect(clampExpectTimeoutMs(-60_000)).toBe(1)
  })

  it('caps at the documented maximum', () => {
    expect(clampExpectTimeoutMs(10_001)).toBe(EXPECT_TIMEOUT_MAX_MS)
    expect(clampExpectTimeoutMs(60_000)).toBe(EXPECT_TIMEOUT_MAX_MS)
  })

  it('passes an in-range value through (floored)', () => {
    expect(clampExpectTimeoutMs(5_000)).toBe(5_000)
    expect(clampExpectTimeoutMs(1_234)).toBe(1_234)
    expect(clampExpectTimeoutMs(1_234.9)).toBe(1_234)
  })

  it('keeps the cap strictly inside the tool registration budget', () => {
    // The invariant that makes `receipt.timedOut` reachable at all: the expect
    // wait must be smaller than the tool budget (gate + margin also live there).
    expect(EXPECT_TIMEOUT_MAX_MS).toBeLessThan(BROWSER_TOOL_TIMEOUT_MS)
    expect(EXPECT_TIMEOUT_DEFAULT_MS).toBeLessThan(EXPECT_TIMEOUT_MAX_MS)
  })
})
