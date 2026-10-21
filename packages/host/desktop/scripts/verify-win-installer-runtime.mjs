/**
 * Behaviour-level gate for the Windows one-click installer (P6).
 *
 * `verify-win-installer.ts` checks PE headers and the `win-unpacked/` tree;
 * `verify-win-installer-payload.mjs` checks the installer payload. Neither runs
 * the installer. This script does, on a Windows CI runner:
 *
 *  1. negative migration: seed a legacy (pre-rebrand) install key, run `/S`,
 *     expect exit code 2, no installation, and the diagnostic file;
 *  2. silent install: `/S`, expect exit 0, the application, both license
 *     notices, the HKCU install key and **no** HKLM key;
 *  3. reinstall: `/S` again, expect a single installation at the same path;
 *  4. silent uninstall: run the generated uninstaller, expect a clean removal.
 *
 * Every process step has a hard timeout: a silent installer that hangs (the
 * failure mode the migration shim used to have) must fail the gate instead of
 * blocking the job.
 *
 * Usage (windows-latest):
 *   node packages/host/desktop/scripts/verify-win-installer-runtime.mjs <Setup.exe>
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDirectInvocation } from './direct-invocation.mjs'

/** NSIS GUID of the current product (`com.zeokeel.harness`). */
export const CURRENT_APP_GUID = '32e9e1af-301a-5c43-9c00-ff00f8ecd7ff'
/** NSIS GUID of the pre-rebrand product (`ai.deepseek.dsh.desktop`, PicoAide). */
export const LEGACY_APP_GUID = '85820364-4c28-594e-b046-8896b3669248'
/** Installer exit code the migration shim uses for a legacy installation. */
export const LEGACY_ABORT_EXIT_CODE = 2
/** Diagnostic file the migration shim always writes before aborting. */
export const LEGACY_DIAGNOSTIC_FILE = 'zeokeel-harness-legacy-install.txt'
/** Product executable name inside the install directory. */
export const APPLICATION_FILE = 'ZeoKeel Harness.exe'
/** Notices delivered through `extraResources` (one-click installers have no EULA page). */
export const REQUIRED_RESOURCE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md']

/** Hard limits for one installer/uninstaller invocation. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const UNINSTALL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Run one process with a hard timeout.
 *
 * On timeout the child is killed and the promise rejects — the caller must fail
 * the gate rather than let a hung installer block CI.
 * @param file - executable path.
 * @param args - arguments.
 * @param timeoutMs - hard limit.
 * @returns exit code plus captured output.
 */
export function runWithTimeout(file, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (cause) {
      rejectPromise(cause)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      rejectPromise(new Error(`timed out after ${String(timeoutMs)}ms: ${file} ${args.join(' ')}`))
    }, timeoutMs)
    child.once('error', cause => {
      clearTimeout(timer)
      rejectPromise(cause)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (signal !== null) {
        rejectPromise(new Error(`${file} terminated by ${signal}`))
        return
      }
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Run `reg.exe` and capture output (`execFile` keeps it simple and bounded). */
function regQuery(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), args, {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (cause, stdout, stderr) => {
      if (cause !== null) rejectPromise(Object.assign(cause, { stdout, stderr }))
      else resolvePromise(stdout)
    })
  })
}

/** Read `InstallLocation` from one registry key, or undefined when it is absent. */
export async function readInstallLocation(hive, guid) {
  try {
    const stdout = await regQuery(['query', `${hive}\\Software\\${guid}`, '/v', 'InstallLocation'])
    const match = /InstallLocation\s+REG_\w+\s+(.+?)\s*$/mu.exec(stdout)
    return match?.[1]?.trim() || undefined
  } catch {
    return undefined
  }
}

/** Delete one registry key (best effort; a missing key is success). */
async function deleteRegistryKey(hive, guid) {
  try {
    await regQuery(['delete', `${hive}\\Software\\${guid}`, '/f'])
  } catch {
    // Absent key: nothing to clean up.
  }
}

