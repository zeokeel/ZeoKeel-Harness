/**
 * Process-backed programming runtime tests (2026-10-23).
 * A fake child proves the CANCELLATION contract (audit R2/R3): abort/deadline
 * kill the process and await its exit, and helper errors travel back verbatim.
 */
import { describe, expect, it, vi } from 'vitest'
import { createPtcProgramRuntime, type ProgramChild } from '../src/program-ptc.ts'

function fakeChild(): { child: ProgramChild, emit: (message: unknown) => void, emitRaw: (chunk: Buffer) => void, end: () => void, written: string[], killed: () => boolean, exitNow: (code?: number) => void } {
  const output: Array<(chunk: string) => void> = []
  const ends: Array<() => void> = []
  let exitResolve: (code: number) => void = () => {}
  let exited = false
  const written: string[] = []
  let wasKilled = false
  const child: ProgramChild = {
    stdin: { write: (chunk: string) => { written.push(chunk) } },
    stdout: { on: (event: string, listener: (chunk?: Buffer | string) => void) => { if (event === 'end') ends.push(() => listener()); else output.push(listener) } },
    kill: () => { wasKilled = true; if (!exited) { exited = true; exitResolve(137) } },
    exit: new Promise<number>(resolve => { exitResolve = (code) => { exited = true; resolve(code) } }),
  }
  const emitRaw = (chunk: Buffer): void => { for (const listener of output) listener(chunk) }
  return {
    child,
    emit: (message) => { for (const listener of output) listener(`${JSON.stringify(message)}\n`) },
    emitRaw,
    end: () => { for (const listener of ends) listener() },
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

  it('a child that exits without a result fails fast (no 120s hang)', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const pending = runtime.execute('x', {})
    fake.exitNow(0)
    await expect(pending).rejects.toThrow(/before returning a result/u)
  })

  it('an already-aborted signal never spawns a process', async () => {
    let spawned = 0
    const runtime = createPtcProgramRuntime({ spawn: () => { spawned += 1; return fakeChild().child } })
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.execute('x', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'interrupted' })
    expect(spawned).toBe(0)
  })

  it('decodes multi-byte UTF-8 split across chunk boundaries', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const pending = runtime.execute('x', {})
    const bytes = Buffer.from(`${JSON.stringify({ type: 'result', result: '中文é' })}\n`, 'utf8')
    const cut = bytes.indexOf(Buffer.from('中', 'utf8')) + 1
    fake.emitRaw(bytes.subarray(0, cut))
    fake.emitRaw(bytes.subarray(cut))
    await expect(pending).resolves.toMatchObject({ result: '中文é' })
  })

  it('flushes a final message without a trailing newline on stdout end', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const pending = runtime.execute('x', {})
    fake.emitRaw(Buffer.from(JSON.stringify({ type: 'result', result: 7 }), 'utf8'))
    fake.end()
    await expect(pending).resolves.toMatchObject({ result: 7 })
  })

  it('caps console bytes and rejects an oversized bridge message', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const pending = runtime.execute('x', {})
    for (let index = 0; index < 2_000; index += 1) fake.emit({ type: 'console', text: 'x'.repeat(100) })
    fake.emit({ type: 'result', result: null })
    await expect(pending).resolves.toMatchObject({ result: null, console: expect.stringContaining('console output truncated') })
    const fake2 = fakeChild()
    const runtime2 = createPtcProgramRuntime({ spawn: () => fake2.child })
    const pending2 = runtime2.execute('x', {})
    // An INCOMPLETE line over the cap (no newline yet) is refused.
    fake2.emitRaw(Buffer.from('y'.repeat(2 * 1024 * 1024), 'utf8'))
    await expect(pending2).rejects.toThrow(/1 MiB limit/u)
  })

  it('a helper result over 4 MiB is replaced by an error line; 3 MiB passes', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const pending = runtime.execute('x', {
      big: () => Promise.resolve('x'.repeat(5 * 1024 * 1024)),
      medium: () => Promise.resolve('y'.repeat(3 * 1024 * 1024)),
    })
    fake.emit({ type: 'call', id: 1, tool: 'big', args: {} })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(fake.written.join('')).toContain('4 MiB bridge limit')
    fake.emit({ type: 'call', id: 2, tool: 'medium', args: {} })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fake.written.join('')).toContain('"id":2')
    fake.emit({ type: 'result', result: null })
    await expect(pending).resolves.toMatchObject({ result: null })
  })

  it('several legal lines arriving in one chunk are not mistaken for an oversized line', async () => {
    const fake = fakeChild()
    const runtime = createPtcProgramRuntime({ spawn: () => fake.child })
    const pending = runtime.execute('x', {})
    const batch = [1, 2, 3].map(() => JSON.stringify({ type: 'console', text: 'z'.repeat(500 * 1024) })).join('\n') + '\n'
    fake.emitRaw(Buffer.from(batch, 'utf8'))
    fake.emit({ type: 'result', result: 'ok' })
    await expect(pending).resolves.toMatchObject({ result: 'ok' })
  })
})
