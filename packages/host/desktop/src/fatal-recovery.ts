/**
 * Fatal-startup recovery operations: safe mode and profile-patch backup (P1).
 *
 * The profile is the most common reason a packaged Desktop cannot start (a
 * third-party bundle or a hand-edited `cordis.patch.yml` that no longer
 * composes), and the user's only other option today is deleting directories by
 * hand — which also throws away their sessions. These operations give the fatal
 * dialog a way out **without booting Cordis**: pure file surgery on the profile
 * directory and the private userData directory, run after the user picks an exit
 * and before the relaunch.
 *
 * Safe mode deliberately writes a **one-boot marker** (`desktop-safe-mode.ts`)
 * rather than the plugin state: the launcher has no "enable plugin" operation
 * and its plugin-management UI is disabled, so a persistent disable would be a
 * one-way trap. The marker is cleared once the profile composes again.
 *
 * Two rules inherited from the fatal path:
 *  - never load or compose the profile (it may be the thing that is broken);
 *  - only disable bundles **outside the installation set** — launcher-owned
 *    layers (`@zeokeel/*`, bundled feature modules) must never be filtered out,
 *    because the profile composition fails hard when its carrier layer is
 *    missing (that would turn the recovery into a guaranteed boot loop).
 *
 * @module dsh-plugin-desktop/fatal-recovery
 */

import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE_PATCH_FILENAME, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { writeSafeModeMarker } from './desktop-safe-mode.ts'
import {
  desktopPluginBundleMutable,
} from './desktop-plugins.ts'
import { desktopInstallationBundle } from './profile.ts'

/** Locations the recovery operations touch; all absolute. */
export interface FatalRecoveryTargets {
  /** Harness home (`$DSH_HOME`): contains `profiles/<name>`. */
  readonly homeDir: string
  /** Desktop profile name (`desktop`). */
  readonly profileName: string
  /** One-boot safe-mode marker inside `<userData>/plugin-management`. */
  readonly safeModePath: string
}

/** Outcome of one recovery operation, suitable for the log line before relaunch. */
export interface FatalRecoveryReport {
  /** Profile-patch backup path, or `undefined` when there was none. */
  readonly backupPath?: string
  /** Harness-home patch backup path, or `undefined` when there was none. */
  readonly homeBackupPath?: string
  /** Third-party bundles the next boot will leave out of the composition. */
  readonly disabledBundles: readonly string[]
  /** Why the profile manifest could not be read (safe mode then has nothing to disable). */
  readonly manifestError?: string
  /**
   * True when safe mode had no third-party bundle to skip and backed the user
   * patches up instead (so the exit is never a dead end).
   */
  readonly degradedToPatchBackup?: boolean
  /**
   * True when a previous safe-mode boot also failed: this attempt kept the
   * marker **and** backed the user patches up, because skipping plugins alone
   * did not fix that failure (2026-10-21 反证审查 C 的 R3-1).
   */
  readonly escalated?: boolean
}

/** Directory of the user-editable Desktop profile. */
export function desktopProfileDirectory(targets: FatalRecoveryTargets): string {
  return resolveProfileDir(targets.profileName, targets.homeDir)
}

/** The user-editable profile patch (the last composition layer). */
export function profilePatchPath(targets: FatalRecoveryTargets): string {
  return join(desktopProfileDirectory(targets), PROFILE_PATCH_FILENAME)
}

/**
 * The machine-wide patch (`$DSH_HOME/cordis.patch.yml`).
 *
 * It is composed after the profile layers, so a broken file there produces the
 * exact same fatal dialog; a recovery that only moves the profile patch would
 * report success and then fail identically (2026-10-21 review A).
 */
export function homePatchPath(targets: FatalRecoveryTargets): string {
  return join(targets.homeDir, PROFILE_PATCH_FILENAME)
}

/**
 * Move the profile patch aside so the next launch starts from an empty one.
 *
 * The backup sits next to the original (`cordis.patch.yml.bak-<timestamp>`) so
 * support can ask the user to send it back; a numeric suffix keeps a second
 * recovery from overwriting the first backup.
 * @param patchPath - absolute patch path.
 * @param now - injectable clock (tests).
 * @returns the backup path, or `undefined` when there is no patch.
 */
