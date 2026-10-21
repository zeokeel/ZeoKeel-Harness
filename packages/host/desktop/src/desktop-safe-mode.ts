/**
 * One-boot "safe mode" marker for the Desktop profile (P1).
 *
 * A packaged Desktop that cannot start is usually broken by a third-party
 * bundle or by a hand-edited `cordis.patch.yml`. Safe mode must get the app back
 * **without** permanently editing anything the user cannot undo: the plugin
 * manager ships without an "enable" operation and its UI is disabled in the
 * desktop composition, so a persistent disable would be a one-way trap.
 *
 * Therefore safe mode writes this marker instead of the plugin state:
 *  - the next launch composes the profile with the listed bundles filtered out;
 *  - once the profile composes successfully the launcher deletes the marker, so
 *    safe mode never outlives the boot it was meant to rescue;
 *  - if that boot fails again, the marker is still there and the same recovery
 *    keeps applying — never a half-state, never a permanent lock-out.
 *
 * The file lives under `<userData>/plugin-management/` next to the plugin state
 * (same private directory, same 0600/0700 modes) and is written atomically.
 *
 * @module dsh-plugin-desktop/desktop-safe-mode
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Marker file name inside the plugin-management directory. */
export const SAFE_MODE_FILE_NAME = 'safe-mode.json'

/** Current marker schema version. */
const SAFE_MODE_VERSION = 1
/** Private file/directory modes, matching the plugin-management state. */
const SAFE_MODE_FILE_MODE = 0o600
const SAFE_MODE_DIRECTORY_MODE = 0o700
/** Upper bound on the bundle list (same cap as the plugin state). */
const MAX_SAFE_MODE_BUNDLES = 512
/** Marker is a small JSON document; anything bigger is not ours. */
const MAX_SAFE_MODE_BYTES = 64 * 1024

/** Persisted content of the marker. */
export interface DesktopSafeModeState {
  /** Bundle package names to leave out of the next composition. */
  readonly bundles: readonly string[]
  /** ISO timestamp of the recovery that wrote the marker. */
  readonly createdAt: string
}

/** Result of reading the marker; `problem` is set instead of throwing. */
export interface ReadSafeModeResult {
  /** Bundle names to filter, already de-duplicated and sorted. */
  readonly bundles: ReadonlySet<string>
  /** Why the marker could not be used; absent when it was absent or valid. */
  readonly problem?: string
  /**
   * Whether the problematic marker may be deleted. False for markers that are
   * structurally valid JSON but carry an unknown version — those may come from a
   * newer build and must not be destroyed by an older one (R3-7).
   */
  readonly removable?: boolean
}

/** Path of the marker for one userData directory. */
export function safeModeMarkerPath(userDataDirectory: string): string {
  return join(userDataDirectory, 'plugin-management', SAFE_MODE_FILE_NAME)
}

/**
 * Write (or replace) the marker atomically.
 * @param markerPath - absolute marker path.
 * @param bundles - bundle package names to filter on the next launch.
 * @param now - injectable clock (tests).
 */
export async function writeSafeModeMarker(
  markerPath: string,
  bundles: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const names = [...new Set(bundles)].sort(stableCompare)
  if (names.length === 0) throw new Error('safe mode needs at least one bundle to disable')
  if (names.length > MAX_SAFE_MODE_BUNDLES) throw new Error('safe mode bundle list is too large')
  const state: DesktopSafeModeState & { readonly version: number } = {
    version: SAFE_MODE_VERSION,
    bundles: names,
    createdAt: now.toISOString(),
  }
  assertPrivateDirectory(dirname(markerPath))
  // 标记本身必须是不存在的路径或普通文件：符号链接会让写入穿透到链接目标
  // （2026-10-21 反证审查 D 的 P5 实测），目录则会让 writeFileAtomic 直接失败。
  if (existsSync(markerPath)) {
    const stat = lstatSync(markerPath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('safe-mode marker must be a regular file')
    }
  }
  await writeFileAtomic(markerPath, `${JSON.stringify(state, undefined, 2)}\n`, {
    mode: SAFE_MODE_FILE_MODE,
    dirMode: SAFE_MODE_DIRECTORY_MODE,
  })
}

/**
 * Read the marker without ever throwing.
 *
 * A corrupt marker must not turn "recover from a broken profile" into another
 * startup failure, so malformed content is reported and treated as absent.
 * @param markerPath - absolute marker path.
 * @returns bundle set plus an optional problem description.
 */
