/**
 * Process-backed programming runtime tests (2026-10-23).
 * A fake child proves the CANCELLATION contract (audit R2/R3): abort/deadline
 * kill the process and await its exit, and helper errors travel back verbatim.
 */
import { describe, expect, it, vi } from 'vitest'
import { createPtcProgramRuntime, type ProgramChild } from '../src/program-ptc.ts'

function fakeChild(): { child: ProgramChild, emit: (message: unknown) => void, written: string[], killed: () => boolean, exitNow: (code?: number) => void } {
  const output: Array<(chunk: string) => void> = []
  let exitResolve: (code: number) => void = () => {}
  let exited = false
  const written: string[] = []
  let wasKilled = false
  const child: ProgramChild = {
    stdin: { write: (chunk: string) => { written.push(chunk) } },
    stdout: { on: (_event, listener) => { output.push(listener) } },
    kill: () => { wasKilled = true; if (!exited) { exited = true; exitResolve(137) } },
    exit: new Promise<number>(resolve => { exitResolve = (code) => { exited = true; resolve(code) } }),
  }
  return {
    child,
    emit: (message) => { for (const listener of output) listener(`${JSON.stringify(message)}\n`) },
    written,
    killed: () => wasKilled,
    exitNow: (code = 0) => exitResolve(code),
  }
}

describe('createPtcProgramRuntime', () => {
  it('collects console messages (controlled channel) and returns the result', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const pending = runtime.execute('x', {})
    fake.emit({ type: 'console', text: 'hello' })
    fake.emit({ type: 'result', result: { ok: 1 } })
    await expect(pending).resolves.toEqual({ result: { ok: 1 }, console: 'hello\n' })
  })

  it('routes a helper call through the bridge and returns the error code verbatim', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const pending = runtime.execute('x', {
      navigate: () => Promise.reject(Object.assign(new Error('navigation blocked'), { code: 'policy' })),
    })
    fake.emit({ type: 'call', id: 1, tool: 'navigate', args: {} })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fake.written.join('')).toContain('"code":"policy"')
    fake.emit({ type: 'result', result: null })
    await expect(pending).resolves.toMatchObject({ result: null })
  })

  it('abort kills the child and awaits its exit (no zombie, no inherited lock)', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const controller = new AbortController()
    const pending = runtime.execute('await sleep(60000)', {}, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'interrupted' })
    expect(fake.killed()).toBe(true)
  })

  it('the deadline also kills the process', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child, timeoutMs: 20 })
    await expect(runtime.execute('x', {})).rejects.toBeTruthy()
    expect(fake.killed()).toBe(true)
  })
})
