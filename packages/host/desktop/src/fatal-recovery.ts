/**
 * Fatal-startup recovery operations: safe mode and profile-patch backup (P1).
 *
 * The profile is the most common reason a packaged Desktop cannot start (a
 * third-party bundle or a hand-edited `cordis.patch.yml` that no longer
 * composes), and the user's only other option today is deleting directories by
 * hand — which also throws away their sessions. These two operations give the
 * fatal dialog a way out **without booting Cordis**: pure file surgery on the
 * profile directory and the Desktop-private plugin state file, run after the
 * user picks an exit and before the relaunch.
 *
 * Constraints, all inherited from the fatal path:
 *  - never load or compose the profile (it may be the thing that is broken);
 *  - never require Electron, the Host, or the network;
 *  - never destroy user data: the patch is **renamed** to a timestamped backup
 *    next to it, and disabling bundles only adds names to the plugin state that
 *    the plugin manager already owns.
 *
 * @module dsh-plugin-desktop/fatal-recovery
 */

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import {
  desktopPluginBundleMutable,
  recordDesktopDisabledBundles,
} from './desktop-plugins.ts'

/** Locations the recovery operations touch; all absolute. */
export interface FatalRecoveryTargets {
  /** Harness home (`$DSH_HOME`): contains `profiles/<name>`. */
  readonly homeDir: string
  /** Desktop profile name (`desktop`). */
  readonly profileName: string
  /** Desktop-private plugin-management state (`<userData>/plugin-management/state.json`). */
  readonly statePath: string
}

/** Outcome of one recovery operation, suitable for the log line before relaunch. */
export interface FatalRecoveryReport {
  /** Backup path, or `undefined` when there was no patch to move. */
  readonly backupPath?: string
  /** Mutable bundles that were written into the disabled set. */
  readonly disabledBundles: readonly string[]
  /** Why the profile manifest could not be read (safe mode then only backs up the patch). */
  readonly manifestError?: string
}

/** Directory of the user-editable Desktop profile. */
export function desktopProfileDirectory(targets: FatalRecoveryTargets): string {
  return resolveProfileDir(targets.profileName, targets.homeDir)
}

/** The user-editable profile patch (the last composition layer). */
export function profilePatchPath(targets: FatalRecoveryTargets): string {
  return join(desktopProfileDirectory(targets), 'cordis.patch.yml')
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
 * Safe mode: back the patch up, then disable every mutable (third-party) bundle.
 *
 * Only bundles the plugin manager would let a user disable are touched, so the
 * launcher-owned layers always stay composed; the next successful start shows
 * the disabled entries in the plugin manager, where the user can re-enable them
 * one by one instead of guessing.
 * @param targets - profile and state paths.
 * @param now - injectable clock (tests).
 * @returns what was moved and disabled.
 */
export async function enterFatalSafeMode(
  targets: FatalRecoveryTargets,
  now: Date = new Date(),
): Promise<FatalRecoveryReport> {
  const profileDirectory = desktopProfileDirectory(targets)
  const backupPath = backupProfilePatch(join(profileDirectory, 'cordis.patch.yml'), now)

  let manifestError: string | undefined
  let bundles: string[] = []
  try {
    bundles = readProfileBundleNames(profileDirectory)
  } catch (cause) {
    // The manifest itself being unreadable is the other plausible cause of the
    // fatal failure; the patch backup above is still worth doing, so report
    // instead of throwing.
    manifestError = cause instanceof Error ? cause.message : String(cause)
  }

  const disabled = bundles.filter(name => desktopPluginBundleMutable(name))
  if (disabled.length > 0) {
    await recordDesktopDisabledBundles(targets.statePath, targets.profileName, disabled)
  }
  return {
    ...(backupPath === undefined ? {} : { backupPath }),
    disabledBundles: disabled,
    ...(manifestError === undefined ? {} : { manifestError }),
  }
}
