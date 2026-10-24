/**
 * Child-process integration (decision B): the REAL restricted executor runs in a
 * Node child and the adversarial probes are re-run there — the child's own Node
 * globals are the risk surface, so only structured results cross the bridge.
 */
import { spawn as spawnProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { childBootstrapSource, childSpawnEnv, createRestrictedProgramRuntime } from '../src/program-child.ts'
import { PTC_MAX_PROGRAM_BYTES, createPtcProgramRuntime, type ProgramChild } from '../src/program-ptc.ts'

const NAMES = ['obj', 'fail'] as const

function runtime() {
  const exits: number[] = []
  const rt = createPtcProgramRuntime({
    spawn: (program: string): ProgramChild => {
      const source = childBootstrapSource(NAMES)
      // The program travels over stdin, never argv (argv is visible in ps).
      const child = spawnProcess(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
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

  it('the temporary host callback is deleted before user code runs', async () => {
    const { rt } = runtime()
    const probe = await rt.execute(`const host = globalThis['__host' + 'Invoke'];
      return { visible: typeof host, escape: typeof host === 'function' ? (() => { try { return host.constructor.constructor('return typeof pro' + 'cess')() } catch { return 'blocked' } })() : 'n/a' }`, bridge)
    expect(probe.result).toEqual({ visible: 'undefined', escape: 'n/a' })
  })

  it('a program larger than 256 KiB is refused before spawning', async () => {
    let spawned = 0
    const rt = createPtcProgramRuntime({ spawn: (): ProgramChild => { spawned += 1; throw new Error('must not spawn') } })
    await expect(rt.execute('x'.repeat(PTC_MAX_PROGRAM_BYTES + 1), bridge)).rejects.toMatchObject({ code: 'policy' })
    expect(spawned).toBe(0)
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

describe('child spawn environment', () => {
  it('sets ELECTRON_RUN_AS_NODE only for an Electron parent and strips loaders', () => {
    const parentEnv = { NODE_OPTIONS: '-r evil.js', NODE_PATH: '/tmp/modules', PATH: '/usr/bin', HOME: '/home/u' }
    const electron = childSpawnEnv({ electron: '44.0.0', node: '22.0.0' }, parentEnv)
    expect(electron['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(electron['NODE_OPTIONS']).toBeUndefined()
    expect(electron['NODE_PATH']).toBeUndefined()
    expect(electron['PATH']).toBe('/usr/bin')
    const node = childSpawnEnv({ node: '22.0.0' }, parentEnv)
    expect(node['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    expect(node['NODE_OPTIONS']).toBeUndefined()
  })
})

describe('production wiring', () => {
  it('the factory runs a program through a real child with the helper bridge', async () => {
    const rt = createRestrictedProgramRuntime(['ping'])
    const outcome = await rt.execute('const env = ((await browser.ping()).pong); return { env }', { ping: async () => ({ pong: 7 }) })
    expect(outcome.result).toEqual({ env: 7 })
  }, 20_000)
})
