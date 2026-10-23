/**
 * Tab-quota derivation (2026-10-23 D2): synthetic memory figures, never 0,
 * bounded by the documented floor/ceiling.
 */
import { describe, expect, it } from 'vitest'
import { MAX_TAB_QUOTA, MIN_TAB_QUOTA, TAB_MEMORY_PER_TAB_BYTES, defaultTabQuota, effectiveMemoryBytes, tabQuotaForMemory } from '../src/capacity.ts'
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

describe('capacity literals and cgroup clamping', () => {
  it('pins the documented constants to literal values (no self-referential maths)', () => {
    expect(TAB_MEMORY_PER_TAB_BYTES).toBe(192 * 1024 * 1024)
    expect(MIN_TAB_QUOTA).toBe(4)
    expect(MAX_TAB_QUOTA).toBe(32)
    // 8 GiB * 0.5 / 192 MiB = 21 (a 384 MiB per-tab cost would give 10).
    expect(tabQuotaForMemory(8 * 1024 * 1024 * 1024)).toBe(21)
  })

  it('clamps the memory figure by a cgroup limit', () => {
    expect(tabQuotaForMemory(64 * 1024 * 1024 * 1024)).toBe(32)
    // A 2 GiB container on a 64 GiB host must not plan for 32 tabs.
    expect(tabQuotaForMemory(effectiveMemoryBytes(64 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024))).toBe(5)
    // Unlimited sentinel is ignored.
    expect(effectiveMemoryBytes(1024, undefined)).toBe(1024)
  })

  it('the pool clamps an explicit quota to the documented ceiling', () => {
    const pool = new TabPool({ maxTabs: 40 })
    expect(pool.options.maxTabs).toBe(MAX_TAB_QUOTA)
    pool.dispose()
  })
})
