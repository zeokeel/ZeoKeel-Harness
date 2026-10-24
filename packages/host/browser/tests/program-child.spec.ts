/**
 * Child-process integration (decision B): the REAL restricted executor runs in a
 * Node child and the adversarial probes are re-run there — the child's own Node
 * globals are the risk surface, so only structured results cross the bridge.
 */
import { spawn as spawnProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { childBootstrapSource } from '../src/program-child.ts'
import { createPtcProgramRuntime, type ProgramChild } from '../src/program-ptc.ts'

const NAMES = ['obj', 'fail'] as const

function runtime() {
  const exits: number[] = []
  const rt = createPtcProgramRuntime({
    spawn: (program: string): ProgramChild => {
      const source = childBootstrapSource(NAMES)
      const child = spawnProcess(process.execPath, ['-e', source, program], { stdio: ['pipe', 'pipe', 'pipe'] })
      const exit = new Promise<number>((resolve) => { child.on('exit', code => { exits.push(code ?? -1); resolve(code ?? -1) }) })
      return { stdin: child.stdin, stdout: child.stdout, kill: () => { child.kill('SIGKILL') }, exit }
    },
    timeoutMs: 10_000,
  })
  return { rt, exits }
}

const bridge = {
  obj: async () => ({ a: 1, nested: { b: 2 } }),
  fail: async () => { throw Object.assign(new Error('refused by policy'), { code: 'policy' }) },
}

describe('child bootstrap', () => {
  it('round-trips values/console and has no ambient capabilities in the child', async () => {
    const { rt } = runtime()
    const probe = await rt.execute(`console.log('child-hi'); const v = await browser.obj(); return { a: v.a, b: v.nested.b, proc: typeof globalThis['pro' + 'cess'], req: typeof globalThis['re' + 'quire'], fetch: typeof globalThis['fet' + 'ch'] }`, bridge)
    expect(probe.result).toEqual({ a: 1, b: 2, proc: 'undefined', req: 'undefined', fetch: 'undefined' })
    expect(probe.console).toContain('child-hi')
  })

  it('context-realm constructor chains and dynamic import are refused in the child', async () => {
    const { rt } = runtime()
    await expect(rt.execute('return (await browser.obj()).constructor.constructor("return 1")()', bridge))
      .rejects.toThrow(/Code generation|code generation/u)
    await expect(rt.execute('return await import("node:fs")', bridge)).rejects.toBeTruthy()
  })

  it('helper errors arrive as structured context errors (code preserved)', async () => {
    const { rt } = runtime()
    const outcome = await rt.execute('try { await browser.fail() } catch (error) { return { code: error.code, isError: error instanceof Error } }', bridge)
    expect(outcome.result).toEqual({ code: 'policy', isError: true })
  })

  it('a synchronous infinite loop is killable by the parent (SIGKILL + awaited exit)', async () => {
    const { rt, exits } = runtime()
    const controller = new AbortController()
    const started = Date.now()
    const pending = rt.execute('while (true) {}', bridge, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 100))
    controller.abort()
    await expect(pending).rejects.toBeTruthy()
    expect(Date.now() - started).toBeLessThan(2_000)
    await expect.poll(() => exits.length, { timeout: 2_000 }).toBe(1)
  }, 20_000)
})
