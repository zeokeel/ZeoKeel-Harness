#!/usr/bin/env node
/**
 * Packaged/Electron E2E probe for `browser_run` (2026-10-23).
 *
 * Runs the REAL restricted-program runtime inside the packaged Electron binary
 * (in its Node mode) so the production spawn path is exercised end to end:
 *   ELECTRON_RUN_AS_NODE=1 <packaged-binary> <harness.mjs>
 * The harness imports the built `lib/` of this package and asserts:
 *   1. `return 1 + 1` -> 2 and a helper bridge call round-trips;
 *   2. aborting `while(true){}` rejects in < 1 s AND the child exits (no zombie);
 *   3. a browser call AFTER the abort responds in < 1 s (no leftover lock).
 *
 * Prerequisites: a packaged binary (or an Electron dev binary) and a built
 * `lib/`. Missing prerequisites are a REGISTERED SKIP with a reason (never a
 * silent pass); any failing assertion exits non-zero.
 *
 *   node packages/host/browser/scripts/e2e-browser-run.mjs
 *   DSH_BROWSER_RUN_APP=/path/to/binary node ...   # override the binary
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

function skip(reason, hint) {
  console.log(`E2E-SKIP browser_run packaged probe: ${reason}`)
  if (hint !== undefined) console.log(`  hint: ${hint}`)
  process.exit(0)
}

const candidates = [
  process.env.DSH_BROWSER_RUN_APP,
  join(packageRoot, '..', 'desktop', 'dist', 'linux-unpacked', 'dsh-plugin-desktop'),
  join(packageRoot, '..', '..', '..', 'node_modules', 'electron', 'dist', 'electron'),
].filter((value) => typeof value === 'string' && value !== '')
const binary = candidates.find((candidate) => existsSync(candidate))
if (binary === undefined) {
  skip('missing-packaged-binary', 'build the desktop app (yarn build / dist:linux) or set DSH_BROWSER_RUN_APP')
}
if (!existsSync(join(packageRoot, 'lib', 'index.js'))) {
  skip('missing-browser-lib', 'build this package first: corepack yarn workspace @zeokeel/dsh-browser build')
}

const harness = `
import { spawn as spawnProcess } from 'node:child_process'
import assert from 'node:assert/strict'
import { createPtcProgramRuntime, childBootstrapSource, childSpawnEnv } from ${JSON.stringify(join(packageRoot, 'lib', 'index.js'))}

const NAME = 'ping'
const results = {}
const exits = []
const runtime = () => createPtcProgramRuntime({
  spawn: () => {
    const child = spawnProcess(process.execPath, ['-e', childBootstrapSource([NAME])], { stdio: ['pipe', 'pipe', 'pipe'], env: childSpawnEnv(process.versions, process.env) })
    const exit = new Promise((resolve) => { child.on('exit', (code) => { exits.push(code ?? -1); resolve(code ?? -1) }) })
    return { stdin: child.stdin, stdout: child.stdout, kill: () => { child.kill('SIGKILL') }, exit }
  },
})
const bridge = { ping: async () => ({ pong: 7 }) }

{
  const rt = runtime()
  const value = await rt.execute('return 1 + 1', {})
  assert.equal(value.result, 2, '1+1 must be 2')
  const helper = await rt.execute('return (await browser.ping()).pong', bridge)
  assert.equal(helper.result, 7, 'helper bridge must round-trip')
  results.arithmetic = value.result
  results.helper = helper.result
}

{
  const rt = runtime()
  const controller = new AbortController()
  const started = Date.now()
  const pending = rt.execute('while (true) {}', bridge, { signal: controller.signal }).then(() => 'ran', (error) => error)
  await new Promise((resolve) => setTimeout(resolve, 200))
  controller.abort()
  await pending
  results.abortMs = Date.now() - started
  assert.ok(results.abortMs < 1000, 'abort must stop the spinning child within 1s')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.notEqual(exits.at(-1), undefined, 'the child must have exited (no zombie)')

  // The NEXT call must not be blocked by the cancelled one.
  const next = runtime()
  const nextStarted = Date.now()
  const value = await next.execute('return 3', {})
  results.nextMs = Date.now() - nextStarted
  assert.equal(value.result, 3, 'a call after the abort must succeed')
  assert.ok(results.nextMs < 1000, 'the call after the abort must respond within 1s')
}

process.stdout.write('BROWSER-RUN-E2E ' + JSON.stringify({ ok: true, ...results }) + '\\n')
`

const dir = mkdtempSync(join(tmpdir(), 'dsh-browser-run-e2e-'))
const harnessPath = join(dir, 'harness.mjs')
writeFileSync(harnessPath, harness, 'utf8')
try {
  // ELECTRON_RUN_AS_NODE mode is Node's CLI: no Chromium flags here.
  const child = spawn(binary, [harnessPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const code = await new Promise((resolve) => { child.on('exit', (value) => resolve(value ?? -1)) })
  const line = stdout.split('\n').find((value) => value.startsWith('BROWSER-RUN-E2E '))
  if (code === 0 && line !== undefined) {
    console.log(line)
    console.log(`E2E-PASS browser_run packaged probe (binary: ${binary})`)
    process.exit(0)
  }
  console.error(`E2E-FAIL browser_run packaged probe (binary: ${binary}, exit ${String(code)})`)
  console.error(stdout)
  console.error(stderr)
  process.exit(1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
