import { describe, expect, it, vi } from 'vitest'
import type {
  ElectronAdapter,
  NativeBounds,
  NativeBrowserWindow,
  NativeDownloadItem,
  NativeImage,
  NativeSession,
  NativeView,
  NativeWebContents,
} from '../src/electron-adapter.ts'
import type { CdpTransport } from '../src/cdp.ts'
import { BrowserRuntime } from '../src/runtime.ts'
import { snapshotNote } from '../src/snapshot.ts'
import { TabPool } from '../src/pool.ts'
import { BrowserStore } from '../src/store.ts'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

class MockTransport implements CdpTransport {
  attached = false
  /** When true, sendCommand never settles (wedged-renderer simulation). */
  hang = false
  readonly sent: Array<{ method: string; params: Record<string, unknown>, sessionId?: string }> = []
  handler: ((method: string, params: Record<string, unknown>) => unknown) | undefined
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  sendCommand(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) })
    if (this.hang) return new Promise(() => {})
    return Promise.resolve(this.handler?.(method, params) ?? {})
  }
  /** CDP event listeners keyed by the transport event name ('message'). */
  private readonly eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  on(event: string, listener: (...args: unknown[]) => void): void {
    const set = this.eventListeners.get(event) ?? new Set()
    set.add(listener)
    this.eventListeners.set(event, set)
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.eventListeners.get(event)?.delete(listener)
  }
  /** Deliver one CDP event (as Electron's debugger 'message' does). */
  emit(method: string, params: unknown = {}): void {
    for (const listener of [...(this.eventListeners.get('message') ?? [])]) listener({}, method, params)
  }
}

