/**
 * Process-backed programming runtime for `browser_run` (2026-10-23).
 *
 * This adapter defines the host contract (a child process speaking a JSON-line
 * bridge protocol over stdio) and the CANCELLATION contract audit R2/R3 asked
 * for: abort/takeover/deadline KILL the child and await its exit, so no in-flight
 * CDP command can keep the global browser mutex. The actual ptc runtime
 * (`@deepseek-ai/dsh-ptc-runtime-node`) is wired by the HOST package: it passes a
 * `spawn` that starts the isolated process.
 * @module @zeokeel/dsh-browser
 */

import { StringDecoder } from 'node:string_decoder'
import type { ProgramRuntime } from './program.ts'

/** Minimal child-process surface the adapter needs (mockable). */
export interface ProgramChild {
  readonly pid?: number
  /** stdin/stdout are line-oriented JSON channels. */
  readonly stdin: { write(chunk: string): boolean | void } | null
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  kill(signal?: string): void
  /** Resolves once the OS process is gone (never a zombie). */
  readonly exit: Promise<number>
}

/** Messages the child may send. */
type ChildMessage =
  | { type: 'call'; id: number; tool: string; args: Record<string, unknown> }
  | { type: 'console'; text: string }
  | { type: 'result'; result: unknown }
  | { type: 'error'; message: string }

/** Maximum bytes of one bridge line (a hostile/large result must not hang the parser). */
export const PTC_MAX_LINE_BYTES = 1024 * 1024
/** Console bytes accepted from the child (the tool re-caps for the model). */
export const PTC_MAX_CONSOLE_BYTES = 64 * 1024
/** Bridge result size cap (screenshot base64 must NOT cross this as a helper result). */
export const PTC_MAX_RESULT_BYTES = 4 * 1024 * 1024

export interface PtcRuntimeOptions {
  /** Start one isolated process (host wired; one per run, never shared). */
  spawn: (program: string) => ProgramChild
  /** Hard wall-clock cap (deadline). */
  timeoutMs?: number
}

/**
 * Create the `ProgramRuntime` used by `runtime.runProgram`.
 * @param options - spawn factory plus timeout.
 * @returns a runtime whose execute() kills the child on abort/deadline.
 */
export function createPtcProgramRuntime(options: PtcRuntimeOptions): ProgramRuntime {
  return {
    async execute(program, bridge, execOptions) {
      // An already-aborted signal must not spawn a process that would run to the
      // deadline (addEventListener never fires for an already-aborted signal).
      if (execOptions?.signal?.aborted === true) throw Object.assign(new Error('browser_run: cancelled'), { code: 'interrupted' })
      const child = options.spawn(program)
      const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000)
      let killed = false
      const kill = async (): Promise<void> => {
        if (killed) return
        killed = true
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        // R2: await the OS exit so the next browser tool cannot inherit a lock.
        await Promise.race([child.exit, new Promise<void>(resolve => setTimeout(resolve, 5_000).unref?.())])
      }
      const onAbort = (): void => { void kill() }
      execOptions?.signal?.addEventListener('abort', onAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await new Promise<{ result: unknown, console: string }>((resolve, reject) => {
          let consoleText = ''
          let consoleBytes = 0
          let buffer = ''
          const decoder = new StringDecoder('utf8')
          let settled = false
          const settle = (fn: () => void): void => { if (settled) return; settled = true; fn() }
          const fail = (error: unknown): void => {
            if (settled) return
            settled = true
            void kill().finally(() => reject(error))
          }
          timer = setTimeout(() => { fail(Object.assign(new Error('browser_run: the program deadline passed'), { code: 'timeout' })) }, timeoutMs)
          execOptions?.signal?.addEventListener('abort', () => fail(Object.assign(new Error('browser_run: cancelled'), { code: 'interrupted' })), { once: true })
          child.stdout?.on('data', (chunk) => {
            // Decode across chunk boundaries: a multi-byte UTF-8 character split
            // between two chunks must not corrupt (or silently drop) a message.
            buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
            if (Buffer.byteLength(buffer, 'utf8') > PTC_MAX_LINE_BYTES) {
              fail(new Error('browser_run: a bridge message exceeded the 1 MiB limit'))
              return
            }
            let index = buffer.indexOf('\n')
            while (index >= 0) {
              const line = buffer.slice(0, index)
              buffer = buffer.slice(index + 1)
              index = buffer.indexOf('\n')
              if (line.trim() === '') continue
              let message: ChildMessage
              try { message = JSON.parse(line) as ChildMessage } catch { continue }
              if (message.type === 'console') {
                consoleBytes += Buffer.byteLength(message.text, 'utf8') + 1
                if (consoleBytes > PTC_MAX_CONSOLE_BYTES) { consoleText += '\n… (console output truncated)\n'; continue }
                consoleText += `${message.text}\n`
                continue
              }
              if (message.type === 'result') { settle(() => resolve({ result: message.result, console: consoleText })); return }
              if (message.type === 'error') { fail(new Error(message.message)); return }
              if (message.type === 'call') {
                const helper = (bridge as Record<string, unknown>)[message.tool]
                if (typeof helper !== 'function') {
                  child.stdin?.write(`${JSON.stringify({ id: message.id, error: `browser_run: unknown helper ${message.tool}` })}\n`)
                  continue
                }
                void (helper as (args: unknown) => Promise<unknown>)(message.args).then(
                  result => {
                    const line = JSON.stringify({ id: message.id, result })
                    if (Buffer.byteLength(line, 'utf8') > PTC_MAX_RESULT_BYTES) {
                      child.stdin?.write(`${JSON.stringify({ id: message.id, error: 'browser_run: helper result exceeds the 4 MiB bridge limit (return an attachment reference instead of raw bytes)' })}\n`)
                      return
                    }
                    child.stdin?.write(`${line}\n`)
                  },
                  error => child.stdin?.write(`${JSON.stringify({ id: message.id, error: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code })}\n`),
                )
              }
            }
          })
          // Exit WITHOUT a result is a protocol failure regardless of the code:
          // a crashed adapter must not hang the run until the deadline.
          child.exit.then(code => { if (!settled) fail(new Error(`browser_run: the program process exited (code ${String(code)}) before returning a result`)) }).catch(error => fail(error))
        })
        return outcome
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        execOptions?.signal?.removeEventListener('abort', onAbort)
        await kill()
      }
    },
  }
}
