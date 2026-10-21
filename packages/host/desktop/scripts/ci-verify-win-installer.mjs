/**
 * CI entry point for the behaviour-level Windows installer gate (P6).
 *
 * The workflow guard (`scripts/check-ci-scripts` 的）refuses inline PowerShell
 * with variable command positions, so the platform job only invokes this repo
 * script; the actual checks live in:
 *  - `verify-win-installer-payload.mjs` (7-Zip payload assertions, any OS);
 *  - `verify-win-installer-runtime.mjs` (silent install/reinstall/uninstall and
 *    the legacy-migration negative case, Windows only).
 *
 * Expected staging layout (produced by `scripts/ci-package-clients.sh
 * --official-last`): `client-assets/official/*Setup*.exe`.
 */

import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isDirectInvocation } from './direct-invocation.mjs'

const execFileAsync = promisify(execFile)

/** Default official staging directory (cwd is the repository root in CI). */
export const OFFICIAL_STAGING_DIR = join('client-assets', 'official')

/**
 * Find the official NSIS installer in a staging directory.
 * @param directory - staging directory to scan.
 * @param list - injectable directory reader (tests).
 * @returns absolute-free path relative to the staging directory.
 */
export function findOfficialInstaller(directory, list = readdirSync) {
  const candidates = list(directory).filter(entry => /Setup.*\.exe$/iu.test(entry)).sort()
  const installer = candidates[0]
  if (installer === undefined) {
    throw new Error(`no official installer staged in ${directory}`)
  }
  return join(directory, installer)
}

async function main() {
  const installerPath = findOfficialInstaller(OFFICIAL_STAGING_DIR)
  console.log(`installer gate: ${installerPath}`)

  // 1) payload: run the payload checker as its own process so a failure names the step.
  const payload = await execFileAsync(process.execPath, [
    join('packages', 'host', 'desktop', 'scripts', 'verify-win-installer-payload.mjs'),
    installerPath,
  ], { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 })
  if (payload.stdout.trim() !== '') console.log(payload.stdout.trim())

  // 2) runtime: silent install / reinstall / uninstall + legacy negative case.
  const { verifyInstallerRuntime } = await import('./verify-win-installer-runtime.mjs')
  const result = await verifyInstallerRuntime(installerPath)
  console.log(`installer gate ok: ${result.installDir} [${result.steps.join(' → ')}]`)
}

if (isDirectInvocation(import.meta)) {
  main()
    .then(() => { process.exitCode = 0 })
    .catch(cause => {
      console.error(`installer gate failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      process.exitCode = 1
    })
}