class MockSession implements NativeSession {
  partition = 'persist:agent-browser'
  readonly downloads: Array<{ item: NativeDownloadItem; event: unknown }> = []
  private readonly downloadListeners: Array<(event: unknown, item: NativeDownloadItem) => void> = []
  clearStorageData = vi.fn(async () => {})
  clearCache = vi.fn(async () => {})
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  on(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void {
    if (event === 'will-download') this.downloadListeners.push(listener)
  }
  removeListener(event: 'will-download', listener: (event: unknown, item: NativeDownloadItem) => void): void {
    const idx = this.downloadListeners.indexOf(listener)
    if (idx >= 0) this.downloadListeners.splice(idx, 1)
  }
  emitDownload(item: NativeDownloadItem): void {
    for (const listener of [...this.downloadListeners]) listener({}, item)
  }
}

class MockImage implements NativeImage {
  width: number
  height: number
  constructor(width = 1920, height = 1080) {
    this.width = width
    this.height = height
  }
  getSize(): { width: number; height: number } { return { width: this.width, height: this.height } }
  resize(options: { width?: number; height?: number }): NativeImage {
    return new MockImage(options.width ?? this.width, options.height ?? this.height)
  }
  toJPEG(_quality: number): Buffer {
    return Buffer.from('jpeg-bytes')
  }
}

class MockView implements NativeView {
  readonly transport = new MockTransport()
  readonly session = new MockSession()
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  attached = false
  visible = false
  bounds: NativeBounds = { x: 0, y: 0, width: 0, height: 0 }
  url = ''
  title = ''
  loading = false
  destroyed = false
  loadURL = vi.fn(async (url: string) => {
    this.url = url
    this.title = `Title of ${url}`
    this.emit('did-stop-loading')
  })
  downloadURL = vi.fn()
  goBack = vi.fn(() => { this.url = 'about:blank'; this.title = ''; this.emit('did-finish-load') })
  goForward = vi.fn(() => { this.emit('did-finish-load') })
  reload = vi.fn(() => { this.emit('did-finish-load') })
  capturePage = vi.fn(async () => new MockImage(1920, 1080))
  setWindowOpenHandler = vi.fn()
  partition = 'persist:agent-browser'
  attach(win: NativeBrowserWindow, bounds: NativeBounds): void {
    this.attached = true
    this.bounds = bounds
    win.contentView.addChildView(this)
  }
  setBounds(bounds: NativeBounds): void { this.bounds = bounds }
  setVisible(visible: boolean): void { this.visible = visible }
  detach(): void { this.attached = false }
  moveToTop(win: NativeBrowserWindow): void {
    win.contentView.removeChildView(this)
    win.contentView.addChildView(this)
  }
  destroy(): void { this.destroyed = true }
  close = vi.fn(() => { this.destroyed = true })
  get webContents(): NativeWebContents {
    return {
      cdp: this.transport,
      loadURL: this.loadURL,
      downloadURL: this.downloadURL,
      goBack: this.goBack,
      goForward: this.goForward,
      reload: this.reload,
      capturePage: this.capturePage,
      getURL: () => this.url,
      getTitle: () => this.title,
      isLoading: () => this.loading,
      on: (event, listener) => {
        const set = this.listeners.get(event) ?? []
        set.push(listener)
        this.listeners.set(event, set)
      },
      removeListener: (event, listener) => {
        const set = this.listeners.get(event) ?? []
        const idx = set.indexOf(listener)
        if (idx >= 0) set.splice(idx, 1)
      },
      close: () => { this.destroyed = true },
      isDestroyed: () => this.destroyed,
      session: this.session,
      setWindowOpenHandler: this.setWindowOpenHandler,
    }
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class MockWindow implements NativeBrowserWindow {
  readonly children: NativeView[] = []
  visible = false
  destroyed = false
  title = ''
  private readonly resize = new Set<() => void>()
  private readonly closed = new Set<() => void>()
  loadURL = vi.fn(async () => {})
  show(): void { this.visible = true }
  hide(): void { this.visible = false }
  focus(): void {}
  isVisible(): boolean { return this.visible }
  isDestroyed(): boolean { return this.destroyed }
  close(): void {
    this.destroyed = true
    for (const cb of [...this.closed]) { try { cb() } catch { /* noop */ } }
  }
  setTitle(title: string): void { this.title = title }
  getContentSize(): { width: number; height: number } { return { width: 1100, height: 780 } }
  contentView = {
    addChildView: (view: unknown) => { this.children.push(view as NativeView) },
    removeChildView: (view: unknown) => {
      const idx = this.children.indexOf(view as NativeView)
      if (idx >= 0) this.children.splice(idx, 1)
    },
  }
  onResize(listener: () => void): () => void { this.resize.add(listener); return () => { this.resize.delete(listener) } }
  onClosed(listener: () => void): () => void { this.closed.add(listener); return () => { this.closed.delete(listener) } }
  focusPage(): void {}
}

class MockAdapter implements ElectronAdapter {
  readonly views: MockView[] = []
  readonly masks: MockView[] = []
  readonly windows: MockWindow[] = []
  showSaveDialog = vi.fn(async () => ({ canceled: true }))
  openPath = vi.fn(async () => ({}))
  createView(partition?: string): NativeView {
    const view = new MockView()
    view.session.partition = partition ?? 'persist:agent-browser'
    view.partition = partition ?? 'persist:agent-browser'
    this.views.push(view)
    return view
  }
  createMaskView(partition?: string): NativeView {
    const view = new MockView()
    view.partition = partition ?? 'persist:agent-browser'
    this.masks.push(view)
    return view
  }
  createBrowserWindow(): NativeBrowserWindow {
    const win = new MockWindow()
    this.windows.push(win)
    return win
  }
  lastView(): MockView {
    const view = this.views.at(-1)
    if (view === undefined) throw new Error('no view created')
    return view
  }
  mask(): MockView {
    const view = this.masks.at(-1)
    if (view === undefined) throw new Error('no mask created')
    return view
  }
}

function makeRuntime(options: { maxTabs?: number; evalEnabled?: boolean; timeoutMs?: number } = {}, credentials?: unknown) {
  const adapter = new MockAdapter()
  const dir = join(process.cwd(), 'tests', `.rt-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const store = new BrowserStore({ dir })
  const runtime = new BrowserRuntime(adapter as never, options, credentials as never, undefined, { store })
  const cleanup = () => { runtime.dispose(); rmSync(dir, { recursive: true, force: true }) }
  return { adapter, runtime, store, cleanup }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('BrowserRuntime v4.2 — flat pool', () => {
  it('agent open creates a tab without popping the window to the front', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    const tab = await runtime.open('https://example.com')
    expect(tab.id).toBe(1)
    expect(runtime.listTabs()).toHaveLength(1)
    expect(runtime.listTabs()[0]?.visible).toBe(true)
    expect(runtime.listTabs()[0]?.url).toBe('https://example.com')
    // 2026-09-08: the agent never surfaces the window (the user may have just
    // closed it); only user paths show it.
    expect(adapter.windows[0]?.visible).toBe(false)
    cleanup()
  })

  it('user open and showWindow surface the window; hideWindow only hides it', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://example.com', undefined, true)
    expect(adapter.windows[0]?.visible).toBe(true)
    runtime.hideWindow()
    expect(adapter.windows[0]?.visible).toBe(false)
    expect(runtime.windowState.created).toBe(true)
    expect(runtime.listTabs()).toHaveLength(1)
    await runtime.showWindow()
    expect(adapter.windows[0]?.visible).toBe(true)
    cleanup()
  })

  it('prewarm brings the window up hidden with restored tabs and no pop-up', async () => {
    const { runtime, store, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    runtime.saveLedger()
    const adapter2 = new MockAdapter()
    const runtime2 = new BrowserRuntime(adapter2 as never, {}, undefined, undefined, { store })
    runtime2.restoreLedger()
    await runtime2.prewarm()
    await sleep(60)
    expect(adapter2.windows.length).toBe(1)
    expect(adapter2.windows[0]?.visible).toBe(false)
    expect(runtime2.listTabs().length).toBe(2)
    // An agent tab open after prewarm still must not surface the window.
    await runtime2.open('https://c.example')
    expect(adapter2.windows[0]?.visible).toBe(false)
    cleanup()
    runtime2.dispose()
  })

  it('a wedged CDP call times out and releases the global mutex (P0-4)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime({ timeoutMs: 60 })
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.hang = true
    await expect(runtime.eval(1, 'document.title')).rejects.toMatchObject({ code: 'timeout' })
    // The mutex must be free again: the next operation proceeds normally.
    view.transport.hang = false
    await expect(runtime.eval(1, 'document.title')).resolves.toBe('null')
    cleanup()
  })

  it('opens a second tab and switches active', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const t2 = await runtime.open('https://b.example')
    expect(runtime.currentTabId()).toBe(t2.id)
    await runtime.switchTab(t2.id === 1 ? 2 : 1)
    expect(runtime.currentTabId()).toBe(t2.id === 1 ? 2 : 1)
    cleanup()
  })

  it('resolveTab defaults to the active tab and rejects unknown ids', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    const active = runtime.currentTabId()!
    expect(runtime.resolveTab(undefined)).toBe(active)
    expect(() => runtime.resolveTab(999)).toThrow()
    cleanup()
  })

  it('navigate goes through the guard (javascript:/data: rejected)', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const tab = runtime.currentTabId()!
    const err = await runtime.navigate(tab, 'javascript:alert(1)').catch((e: unknown) => e)
    expect((err as Error).message).toContain('navigation denied')
    cleanup()
  })

  it('reload/back/forward work on the active tab', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    await runtime.navigate(id, 'https://b.example')
    await runtime.goBack(id)
    expect(adapter.lastView().url).toBe('about:blank')
    await runtime.goForward(id)
    await runtime.reload(id)
    cleanup()
  })

  it('closes a tab and destroys its view', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    const first = adapter.views[0]!
    await runtime.closeTab(first === adapter.views[0] ? first.bounds ? runtime.listTabs()[0]!.id : runtime.listTabs()[0]!.id : 0)
    expect(runtime.listTabs()).toHaveLength(1)
    cleanup()
  })

  it('eval policy: statements pass, destructive navigation refused, gate honored', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const result = await runtime.eval(id, 'window.__NEXT_DATA__ ? 1 : 2')
    expect(typeof result).toBe('string')
    // 2026-10-23 capability unlock: assignments/statements are ordinary page work.
    await expect(runtime.eval(id, 'window.x = 1')).resolves.toBeTypeOf('string')
    // The destructive surface (navigation) is still refused before any page work.
    const err = await runtime.eval(id, "location.href = 'https://b.example'").catch((e: unknown) => e)
    expect((err as Error & { code?: string }).code).toBe('eval-policy')
    cleanup()
  })

  it('default caps are the unlocked ones (snapshot 400 / text 64 KiB)', () => {
    const { runtime, cleanup } = makeRuntime()
    expect(runtime.options.snapshotLimit).toBe(400)
    expect(runtime.options.textLimit).toBe(64 * 1024)
    cleanup()
  })

  it('refuses page navigation only for the tab whose eval is in flight', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    const tabs = runtime.listTabs()
    const tabA = tabs[0]!.id
    const viewA = adapter.views[0]!
    const viewB = adapter.views[1]!
    const fire = (view: typeof viewA, event: string, url: string): boolean => {
      const state = { prevented: false }
      const handler = view.listeners.get(event)?.[0]
      expect(handler, `view must register ${event}`).toBeTypeOf('function')
      handler!({ preventDefault: () => { state.prevented = true } }, url)
      return state.prevented
    }
    const seen: boolean[] = []
    viewA.transport.handler = (method: string) => {
      if (method !== 'Runtime.evaluate') return {}
      // Simulate the page navigating itself from inside the evaluation.
      seen.push(fire(viewA, 'will-navigate', 'https://evil.example/a'))
      seen.push(fire(viewB, 'will-navigate', 'https://evil.example/b'))
      return { result: { value: 1 } }
    }
    await runtime.eval(tabA, '1')
    // Own tab blocked while the eval ran; the other tab's user navigation is untouched.
    expect(seen).toEqual([true, false])
    // The guard is released once the evaluation settles.
    expect(fire(viewA, 'will-navigate', 'https://evil.example/a')).toBe(false)
    // A throwing evaluation must release it too.
    viewA.transport.handler = (method: string) => { if (method === 'Runtime.evaluate') throw new Error('cdp boom'); return {} }
    await expect(runtime.eval(tabA, '2')).rejects.toBeTruthy()
    expect(fire(viewA, 'will-navigate', 'https://evil.example/a')).toBe(false)
    cleanup()
  })

  it('resolves locators through one page probe and fails loud on ambiguity/zero', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const tabId = runtime.currentTabId()!
    const view = adapter.lastView()
    let probes = 0
    const probeValue = (value: unknown): { result: { value: string } } => ({ result: { value: JSON.stringify(value) } })
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      probes += 1
      return probeValue({ count: 1, selector: '#save', candidates: [] })
    }
    await expect(runtime.resolveTargetSelector(tabId, 'text=Save')).resolves.toEqual({ selector: '#save' })
    expect(probes).toBe(1)

    // CSS passthrough does not touch the page at all.
    probes = 0
    await expect(runtime.resolveTargetSelector(tabId, 'css=#a > b')).resolves.toEqual({ selector: '#a > b' })
    expect(probes).toBe(0)

    view.transport.handler = () => probeValue({ count: 2, selector: null, candidates: ['button a', 'button b'] })
    await expect(runtime.resolveTargetSelector(tabId, 'role=button')).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('matched 2 elements'),
    })

    view.transport.handler = () => probeValue({ count: 0, selector: null, candidates: [] })
    await expect(runtime.resolveTargetSelector(tabId, 'text=Missing')).rejects.toMatchObject({ code: 'not-found' })

    // A malformed locator is a policy error, not a page error.
    view.transport.handler = () => { throw new Error('the page must not be touched for a malformed locator') }
    await expect(runtime.resolveTargetSelector(tabId, 'loc=bogus:x')).rejects.toMatchObject({ code: 'policy' })
    cleanup()
  })

  it('selectOptionChoice honours label/index/clear and reports the selected values', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const expressions: string[] = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      expressions.push(String(params['expression'] ?? ''))
      return { result: { value: { selected: ['10', '20'], count: 2 } } }
    }
    await expect(runtime.selectOptionChoice(1, 'select#plan', { label: ['October', 'November'] }))
      .resolves.toEqual({ selected: ['10', '20'], count: 2 })
    expect(expressions[0]).toContain('"label":["October","November"]')
    await expect(runtime.selectOptionChoice(1, 'select#plan', { index: 2 })).resolves.toMatchObject({ count: 2 })
    await expect(runtime.selectOptionChoice(1, 'select#plan', { clear: true })).resolves.toMatchObject({ count: 2 })
    expect(expressions[1]).toContain('"index":2')
    expect(expressions[2]).toContain('"clear":true')
    // Page-side refusals surface as not-found (single select with an array, missing label).
    view.transport.handler = () => ({ result: { value: { error: 'this select is not multiple — give exactly one target or pass clear' } } })
    await expect(runtime.selectOptionChoice(1, 'select#plan', { value: ['a', 'b'] })).rejects.toMatchObject({ code: 'not-found' })
    cleanup()
  })

  it('selectOptionChoice sends the SINGLE-SOURCE page script (no inline copy)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const sent: string[] = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      sent.push(String(params['expression'] ?? ''))
      return { result: { value: { selected: ['1'], count: 1 } } }
    }
    const { selectPageScript } = await import('../src/runtime.ts')
    await runtime.selectOptionChoice(1, 'select#s', { label: 'Red' })
    expect(sent[0]).toBe(selectPageScript('select#s', { label: 'Red' }))
    cleanup()
  })

  it('wait_for function resolves on ANY truthy value (element / number / string)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    let value: unknown = 1
    view.transport.handler = (method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value, objectId: value === null ? undefined : 'obj' } }
      return {}
    }
    await expect(runtime.waitFor(1, { condition: 'function', expression: '1', timeoutMs: 500 })).resolves.toMatchObject({ ok: true })
    value = 'ready'
    await expect(runtime.waitFor(1, { condition: 'function', expression: 'document.title', timeoutMs: 500 })).resolves.toMatchObject({ ok: true })
    // An element is an object (truthy), not `true`.
    value = { nodeType: 1 }
    await expect(runtime.waitFor(1, { condition: 'function', expression: 'document.querySelector("#t")', timeoutMs: 500 })).resolves.toMatchObject({ ok: true })
    // Falsy values keep polling and time out — including the ones a hand-rolled
    // `!== 0` list would get wrong (NaN, 0n).
    for (const [expression, falsy] of [['0', 0], ['NaN', NaN], ['0n', 0n], ['""', '']] as const) {
      value = falsy
      await expect(runtime.waitFor(1, { condition: 'function', expression, timeoutMs: 120 })).resolves.toMatchObject({ ok: false })
    }
    cleanup()
  })

  it('wait_for function condition polls an expression and refuses destructive code', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const expressions: string[] = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params['expression'] ?? '')
      expressions.push(expression)
      if (expression === 'globalThis') return { result: { objectId: 'g' } }
      return { result: { value: true } }
    }
    await expect(runtime.waitFor(1, { condition: 'function', expression: 'document.readyState === "complete"', timeoutMs: 1_000 }))
      .resolves.toMatchObject({ ok: true })
    expect(expressions.some(expression => expression.includes('(async () => {') && expression.includes('document.readyState'))).toBe(true)
    await expect(runtime.waitFor(1, { condition: 'function', expression: 'location.assign("https://evil.example")', timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: 'eval-policy' })
    cleanup()
  })

  it('wait_for url-match carries the glob as data, never as page source', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    let payload: Record<string, unknown> | undefined
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'g' } }
      if (method === 'Runtime.callFunctionOn') {
        const args = params['arguments'] as Array<{ value?: Record<string, unknown> }> | undefined
        payload = args?.[0]?.value
        return { result: { value: true } }
      }
      return {}
    }
    await expect(runtime.waitFor(1, { condition: 'url-match', pattern: '**/dashboard*', timeoutMs: 1_000 })).resolves.toMatchObject({ ok: true })
    expect(payload?.['pattern']).toBe('**/dashboard*')
    cleanup()
  })

  it('gate: evalEnabled=false rejects with policy', async () => {
    const { runtime, cleanup } = makeRuntime({ evalEnabled: false })
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const err = await runtime.eval(id, '1 + 1').catch((e: unknown) => e)
    expect((err as Error & { code?: string }).code).toBe('policy')
    cleanup()
  })

  it('waitFor returns ok for settled conditions and times out gracefully', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    adapter.lastView().transport.handler = (method) => {
      // CDP: the constant predicate runs against the page's global object.
      if (method === 'Runtime.evaluate') return { result: { objectId: 'page-global' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
      return {}
    }
    const ok = await runtime.waitFor(id, { condition: 'settled', timeoutMs: 1000 })
    expect(ok.ok).toBe(true)
    cleanup()
  })

  it('waitFor sends the condition as a CDP argument, never as page source', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const selector = `#x'); globalThis.__pwned = true; //`
    adapter.lastView().transport.handler = (method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'page-global' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: false } }
      return {}
    }
    const result = await runtime.waitFor(id, { condition: 'element-present', selector, timeoutMs: 50 })
    expect(result.ok).toBe(false)

    const sent = adapter.lastView().transport.sent
    const evaluate = sent.filter(entry => entry.method === 'Runtime.evaluate')
    // Runtime.evaluate is only used to resolve the page global object.
    expect(evaluate.length).toBeGreaterThan(0)
    for (const entry of evaluate) expect(entry.params.expression).toBe('globalThis')

    const call = sent.find(entry => entry.method === 'Runtime.callFunctionOn')
    expect(call).toBeDefined()
    expect(String(call?.params.functionDeclaration)).not.toContain(selector)
    expect(call?.params.arguments).toEqual([{ value: {
      condition: 'element-present',
      selector,
      text: null,
      pattern: null,
      startUrl: 'https://a.example',
      networkIdleMs: 800,
    } }])
    cleanup()
  })