export function backupProfilePatch(patchPath: string, now: Date = new Date()): string | undefined {
  if (!existsSync(patchPath)) return undefined
  const stat = lstatSync(patchPath)
  // 普通文件与符号链接都可以搬：搬链接就是把"这个用户补丁"整体移出组合，链接目标
  // 原样保留，是可恢复的（2026-10-21 反证审查 C 的 R3-5：此前拒绝 symlink 让两个出口
  // 都变成死胡同，而 symlink 补丁在启动期本来是可用的）。目录不能被当成补丁搬走。
  if (stat.isDirectory() || (!stat.isFile() && !stat.isSymbolicLink())) {
    throw new Error(`fatal recovery: ${patchPath} is not a patch file`)
  }
  const stamp = now.toISOString().replace(/[:.]/gu, '-')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${String(attempt)}`
    const candidate = `${patchPath}.bak-${stamp}${suffix}`
    if (existsSync(candidate)) continue
    renameSync(patchPath, candidate)
    return candidate
  }
  throw new Error(`fatal recovery: no free backup name next to ${patchPath}`)
}

/**
 * Bundle names listed by the profile manifest.
 *
 * Reads only `package.json` (`dsh.profile.bundles`), never the patch layers:
 * the YAML is the usual suspect and must not be parsed here.
 * @param profileDirectory - absolute profile directory.
 * @returns listed bundle names (empty when the field is absent).
 */
export function readProfileBundleNames(profileDirectory: string): string[] {
  const manifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')) as unknown
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('profile manifest must be an object')
  }
  const dsh = (manifest as { dsh?: unknown }).dsh
  if (dsh === undefined || dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return []
  const profile = (dsh as { profile?: unknown }).profile
  if (profile === undefined || profile === null || typeof profile !== 'object' || Array.isArray(profile)) return []
  const bundles = (profile as { bundles?: unknown }).bundles
  if (bundles === undefined) return []
  if (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string')) {
    throw new Error('dsh.profile.bundles must be an array of package names')
  }
  return bundles as string[]
}

/**
 * Third-party bundles safe mode may filter for one boot.
 *
 * "Third-party" = mutable to the plugin manager **and** outside the installation
 * set. The second half is load-bearing: filtering out a launcher-owned layer
 * makes `prepareDesktopProfile` fail with "desktop profile is missing the
 * @zeokeel/dsh-enterprise bundle layer", i.e. the recovery would guarantee the
 * same fatal dialog again.
 * @param bundles - names from the profile manifest.
 * @returns sorted, de-duplicated names that are safe to leave out.
 */
export function safeModeCandidates(bundles: readonly string[]): string[] {
  return [...new Set(bundles)]
    .filter(name => desktopPluginBundleMutable(name) && !desktopInstallationBundle(name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * Safe mode: leave every third-party bundle out of the next composition, and
 * back the user's patch up so a broken patch cannot re-break that same boot.
 *
 * Ordering matters: the marker is written **before** the patch is moved, so a
 * failed marker write leaves the profile untouched. If a patch move then fails,
 * the marker survives and the next launch still composes in safe mode.
 * @param targets - profile and marker locations.
 * @param now - injectable clock (tests).
 * @returns what was moved and which bundles the marker filters.
 */
export async function enterFatalSafeMode(
  targets: FatalRecoveryTargets,
  now: Date = new Date(),
): Promise<FatalRecoveryReport> {
  const profileDirectory = desktopProfileDirectory(targets)
  let bundles: string[]
  try {
    bundles = readProfileBundleNames(profileDirectory)
  } catch (cause) {
    const manifestError = cause instanceof Error ? cause.message : String(cause)
    // Without the manifest there is no way to tell third-party bundles apart,
    // so safe mode has nothing safe to do. Report instead of guessing.
    return { disabledBundles: [], manifestError }
  }

  const candidates = safeModeCandidates(bundles)
  const previousSafeModeFailed = existsSync(targets.safeModePath)
  if (candidates.length > 0) {
    // 只写标记：**不搬补丁**。安全模式解决的是"第三方插件"，用户的设置补丁
    // （SettingsForms 就写在 profile 补丁里，home 补丁还与 CLI 共享）不该被一次
    // 插件故障顺手移走（2026-10-21 反证审查 A 的 R2-5）。要重置补丁请用另一个出口。
    await writeSafeModeMarker(targets.safeModePath, candidates, now)
    if (!previousSafeModeFailed) return { disabledBundles: candidates }
    // 标记还在 ⇒ 上一次"跳过插件"的启动同样没救回来（失败跳不会清标记）。
    // 继续重复同一个动作只会无限循环（反证审查 C 的 R3-1），所以升级为"同时备份
    // 补丁"；连补丁都没有时明确失败，让调用方显示错误而非假装成功。
    const backups = backupUserPatches(targets, now)
    return { disabledBundles: candidates, ...backups, escalated: true }
  }

  // 没有第三方插件可跳过时，安全模式不能是死胡同（R2-4）：退化为备份用户补丁。
  const backups = backupUserPatches(targets, now)
  return { disabledBundles: [], ...backups, degradedToPatchBackup: true }
}

/** Result of moving the two user-editable patches aside. */
export interface UserPatchBackups {
  readonly backupPath?: string
  readonly homeBackupPath?: string
}

/**
 * Move both user patches aside, validating both before touching either.
 *
 * 先校验再改名：补丁是目录/符号链接时直接拒绝，避免"搬走一个假的备份"；
 * home 补丁改名失败时把 profile 补丁回滚，不留下半执行状态（R2-6）。
 * @param targets - resolved profile locations.
 * @param now - injectable clock (tests).
 * @returns both backup paths (absent when that patch did not exist).
 */
export function backupUserPatches(targets: FatalRecoveryTargets, now: Date = new Date()): UserPatchBackups {
  const profilePatch = profilePatchPath(targets)
  const homePatch = homePatchPath(targets)
  // Validate first: `backupProfilePatch` also validates, but doing both up front
  // keeps the rollback below from starting when the second path is a directory.
  for (const patch of [profilePatch, homePatch]) {
    if (!existsSync(patch)) continue
    const stat = lstatSync(patch)
    if (stat.isDirectory() || (!stat.isFile() && !stat.isSymbolicLink())) {
      throw new Error(`fatal recovery: ${patch} is not a patch file`)
    }
  }
  const backupPath = backupProfilePatch(profilePatch, now)
  let homeBackupPath: string | undefined
  try {
    homeBackupPath = backupProfilePatch(homePatch, now)
  } catch (cause) {
    if (backupPath !== undefined) {
      // Roll back the profile-patch move so the next boot still sees the user's
      // settings rather than a half-migrated state.
      try { renameSync(backupPath, profilePatch) } catch { /* keep the backup; report below */ }
    }
    throw cause
  }
  if (backupPath === undefined && homeBackupPath === undefined) {
    throw new Error('no user patch found; nothing to back up')
  }
  return {
    ...(backupPath === undefined ? {} : { backupPath }),
    ...(homeBackupPath === undefined ? {} : { homeBackupPath }),
  }
}

/**
 * Run one recovery exit; throws only when the recovery itself could not be done
 * (the caller then exits non-zero instead of relaunching into the same dialog).
 * @param action - which exit the user picked.
 * @param targets - resolved profile/marker locations.
 * @param now - injectable clock (tests).
 * @returns report for the log line.
 */
export async function performFatalRecovery(
  action: 'safe-mode' | 'backup-patch',
  targets: FatalRecoveryTargets,
  now: Date = new Date(),
): Promise<FatalRecoveryReport> {
  if (action === 'safe-mode') {
    const report = await enterFatalSafeMode(targets, now)
    if (report.manifestError !== undefined) {
      throw new Error(`safe mode cannot read the profile manifest: ${report.manifestError}`)
    }
    return report
  }
  return { disabledBundles: [], ...backupUserPatches(targets, now) }
}
