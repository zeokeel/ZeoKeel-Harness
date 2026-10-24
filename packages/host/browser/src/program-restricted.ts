/**
 * Restricted program executor (user decision **B**, 2026-10-23).
 *
 * `browser_run` promises **no filesystem / network / process**. Upstream
 * `ctx.ptcRuntime` cannot provide that (its Node backend leaves ambient Node APIs
 * reachable), so this module runs the script inside `vm` with a context that
 * contains ONLY the bridge helpers and a minimal console. The child-process
 * bootstrap (program-ptc.ts protocol) uses the same context constructor.
 *
 * HONEST BOUNDARY: a `vm` context is not an OS-level sandbox. What this does and
 * does not guarantee is documented in
 * `docs/planning/2026-10-23-browser-run-design.md`; the capability promise relies
 * on (a) never passing fs/net/process objects, (b) a strict static denylist, and
 * (c) running the code in a separate process so a crash/escape cannot reach the
 * host's memory directly. This is a product boundary, not a security boundary
 * against a hostile local operator.
 * @module @zeokeel/dsh-browser
 */

import { createContext, runInContext } from 'node:vm'

/** Names refused anywhere in a program (capability promise). */
export const PROGRAM_DENIED_IDENTIFIERS: readonly string[] = [
  'require', 'process', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'child_process', 'fs', 'net', 'http', 'https', 'dns', 'import',
  'globalThis', 'global', 'module', 'exports', '__dirname', '__filename',
]

/**
 * Refuse a program that references a denied identifier as a WORD (not inside a
 * string/comment is not attempted: this is a second layer, the vm context is the
 * first, and the honest boundary note above applies).
 * @param program - script source.
 */
export function assertProgramAllowed(program: string): void {
  for (const name of PROGRAM_DENIED_IDENTIFIERS) {
    const pattern = new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`, 'u')
    if (pattern.test(program)) {
      throw new Error(`browser_run: the program references a forbidden capability (${name}) — only the browser helpers are available`)
    }
  }
}

/** Console lines captured from the program. */
export interface RestrictedRunResult {
  readonly result: unknown
  readonly console: string
}

/**
 * Run a program in the restricted context.
 * @param program - script source (function body with top-level await/return).
 * @param bridge - the frozen browser helper object.
 * @returns the completion value and captured console text.
 */
export async function runRestrictedProgram(
  program: string,
  bridge: Readonly<Record<string, unknown>>,
): Promise<RestrictedRunResult> {
  assertProgramAllowed(program)
  const logs: string[] = []
  const record = (level: string) => (...args: unknown[]) => {
    logs.push(`${level}: ${args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')}`)
  }
  // No eval/Function compilation inside the program's realm: the classic
  // `({}).constructor.constructor('return process')()` vm escape needs it.
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  // Only these three globals exist in the program's world.
  const sandbox = context as unknown as Record<string, unknown>
  sandbox['browser'] = bridge
  sandbox['console'] = { log: record('log'), error: record('error'), warn: record('warn'), info: record('info') }
  const source = `(async () => {\n${program}\n})()`
  const value = await runInContext(source, context, { timeout: 120_000, displayErrors: false })
  return { result: value === undefined ? null : value, console: logs.join('\n') }
}
