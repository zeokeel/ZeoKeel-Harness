/**
 * Tab-quota derivation (2026-10-23 D2): synthetic memory figures, never 0,
 * bounded by the documented floor/ceiling.
 */
import { describe, expect, it } from 'vitest'
import { MAX_TAB_QUOTA, MIN_TAB_QUOTA, TAB_MEMORY_PER_TAB_BYTES, defaultTabQuota, tabQuotaForMemory } from '../src/capacity.ts'
import { TabPool } from '../src/pool.ts'

describe('tabQuotaForMemory', () => {
  it('never drops below the floor, even on a tiny container', () => {
    expect(tabQuotaForMemory(0)).toBe(MIN_TAB_QUOTA)
    expect(tabQuotaForMemory(Number.NaN)).toBe(MIN_TAB_QUOTA)
    expect(tabQuotaForMemory(64 * 1024 * 1024)).toBe(MIN_TAB_QUOTA)
  })

  it('scales with memory and never exceeds the ceiling', () => {
    // 8 GiB * 0.5 / 192 MiB ≈ 21
    expect(tabQuotaForMemory(8 * 1024 * 1024 * 1024)).toBe(Math.floor(8 * 1024 * 1024 * 1024 * 0.5 / TAB_MEMORY_PER_TAB_BYTES))
    expect(tabQuotaForMemory(1024 * 1024 * 1024 * 1024)).toBe(MAX_TAB_QUOTA)
  })

  it('the live default is a real quota, not a literal', () => {
    const quota = defaultTabQuota()
    expect(quota).toBeGreaterThanOrEqual(MIN_TAB_QUOTA)
    expect(quota).toBeLessThanOrEqual(MAX_TAB_QUOTA)
  })

  it('the pool default comes from the derivation (not a literal)', () => {
    const pool = new TabPool()
    expect(pool.options.maxTabs).toBe(defaultTabQuota())
    pool.dispose()
  })
})
