/**
 * Page-side destructive-surface shim (2026-10-23 batch 1 audit P0 修复的运行时半边).
 *
 * 静态 AST 只能看见"写出来"的形态；审计实测的绕过都是**运行时才成形**的：
 * `localStorage.setItem.call(...)`、`Object.getOwnPropertyDescriptor(Document.prototype,
 * 'cookie').set.call(...)`、`window.eval('...')`、以及调用前就捕获好的别名。
 * 因此 `wrapEvalExpression` 在每次求值时安装一层页面内 shim（document 写 /
 * storage 写 / history 导航 / location 导航 / cookie setter / eval / Function），
 * 并在 `finally` 里逐条还原。
 *
 * 本文件用一个 `node:vm` 假 DOM 验证"装上了、真的拦得住、还原得回来"，
 * 不依赖 Electron / jsdom。
 */
import { describe, expect, it } from 'vitest'
import vm from 'node:vm'
import { EVAL_BLOCKED_MARKER, wrapEvalExpression } from '../src/eval-policy.ts'

interface FakeDom {
  readonly ctx: vm.Context
  readonly calls: string[]
  /** Run one program through the wrapper; resolves with its value. */
  run(code: string): Promise<unknown>
  /** Run one raw statement directly in the context (post-eval restore probe). */
  raw(code: string): unknown
}

function fakeDom(): FakeDom {
  const calls: string[] = []
  class Document {
    write(value: unknown): void { calls.push(`write:${String(value)}`); }
    writeln(value: unknown): void { calls.push(`writeln:${String(value)}`); }
    open(): void { calls.push('open'); }
    close(): void { calls.push('close'); }
    get cookie(): string { return ''; }
    set cookie(value: string) { calls.push(`cookie:${value}`); }
  }
  class Storage {
    setItem(key: unknown, value: unknown): void { calls.push(`setItem:${String(key)}=${String(value)}`); }
    removeItem(key: unknown): void { calls.push(`removeItem:${String(key)}`); }
    clear(): void { calls.push('clear'); }
    getItem(): string | null { return null; }
  }
  class History {
    pushState(): void { calls.push('pushState'); }
    replaceState(): void { calls.push('replaceState'); }
    go(): void { calls.push('go'); }
    back(): void { calls.push('back'); }
    forward(): void { calls.push('forward'); }
  }
  class Location {
    assign(target: unknown): void { calls.push(`assign:${String(target)}`); }
    replace(target: unknown): void { calls.push(`replace:${String(target)}`); }
    reload(): void { calls.push('reload'); }
  }
  const document = new Document()
  const sandbox: Record<string, unknown> = {
    document,
    localStorage: new Storage(),
    sessionStorage: new Storage(),
    history: new History(),
    location: new Location(),
    navigator: {},
    Document,
    Storage,
    History,
    Location,
    console,
  }
  const ctx = vm.createContext(sandbox)
  sandbox['window'] = sandbox
  sandbox['globalThis'] = sandbox
  return {
    ctx,
    calls,
    run: async (code: string): Promise<unknown> => await vm.runInContext(wrapEvalExpression(code), ctx),
    raw: (code: string): unknown => vm.runInContext(code, ctx),
  }
}

describe('eval page shim: indirect destructive vectors are refused at runtime', () => {
  it('blocks X.call / X.apply over a destructive member', async () => {
    const dom = fakeDom()
    await expect(dom.run("localStorage.setItem.call(localStorage, 'k', 'v')")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    await expect(dom.run("history.pushState.apply(history, [null, '', '/pwned'])")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    expect(dom.calls).toEqual([])
  })

  it('blocks a cookie setter fetched through the property descriptor', async () => {
    const dom = fakeDom()
    await expect(dom.run("Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').set.call(document, 'pwned=1')"))
      .rejects.toThrow(EVAL_BLOCKED_MARKER)
    expect(dom.calls).toEqual([])
  })

  it('blocks document.write through an alias captured inside the call', async () => {
    const dom = fakeDom()
    await expect(dom.run("const w = document.write; w.call(document, 'x')")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    expect(dom.calls).toEqual([])
  })

  it('blocks window.eval / global Function (string code execution)', async () => {
    const dom = fakeDom()
    await expect(dom.run("window.eval(\"localStorage.setItem('k','v')\")")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    await expect(dom.run("globalThis.Function('return 1')()")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    expect(dom.calls).toEqual([])
  })

  it('blocks an aliased history object (History.prototype methods are shimmed)', async () => {
    const dom = fakeDom()
    await expect(dom.run("const h = history; h.go(-1)")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    expect(dom.calls).toEqual([])
  })

  it('blocks storage PROPERTY writes through the Proxy getter (exotic [[Set]])', async () => {
    // 2026-10-23 batch1-fix audit P0-2: `s.zzz = 'v'` writes through the Storage
    // exotic [[Set]] and never touches the prototype method, so the method shim
    // alone missed it. The window.localStorage getter returns a Proxy here.
    const dom = fakeDom()
    await expect(dom.run("const s = localStorage; s.zzz = 'v'")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    await expect(dom.run("Object.assign(localStorage, { a: 1 })")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    await expect(dom.run("Reflect.set(localStorage, 'k', 'v')")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    expect(dom.calls).toEqual([])
  })
})

describe('eval page shim: restore + normal work', () => {
  it('restores every shim after a refused program (page keeps working)', async () => {
    const dom = fakeDom()
    await expect(dom.run("localStorage.setItem.call(localStorage, 'k', 'v')")).rejects.toThrow(EVAL_BLOCKED_MARKER)
    // After the finally-restore the page's own API works again.
    dom.raw("localStorage.setItem('after', 'ok')")
    expect(dom.calls).toEqual(['setItem:after=ok'])
  })

  it('restores exact descriptors (window.eval keeps enumerable:false)', async () => {
    const dom = fakeDom()
    const read = (): Record<string, unknown> => dom.raw(`
      (() => { const d = Object.getOwnPropertyDescriptor(globalThis, 'eval')
        return d === undefined ? { missing: true } : { enumerable: d.enumerable, writable: d.writable, configurable: d.configurable } })()`)
    const before = read()
    await expect(dom.run('1 + 1')).resolves.toBe(2)
    expect(read()).toEqual(before)
  })

  it('leaves ordinary programs alone and returns the last expression value', async () => {
    const dom = fakeDom()
    await expect(dom.run('const xs = [3, 1, 2]; xs.sort(); xs[0]')).resolves.toBe(1)
    await expect(dom.run('await Promise.resolve(7)')).resolves.toBe(7)
    await expect(dom.run('readText')).resolves.toBeTypeOf('function')
  })

  it('does not shadow ordinary page methods (data-only object writes)', async () => {
    const dom = fakeDom()
    await expect(dom.run('const r = {}; r.location = { lat: 1 }; r.location.lat')).resolves.toBe(1)
  })
})