export function readSafeModeBundles(markerPath: string): ReadSafeModeResult {
  if (!existsSync(markerPath)) return { bundles: new Set() }
  // 读侧也要先看形态：FIFO/设备文件会让 readFileSync **永久阻塞**启动
  // （2026-10-21 反证审查 A 的 R2-1 实测 timeout=124），"绝不抛错"不等于"绝不阻塞"。
  const stat = lstatSync(markerPath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { bundles: new Set(), problem: 'safe-mode marker is not a regular file', removable: true }
  }
  if (stat.size > MAX_SAFE_MODE_BYTES) {
    return { bundles: new Set(), problem: 'safe-mode marker is too large', removable: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown
  } catch (cause) {
    return { bundles: new Set(), problem: `safe-mode marker is unreadable: ${describe(cause)}`, removable: true }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { bundles: new Set(), problem: 'safe-mode marker is not an object', removable: true }
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== SAFE_MODE_VERSION) {
    // 版本不认识 ⇒ 可能是更新版本写的：只报告，不删除。
    return { bundles: new Set(), problem: `safe-mode marker version is ${String(record.version)}` }
  }
  const bundles = record.bundles
  if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string')
    || bundles.length > MAX_SAFE_MODE_BUNDLES) {
    return { bundles: new Set(), problem: 'safe-mode marker bundle list is invalid', removable: true }
  }
  return { bundles: new Set((bundles as string[]).sort(stableCompare)) }
}

/**
 * Delete the marker after a successful composition (never throws).
 * @param markerPath - absolute marker path.
 * @returns true when a marker was removed.
 */
export function clearSafeModeMarker(markerPath: string): boolean {
  try {
    unlinkSync(markerPath)
    return true
  } catch (cause) {
    // Leaving a marker behind only repeats one safe-mode boot; it must never
    // fail the boot that already succeeded.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    return false
  }
}

/**
 * Reject a plugin-management directory that is a link (or a non-directory).
 *
 * The marker lives in the same private directory as the plugin state; writing
 * through a symlink would put recovery data outside the userData tree, which is
 * both a privacy and a security problem.
 * @param directory - directory containing the marker.
 */
function assertPrivateDirectory(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: SAFE_MODE_DIRECTORY_MODE })
  }
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('safe-mode directory must be a real directory')
  }
  // 已存在的目录可能是 0755（旧版本/手工创建）：与 plugin state 一样收紧到 0700，
  // 否则恢复标记里的第三方包名会对同机其它账户可读（2026-10-21 反证审查 C 的 N3）。
  if ((stat.mode & 0o777) !== SAFE_MODE_DIRECTORY_MODE) chmodSync(directory, SAFE_MODE_DIRECTORY_MODE)
}

/**
 * Read the marker at boot time and log an unusable one.
 *
 * A corrupt marker must never fail the boot it was supposed to rescue; the
 * caller only needs the bundle set.
 * @param markerPath - absolute marker path.
 * @param log - diagnostics sink (file logger in production).
 * @returns bundle names to filter for this boot.
 */
export function beginSafeModeBoot(markerPath: string, log: (message: string) => void): ReadonlySet<string> {
  const result = readSafeModeBundles(markerPath)
  if (result.problem !== undefined) {
    log(`safe-mode marker ignored: ${result.problem}`)
    // 坏标记不能永远躺在那里（R2-10）；未知版本留给更新版本自己处理（R3-7）。
    if (result.removable === true && !clearSafeModeMarker(markerPath)) {
      log('safe-mode marker could not be removed')
    }
  }
  return result.bundles
}

/**
 * Clear the marker once the boot actually reached a mounted Host.
 *
 * Only a boot that consumed the marker clears it; an absent or malformed marker
 * is a no-op, so a second recovery attempt keeps working.
 * @param markerPath - absolute marker path.
 * @param bundles - bundle set returned by {@link beginSafeModeBoot}.
 * @param log - diagnostics sink.
 * @returns true when a marker was removed.
 */
export function finishSafeModeBoot(
  markerPath: string,
  bundles: ReadonlySet<string>,
  log: (message: string) => void,
): boolean {
  if (bundles.size === 0) return false
  if (!clearSafeModeMarker(markerPath)) {
    log('safe-mode marker could not be removed; the next boot will stay in safe mode')
    return false
  }
  log(`left safe mode after a successful boot (${String(bundles.size)} third-party bundle(s) re-enabled)`)
  return true
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
