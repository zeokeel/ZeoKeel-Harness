/**
 * Restricted program executor (user decision **B**, 2026-10-23).
 *
 * `browser_run` promises **no filesystem / network / process**. The program runs
 * in a `vm` context whose globals are created INSIDE that context: the bridge
 * (`browser`) and `console` are context-realm objects whose methods close over a
 * single host callback that is deleted from the global scope right after
 * bootstrap. No host function/object is reachable from the program, so
 * `browser.method.constructor` / `console.log.constructor` / prototype walks all
 * reach the context's Function, whose string constructor is disabled by
 * `codeGeneration`.
 *
 * HONEST BOUNDARY: `vm` is not an OS-level sandbox. The capability promise is a
 * PRODUCT boundary built from: separate process, no fs/net/process objects, a
 * context-realm bridge, disabled code generation, a hard deadline, and the fact
 * that a local operator who can run code as this user can already run Node.
 * See `docs/planning/2026-10-23-browser-run-design.md`.
 * @module @zeokeel/dsh-browser
 */

import { createContext, runInContext } from 'node:vm'

/** One helper call that escapes to the host. */
export type RestrictedInvoke = (helper: string, args: unknown[]) => Promise<unknown>

/** Console lines captured from the program. */
export interface RestrictedRunResult {
  readonly result: unknown
  readonly console: string
}

/** A sandbox with a bootstrapped bridge. */
export interface RestrictedExecutor {
  run(program: string): Promise<RestrictedRunResult>
}

/**
 * Build a restricted executor for the given helper names.
 * @param names - bridge method names (the program's only capability).
 * @param invoke - host callback the context-realm methods call.
 * @param timeoutMs - synchronous-execution cap (async work is bounded by the caller).
 * @returns an executor whose `run` evaluates one program.
 */
export function createRestrictedExecutor(
  names: readonly string[],
  invoke: RestrictedInvoke,
  timeoutMs = 120_000,
): RestrictedExecutor {
  return {
    async run(program: string): Promise<RestrictedRunResult> {
      const logs: string[] = []
      const context = createContext(Object.create(null), {
        codeGeneration: { strings: false, wasm: false },
      })
      const sandbox = context as unknown as Record<string, unknown>
      // The ONE host reference placed in the context. Every value crossing it is a
      // JSON STRING: host objects/errors can never reach the program's realm, so
      // `result.constructor.constructor` and caught-error prototype walks stay in
      // the context realm (see the tests).
      sandbox['__hostInvoke'] = async (kind: string, payload: string, level?: string): Promise<string> => {
        if (kind === '__console__') {
          logs.push(`${level ?? 'log'}: ${payload}`)
          return 'null'
        }
        try {
          const args = JSON.parse(payload) as unknown[]
          const value = await invoke(kind, Array.isArray(args) ? args : [])
          return JSON.stringify({ value: value === undefined ? null : value })
        } catch (cause) {
          const error = cause as { code?: unknown, message?: unknown }
          return JSON.stringify({
            __error: true,
            code: typeof error.code === 'string' ? error.code : 'error',
            message: typeof error.message === 'string' ? error.message : String(cause),
          })
        }
      }
      const bootstrap = `(() => {
        const host = globalThis['__hostInvoke'];
        delete globalThis['__hostInvoke'];
        const serialize = (value) => {
          try { return JSON.stringify(value); } catch { return '"<unserializable>"'; }
        };
        const log = (level) => (...args) => { void host('__console__', args.map(serialize).join(' '), level); };
        const consoleObj = Object.freeze({ log: log('log'), error: log('error'), warn: log('warn'), info: log('info') });
        const browser = {};
        for (const name of ${JSON.stringify(names)}) {
          browser[name] = async (...args) => {
            const raw = await host(name, JSON.stringify(args.length === 0 ? [] : args));
            const envelope = JSON.parse(raw);
            if (envelope !== null && typeof envelope === 'object' && envelope.__error === true) {
              const error = new Error(String(envelope.message));
              error.code = String(envelope.code);
              throw error;
            }
            return envelope === null || typeof envelope !== 'object' ? null : envelope.value;
          };
        }
        Object.freeze(browser);
        Object.defineProperty(globalThis, 'browser', { value: browser, enumerable: false, configurable: false, writable: false });
        Object.defineProperty(globalThis, 'console', { value: consoleObj, enumerable: false, configurable: false, writable: false });
      })()`
      runInContext(bootstrap, context, { timeout: 1_000, displayErrors: true })
      const source = `(async () => {\n${program}\n})()`
      const value = await runInContext(source, context, { timeout: timeoutMs, displayErrors: false })
      return { result: value === undefined ? null : value, console: logs.join('\n') }
    },
  }
}
