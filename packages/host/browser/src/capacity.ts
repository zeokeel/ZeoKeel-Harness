/**
 * Runtime tab-quota derivation (2026-10-23 D2).
 *
 * The quota is the product's only capacity that follows the MACHINE: it is
 * derived from the memory available to this process (cgroup-aware where the
 * runtime exposes it) with a fixed per-tab cost. Product latency budgets stay in
 * `budgets.ts` — this module must never be wired to a timing decision.
 *
 * Domain boundary: `scripts/build-capacity.mjs` sizes BUILD parallelism (CPU
 * budget + memory per concurrent build task); this module sizes the PRODUCT's
 * tab quota from the machine's available memory. The per-task and per-tab prices
 * are different domains and must not be merged.
 * @module @zeokeel/dsh-browser
 */

import { readFileSync } from 'node:fs'
import { totalmem } from 'node:os'

/** Memory assumed per browser tab (Electron renderer + its page). */
export const TAB_MEMORY_PER_TAB_BYTES = 192 * 1024 * 1024
/** Fraction of the machine's memory the embedded browser may claim. */
export const TAB_MEMORY_SHARE = 0.5
/** Never below this: a tiny container must still open tabs. */
export const MIN_TAB_QUOTA = 4
/** Never above this: past it the UX/state cost outweighs the parallelism. */
export const MAX_TAB_QUOTA = 32

/**
 * Quota from a total-memory figure (pure; synthetic inputs are tested).
 * @param totalBytes - memory available to the process.
 * @returns tabs this machine may open (never 0).
 */
export function tabQuotaForMemory(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return MIN_TAB_QUOTA
  const usable = totalBytes * TAB_MEMORY_SHARE
  const quota = Math.floor(usable / TAB_MEMORY_PER_TAB_BYTES)
  return Math.max(MIN_TAB_QUOTA, Math.min(MAX_TAB_QUOTA, quota))
}

/**
 * Clamp a total-memory figure by a cgroup limit (v2 `memory.max` / v1
 * `memory.limit_in_bytes` report `max` or a huge sentinel when unlimited).
 * @param totalBytes - `os.totalmem()`.
 * @param cgroupMax - parsed cgroup limit, when present.
 * @returns the effective memory the browser may plan for.
 */
export function effectiveMemoryBytes(totalBytes: number, cgroupMax?: number): number {
  if (cgroupMax === undefined || !Number.isFinite(cgroupMax) || cgroupMax <= 0) return totalBytes
  return Math.min(totalBytes, cgroupMax)
}

/**
 * Read the cgroup memory limit when the host exposes one (best effort).
 *
 * Only the ROOT cgroup path is probed: a nested systemd slice can live deeper
 * than `/sys/fs/cgroup/<name>`, so this is intentionally best-effort (never a
 * security boundary — it only keeps the tab quota from overshooting memory).
 * @param read - file reader (injectable for tests).
 * @returns the effective limit, or undefined when unlimited/unknown.
 */
export function cgroupMemoryLimit(read: (path: string) => string = path => readFileSync(path, 'utf8')): number | undefined {
  try {
    for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
      try {
        const raw = read(file).trim()
        if (raw === 'max') return undefined
        const value = Number(raw)
        // v1 reports a page-rounded huge number when unlimited.
        if (Number.isFinite(value) && value > 0 && value < totalmem()) return value
      } catch { /* next candidate */ }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Quota for the current process (cgroup-aware where the runtime exposes it). */
export function defaultTabQuota(): number {
  return tabQuotaForMemory(effectiveMemoryBytes(totalmem(), cgroupMemoryLimit()))
}
