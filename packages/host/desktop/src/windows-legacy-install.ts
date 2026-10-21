/**
 * Pre-rebrand Windows installations (P2, 2026-10-21 packaging review).
 *
 * The published 2.8.x line used the PicoAide app id (`ai.deepseek.dsh.desktop`,
 * NSIS GUID `85820364-4c28-594e-b046-8896b3669248`), and later ZeoKeel releases
 * changed the app id, so the installer's own legacy check only sees the current
 * GUID. The app therefore pre-checks the legacy keys before handing a downloaded
 * installer to the OS: an in-app update can show a native dialog, while the
 * installer-side shim can only exit with code 2 (a silent updater would
 * otherwise leave the user with "nothing happened").
 *
 * @module dsh-plugin-desktop/windows-legacy-install
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** NSIS install key GUID of the pre-rebrand product (PicoAide Harness). */
export const LEGACY_WINDOWS_APP_GUID = '85820364-4c28-594e-b046-8896b3669248'

/** One legacy installation discovered in the registry. */
export interface LegacyWindowsInstall {
  /** Registry key that matched (`HKLM\...` or `HKCU\...`). */
  readonly registryPath: string
  /** Value of `InstallLocation` (the old installation directory). */
  readonly installLocation: string
}

/** Injectable command runner (tests). */
export type RegQueryRunner = (file: string, args: readonly string[]) => Promise<string>

/**
 * Extract `InstallLocation` from `reg query <key> /v InstallLocation` output.
 *
 * The value column is separated by four spaces; a missing value prints an error
 * on stdout in some Windows locales, so callers treat `undefined` as "not found".
 * @param stdout - command output.
 * @returns the string value, when present and non-empty.
 */
export function parseRegQueryInstallLocation(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /InstallLocation\s+REG_\w+\s+(.+?)\s*$/u.exec(line)
    if (match === null) continue
    const value = (match[1] ?? '').trim()
    if (value.length > 0) return value
  }
  return undefined
}

/**
 * Look for a pre-rebrand installation in the registry.
 *
 * Per-machine (HKLM) is checked first because that is the layout that produced
 * duplicate installs; per-user (HKCU) is checked as well so an in-app update can
 * warn before creating a side-by-side copy.
 * @param run - injectable `reg.exe` runner.
 * @param systemRoot - Windows directory (defaults to `%SystemRoot%`).
 * @returns the first match, or `undefined` when nothing is registered.
 */
export async function findLegacyWindowsInstall(
  run: RegQueryRunner = defaultRunner,
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
): Promise<LegacyWindowsInstall | undefined> {
  const regExe = `${systemRoot}\\System32\\reg.exe`
  for (const registryPath of [
    `HKLM\\Software\\${LEGACY_WINDOWS_APP_GUID}`,
    `HKCU\\Software\\${LEGACY_WINDOWS_APP_GUID}`,
  ]) {
    let stdout: string
    try {
      stdout = await run(regExe, ['query', registryPath, '/v', 'InstallLocation'])
    } catch {
      // Missing key, access denied, no reg.exe — all mean "not detected here".
      continue
    }
    const installLocation = parseRegQueryInstallLocation(stdout)
    if (installLocation !== undefined) return { registryPath, installLocation }
  }
  return undefined
}

const execFileAsync = promisify(execFile)

/** Default runner: a bounded, output-capturing `reg.exe query`. */
async function defaultRunner(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, [...args], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}