  it('dialog: Page.enable is sent once per tab and dialog events fail page ops fast', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const enables = view.transport.sent.filter(entry => entry.method === 'Page.enable')
    expect(enables).toHaveLength(1)
    view.transport.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete this item?', url: 'https://a.example/' })
    expect(runtime.dialogState(1)).toMatchObject({ type: 'confirm', message: 'Delete this item?' })
    // Every page operation now fails fast and points at browser_dialog.
    const error = await runtime.eval(1, '1').catch((cause: unknown) => cause as { code?: string, message?: string })
    expect(error.code).toBe('policy')
    expect(String(error.message)).toContain('browser_dialog')
  })

  it('dialog: the fail-fast matrix covers every page entry (single choke point + navigation family)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'blocked' })
    const expectPolicy = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      const error = await run().then(() => undefined, (cause: unknown) => cause as { code?: string })
      expect(error, `${label} must fail fast while a dialog is pending`).toBeDefined()
      expect(error?.code, label).toBe('policy')
      // The message must point at the answer tool — otherwise the model sees a
      // generic policy refusal and has no way out (strict matrix, audit M1fix).
      expect(String((error as { message?: string }).message), label).toContain('browser_dialog')
    }
    const tab = 1
    await expectPolicy('navigate', () => runtime.navigate(tab, 'https://b.example'))
    await expectPolicy('reload', () => runtime.reload(tab))
    await expectPolicy('goBack', () => runtime.goBack(tab))
    await expectPolicy('goForward', () => runtime.goForward(tab))
    await expectPolicy('downloadUrl', () => runtime.downloadUrl('https://files.example/x.zip'))
    await expectPolicy('eval', () => runtime.eval(tab, '1'))
    await expectPolicy('snapshot', () => runtime.modelSnapshot(tab))
    await expectPolicy('snapshotWithMeta', () => runtime.snapshotWithMeta(tab))
    await expectPolicy('text', () => runtime.textWithMeta(tab, undefined))
    await expectPolicy('screenshot', () => runtime.screenshot(tab))
    await expectPolicy('locateElement', () => runtime.locateElement(tab, '#x'))
    await expectPolicy('resolveTargetSelector', () => runtime.resolveTargetSelector(tab, 'text=x'))
    await expectPolicy('clickAt', () => runtime.clickAt(tab, { x: 1, y: 1 }))
    await expectPolicy('typeInto', () => runtime.typeInto(tab, '#x', 'y'))
    await expectPolicy('pressKey', () => runtime.pressKey(tab, 'Enter'))
    await expectPolicy('selectOptionChoice', () => runtime.selectOptionChoice(tab, '#s', { index: 0 }))
    await expectPolicy('scroll', () => runtime.scroll(tab, 10, undefined))
    await expectPolicy('fillForm', () => runtime.fillForm(tab, [{ field: 'a', value: 'b' }], false))
    // A vetted path is required, otherwise the allowlist refusal would mask the
    // dialog gate (audit M1fix: this row used to be a false green).
    await expectPolicy('uploadFile', () => runtime.uploadFile(tab, ['/tmp/x'], undefined, ['/tmp']))
    await expectPolicy('waitFor', () => runtime.waitFor(tab, { condition: 'settled', timeoutMs: 100 }))
    // Answering the dialog is never blocked.
    view.transport.handler = () => ({})
    await expect(runtime.handleDialog(tab, 'dismiss')).resolves.toMatchObject({ type: 'confirm' })
    await expect(runtime.eval(tab, '1')).resolves.toBeTypeOf('string')
    cleanup()
  })

  it('dialog: url and defaultPrompt go through the tab value redactor', async () => {
    const SECRET = 'S3cr3tPass-xyz'
    const { adapter, runtime, cleanup } = makeRuntime({}, async () => ({ username: 'alice', password: SECRET }))
    await runtime.open('https://login.example/form')
    const view = adapter.lastView()
    view.transport.handler = (method: string) => {
      if (method !== 'Runtime.evaluate') return {}
      return { result: { value: { filled: 2, username: true, password: true } } }
    }
    await runtime.fillCredentials(1, 'connector-x')
    view.transport.emit('Page.javascriptDialogOpening', {
      type: 'prompt',
      message: `Name? ${SECRET}`,
      defaultPrompt: `prefill ${SECRET}`,
      url: `https://login.example/form?p=${SECRET}`,
    })
    const dialog = runtime.dialogState(1)!
    expect(dialog.message).not.toContain(SECRET)
    expect(dialog.defaultPrompt).not.toContain(SECRET)
    expect(dialog.url).not.toContain(SECRET)
    cleanup()
  })

  it('dialog: closeTab is an escape hatch while the tab is blocked', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'stuck' })
    // The user gate is held (as if a click triggered this dialog and is stuck):
    // the agent-path close must still resolve instead of waiting for the gate.
    runtime.setUserControl(true, 'user')
    const calls: string[] = []
    view.transport.handler = (method: string) => { calls.push(method); return {} }
    await expect(runtime.closeTab(1)).resolves.toBeUndefined()
    expect(calls).toContain('Page.handleJavaScriptDialog')
    runtime.setUserControl(false)
    cleanup()
  })

  it('dialog: dismiss happens BEFORE the state is forgotten', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'order' })
    const seenDuringDismiss: Array<boolean> = []
    view.transport.handler = (method: string) => {
      if (method === 'Page.handleJavaScriptDialog') seenDuringDismiss.push(runtime.dialogState(1) !== undefined)
      return {}
    }
    await runtime.handleDialog(1, 'dismiss')
    // A delete-first implementation would show `false` here.
    expect(seenDuringDismiss).toEqual([true])
    expect(runtime.dialogState(1)).toBeUndefined()
    cleanup()
  })

  it('dialog: the user navigation path is refused too, and the message is actionable', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'leave?' })
    const error = await runtime.navigate(1, 'https://b.example', 'domcontentloaded', undefined, true)
      .then(() => undefined, (cause: unknown) => cause as { code?: string, message?: string })
    expect(error?.code).toBe('policy')
    expect(String(error?.message)).toContain('browser_dialog')
    await expect(runtime.navigateUser('https://b.example')).rejects.toMatchObject({ code: 'policy' })
    cleanup()
  })

  it('dialog: an in-flight page command is aborted when the dialog arrives (no mutex wait)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    // A page command that hangs (as a blocked renderer does).
    view.transport.hang = true
    const hanging = runtime.eval(1, '1').catch((cause: unknown) => cause)
    // Wait until the command really HOLDS the mutex: it must have reached the
    // transport (sent) and the runtime must report busy. `await Promise.resolve()`
    // was not enough — the command had not reached the CDP send yet, which is why
    // deleting `abortPending` used to leave the suite green (audit M1fix2 P2).
    const sentEval = (): boolean => view.transport.sent.some(entry => entry.method === 'Runtime.evaluate')
    for (let i = 0; i < 200 && !sentEval(); i += 1) await sleep(5)
    for (let i = 0; i < 200 && !runtime.controlState().busy; i += 1) await sleep(5)
    expect(sentEval(), 'the hung command must have reached CDP before the dialog').toBe(true)
    expect(runtime.controlState().busy, 'the hung command must hold the mutex before the dialog').toBe(true)
    // The dialog arrives while the command is in flight.
    view.transport.hang = false
    view.transport.handler = () => ({})
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'stuck' })
    const started = Date.now()
    await expect(runtime.handleDialog(1, 'dismiss')).resolves.toMatchObject({ type: 'alert' })
    expect(Date.now() - started, 'the answer must not wait for the aborted command budget').toBeLessThan(500)
    // The aborted command settles long before its own CDP timeout (4s+).
    const hungError = await hanging
    expect(hungError).toBeDefined()
    cleanup()
  })

  it('dialog: closeTab dismisses before forgetting the state (observable during the CDP call)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'order' })
    const seen: boolean[] = []
    view.transport.handler = (method: string) => {
      if (method === 'Page.handleJavaScriptDialog') seen.push(runtime.dialogState(1) !== undefined)
      return {}
    }
    await runtime.closeTab(1, true)
    expect(seen).toEqual([true])
    expect(runtime.dialogState(1)).toBeUndefined()
    cleanup()
  })

  it('dialog: a dialog for an unknown tab still redacts the message (no tab value set needed)', () => {
    const { runtime, cleanup } = makeRuntime()
    // No tab 99 exists: the fallback path must still use the keyword list.
    ;(runtime as unknown as { noteDialogOpened: (id: number, params: unknown) => void }).noteDialogOpened(99, {
      type: 'alert',
      message: 'token=supersecretvalue',
    })
    expect(runtime.dialogState(99)?.message).toContain('****')
    expect(runtime.dialogState(99)?.message).not.toContain('supersecretvalue')
    cleanup()
  })

  it('events: dialog, popup and download land on the tab event bus', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    // dialog
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' })
    expect(runtime.eventBus(1)?.drain('dialog')).toHaveLength(1)
    view.transport.handler = () => ({})
    await runtime.handleDialog(1, 'dismiss')
    // popup: the captured window-open handler opens a tab, then publishes the event
    const openHandler = view.setWindowOpenHandler.mock.calls.at(-1)?.[0] as ((details: { url: string }) => unknown) | undefined
    expect(openHandler, 'window-open handler must be registered').toBeTypeOf('function')
    openHandler!({ url: 'https://popup.example/landing' })
    for (let i = 0; i < 100 && (runtime.eventBus(1)?.size ?? 0) === 0; i += 1) await sleep(5)
    const popup = runtime.eventBus(1)?.drain('popup')[0]
    expect(popup?.payload).toMatchObject({ url: 'https://popup.example/landing', actor: 'ai' })
    expect((popup?.payload as { tab?: number }).tab).toBeGreaterThan(1)
    cleanup()
  })

  it('wait_for popup/download consumes the bus and times out without an event', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const bus = runtime.eventBus(1)!
    bus.push('popup', { tab: 9 })
    await expect(runtime.waitFor(1, { condition: 'popup', timeoutMs: 200 })).resolves.toMatchObject({ ok: true })
    await expect(runtime.waitFor(1, { condition: 'download', timeoutMs: 100 })).resolves.toMatchObject({ ok: false })
    cleanup()
  })

  it('download completion stays attributed to the tab that started it after a tab switch (real recorder path)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    await runtime.switchTab(1)
    // Production path: the recorder writes to the store and publishes the events.
    const recorder = (runtime as unknown as {
      downloadRecorder: () => {
        add: (entry: { url: string, fileName: string, path: string, size: number, status: 'in-progress', actor: 'ai', group: string }) => number
        update: (id: number, patch: { status: 'done' }) => void
      }
    }).downloadRecorder()
    const id = recorder.add({ url: 'https://files.example/x.zip', fileName: 'x.zip', path: '', size: 0, status: 'in-progress', actor: 'ai', group: '' })
    // ...the user switches tabs while the download is still running...
    await runtime.switchTab(2)
    // ...and the completion event must still go to tab 1's bus (not the active one).
    recorder.update(id, { status: 'done' })
    const bus1 = runtime.eventBus(1)!
    const bus2 = runtime.eventBus(2)!
    const events = bus1.drain('download')
    expect(events.some(event => (event.payload as { status?: string }).status === 'done')).toBe(true)
    expect(bus2.drain('download')).toHaveLength(0)
    cleanup()
  })

  it('dialog pending does not block event-kind waits (and reports a timeout honestly)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'blocked' })
    // No popup yet: a timeout, NOT a policy refusal from the dialog gate.
    await expect(runtime.waitFor(1, { condition: 'popup', timeoutMs: 100 }))
      .resolves.toMatchObject({ ok: false })
    // An event already buffered satisfies the wait even while the dialog blocks.
    runtime.eventBus(1)!.push('popup', { tab: 2 })
    await expect(runtime.waitFor(1, { condition: 'popup', timeoutMs: 200 }))
      .resolves.toMatchObject({ ok: true })
    cleanup()
  })

  it('file chooser: interception is armed per tab and events land on the bus', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    expect(view.transport.sent.some(entry => entry.method === 'Page.setInterceptFileChooserDialog' && entry.params?.['enabled'] === true)).toBe(true)
    view.transport.emit('Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' })
    expect(runtime.chooserState(1)).toEqual({ backendNodeId: 42, mode: 'selectSingle' })
    expect(runtime.eventBus(1)?.drain('file-chooser')[0]?.payload).toMatchObject({ backendNodeId: 42, tab: 1 })
    cleanup()
  })

  it('file chooser: chooseFiles sets files, cancel sends an empty list, and no pending is not-found', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    await expect(runtime.chooseFiles(1, { files: ['/tmp/a.txt'] }, ['/tmp'])).rejects.toMatchObject({ code: 'not-found' })
    view.transport.emit('Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectMultiple' })
    await expect(runtime.chooseFiles(1, { files: ['/tmp/a.txt'] }, ['/tmp'])).resolves.toEqual({ files: ['/tmp/a.txt'] })
    expect(calls).toContainEqual({ method: 'DOM.setFileInputFiles', params: { files: ['/tmp/a.txt'], backendNodeId: 7 } })
    expect(runtime.chooserState(1)).toBeUndefined()
    view.transport.emit('Page.fileChooserOpened', { backendNodeId: 8, mode: 'selectSingle' })
    await expect(runtime.chooseFiles(1, { cancel: true }, ['/tmp'])).resolves.toEqual({ cancelled: true })
    expect(calls).toContainEqual({ method: 'DOM.setFileInputFiles', params: { files: [], backendNodeId: 8 } })
    // Outside the allow-list: policy, and the chooser is NOT consumed.
    view.transport.emit('Page.fileChooserOpened', { backendNodeId: 9, mode: 'selectSingle' })
    await expect(runtime.chooseFiles(1, { files: ['/etc/passwd'] }, ['/tmp'])).rejects.toMatchObject({ code: 'policy' })
    expect(runtime.chooserState(1)).toEqual({ backendNodeId: 9, mode: 'selectSingle' })
    cleanup()
  })

  it('file chooser: a pending dialog blocks the CDP write but not the chooser itself', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.fileChooserOpened', { backendNodeId: 11, mode: 'selectSingle' })
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'blocked' })
    // DOM.setFileInputFiles is deliberately NOT in the dialog exemption list.
    await expect(runtime.chooseFiles(1, { files: ['/tmp/a.txt'] }, ['/tmp'])).rejects.toMatchObject({ code: 'policy' })
    // The chooser survives the dialog: answering the dialog makes it usable.
    view.transport.handler = () => ({})
    await runtime.handleDialog(1, 'dismiss')
    view.transport.emit('Page.fileChooserOpened', { backendNodeId: 11, mode: 'selectSingle' })
    await expect(runtime.chooseFiles(1, { files: ['/tmp/a.txt'] }, ['/tmp'])).resolves.toEqual({ files: ['/tmp/a.txt'] })
    cleanup()
  })

  it('file chooser: user takeover disables interception and clears the pending chooser', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.fileChooserOpened', { backendNodeId: 12, mode: 'selectSingle' })
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    runtime.setUserControl(true, 'user')
    await sleep(10)
    expect(calls.some(entry => entry.method === 'Page.setInterceptFileChooserDialog' && entry.params['enabled'] === false)).toBe(true)
    expect(runtime.chooserState(1)).toBeUndefined()
    calls.length = 0
    runtime.setUserControl(false)
    await sleep(10)
    expect(calls.some(entry => entry.method === 'Page.setInterceptFileChooserDialog' && entry.params['enabled'] === true)).toBe(true)
    cleanup()
  })

  it('download receipts: waitForDownload / waitForNewDownload return the terminal record or null', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const recorder = (runtime as unknown as {
      downloadRecorder: () => {
        add: (entry: { url: string, fileName: string, path: string, size: number, status: 'in-progress', actor: 'ai', group: string }) => number
        update: (id: number, patch: { status: 'done' }) => void
      }
    }).downloadRecorder()
    const id = recorder.add({ url: 'https://files.example/x.zip', fileName: 'x.zip', path: '', size: 0, status: 'in-progress', actor: 'ai', group: '' })
    expect(runtime.highestDownloadId()).toBe(id)
    // Still in progress: a short wait times out honestly.
    await expect(runtime.waitForDownload(id, 150)).resolves.toBeNull()
    await expect(runtime.waitForNewDownload(id - 1, 150)).resolves.toBeNull()
    recorder.update(id, { status: 'done' })
    await expect(runtime.waitForDownload(id, 2_000)).resolves.toMatchObject({ id, status: 'done' })
    await expect(runtime.waitForNewDownload(id - 1, 2_000)).resolves.toMatchObject({ id, status: 'done' })
    cleanup()
  })

  it('download receipts: baseline filtering never returns an older unrelated download', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const recorder = (runtime as unknown as {
      downloadRecorder: () => {
        add: (entry: { url: string, fileName: string, path: string, size: number, status: 'in-progress', actor: 'ai', group: string }) => number
        update: (id: number, patch: { status: 'done' }) => void
      }
    }).downloadRecorder()
    // An unrelated download finishes BEFORE the action...
    const oldId = recorder.add({ url: 'https://files.example/a.bin', fileName: 'a.bin', path: '', size: 1, status: 'in-progress', actor: 'ai', group: '' })
    recorder.update(oldId, { status: 'done' })
    // ...the action starts a NEW one that is still running.
    const newId = recorder.add({ url: 'https://files.example/b.bin', fileName: 'b.bin', path: '', size: 2, status: 'in-progress', actor: 'ai', group: '' })
    // The baseline is the highest id seen BEFORE the action, so the wait must
    // ignore the old download and time out honestly instead of returning a.bin.
    const owner = runtime.downloadOwnerTab()
    await expect(runtime.waitForNewDownload(newId - 1, 150, owner)).resolves.toBeNull()
    recorder.update(newId, { status: 'done' })
    await expect(runtime.waitForNewDownload(newId - 1, 2_000, owner)).resolves.toMatchObject({ id: newId, fileName: 'b.bin' })
    cleanup()
  })

  it('download receipts: abortable wait rejects with interrupted instead of a DOMException after a tick', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    await expect(runtime.waitForDownload(1, 30_000, controller.signal)).rejects.toMatchObject({ code: 'interrupted' })
    expect(Date.now() - started).toBeLessThan(200)
    cleanup()
  })

  it('download receipts: per-tab attribution ignores another tab download', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    const recorder = (runtime as unknown as {
      downloadRecorder: () => {
        add: (entry: { url: string, fileName: string, path: string, size: number, status: 'in-progress', actor: 'ai', group: string }) => number
        update: (id: number, patch: { status: 'done' }) => void
      }
    }).downloadRecorder()
    // Tab 2 starts and finishes a download; the waiter is for tab 1.
    await runtime.switchTab(2)
    const otherId = recorder.add({ url: 'https://files.example/other.bin', fileName: 'other.bin', path: '', size: 1, status: 'in-progress', actor: 'ai', group: '' })
    recorder.update(otherId, { status: 'done' })
    await runtime.switchTab(1)
    const mineId = recorder.add({ url: 'https://files.example/mine.bin', fileName: 'mine.bin', path: '', size: 2, status: 'in-progress', actor: 'ai', group: '' })
    // Not terminal yet AND the terminal one belongs to tab 2 -> no false result.
    await expect(runtime.waitForNewDownload(mineId - 1, 150, 1)).resolves.toBeNull()
    recorder.update(mineId, { status: 'done' })
    await expect(runtime.waitForNewDownload(mineId - 1, 2_000, 1)).resolves.toMatchObject({ id: mineId, fileName: 'mine.bin' })
    cleanup()
  })

  it('file chooser: selectSingle refuses several files, and repeated takeovers are deduped', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    view.transport.emit('Page.fileChooserOpened', { backendNodeId: 31, mode: 'selectSingle' })
    await expect(runtime.chooseFiles(1, { files: ['/tmp/a', '/tmp/b'] }, ['/tmp'])).rejects.toMatchObject({ code: 'policy' })
    // Dedupe: two takeovers in a row emit ONE disable, not two.
    runtime.setUserControl(true, 'user')
    runtime.setUserControl(true, 'user')
    await sleep(10)
    const disables = calls.filter(entry => entry.method === 'Page.setInterceptFileChooserDialog' && entry.params['enabled'] === false)
    expect(disables).toHaveLength(1)
    runtime.setUserControl(false)
    await sleep(10)
    cleanup()
  })

  it('file chooser: release while a dialog is pending re-enables after the dialog is answered', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    runtime.setUserControl(true, 'user')
    await sleep(10)
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'blocked' })
    runtime.setUserControl(false)
    await sleep(10)
    // Blocked by the dialog hook: the re-enable is deferred, not lost.
    expect(calls.some(entry => entry.method === 'Page.setInterceptFileChooserDialog' && entry.params['enabled'] === true)).toBe(false)
    await runtime.handleDialog(1, 'dismiss')
    await sleep(10)
    expect(calls.some(entry => entry.method === 'Page.setInterceptFileChooserDialog' && entry.params['enabled'] === true)).toBe(true)
    cleanup()
  })

  it('download receipts: a tab with NO candidate never receives another tab download (strict filter)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    const recorder = (runtime as unknown as {
      downloadRecorder: () => {
        add: (entry: { url: string, fileName: string, path: string, size: number, status: 'in-progress', actor: 'ai', group: string }) => number
        update: (id: number, patch: { status: 'done' }) => void
      }
    }).downloadRecorder()
    // Only TAB 2 has a download; the waiter asks for TAB 1 (which has none).
    await runtime.switchTab(2)
    const otherId = recorder.add({ url: 'https://files.example/other.bin', fileName: 'other.bin', path: '', size: 1, status: 'in-progress', actor: 'ai', group: '' })
    recorder.update(otherId, { status: 'done' })
    await runtime.switchTab(1)
    // No fallback: the answer is null, never tab 2's file.
    await expect(runtime.waitForNewDownload(otherId - 1, 150, 1)).resolves.toBeNull()
    cleanup()
  })

  it('file chooser: a dialog-closed event also flushes the deferred interception re-enable', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    runtime.setUserControl(true, 'user')
    await sleep(10)
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'blocked' })
    runtime.setUserControl(false)
    await sleep(10)
    expect(calls.some(entry => entry.method === 'Page.setInterceptFileChooserDialog' && entry.params['enabled'] === true)).toBe(false)
    // The page closes the dialog by itself (no handleDialog): the queued re-enable
    // must still fire from the CDP event path.
    view.transport.emit('Page.javascriptDialogClosed', {})
    await sleep(10)
    expect(calls.some(entry => entry.method === 'Page.setInterceptFileChooserDialog' && entry.params['enabled'] === true)).toBe(true)
    cleanup()
  })

  it('input: modifiers use the CDP bitmask and chords press/release in order', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.windows[0]!.visible = true
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'Runtime.evaluate') return { result: { value: 'INPUT' } }
      return {}
    }
    const bits = 2 | 8 // ctrl + shift
    await runtime.pressKey(1, 'A', undefined, { modifiers: bits })
    const keyEvents = calls.filter(entry => entry.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.map(entry => `${String(entry.params['type'])}:${String(entry.params['modifiers'])}`)).toEqual(['keyDown:10', 'keyUp:10'])
    calls.length = 0
    await runtime.hotkey(1, ['Control', 'A'])
    const chord = calls.filter(entry => entry.method === 'Input.dispatchKeyEvent')
    expect(chord.map(entry => `${String(entry.params['type'])}:${String(entry.params['key'])}`))
      .toEqual(['keyDown:Control', 'keyDown:A', 'keyUp:A', 'keyUp:Control'])
    // Control must contribute bit 2, not 0 (audit P1-1: `control` vs `ctrl` key bug).
    expect(chord.every(entry => entry.params['modifiers'] === 2)).toBe(true)
    calls.length = 0
    await runtime.hotkey(1, ['Control', 'Shift', 'A'])
    expect(calls.filter(entry => entry.method === 'Input.dispatchKeyEvent').every(entry => entry.params['modifiers'] === 10)).toBe(true)
    cleanup()
  })

  it('input: a chord is refused on a hidden window and for unknown keys', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.windows[0]!.visible = false
    const calls: string[] = []
    adapter.lastView().transport.handler = (method: string) => { calls.push(method); return { result: { value: 'BODY' } } }
    await expect(runtime.hotkey(1, ['Control', 'A'])).rejects.toMatchObject({ code: 'policy' })
    expect(calls.filter(method => method === 'Input.dispatchKeyEvent')).toEqual([])
    adapter.windows[0]!.visible = true
    // macOS application shortcuts share the same denylist class.
    await expect(runtime.hotkey(1, ['Meta', 'Q'])).rejects.toMatchObject({ code: 'policy' })
    expect(calls.filter(method => method === 'Input.dispatchKeyEvent')).toEqual([])
    await expect(runtime.hotkey(1, ['Control', 'NotAKey'])).rejects.toMatchObject({ code: 'policy' })
    // Modifiers must come first.
    await expect(runtime.hotkey(1, ['A', 'Control'])).rejects.toMatchObject({ code: 'policy' })
    cleanup()
  })

  it('scroll: untilBottom aborts promptly when the caller cancels', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('document.documentElement.scrollHeight')) {
        return { result: { value: { scrollX: 0, scrollY: 0, scrollHeight: 10_000, innerHeight: 800 } } }
      }
      return { result: { value: 'ok' } }
    }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)
    const started = Date.now()
    await expect(runtime.scroll(1, 0, undefined, controller.signal, { untilBottom: true })).rejects.toMatchObject({ code: 'interrupted' })
    expect(Date.now() - started).toBeLessThan(400)
    cleanup()
  })

  it('input: reserved application shortcuts are refused before any event', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.windows[0]!.visible = true
    const calls: string[] = []
    adapter.lastView().transport.handler = (method: string) => { calls.push(method); return { result: { value: 'BODY' } } }
    await expect(runtime.hotkey(1, ['Control', 'W'])).rejects.toMatchObject({ code: 'policy' })
    expect(calls.filter(method => method === 'Input.dispatchKeyEvent')).toEqual([])
    cleanup()
  })

  it('input: held keys are tracked, and a tab close releases them', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.windows[0]!.visible = true
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    const view = adapter.lastView()
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return method === 'Runtime.evaluate' ? { result: { value: 'INPUT' } } : {}
    }
    await runtime.pressKey(1, 'Shift', undefined, { action: 'down' })
    await expect(runtime.pressKey(1, 'Shift', undefined, { action: 'down' })).rejects.toMatchObject({ code: 'policy' })
    await runtime.closeTab(1, true)
    const keyUps = calls.filter(entry => entry.method === 'Input.dispatchKeyEvent' && entry.params['type'] === 'keyUp')
    expect(keyUps.length).toBeGreaterThanOrEqual(1)
    cleanup()
  })

  it('input: drag releases the button even when the caller aborts mid-drag', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.windows[0]!.visible = true
    const controller = new AbortController()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    adapter.lastView().transport.handler = (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mousePressed') controller.abort(new Error('caller gave up'))
      return {}
    }
    await expect(runtime.dragAt(1, { x: 10, y: 10 }, { x: 50, y: 50 }, controller.signal)).rejects.toBeTruthy()
    const releases = calls.filter(entry => entry.method === 'Input.dispatchMouseEvent' && entry.params['type'] === 'mouseReleased')
    expect(releases.length).toBeGreaterThanOrEqual(1)
    expect(releases[0]?.params['buttons']).toBe(0)
    cleanup()
  })

  it('input: double click sends two pairs and right click sets button+buttons', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    adapter.windows[0]!.visible = true
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    adapter.lastView().transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    await runtime.clickAt(1, { x: 5, y: 5 }, undefined, undefined, { doubleClick: true })
    const mouse = calls.filter(entry => entry.method === 'Input.dispatchMouseEvent')
    expect(mouse.map(entry => `${String(entry.params['type'])}:${String(entry.params['clickCount'])}`))
      .toEqual(['mousePressed:1', 'mouseReleased:1', 'mousePressed:2', 'mouseReleased:2'])
    calls.length = 0
    await runtime.clickAt(1, { x: 5, y: 5 }, undefined, undefined, { button: 'right' })
    const right = calls.filter(entry => entry.method === 'Input.dispatchMouseEvent')
    expect(right[0]?.params).toMatchObject({ button: 'right', buttons: 2 })
    cleanup()
  })

  it('input: slow typing caps the TOTAL delay and reports the applied value', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    let reads = 0
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      const expression = String(params?.['expression'] ?? '')
      if (method === 'Runtime.evaluate' && expression.includes('isContentEditable')) {
        // before/after read-back must differ, otherwise typeInto falls into the
        // DOM write fallback (which this mock does not implement).
        reads += 1
        return { result: { value: reads === 1 ? 'x' : 'xy' } }
      }
      return {}
    }
    const text = 'a'.repeat(100)
    const result = await runtime.typeInto(1, '#f', text, false, undefined, undefined, 1_000)
    // 5000 ms total cap / 100 chars = 50 ms each.
    expect(result.appliedDelayMs).toBe(50)
    cleanup()
  })

  it('input: clipboard read is capped and write is bounded', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const clipboard = adapter as unknown as { readClipboardText?: () => string, writeClipboardText?: (text: string) => void }
    clipboard.readClipboardText = () => 'password=hunter2 token=abc123 Authorization: Bearer xyz'
    const read = await runtime.clipboardRead()
    expect(read.text).toContain('****')
    expect(read.text).not.toContain('hunter2')
    expect(read.text).not.toContain('abc123')
    clipboard.readClipboardText = () => 'x'.repeat(100_000)
    const capped = await runtime.clipboardRead()
    expect(capped.text.length).toBe(64 * 1024)
    expect(capped.truncated).toBe(true)
    await expect(runtime.clipboardWrite('y'.repeat(1024 * 1024 + 1))).rejects.toMatchObject({ code: 'policy' })
    cleanup()
  })

  it('scroll: untilBottom reports the honest step limit, and position returns the actual point', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('document.documentElement.scrollHeight')) {
        return { result: { value: { scrollX: 3, scrollY: 7, scrollHeight: 10_000, innerHeight: 800 } } }
      }
      return { result: { value: 'ok' } }
    }
    let reads = 0
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('document.documentElement.scrollHeight')) {
        // The page never moves: the loop must stop with no-progress.
        return { result: { value: { scrollX: 0, scrollY: 0, scrollHeight: 10_000, innerHeight: 800 } } }
      }
      return { result: { value: 'ok' } }
    }
    const bottom = await runtime.scroll(1, 0, undefined, undefined, { untilBottom: true })
    expect(bottom.reachedBottom).toBe(false)
    expect(bottom.bottomReason).toBe('no-progress')
    // position returns the ACTUAL scroll point, not the requested one.
    reads = 0
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.['expression'] ?? '')
      if (expression.includes('document.documentElement.scrollHeight')) {
        reads += 1
        return { result: { value: { scrollX: 5, scrollY: 9, scrollHeight: 10_000, innerHeight: 800 } } }
      }
      return { result: { value: 'ok' } }
    }
    const position = await runtime.scroll(1, 0, undefined, undefined, { position: { x: 3, y: 7 } })
    expect(position).toMatchObject({ scrollX: 5, scrollY: 9 })
    cleanup()
  })

  it('snapshot extras: default output is byte-identical, shadow/frame entries are append-only', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const mainProbeValue = {
      elements: [{ kind: 'button', text: 'Save', selector: '#save', visible: true, disabled: false }],
      total: 1,
      truncated: false,
      frames: 1,
      shadowRoots: 1,
      shadowScanCapped: false,
      countCapped: false,
    }
    let extrasCalls = 0
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params['expression'] ?? '')
      if (expression.includes('crossOrigin')) {
        extrasCalls += 1
        return {
          result: {
            value: JSON.stringify({
              entries: [
                { selector: '#host >>> button:nth-child(1)', kind: 'button', text: 'Inner', shadow: true, visible: true, disabled: false },
                { selector: '#in-frame', kind: 'link', text: 'Link', frame: 2, visible: false, disabled: true },
              ],
              crossOrigin: [3],
            }),
          },
        }
      }
      return { result: { value: mainProbeValue } }
    }
    const plain = await runtime.modelSnapshot(1)
    const explicitFalse = await runtime.modelSnapshot(1, undefined, { includeShadow: false, includeFrames: false })
    expect(plain.elements).toEqual(explicitFalse.elements)
    expect(extrasCalls).toBe(0)
    expect(plain.elements).toHaveLength(1)
    const withExtras = await runtime.modelSnapshot(1, undefined, { includeShadow: true, includeFrames: true })
    expect(extrasCalls).toBe(1)
    // Append-only: the existing entry keeps index 1, new ones come after.
    expect(withExtras.elements[0]).toMatchObject({ index: 1, selector: '#save' })
    expect(withExtras.elements[1]).toMatchObject({ index: 2, shadow: true })
    expect(withExtras.elements[2]).toMatchObject({ index: 3, frame: 2, selector: '#in-frame', visible: false, disabled: true })
    expect(withExtras.meta.crossOriginFrames).toEqual([3])
    cleanup()
  })

  it('snapshot extras: text is redacted BEFORE the 200-char slice (no secret fragment)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params['expression'] ?? '')
      if (expression.includes('crossOrigin')) {
        return {
          result: {
            value: JSON.stringify({
              entries: [{ selector: '#host >>> button', kind: 'button', text: 'A'.repeat(150) + 'password=supersecret12345', shadow: true, visible: true, disabled: false }],
              crossOrigin: [],
            }),
          },
        }
      }
      return {
        result: {
          value: {
            elements: [{ kind: 'button', text: 'Save', selector: '#save', visible: true, disabled: false }],
            total: 1, truncated: false, frames: 0, shadowRoots: 1, shadowScanCapped: false, countCapped: false,
          },
        },
      }
    }
    const snapshot = await runtime.modelSnapshot(1, undefined, { includeShadow: true })
    const extras = snapshot.elements[1]!
    expect(extras.text.length).toBeLessThanOrEqual(200)
    // The VALUE must be gone (a truncated value fragment is the R7 leak); the
    // keyword itself (`password=`) may legitimately stay.
    expect(extras.text).not.toContain('supersecret')
    expect(extras.text).not.toContain('supersecr')
    expect(extras.text).toContain('****')
    cleanup()
  })

  it('snapshot extras: covered blind spots leave the note, nested frames and truncation stay visible', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params['expression'] ?? '')
      if (expression.includes('crossOrigin')) {
        return {
          result: {
            value: JSON.stringify({
              entries: [{ selector: '#in-frame', kind: 'button', text: 'Go', frame: 1, visible: true, disabled: false }],
              crossOrigin: [],
              truncated: true,
              frames: 1,
            }),
          },
        }
      }
      return {
        result: {
          value: {
            elements: [{ kind: 'button', text: 'Save', selector: '#save', visible: true, disabled: false }],
            total: 1, truncated: false, frames: 1, shadowRoots: 1, shadowScanCapped: false, countCapped: false,
          },
        },
      }
    }
    const plain = await runtime.modelSnapshot(1)
    expect(snapshotNote(plain.meta)).toContain('NOT included')
    const withExtras = await runtime.modelSnapshot(1, undefined, { includeShadow: true, includeFrames: true })
    const note = snapshotNote(withExtras.meta)
    // Covered blind spots are no longer claimed as missing; truncation still is.
    expect(note ?? '').not.toContain('NOT included')
    expect(note ?? '').toContain('cut at the limit')
    expect(withExtras.meta.truncated).toBe(true)
    cleanup()
  })

  it('locate: a ">>>" selector walks open shadow roots, a plain one does not', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const expressions: string[] = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      expressions.push(String(params['expression'] ?? ''))
      return { result: { value: { x: 10, y: 20 } } }
    }
    await expect(runtime.locateElement(1, '#host >>> button')).resolves.toEqual({ x: 10, y: 20 })
    expect(expressions[0]).toContain('shadowRoot')
    expect(expressions[0]).toContain('"#host >>> button"')
    expressions.length = 0
    await runtime.locateElement(1, '#plain')
    // A plain selector still goes through the piercing helper (same code path) —
    // the important part is that its parts array has a single segment.
    expect(expressions[0]).toContain('#plain')
    cleanup()
  })

  it('shadow selectors reach type/select/get_text/scroll (no action-only dead end)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const expressions: string[] = []
    let reads = 0
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params['expression'] ?? '')
      expressions.push(expression)
      if (expression.includes('isContentEditable')) {
        // typeInto's read-back must change so it takes the typed path.
        reads += 1
        return { result: { value: reads === 1 ? 'a' : 'ab' } }
      }
      return { result: { value: 'x' } }
    }
    const shadowSelector = '#host >>> input'
    await runtime.textWithMeta(1, shadowSelector)
    expect(expressions.at(-1)).toContain('__query')
    expressions.length = 0
    await runtime.scroll(1, 0, shadowSelector)
    expect(expressions.some(expression => expression.includes('__query'))).toBe(true)
    expressions.length = 0
    await runtime.selectOptionChoice(1, '#host >>> select', { index: 0 })
    expect(expressions.at(-1)).toContain('__query')
    expressions.length = 0
    await runtime.typeInto(1, shadowSelector, 'abc', false)
    expect(expressions.some(expression => expression.includes('__query'))).toBe(true)
    // Selector without >>> keeps the plain path (no helper injected).
    expressions.length = 0
    await runtime.textWithMeta(1, '#plain')
    expect(expressions.at(-1)).not.toContain('__query')
    cleanup()
  })

  it('frame actions: click/text run in the frame context and validate arguments', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown>, argv: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params, argv: {} })
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'F0', url: 'https://a.example/', childFrames: [] },
          },
        }
      }
      if (method === 'Page.createIsolatedWorld' || method === 'Runtime.enable') return {}
      return { result: { value: frameValue } }
    }
    let frameValue: unknown = 'clicked'
    // resolveFrame reads Page.getFrameTree + Runtime.enable; the mock above keeps
    // the tree at frame 0 only, so frame 1 is an explicit not-found instead of
    // silently acting on the main frame.
    await expect(runtime.clickInFrame(1, 1, '#go')).rejects.toMatchObject({ code: 'not-found' })
    // A frame script NEVER goes through the main-frame document: the expression
    // is evaluated with the frame's contextId (or its session id).
    frameValue = 'body text'
    await expect(runtime.textInFrame(1, 1, undefined)).rejects.toMatchObject({ code: 'not-found' })
    cleanup()
  })

  it('frame actions: same-process frames use contextId, OOPIF frames use the session id', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method: string) => (method === 'Runtime.evaluate' ? { result: { value: 'clicked' } } : {})
    const internal = runtime as unknown as { resolveFrame: (tab: unknown, frame: number) => Promise<unknown> }
    internal.resolveFrame = async () => ({ frameId: 'F1', url: 'https://a.example/frame', depth: 1, contextId: 7 })
    await runtime.clickInFrame(1, 1, '#go')
    const sameProcess = view.transport.sent.filter(entry => entry.method === 'Runtime.evaluate').at(-1)!
    expect(sameProcess.params['contextId']).toBe(7)
    expect(sameProcess.sessionId).toBeUndefined()
    internal.resolveFrame = async () => ({ frameId: 'F2', url: 'https://other.example/frame', depth: 1, sessionId: 'SESSION-1' })
    await runtime.clickInFrame(1, 1, '#go')
    const oopif = view.transport.sent.filter(entry => entry.method === 'Runtime.evaluate').at(-1)!
    expect(oopif.sessionId).toBe('SESSION-1')
    // A disabled element inside the frame is refused instead of "clicked".
    view.transport.handler = () => ({ result: { value: 'disabled' } })
    await expect(runtime.clickInFrame(1, 1, '#off')).rejects.toMatchObject({ code: 'policy' })
    cleanup()
  })

  it('frame-level stale: a replaced or navigated frame refuses the old numbering', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method: string) => (method === 'Runtime.evaluate'
      ? { result: { value: { elements: [], total: 0, truncated: false, frames: 1, shadowRoots: 0, shadowScanCapped: false, countCapped: false } } }
      : {})
    const internal = runtime as unknown as { frameIndex: (tab: unknown) => Promise<unknown> }
    internal.frameIndex = async () => [
      { frameId: 'F0', url: 'https://a.example/', depth: 0 },
      { frameId: 'F1', url: 'https://a.example/frame', depth: 1, contextId: 3 },
    ]
    await runtime.modelSnapshot(1)
    await expect(runtime.assertFrameFresh(1, 1)).resolves.toBeUndefined()
    // The frame document was replaced (reload) — same url, different frameId —
    // WITHOUT taking a new snapshot: the old numbering must go stale.
    internal.frameIndex = async () => [
      { frameId: 'F0', url: 'https://a.example/', depth: 0 },
      { frameId: 'F1-NEW', url: 'https://a.example/frame', depth: 1, contextId: 4 },
    ]
    await expect(runtime.assertFrameFresh(1, 1)).rejects.toMatchObject({ code: 'stale-snapshot' })
    cleanup()
  })

  it('frame-level stale: a same-frameId navigation (url change) is caught too', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const sendFrame = (url: string) => { void url }
    const view = adapter.lastView()
    sendFrame('https://a.example/frame')
    view.transport.handler = (method: string) => (method === 'Runtime.evaluate'
      ? { result: { value: { elements: [], total: 0, truncated: false, frames: 1, shadowRoots: 0, shadowScanCapped: false, countCapped: false } } }
      : {})
    const internal = runtime as unknown as { frameIndex: (tab: unknown) => Promise<unknown> }
    internal.frameIndex = async () => [
      { frameId: 'F0', url: 'https://a.example/', depth: 0 },
      { frameId: 'F1', url: 'https://a.example/frame', depth: 1, contextId: 3 },
    ]
    await runtime.modelSnapshot(1)
    internal.frameIndex = async () => [
      { frameId: 'F0', url: 'https://a.example/', depth: 0 },
      { frameId: 'F1', url: 'https://a.example/other', depth: 1, contextId: 4 },
    ]
    await expect(runtime.assertFrameFresh(1, 1)).rejects.toMatchObject({ code: 'stale-snapshot' })
    cleanup()
  })

  it('screenshots: fullPage capture, honest CDP fallback and the size cap', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    const tiny = 'A'.repeat(64)
    let failFirst = false
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, contentSize: { width: 800, height: 5000 } }
      if (method === 'Page.captureScreenshot') {
        if (failFirst) { failFirst = false; throw new Error('full page failed') }
        return { data: tiny }
      }
      return {}
    }
    const full = await runtime.screenshotWithOptions(1, { fullPage: true })
    expect(full).toMatchObject({ fullPage: true, format: 'jpeg' })
    const capture = calls.find(entry => entry.method === 'Page.captureScreenshot')!
    expect(capture.params['captureBeyondViewport']).toBe(true)
    // A failing full-page capture falls back INSIDE the CDP path (works on a
    // hidden window) and keeps the requested format.
    calls.length = 0
    failFirst = true
    const fallback = await runtime.screenshotWithOptions(1, { fullPage: true, format: 'png' })
    expect(fallback.fullPage).toBe(false)
    expect(fallback.format).toBe('png')
    expect(fallback.data.startsWith('data:image/png;base64,')).toBe(true)
    // PNG over the cap: policy, and NO second capture attempt.
    calls.length = 0
    const huge = 'A'.repeat(Math.ceil(9 * 1024 * 1024 * 4 / 3))
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, contentSize: { width: 800, height: 5000 } }
      if (method === 'Page.captureScreenshot') return { data: huge }
      return {}
    }
    await expect(runtime.screenshotWithOptions(1, { fullPage: true, format: 'png' })).rejects.toMatchObject({ code: 'policy' })
    expect(calls.filter(entry => entry.method === 'Page.captureScreenshot')).toHaveLength(1)
    // JPEG over the cap: exactly ONE retry with a lower quality.
    const qualities: unknown[] = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, contentSize: { width: 800, height: 5000 } }
      if (method === 'Page.captureScreenshot') {
        qualities.push(params['quality'])
        return { data: qualities.length === 1 ? huge : tiny }
      }
      return {}
    }
    const degraded = await runtime.screenshotWithOptions(1, { fullPage: true, quality: 80 })
    expect(degraded.format).toBe('jpeg')
    expect(qualities).toEqual([80, 40])
    cleanup()
  })

  it('screenshots: a clip is clamped and a failed capture still restores overrides', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, contentSize: { width: 1000, height: 2000 } }
      if (method === 'Page.captureScreenshot') return { data: 'A'.repeat(64) }
      return {}
    }
    await runtime.screenshotWithOptions(1, { clip: { x: 900, y: 1900, width: 500, height: 500 } })
    const capture = calls.find(entry => entry.method === 'Page.captureScreenshot')!
    const clip = capture.params['clip'] as { x: number, y: number, width: number, height: number }
    expect(clip.x + clip.width).toBeLessThanOrEqual(1000)
    expect(clip.y + clip.height).toBeLessThanOrEqual(2000)
    expect(clip.width).toBeGreaterThan(0)
    // A far-out origin is clamped to the last pixel, and the size to what is left.
    calls.length = 0
    await runtime.screenshotWithOptions(1, { clip: { x: 9_999, y: 9_999, width: 50, height: 50 } })
    const farClip = (calls.find(entry => entry.method === 'Page.captureScreenshot')!.params['clip']) as { x: number, y: number, width: number, height: number }
    expect(farClip).toMatchObject({ x: 999, y: 1999, width: 1, height: 1 })
    // Exception path: overrides are still restored.
    ;(runtime as unknown as { emulationOverrides: Map<number, unknown> }).emulationOverrides.set(1, { viewport: { width: 400, height: 800 } })
    view.transport.handler = (method: string) => {
      calls.push({ method, params: {} })
      if (method === 'Page.getLayoutMetrics') return {}
      if (method === 'Page.captureScreenshot') throw new Error('capture failed')
      return {}
    }
    await expect(runtime.screenshotWithOptions(1, { fullPage: true })).rejects.toBeTruthy()
    expect(calls.some(entry => entry.method === 'Emulation.setDeviceMetricsOverride')).toBe(true)
    cleanup()
  })

  it('screenshots: emulation overrides are cleared before fullPage and restored after', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: string[] = []
    view.transport.handler = (method: string) => {
      calls.push(method)
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, contentSize: { width: 800, height: 5000 } }
      if (method === 'Page.captureScreenshot') return { data: 'A'.repeat(64) }
      return {}
    }
    ;(runtime as unknown as { emulationOverrides: Map<number, unknown> }).emulationOverrides.set(1, { viewport: { width: 400, height: 800 }, userAgent: 'UA-X' })
    await runtime.screenshotWithOptions(1, { fullPage: true })
    const clearIndex = calls.indexOf('Emulation.clearDeviceMetricsOverride')
    const captureIndex = calls.indexOf('Page.captureScreenshot')
    const restoreIndex = calls.lastIndexOf('Emulation.setDeviceMetricsOverride')
    expect(clearIndex).toBeGreaterThanOrEqual(0)
    expect(captureIndex).toBeGreaterThan(clearIndex)
    expect(restoreIndex).toBeGreaterThan(captureIndex)
    cleanup()
  })

  it('screenshots: the viewport fallback is still bounded by the 8 MiB cap', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const huge = 'A'.repeat(Math.ceil(9 * 1024 * 1024 * 4 / 3))
    const captures: Array<Record<string, unknown>> = []
    let call = 0
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, contentSize: { width: 800, height: 5000 } }
      if (method === 'Page.captureScreenshot') {
        call += 1
        captures.push(params)
        if (call === 1) throw new Error('full page failed')
        return { data: huge }
      }
      return {}
    }
    // JPEG: one quality retry, then policy — never an over-cap data URL.
    await expect(runtime.screenshotWithOptions(1, { fullPage: true })).rejects.toMatchObject({ code: 'policy' })
    expect(captures).toHaveLength(3)
    // PNG: the fallback cannot be recompressed -> policy after the fallback capture.
    captures.length = 0
    call = 0
    await expect(runtime.screenshotWithOptions(1, { fullPage: true, format: 'png' })).rejects.toMatchObject({ code: 'policy' })
    expect(captures).toHaveLength(2)
    cleanup()
  })

  it('fetch: request data travels as the callFunctionOn argument and redirects are refused', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    let response = JSON.stringify({ status: 200, ok: true, url: 'https://a.example/api', contentType: 'application/json', bytes: 2, body: '{}', truncated: false, bodyOmitted: false })
    view.transport.handler = (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'Runtime.callFunctionOn') return { result: { value: response } }
      if (method === 'Runtime.evaluate') return { result: { objectId: 'g' } }
      return {}
    }
    const url = "https://a.example/api?q='\") ; drop"
    const result = await runtime.pageFetch(1, { url, method: 'POST', body: '{"x":1}', headers: { 'content-type': 'application/json' } })
    expect(result).toMatchObject({ status: 200, ok: true, body: '{}' })
    const call = calls.find(entry => entry.method === 'Runtime.callFunctionOn')!
    const payload = (call.params['arguments'] as Array<{ value: Record<string, unknown> }>)[0]!.value
    // Injected characters stay DATA: the argument carries the exact string.
    expect(payload['url']).toBe(url)
    expect(payload['method']).toBe('POST')
    expect(payload['timeoutMs']).toBeLessThanOrEqual(10_000)
    // A redirect/CORS error is refused (redirect:'error' semantics).
    view.transport.handler = () => { throw new Error('Failed to fetch') }
    await expect(runtime.pageFetch(1, { url: 'https://a.example/r' })).rejects.toMatchObject({ code: 'policy' })
    cleanup()
  })

  it('fetch: method/body/header/url guards are enforced before any page call', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    let called = 0
    view.transport.handler = (method: string) => { called += 1; return method === 'Runtime.evaluate' ? { result: { objectId: 'g' } } : { result: { value: '{}' } } }
    await expect(runtime.pageFetch(1, { url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'policy' })
    await expect(runtime.pageFetch(1, { url: 'https://a.example/', headers: { authorization: 'x' } })).rejects.toMatchObject({ code: 'policy' })
    await expect(runtime.pageFetch(1, { url: 'https://a.example/', method: 'GET', body: 'x' })).rejects.toMatchObject({ code: 'policy' })
    await expect(runtime.pageFetch(1, { url: 'https://a.example/', method: 'TRACE' })).rejects.toMatchObject({ code: 'policy' })
    // POST so the GET-body guard does not mask the size guard (audit V5).
    await expect(runtime.pageFetch(1, { url: 'https://a.example/', method: 'POST', body: 'x'.repeat(300 * 1024) })).rejects.toMatchObject({ code: 'policy' })
    expect(called).toBe(0)
    cleanup()
  })

  it('fetch: a non-text response returns metadata only (no base64 body)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.handler = (method: string) => {
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: JSON.stringify({ status: 200, ok: true, url: 'https://a.example/a.bin', contentType: 'application/octet-stream', bytes: 4096, body: null, truncated: false, bodyOmitted: true }) } }
      }
      if (method === 'Runtime.evaluate') return { result: { objectId: 'g' } }
      return {}
    }
    const result = await runtime.pageFetch(1, { url: 'https://a.example/a.bin' })
    expect(result).toMatchObject({ bytes: 4096, body: null, bodyOmitted: true })
    cleanup()
  })

  it('dialog: browser_dialog itself is never blocked by its own fail-fast', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?', defaultPrompt: 'x', url: 'https://a.example/' })
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    await expect(runtime.handleDialog(1, 'accept', 'typed')).resolves.toMatchObject({ type: 'prompt' })
    expect(calls).toContainEqual({ method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'typed' } })
    expect(runtime.dialogState(1)).toBeUndefined()
    // A second answer is an explicit not-found, not a silent no-op.
    await expect(runtime.handleDialog(1, 'dismiss')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('dialog: promptText is refused for non-prompt dialogs, and dismiss sends accept=false', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    view.transport.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' })
    await expect(runtime.handleDialog(1, 'accept', 'text')).rejects.toMatchObject({ code: 'policy' })
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    await runtime.handleDialog(1, 'dismiss')
    expect(calls).toContainEqual({ method: 'Page.handleJavaScriptDialog', params: { accept: false } })
  })

  it('dialog: teardown and user takeover dismiss (dismiss before forgetting state)', async () => {
    const { adapter, runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const view = adapter.lastView()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    view.transport.handler = (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {} }
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' })
    runtime.setUserControl(true, 'user')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(calls).toContainEqual({ method: 'Page.handleJavaScriptDialog', params: { accept: false } })
    expect(runtime.dialogState(1)).toBeUndefined()
    // Release the user gate before closing: an agent-path close would wait for
    // the gate (10s) — the user path is the correct way out of a takeover.
    runtime.setUserControl(false)
    view.transport.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'again' })
    await runtime.closeTab(1, true)
    expect(runtime.dialogState(1)).toBeUndefined()
    cleanup()
  })

  it('downloadUrl triggers webContents.downloadURL and records history', async () => {
    const { runtime, adapter, store, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.downloadUrl('https://files.example/x.zip')
    expect(adapter.lastView().downloadURL).toHaveBeenCalledWith('https://files.example/x.zip')
    expect(store.counts().history).toBeGreaterThan(0)
    cleanup()
  })

  it('bookmarks add/list/remove work with active tab', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const b = runtime.addBookmark(id, 'My Bookmark')
    expect(runtime.listBookmarks().some((x) => x.id === b.id)).toBe(true)
    expect(runtime.removeBookmark(b.id)).toBe(true)
    cleanup()
  })

  it('clearData clears session storage/cache', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.open('https://b.example')
    await runtime.clearData(true)
    for (const view of adapter.views) {
      expect(view.session.clearStorageData).toHaveBeenCalled()
      expect(view.session.clearCache).toHaveBeenCalled()
    }
    cleanup()
  })

  it('user takeover pauses agent ops; release resumes them; abort rejects window-controlled', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    runtime.setUserControl(true)
    let ran = false
    const p = runtime.navigate(1, 'https://c.example').then(() => { ran = true })
    await sleep(80)
    expect(ran).toBe(false)
    runtime.setUserControl(false)
    await p
    expect(ran).toBe(true)
    runtime.setUserControl(true)
    const ctrl = new AbortController()
    const pending = runtime.navigate(1, 'https://d.example', 'domcontentloaded', ctrl.signal).catch((e: unknown) => e)
    ctrl.abort()
    const err = await pending
    expect((err as Error & { code?: string }).code).toBe('window-controlled')
    cleanup()
  })

  it('用户闸挡住调用后上报"等待交还"状态，一次控制权周期只记一条 op（2026-09-16）', async () => {
    // 现场（会话 session-88502514）：AI 的动作被用户闸挡住 25 分钟，模型只看到
    // 笼统超时，界面/日志里没有任何"用户正拿着控制权"的证据。这个状态要能被
    // shell（GET /state）、侧边栏提示和 browser_list_tabs 同时读到。
    const adapter = new MockAdapter()
    const dir = join(process.cwd(), 'tests', `.rt-gate-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const store = new BrowserStore({ dir })
    const pool = new TabPool({ userGateTimeoutMs: 40 })
    const runtime = new BrowserRuntime(adapter, {}, undefined, undefined, { pool, store })
    try {
      await runtime.open('https://a.example')
      expect(runtime.shellState().awaitingRelease).toBe(false)

      runtime.setUserControl(true, 'ai')
      const first = await runtime.navigate(1, 'https://b.example').catch((cause: unknown) => cause)
      expect((first as { code?: string }).code).toBe('window-controlled')
      expect(String((first as Error).message)).toContain('交给 AI')

      const state = runtime.shellState()
      expect(state.controlled).toBe(true)
      expect(state.awaitingRelease).toBe(true)
      expect(state.awaitingReleaseTool).toBe('browser_navigate')
      expect(runtime.controlState()).toMatchObject({ awaitingRelease: true, awaitingReleaseTool: 'browser_navigate' })

      // 只有第一条被拒的调用进活动面板（模型重试十几次不该刷屏）
      const blocked = runtime.opLog.filter((op) => op.summary.includes('用户正在操作浏览器'))
      expect(blocked).toHaveLength(1)
      expect(blocked[0]?.failed).toBe(true)
      await runtime.navigate(1, 'https://c.example').catch(() => {})
      expect(runtime.opLog.filter((op) => op.summary.includes('用户正在操作浏览器'))).toHaveLength(1)

      // 池子被清空（关闭浏览器/窗口销毁/切换会话）同样复位"等待交还"
      pool.clear()
      expect(runtime.shellState().controlled).toBe(false)
      expect(runtime.shellState().awaitingRelease).toBe(false)
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('用户交还控制权后"等待交还"提示立刻消失（2026-09-16）', async () => {
    const adapter = new MockAdapter()
    const dir = join(process.cwd(), 'tests', `.rt-gate-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    const store = new BrowserStore({ dir })
    const runtime = new BrowserRuntime(adapter, {}, undefined, undefined, { pool: new TabPool({ userGateTimeoutMs: 40 }), store })
    try {
      await runtime.open('https://a.example')
      runtime.setUserControl(true, 'ai')
      await runtime.navigate(1, 'https://b.example').catch(() => {})
      expect(runtime.shellState().awaitingRelease).toBe(true)
      runtime.setUserControl(false, 'user')
      expect(runtime.shellState().awaitingRelease).toBe(false)
      expect(runtime.shellState().awaitingReleaseTool).toBe('')
      // 交还后 agent 操作恢复正常（不是把池子卡死）
      await expect(runtime.navigate(1, 'https://d.example')).resolves.toBeUndefined()
    } finally {
      runtime.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('user takeover aborts an in-flight waitFor (cooperative checkpoint)', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const view = adapter.lastView()
    view.transport.handler = (method) => method === 'Runtime.callFunctionOn' ? { result: { value: false } } : {}
    const pending = runtime.waitFor(id, { condition: 'element-present', selector: '#never', timeoutMs: 10_000 })
      .catch((cause: unknown) => cause)
    await sleep(180)
    runtime.setUserControl(true, 'user')
    const error = await pending as { code?: string }
    expect(error.code).toBe('window-controlled')
    runtime.setUserControl(false, 'user')
    cleanup()
  })

  it('截图渲染期间的接管也必须记进 gateBlock（2026-09-17 审计 S01-2/S02-03）', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const id = runtime.currentTabId()!
    const view = adapter.lastView()
    // 把捕获挂住：模拟"用户在截图渲染期间点了「我来操作」"。
    let release!: (image: NativeImage) => void
    const gate = new Promise<NativeImage>((resolve) => { release = resolve })
    view.capturePage.mockImplementationOnce(async () => await gate)

    const pending = runtime.screenshot(id).catch((cause: unknown) => cause)
    await sleep(30)
    runtime.setUserControl(true, 'user')
    release(new MockImage(64, 64))

    const error = await pending as { code?: string }
    expect(error.code).toBe('window-controlled')
    // 关键：这次拒绝必须走到 withAgentAttribution 的记账路径，否则侧边栏
    // 「AI 正在等你交还浏览器控制权」不会亮（gateBlock 是唯一触发源）。
    expect(runtime.shellState()).toMatchObject({
      controlled: true,
      awaitingRelease: true,
      awaitingReleaseTool: 'browser_screenshot',
    })
    expect(runtime.opLog.filter((op) => op.summary.includes('用户正在操作浏览器'))).toHaveLength(1)
    runtime.setUserControl(false, 'user')
    cleanup()
  })

  it('navigation failure with a previous page is reported, not swallowed', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://old.example')
    const view = adapter.lastView()
    view.loadURL.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED'))
    const error = await runtime.navigate(runtime.currentTabId()!, 'https://bad.example')
      .catch((cause: unknown) => cause) as { code?: string, message?: string }
    expect(error.code).toBe('network')
    expect(String(error.message)).toContain('navigation failed')
    cleanup()
  })

  it('shellState exposes tabs/busy/controlled/latestOp', async () => {
    const { runtime, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    const state = runtime.shellState()
    expect(state.tabs).toHaveLength(1)
    expect(state.busy).toBe(false)
    expect(state.controlled).toBe(false)
    expect(state.latestOp?.tool).toBe('browser_open')
    cleanup()
  })

  it('closeAll clears tabs and hides the window', async () => {
    const { runtime, adapter, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    await runtime.closeAll(true)
    expect(runtime.listTabs()).toHaveLength(0)
    expect(adapter.windows[0]?.visible).toBe(false)
    cleanup()
  })

  it('ledger persists tabs across runtimes (same store)', async () => {
    const { runtime, store, cleanup } = makeRuntime()
    await runtime.open('https://a.example')
    runtime.saveLedger()
    const runtime2 = new BrowserRuntime(new MockAdapter(), {}, undefined, undefined, { store })
    runtime2.restoreLedger()
    expect(runtime2.pool.list().length).toBe(1)
    cleanup()
    runtime2.dispose()
  })
})