/** Create one registry key with an InstallLocation value. */
async function seedInstallLocation(hive, guid, directory) {
  const key = `${hive}\\Software\\${guid}`
  await regQuery(['add', key, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', directory, '/f'])
}

/** Find the generated NSIS uninstaller in an installation directory. */
export function findUninstaller(entries) {
  return entries.find(entry => /^Uninstall .*\.exe$/u.test(entry))
}

/** Filesystem operations the gate needs (tests inject a fake). */
const REAL_FS = {
  exists: path => existsSync(path),
  size: path => statSync(path).size,
  list: directory => readdirSync(directory),
  remove: (path, recursive) => { rmSync(path, { recursive, force: true }) },
}

/** Registry operations the gate needs (tests inject a fake). */
const REAL_REGISTRY = {
  read: readInstallLocation,
  seed: seedInstallLocation,
  delete: deleteRegistryKey,
}

/** Assert a file exists and is non-empty. */
function assertFile(path, fs) {
  if (!fs.exists(path)) throw new Error(`missing file: ${path}`)
  if (fs.size(path) === 0) throw new Error(`empty file: ${path}`)
}

/**
 * Run the full behaviour gate.
 * @param installerPath - absolute installer path.
 * @param options - injectable pieces for focused tests.
 * @returns the install directory that was verified.
 */
export async function verifyInstallerRuntime(installerPath, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error(`installer runtime verification requires Windows, got ${platform}`)
  const run = options.run ?? runWithTimeout
  const fs = options.fs ?? REAL_FS
  const registry = options.registry ?? REAL_REGISTRY
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA
  if (localAppData === undefined || localAppData === '') throw new Error('LOCALAPPDATA is not set')
  const temporaryRoot = options.temporaryRoot ?? tmpdir()
  const installDir = options.installDir ?? join(localAppData, 'Programs', 'dsh-plugin-desktop')
  const diagnosticPath = join(temporaryRoot, LEGACY_DIAGNOSTIC_FILE)
  const legacyFakeDir = options.legacyScratchDir ?? mkdtempSync(join(temporaryRoot, 'dsh-legacy-'))
  const steps = []

  try {
    // ---- preflight -------------------------------------------------------
    if (fs.exists(installDir)) throw new Error(`installation already exists: ${installDir}`)
    for (const [hive, guid] of [['HKCU', CURRENT_APP_GUID], ['HKLM', CURRENT_APP_GUID], ['HKLM', LEGACY_APP_GUID]]) {
      if (await registry.read(hive, guid) !== undefined) {
        throw new Error(`registry already has ${hive}\\Software\\${guid}; run this gate on a clean runner`)
      }
    }
    fs.remove(diagnosticPath, false)
    steps.push('preflight')

    // ---- 1. legacy migration is refused -------------------------------
    await registry.seed('HKLM', LEGACY_APP_GUID, legacyFakeDir)
    try {
      const legacyRun = await run(installerPath, ['/S'], INSTALL_TIMEOUT_MS)
      if (legacyRun.code !== LEGACY_ABORT_EXIT_CODE) {
        throw new Error(`legacy abort must exit ${LEGACY_ABORT_EXIT_CODE}, got ${legacyRun.code}`)
      }
      if (fs.exists(installDir)) throw new Error(`legacy abort still installed into ${installDir}`)
      assertFile(diagnosticPath, fs)
      steps.push('legacy-abort')
    } finally {
      await registry.delete('HKLM', LEGACY_APP_GUID)
      fs.remove(legacyFakeDir, true)
      fs.remove(diagnosticPath, false)
    }

    // ---- 2. silent install --------------------------------------------
    const install = await run(installerPath, ['/S'], INSTALL_TIMEOUT_MS)
    if (install.code !== 0) throw new Error(`silent install failed with exit code ${String(install.code)}`)
    assertFile(join(installDir, APPLICATION_FILE), fs)
    for (const notice of REQUIRED_RESOURCE_FILES) assertFile(join(installDir, 'resources', notice), fs)
    if (await registry.read('HKCU', CURRENT_APP_GUID) !== installDir) {
      throw new Error('silent install did not record the HKCU InstallLocation')
    }
    if (await registry.read('HKLM', CURRENT_APP_GUID) !== undefined) {
      throw new Error('silent install wrote an HKLM key (must be per-user only)')
    }
    steps.push('silent-install')

    // ---- 3. reinstall stays single ------------------------------------
    const reinstall = await run(installerPath, ['/S'], INSTALL_TIMEOUT_MS)
    if (reinstall.code !== 0) throw new Error(`reinstall failed with exit code ${String(reinstall.code)}`)
    if (await registry.read('HKCU', CURRENT_APP_GUID) !== installDir) {
      throw new Error('reinstall changed the installation directory')
    }
    steps.push('reinstall-single')

    // ---- 4. silent uninstall ------------------------------------------
    const uninstaller = findUninstaller(fs.list(installDir))
    if (uninstaller === undefined) throw new Error(`no uninstaller found in ${installDir}`)
    const uninstall = await run(join(installDir, uninstaller), ['/S'], UNINSTALL_TIMEOUT_MS)
    if (uninstall.code !== 0) throw new Error(`silent uninstall failed with exit code ${String(uninstall.code)}`)
    if (fs.exists(installDir)) throw new Error(`uninstall left files behind: ${installDir}`)
    if (await registry.read('HKCU', CURRENT_APP_GUID) !== undefined) {
      throw new Error('uninstall left the HKCU install key behind')
    }
    steps.push('silent-uninstall')

    return { installDir, steps }
  } finally {
    fs.remove(legacyFakeDir, true)
  }
}

async function main(argv) {
  const installerPath = argv[2]
  if (installerPath === undefined) {
    console.error('usage: verify-win-installer-runtime.mjs <Setup.exe>')
    return 2
  }
  const result = await verifyInstallerRuntime(installerPath)
  console.log(`installer runtime ok: ${result.installDir} [${result.steps.join(' → ')}]`)
  return 0
}

if (isDirectInvocation(import.meta)) {
  main(process.argv)
    .then(code => { process.exitCode = code })
    .catch(cause => {
      console.error(`verify-win-installer-runtime: ${cause instanceof Error ? cause.message : String(cause)}`)
      process.exitCode = 1
    })
}
