/**
 * Verify the **payload** inside a Windows NSIS installer (behavior-level gate).
 *
 * Why: `verify-win-installer.ts` only checks PE headers and the unpacked
 * `win-unpacked/` tree. The one-click installer no longer shows a license page,
 * so the MIT text and third-party notices must travel inside the installer
 * payload — and nothing verified that they actually do (2026-10-21 packaging
 * review, P6). This script opens the installer the same way NSIS does: the
 * `$PLUGINSDIR` payload archive (`app-64.zip` with `useZip: true`) carries
 * `resources/LICENSE` and `resources/THIRD_PARTY_NOTICES.md`.
 *
 * Usage (Linux CI or Windows):
 *   node packages/host/desktop/scripts/verify-win-installer-payload.mjs <Setup.exe>
 *
 * Requires a 7-Zip CLI (`7z`, `7za`, `7zz`, or `SEVEN_ZIP=/path/to/7z`).
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { isDirectInvocation } from './direct-invocation.mjs'

const execFileAsync = promisify(execFile)

/** Payload files every installer must carry (extraResources in package.json). */
export const REQUIRED_PAYLOAD_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md']
/** Archive names electron-builder may produce for the app payload. */
export const PAYLOAD_ARCHIVE_PATTERN = /^app-(?:64|x64)\.(?:zip|7z)$/u

/**
 * Find the app payload archive in an extracted installer tree.
 * @param files - flat list of relative paths (POSIX separators).
 * @returns the matching relative path, or undefined.
 */
export function findPayloadArchive(files) {
  return files.find(file => PAYLOAD_ARCHIVE_PATTERN.test(basename(file)))
}

/**
 * Locate a 7-Zip CLI.
 * @param env - environment (`SEVEN_ZIP` override).
 * @param exists - existence probe (tests).
 * @returns absolute/bare command name.
 */
export function resolveSevenZip(env = process.env, exists = existsSync) {
  const override = env.SEVEN_ZIP?.trim()
  if (override !== undefined && override !== '') {
    if (!exists(override)) throw new Error(`SEVEN_ZIP does not exist: ${override}`)
    return override
  }
  // GitHub's windows-latest image installs 7-Zip outside PATH sometimes; probe the
  // two standard locations before falling back to a bare command name.
  for (const candidate of [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]) {
    if (exists(candidate)) return candidate
  }
  return '7z'
}

/** Extract an archive into a directory and return the extracted relative paths. */
async function extract(sevenZip, archive, destination) {
  await execFileAsync(sevenZip, ['x', '-y', `-o${destination}`, archive], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const files = []
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(directory, entry.name), relative)
      else files.push(relative)
    }
  }
  walk(destination, '')
  return files
}

/**
 * Verify one installer's payload.
 * @param installerPath - absolute `.exe` path.
 * @param options - injectable helpers (tests).
 * @returns names of the verified files.
 */
export async function verifyInstallerPayload(installerPath, options = {}) {
  const sevenZip = options.sevenZip ?? resolveSevenZip()
  const staging = options.staging ?? mkdtempSync(join(tmpdir(), 'dsh-installer-payload-'))
  const cleanup = options.cleanup ?? (() => { rmSync(staging, { recursive: true, force: true }) })
  const extractArchive = options.extract ?? extract
  const sizeOf = options.size ?? (path => statSync(path).size)
  try {
    const installerFiles = await extractArchive(sevenZip, installerPath, join(staging, 'installer'))
    const payloadArchive = findPayloadArchive(installerFiles)
    if (payloadArchive === undefined) {
      throw new Error(`installer payload archive (app-64.zip/app-64.7z) not found in ${basename(installerPath)}`)
    }
    const payloadFiles = await extractArchive(
      sevenZip,
      join(staging, 'installer', payloadArchive),
      join(staging, 'payload'),
    )
    const missing = []
    for (const required of REQUIRED_PAYLOAD_FILES) {
      const match = payloadFiles.find(file => file === `resources/${required}`
        || file.endsWith(`/resources/${required}`))
      if (match === undefined) {
        missing.push(required)
        continue
      }
      const size = sizeOf(join(staging, 'payload', match))
      if (size === 0) throw new Error(`installer payload carries an empty resources/${required}`)
    }
    if (missing.length > 0) {
      throw new Error(`installer payload is missing resources/${missing.join(', resources/')}`)
    }
    const executable = payloadFiles.find(file => /(?:^|\/)ZeoKeel Harness\.exe$/u.test(file))
    if (executable === undefined) throw new Error('installer payload does not contain the application executable')
    return { payloadArchive, files: [...REQUIRED_PAYLOAD_FILES] }
  } finally {
    cleanup()
  }
}

async function main(argv) {
  const installerPath = argv[2]
  if (installerPath === undefined) {
    console.error('usage: verify-win-installer-payload.mjs <Setup.exe>')
    return 2
  }
  if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin') {
    console.error(`verify-win-installer-payload: unsupported platform ${process.platform}`)
    return 1
  }
  const result = await verifyInstallerPayload(installerPath)
  console.log(`installer payload ok: ${result.payloadArchive} carries ${result.files.join(', ')}`)
  return 0
}

if (isDirectInvocation(import.meta)) {
  main(process.argv)
    .then(code => { process.exitCode = code })
    .catch(cause => {
      console.error(`verify-win-installer-payload: ${cause instanceof Error ? cause.message : String(cause)}`)
      process.exitCode = 1
    })
}
