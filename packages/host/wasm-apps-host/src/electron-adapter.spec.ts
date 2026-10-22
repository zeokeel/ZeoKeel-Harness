/**
 * Electron 适配器回归：协议特权位与两次注册（默认 session + 分区）。
 *
 * `electron` 用 `vi.mock` 替身注入：本模块的静态 `import { protocol, session }
 * from 'electron'` 在纯 Node 下解析到的是 Electron 包的 CJS 入口（无命名导出），
 * 所以这个 spec 是"适配器形状"唯一的离线判据。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registerSchemesAsPrivileged = vi.fn()
const defaultHandle = vi.fn()
const partitionHandle = vi.fn()
// F-07：`clearStorageData` 的**精确 origin** 判据（见本文件末尾的 `clearAppStorage` 用例）。
const defaultClearStorage = vi.fn(async () => undefined)
const partitionClearStorage = vi.fn(async () => undefined)
const fromPartition = vi.fn(() => ({ protocol: { handle: partitionHandle }, clearStorageData: partitionClearStorage }))
const defaultSessionFetch = vi.fn(async () => new Response('ok', { status: 200 }))

/**
 * 替身 `BrowserWindow`（`electron-adapter.spec.ts` 的第二个被测对象 =
 * `createRealElectronWindowAdapter`）。
 *
 * 为什么用替身而不是真 Electron：这里要钉的是"原生动作有没有按契约发生"
 * （几何进了构造参数、导航闸门按 app origin 判、标题不可被页面改写、关窗后
 * `isAlive` 变假），不是 Electron 自己的行为。真正的"窗口真的开了"由真机判据
 * （CDP 目标列表出现 `zeokeel-app://<app_id>/`）承担。
 */
class FakeWebContents {
  static nextId = 100
  readonly id = (FakeWebContents.nextId += 1)
  url = ''
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  windowOpenHandler: ((details: unknown) => unknown) | undefined
  /** 下一次 `loadURL` 的失败（模拟被顶掉/加载错误）。 */
  nextLoadFailure: unknown
  /** 下一次 `loadURL` **永不 settle**（U-01 看门狗：加载既不 resolve 也不 reject）。 */
  nextLoadHangs = false

  /** F-06：刷新 / 返回的次数（右键菜单与键盘快捷键共用同一对实现）。 */
  reloaded = 0
  readonly navigationHistory = { back: 0, goBack: (): void => { this.navigationHistory.back += 1 } }
  /** F-05：注入应用页面的脚本（提示条）。 */
  readonly executed: string[] = []

  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  reload(): void {
    this.reloaded += 1
  }

  executeJavaScript(code: string): Promise<unknown> {
    this.executed.push(code)
    return Promise.resolve(undefined)
  }

  getURL(): string {
    return this.url
  }

  setWindowOpenHandler(handler: (details: unknown) => unknown): void {
    this.windowOpenHandler = handler
  }

  failNextLoad(cause: unknown): void {
    this.nextLoadFailure = cause
  }

  emit(event: string, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class FakeBrowserWindow {
  static readonly created: FakeBrowserWindow[] = []
  readonly options: Record<string, unknown>
  readonly webContents = new FakeWebContents()
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  readonly loaded: string[] = []
  readonly aspectRatios: Array<{ ratio: number, extraSize: unknown }> = []
  destroyed = false
  minimized = false
  visible = true
  focused = 0
  menuBarHidden = false

  constructor(options: Record<string, unknown>) {
    this.options = options
    FakeBrowserWindow.created.push(this)
  }

  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: string, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  setMenuBarVisibility(visible: boolean): void {
    this.menuBarHidden = !visible
  }

  loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    this.webContents.url = url
    if (this.webContents.nextLoadHangs) {
      this.webContents.nextLoadHangs = false
      // 永不 settle：模拟协议 handler 卡死/导航被吞（既不 resolve 也不 reject）。
      return new Promise(() => {})
    }
    const failure = this.webContents.nextLoadFailure
    this.webContents.nextLoadFailure = undefined
    if (failure !== undefined) return Promise.reject(failure)
    return Promise.resolve()
  }

  focus(): void {
    this.focused += 1
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isVisible(): boolean {
    return this.visible
  }

  restore(): void {
    this.minimized = false
  }

  show(): void {
    this.visible = true
  }

  close(): void {
    this.destroyed = true
    this.emit('closed')
  }

  setAspectRatio(ratio: number, extraSize: unknown): void {
    this.aspectRatios.push({ ratio, extraSize })
  }
}

const getCursorScreenPoint = vi.fn(() => ({ x: 5, y: 6 }))
const getDisplayNearestPoint = vi.fn(() => ({ workArea: { x: 1, y: 2, width: 1600, height: 900 } }))

/**
 * 替身 `net.request`（ClientRequest）：`createPlatformFetch` 的被测对象。
 *
 * 记录 method/url/session/头/体，并按脚本回一个响应（或错误）。
 */
interface FakeClientRequest {
  method: string
  url: string
  session: unknown
  redirect: unknown
  headers: Record<string, string>
  body: Buffer[]
  aborted: boolean
  ended: boolean
  /** 是否在 `redirect` 事件里同步调过 `followRedirect()`（真实 Electron 的契约）。 */
  followed: boolean
  listeners: Map<string, Array<(...args: never[]) => void>>
  setHeader(name: string, value: string): void
  write(chunk: Buffer | string): void
  end(): void
  abort(): void
  followRedirect(): void
  on(event: string, listener: (...args: never[]) => void): void
  emit(event: string, ...args: never[]): void
}

/** 下一次 `net.request` 的行为脚本。 */
let netScript: {
  status?: number
  statusMessage?: string
  headers?: Record<string, string | string[]>
  chunks?: Buffer[]
  failWith?: Error
  respond?: boolean
  /**
   * 先回一个 3xx（`redirect` 事件），再按真实 Electron 的语义走：
   * 监听器里同步调了 `followRedirect()` ⇒ 继续跑这次请求的响应；没调 ⇒
   * `error: Redirect was cancelled`（2026-09-20 探针 `temp/fix-appwin-r2/probe-nav.mjs`
   * 在 Electron 43 上实测的形态）。
   */
  redirectTo?: string
  redirectStatus?: number
} = {}

const netRequests: FakeClientRequest[] = []

function makeClientRequest(options: { method: string, url: string, session: unknown, redirect: unknown }): FakeClientRequest {
  const request: FakeClientRequest = {
    method: options.method,
    url: options.url,
    session: options.session,
    redirect: options.redirect,
    headers: {},
    body: [],
    aborted: false,
    ended: false,
    followed: false,
    listeners: new Map(),
    setHeader(name, value) { request.headers[name] = value },
    write(chunk) { request.body.push(Buffer.from(chunk)) },
    on(event, listener) {
      const list = request.listeners.get(event) ?? []
      list.push(listener)
      request.listeners.set(event, list)
    },
    emit(event, ...args) {
      for (const listener of request.listeners.get(event) ?? []) listener(...args)
    },
    abort() {
      request.aborted = true
      request.emit('abort')
    },
    followRedirect() { request.followed = true },
    end() {
      request.ended = true
      if (netScript.failWith !== undefined) {
        queueMicrotask(() => { request.emit('error', netScript.failWith as never) })
        return
      }
      if (netScript.respond === false) return
      queueMicrotask(() => {
        if (netScript.redirectTo !== undefined) {
          request.emit('redirect', (netScript.redirectStatus ?? 302) as never, 'GET' as never, netScript.redirectTo as never)
          if (!request.followed) {
            request.emit('error', new Error('Redirect was cancelled') as never)
            return
          }
        }
        const response = {
          statusCode: netScript.status ?? 200,
          statusMessage: netScript.statusMessage ?? 'OK',
          headers: netScript.headers ?? { 'content-type': ['application/json'] },
          listeners: new Map<string, Array<(...args: never[]) => void>>(),
          on(event: string, listener: (...args: never[]) => void) {
            const list = this.listeners.get(event) ?? []
            list.push(listener)
            this.listeners.set(event, list)
          },
          emit(event: string, ...args: never[]) {
            for (const listener of this.listeners.get(event) ?? []) listener(...args)
          },
        }
        request.emit('response', response as never)
        for (const chunk of netScript.chunks ?? [Buffer.from('{"ok":true}')]) response.emit('data', chunk as never)
        response.emit('end' as never)
      })
    },
  }
  netRequests.push(request)
  return request
}

const netRequest = vi.fn((options: { method: string, url: string, session: unknown, redirect: unknown }) => makeClientRequest(options))

const menuPopup = vi.fn()
const buildFromTemplate = vi.fn((template: unknown[]) => ({ popup: menuPopup, template }))
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged },
  Menu: { buildFromTemplate },
  session: {
    defaultSession: { protocol: { handle: defaultHandle }, fetch: defaultSessionFetch, clearStorageData: defaultClearStorage },
    fromPartition,
  },
  BrowserWindow: FakeBrowserWindow,
  screen: { getCursorScreenPoint, getDisplayNearestPoint },
  net: { request: netRequest },
}))

/**
 * 浏览器包的 session 守卫（R2-L2-5）：**适配器的转发**是本节要证的接线 ——
 * scheme 传错（例如传成深链 scheme）或漏传 partition 时，真机探针与浏览器包自己的
 * 单测都不会红（探针在探针内部重实现了一遍闸门）。
 */
const guardEnsureSession = vi.fn()
const guardInstallGate = vi.fn()
vi.mock('@zeokeel/dsh-browser/guard', () => ({
  ensureSessionGuard: guardEnsureSession,
  installAppSchemeRequestGate: guardInstallGate,
}))

const { DEFAULT_APP_SCHEME } = await import('./app-protocol.ts')
const { createRealElectronAdapter, createRealElectronWindowAdapter, registerAppScheme } = await import('./electron-adapter.ts')
// 动态 import（不是静态）：静态 import 会在上面的替身声明**之前**求值 mock 工厂。
const { session } = await import('electron')

beforeEach(() => {
  registerSchemesAsPrivileged.mockClear()
  defaultHandle.mockClear()
  partitionHandle.mockClear()
  fromPartition.mockClear()
  defaultClearStorage.mockClear()
  partitionClearStorage.mockClear()
  defaultSessionFetch.mockClear()
  guardEnsureSession.mockClear()
  guardInstallGate.mockClear()
  netRequest.mockClear()
  // F-06：右键菜单的替身（每次用例从零计数）。
  buildFromTemplate.mockClear()
  menuPopup.mockClear()
  netRequests.length = 0
  netScript = {}
})

describe('registerAppScheme', () => {
  it('registers the frozen privilege set exactly once per scheme (§16.1 渠道参数化)', () => {
    registerAppScheme('schema-probe-a-app')
    registerAppScheme('schema-probe-a-app')
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: 'schema-probe-a-app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
        codeCache: true,
      },
    }])
  })

  it('refuses an invalid or reserved scheme instead of registering it (fail-loud)', () => {
    for (const bad of ['', 'A-app', '-app', 'app_', 'https', 'file', 'javascript', 'x'.repeat(33)]) {
      expect(() => registerAppScheme(bad), bad).toThrow()
    }
    expect(registerSchemesAsPrivileged).not.toHaveBeenCalled()
  })

  it('registers a different channel scheme independently (per-scheme idempotency)', () => {
    registerAppScheme('schema-probe-b-app')
    registerSchemesAsPrivileged.mockClear()
    registerAppScheme('schema-probe-b-app')
    registerAppScheme('schema-probe-c-app')
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: 'schema-probe-c-app' }),
    ])
  })
})

describe('createRealElectronAdapter', () => {
  it('registers the handler on the default session and on a named partition', () => {
    const adapter = createRealElectronAdapter()
    const handler = (): Response => new Response('x')
    adapter.handleAppScheme(DEFAULT_APP_SCHEME, handler)
    expect(defaultHandle).toHaveBeenCalledWith(DEFAULT_APP_SCHEME, handler)

    adapter.handleInSession('schema-probe-d-app', 'persist:agent-browser-alice', handler)
    expect(fromPartition).toHaveBeenCalledWith('persist:agent-browser-alice')
    expect(partitionHandle).toHaveBeenCalledWith('schema-probe-d-app', handler)
  })

  it('把权限守卫与请求闸门转发到正确的 session（默认 / 分区），带 scheme 与判据（R2-L2-5）', () => {
    const adapter = createRealElectronAdapter()
    const isAppSurface = (id: number | undefined): boolean => id === 7

    // 默认 session：两个守卫都不带 partition。
    adapter.ensureSessionGuard?.()
    expect(guardEnsureSession).toHaveBeenCalledTimes(1)
    expect(guardEnsureSession.mock.calls[0]?.[0]).toBe(session.defaultSession)

    adapter.installAppSchemeRequestGate?.('schema-probe-e-app', isAppSurface)
    expect(guardInstallGate).toHaveBeenCalledTimes(1)
    const [defaultTarget, defaultOptions] = guardInstallGate.mock.calls[0] as unknown as [unknown, { scheme: string, isAppSurfaceWebContents: unknown }]
    expect(defaultTarget).toBe(session.defaultSession)
    // scheme 与判据都要**原样**转发：这里是"传成深链 scheme / 判据写反"的唯一判据点。
    expect(defaultOptions.scheme).toBe('schema-probe-e-app')
    expect(defaultOptions.isAppSurfaceWebContents).toBe(isAppSurface)

    // 分区：target 换成该分区，参数不变。
    adapter.ensureSessionGuard?.('persist:agent-browser-alice')
    adapter.installAppSchemeRequestGate?.('schema-probe-e-app', isAppSurface, 'persist:agent-browser-alice')
    expect(fromPartition).toHaveBeenCalledWith('persist:agent-browser-alice')
    expect(guardEnsureSession).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: { handle: partitionHandle } }))
    const [partitionTarget, partitionOptions] = guardInstallGate.mock.calls[1] as unknown as [unknown, { scheme: string, isAppSurfaceWebContents: unknown }]
    expect(partitionTarget).toEqual(expect.objectContaining({ protocol: { handle: partitionHandle } }))
    expect(partitionOptions.scheme).toBe('schema-probe-e-app')
    expect(partitionOptions.isAppSurfaceWebContents).toBe(isAppSurface)
  })

  /**
   * F-07（P1，2026-10-22 审计）：下架/冻结/删除/恢复之后清**该应用 origin** 的
   * 浏览器存储 —— 精确到 origin，**不许整分区清**。
   *
   * 为什么判据必须落在"入参"上：分区是按**用户**的（`persist:agent-browser-<user>@<hash>`），
   * 一次不带 `origin` 的 `clearStorageData()` 会把同一账号下其它应用的 localStorage /
   * IndexedDB 一起打掉 —— 那是不可逆的数据丢失，而界面上看不出任何区别。
   */
  it('clearAppStorage 精确到 app origin（分区来自调用方；绝不整分区清）', async () => {
    const adapter = createRealElectronAdapter()
    expect(adapter.clearAppStorage, '适配器必须暴露清理能力（否则 F-07 只能记 warn）').toBeDefined()
    await adapter.clearAppStorage!('persist:agent-browser-alice', 'zeokeel-app://demo')

    // ① 分区来自调用方（应用窗口就落在那里）。
    expect(fromPartition).toHaveBeenCalledWith('persist:agent-browser-alice')
    // ② 清理**带 origin**（唯一入参形态）：变异：改成 `clearStorageData()` ⇒ 本断言红。
    expect(partitionClearStorage).toHaveBeenCalledTimes(1)
    expect(partitionClearStorage).toHaveBeenCalledWith({ origin: 'zeokeel-app://demo' })
    // ③ 默认 session 一次都不该被清（应用页面不在默认 session 上）。
    expect(defaultClearStorage).not.toHaveBeenCalled()
  })

  it('clearAppStorage：分区为空/缺席时退回默认 session（仍然带 origin）', async () => {
    const adapter = createRealElectronAdapter()
    await adapter.clearAppStorage!('', 'zeokeel-app://demo')
    expect(defaultClearStorage).toHaveBeenCalledWith({ origin: 'zeokeel-app://demo' })
    expect(partitionClearStorage).not.toHaveBeenCalled()
  })

  /**
   * 出站**必须走 `net.request`**（2026-09-20 真机实测的 CORS 预检缺陷）。
   *
   * 判据的核心不是"实现细节"，而是**Origin 头能不能真的出去**：平台对非幂等请求强制
   * 校验 `Origin == <app scheme>://<app_id>`（`appserver.checkClientOrigin`），而
   * `session.fetch` 只要带 Origin 就先发 CORS 预检（平台没有 OPTIONS 路由 ⇒ 404 ⇒
   * `net::ERR_FAILED`），现象是"窗口开了、应用页永远说连不上服务端"。
   */
  it('平台出站走 net.request 并原样带上 Origin（session.fetch 的 CORS 预检会打死应用页）', async () => {
    const adapter = createRealElectronAdapter()
    const response = await adapter.fetch!('https://harness.example.com/api/client/v2/apps/wasm/demo/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'zeokeel-app://demo',
        Authorization: 'Bearer token',
        'X-ZeoKeel-App-Proof': 'proof',
      },
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    // 出站是 net.request，且**没有**碰 session.fetch（那条路会发预检）。
    expect(netRequest).toHaveBeenCalledTimes(1)
    expect(defaultSessionFetch).not.toHaveBeenCalled()
    const request = netRequests[0]!
    expect(request.url).toBe('https://harness.example.com/api/client/v2/apps/wasm/demo/request')
    expect(request.method).toBe('POST')
    expect(request.session).toBe(session.defaultSession)
    // `manual`：**不让 Chromium 自己跟跳** —— 每一次重定向都要过同源判据（P2-2）。
    expect(request.redirect).toBe('manual')
    // Origin 与自定义头逐字送达 —— 这条是本次缺陷的回归判据。
    // （`Headers` 迭代把名字小写化，HTTP 头名本就大小写不敏感。）
    expect(request.headers['origin']).toBe('zeokeel-app://demo')
    expect(request.headers['authorization']).toBe('Bearer token')
    expect(request.headers['x-zeokeel-app-proof']).toBe('proof')
    expect(Buffer.concat(request.body).toString('utf8')).toBe(JSON.stringify({ hello: 'world' }))
    expect(request.ended).toBe(true)
  })

  it('丢掉逐跳/传输层头（体已解压，content-encoding/length 原样带进去会截断响应）', async () => {
    const adapter = createRealElectronAdapter()
    netScript = {
      status: 200,
      headers: {
        'content-type': ['application/json'],
        'content-encoding': ['gzip'],
        'content-length': ['999999'],
        'transfer-encoding': ['chunked'],
        'x-request-id': ['abc'],
      },
      chunks: [Buffer.from('{"ok":true}')],
    }
    const response = await adapter.fetch!('https://harness.example.com/x', { method: 'GET' })
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('transfer-encoding')).toBeNull()
    expect(response.headers.get('x-request-id')).toBe('abc')
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('abort 信号真的中止出站请求（应用请求预算到点必须停，不能挂着）', async () => {
    const adapter = createRealElectronAdapter()
    netScript = { respond: false }
    const controller = new AbortController()
    const pending = adapter.fetch!('https://harness.example.com/x', { method: 'POST', body: '{}', signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(netRequests[0]?.aborted).toBe(true)
  })

  it('传输层错误转成 rejection（而不是永远挂起的 promise）', async () => {
    const adapter = createRealElectronAdapter()
    netScript = { failWith: new Error('net::ERR_CONNECTION_REFUSED') }
    await expect(adapter.fetch!('https://harness.example.com/x', { method: 'GET' })).rejects.toThrow('ERR_CONNECTION_REFUSED')
  })

  /**
   * P2-1：**响应构造失败也必须 settle**（2026-09-20 审计实测 status 700 时 3 s 不
   * settle，随后 abort 也救不回）。
   *
   * 触发面：`new Response(body, {status})` 对 ∉[200,599] 抛 RangeError，对含非
   * 0x20–0x7E 的 statusText 抛 TypeError —— 原实现先置 `settled = true` 再构造，
   * 异常路径于是被 `fail()` 的早退吞掉，promise 永久 pending，调用方的 AbortSignal
   * 也已被摘掉（"一次失败"被放大成"永不返回"）。
   *
   * 变异：把 `settled = true` 挪回 `resolve` 之前 ⇒ 本用例两个断言都变红（挂起）。
   */
  it('响应无法构造成 Response 时必定 reject（status 700 / 非法 statusText），不得挂起', async () => {
    const adapter = createRealElectronAdapter()

    netScript = { status: 700, statusMessage: 'Weird', headers: { 'content-type': ['text/plain'] }, chunks: [Buffer.from('hi')] }
    await expect(adapter.fetch!('https://harness.example.com/x', { method: 'GET' })).rejects.toThrow(/status/i)

    // statusText 里的换行是非法的（Response 构造期 TypeError）。
    netScript = { status: 200, statusMessage: 'OK\nX-Injected: 1', headers: { 'content-type': ['text/plain'] }, chunks: [Buffer.from('hi')] }
    await expect(adapter.fetch!('https://harness.example.com/x', { method: 'GET' })).rejects.toThrow()

    // 且不是靠"永不 settle"骗过断言：两条都必须在预算内给出结论（Promise.race 兜底）。
    netScript = { status: 700 }
    const outcome = await Promise.race([
      adapter.fetch!('https://harness.example.com/x', { method: 'GET' }).then(() => 'resolved', () => 'rejected'),
      new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 1000)),
    ])
    expect(outcome).toBe('rejected')
  })

  /**
   * P2-2：跨源 302 **不带凭据出去**（fail-closed）。
   *
   * 这条出站通道每次都带 `Authorization: Bearer <员工令牌>` 与 `X-ZeoKeel-App-Proof`，
   * 平台 API 没有任何合法的跨源重定向用途。审计实测旧实现（`redirect: 'follow'`）会把
   * 两件凭据原样送到新 host（`net.request` 与 `session.fetch` 两代都如此）。
   *
   * 判据打在**能力**上：①promise reject；②`followRedirect()` 一次都没调（=不会发出
   * 第二个请求）；③同源 302 仍照旧跟随（正对照，防止"一刀切成谁都不跟"）。
   *
   * 变异：把 `redirect: 'manual'` 改回 `'follow'`（或删掉 `sameOriginRedirect` 判定）
   * ⇒ 第一段断言变红。
   */
  it('跨源 302 中止并报错（不发第二个请求）；同源 302 仍然跟随', async () => {
    const adapter = createRealElectronAdapter()

    // 跨源：初始 https://harness.example.com，Location 指向别的 host。
    netScript = { redirectTo: 'https://evil.example/steal' }
    await expect(adapter.fetch!('https://harness.example.com/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer SECRET-TOKEN', 'X-ZeoKeel-App-Proof': 'PROOF-JTI' },
      body: '{}',
    })).rejects.toThrow(/cross-origin redirect/)
    expect(netRequests[0]?.followed).toBe(false)
    expect(netRequests[0]?.aborted).toBe(true)

    // 相对 Location（同源）⇒ 跟随，并且拿得到最终响应。
    netRequests.length = 0
    netScript = { redirectTo: '/moved', status: 200, chunks: [Buffer.from('FINAL')] }
    const followed = await adapter.fetch!('https://harness.example.com/x', { method: 'GET' })
    expect(netRequests[0]?.followed).toBe(true)
    expect(followed.status).toBe(200)

    // 换端口 = 换 origin（`http://127.0.0.1:1` → `http://127.0.0.1:2`）⇒ 同样拒绝。
    netRequests.length = 0
    netScript = { redirectTo: 'http://127.0.0.1:2/landed' }
    await expect(adapter.fetch!('http://127.0.0.1:1/x', { method: 'GET' })).rejects.toThrow(/cross-origin redirect/)
    expect(netRequests[0]?.followed).toBe(false)
  })

  it('不支持的 body 形态一律拒绝（悄悄丢 body 会让平台回一个看不懂的 400）', async () => {
    const adapter = createRealElectronAdapter()
    netScript = {}
    await expect(adapter.fetch!('https://harness.example.com/x', {
      method: 'POST',
      body: new ReadableStream() as unknown as BodyInit,
    })).rejects.toThrow(/unsupported request body/)
  })
})

/**
 * 应用窗口载体（W-C 独立窗口）的**原生动作面**。
 *
 * 这一组用例存在的理由：`windows.ts` 的几何/生命周期逻辑早已有纯逻辑判据，但
 * "这些语义有没有接到真实 Electron 上"在 2026-09-20 之前**零判据** ——
 * `WASM_APPS_WINDOW_ADAPTER_SERVICE` 没有任何 provider，`createRealElectronWindowAdapter`
 * 根本不存在。契约对、现象空（点"打开"回 `opened`，屏幕上什么都没有）就是从这里来的。
 */
describe('createRealElectronWindowAdapter', () => {
  const APP_SCHEME = 'schema-probe-app'
  /** 判据里用的按用户分区（形状与 `browserPartitionFor` 一致）。 */
  const PARTITION = 'persist:agent-browser-alice'
  /** 宿主诊断出口的收集器（拒绝导航/窗口的文案是**唯一**的可见出口）。 */
  let warned: string[] = []

  beforeEach(() => {
    FakeBrowserWindow.created.length = 0
    getCursorScreenPoint.mockClear()
    getDisplayNearestPoint.mockClear()
    fromPartition.mockClear()
    warned = []
  })

  /** 建一个窗口并返回（替身）实例与句柄。 */
  function createProbeWindow(adapter: ReturnType<typeof createRealElectronWindowAdapter>, appId = 'demo') {
    const handle = adapter.createAppWindow({
      appId,
      url: `${APP_SCHEME}://${appId}/`,
      title: '演示应用 · ZeoKeel Harness',
      appLabel: '演示应用',
      partition: PARTITION,
      width: 1280,
      height: 720,
      x: 10,
      y: 20,
      minimumWidth: 320,
      minimumHeight: 240,
    })
    const win = FakeBrowserWindow.created[FakeBrowserWindow.created.length - 1]!
    return { handle, win }
  }

  /**
   * P1-2（2026-09-20 审计）：应用窗口必须落在**插件显式给出的按用户分区**上，
   * 不是默认 session —— §7.2:240 / R2S-8 冻结的是"复用内置浏览器的按用户分区"。
   *
   * 变异：把 `partition` 从 `webPreferences` 里去掉（或写死 `undefined`）⇒ 本用例红；
   * 把 `ensureSessionGuard` 装回默认 session ⇒ 第二条 spec 红。
   */
  it('窗口落在插件给的分区上（webPreferences.partition + 同一个 session 实例）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { win } = createProbeWindow(adapter)

    expect(win.options.webPreferences).toMatchObject({ partition: PARTITION })
    // 解析分区（而不是拿默认 session）：`fromPartition` 是唯一入口。
    expect(fromPartition).toHaveBeenCalledWith(PARTITION)
    expect(win.options.webPreferences).toMatchObject({
      session: expect.objectContaining({ protocol: { handle: partitionHandle } }),
    })
    expect(win.options.webPreferences).not.toMatchObject({ session: session.defaultSession })
  })

  it('分区非法/缺席一律建窗期抛（静默退回默认 session 正是 P1-2 的形态）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    for (const bad of ['', undefined, null]) {
      expect(() => adapter.createAppWindow({
        appId: 'demo',
        url: `${APP_SCHEME}://demo/`,
        title: 'x',
        appLabel: 'x',
        partition: bad as unknown as string,
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        minimumWidth: 320,
        minimumHeight: 240,
      }), String(bad)).toThrow(/partition/)
    }
    expect(FakeBrowserWindow.created).toHaveLength(0)
  })

  it('把几何/标题原样交给 BrowserWindow，并用应用 origin 加载（§7.2/§16.1）', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { win } = createProbeWindow(adapter)
    await settleRecovery()

    expect(win.options).toMatchObject({
      width: 1280,
      height: 720,
      x: 10,
      y: 20,
      minWidth: 320,
      minHeight: 240,
      title: '演示应用 · ZeoKeel Harness',
      show: true,
      autoHideMenuBar: true,
    })
    // 应用页面**必须**是应用 origin：加载 http(s) 会把应用当作普通网页（且请求
    // 闸门会拒掉它的应用 scheme 子资源）。
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`])
    // U-01：第一次加载是**骨架页**（应用文档在它之后加载）。
    expect(skeletonLoads(win)).toHaveLength(1)
    expect(win.loaded[0]!.startsWith('data:text/html')).toBe(true)
    expect(win.menuBarHidden).toBe(true)
    // 沙箱：应用 HTML 是不可信内容，不得拿到 Node。
    expect(win.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })
  })

  it('标题不可被页面改写（防伪装），且句柄能报出 webContents id（请求闸门白名单要用）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)

    const event = { preventDefault: vi.fn(), defaultPrevented: false }
    win.emit('page-title-updated', event as never, '登录' as never, true as never)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)

    expect(adapter.webContentsId?.(handle)).toBe(win.webContents.id)
    // surface 注册要的是**真实** webContents（不是 id）：browser runtime 的 CDP
    // 附着路径只认它（`surface.webContents`）。变异：让它返回 id/undefined ⇒ 本断言红。
    expect(adapter.webContents?.(handle)).toBe(win.webContents)
    expect(adapter.isAlive?.(handle)).toBe(true)
  })

  it('关窗后 isAlive 变假（否则第二次 open 会回 focused 而屏幕上没有窗口）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)

    adapter.closeAppWindow(handle)
    expect(win.destroyed).toBe(true)
    expect(adapter.isAlive?.(handle)).toBe(false)
    expect(adapter.webContentsId?.(handle)).toBeUndefined()
    // 已销毁的窗口不得把 webContents 交给 surface 注册（否则模型会寻址到一个死句柄）。
    expect(adapter.webContents?.(handle)).toBeUndefined()
    // 已销毁的句柄上再操作必须是 no-op（不能抛，也不能"复活"一个死窗口）。
    expect(() => adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/next`)).not.toThrow()
    expect(() => adapter.setAspectRatio(handle, 1.5, { width: 0, height: 0 })).not.toThrow()
    expect(() => adapter.closeAppWindow(handle)).not.toThrow()
  })

  it('聚焦已有窗口：导航到目标路径 + 把最小化的窗口带回来（软闸门不能"点了没反应"）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)
    win.minimized = true
    win.visible = false

    adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/settings`)
    // U-01：首个 `loadURL` 是骨架页；聚焦导航落在它之后（初始应用加载被这次导航顶掉，
    // 这是"打开后立刻又打开另一个路径"的真实序列）。
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/settings`])
    expect(win.minimized).toBe(false)
    expect(win.visible).toBe(true)
    expect(win.focused).toBeGreaterThan(0)

    // 同一个 URL 不重复加载（避免每次点"打开"都把应用重置回首页）。
    const before = appDocumentLoads(win).length
    adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/settings`)
    expect(appDocumentLoads(win)).toHaveLength(before)
  })

  it('导航闸门只放行同 app origin；跨 app 与 http(s) 一律拒（§7.2 N7）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)
    adapter.installAppWindowGuards?.(handle, 'demo')

    /** 触发一次导航，返回 event.preventDefault 是否被调用。 */
    const navigate = (
      url: string,
      eventName: 'will-navigate' | 'will-frame-navigate' | 'will-redirect' = 'will-navigate',
      isMainFrame = true,
    ) => {
      const event = { preventDefault: vi.fn(), defaultPrevented: false, url, isMainFrame }
      win.webContents.emit(eventName, event as never, url as never)
      return event.preventDefault.mock.calls.length > 0
    }

    expect(navigate(`${APP_SCHEME}://demo/settings`)).toBe(false)
    expect(navigate(`${APP_SCHEME}://other-app/`)).toBe(true)
    expect(navigate('https://harness.example.com/')).toBe(true)
    expect(navigate('javascript:alert(1)')).toBe(true)
    // 顶层 frame 的 will-frame-navigate 仍要闸。
    expect(navigate('https://evil.example.com/', 'will-frame-navigate', true)).toBe(true)
    // 子框架：**跨 app 内嵌必须拒**（换壳，P2-3）；http(s) 子框架放行（平台 CSP 兜底）。
    expect(navigate(`${APP_SCHEME}://other-app/`, 'will-frame-navigate', false)).toBe(true)
    expect(navigate(`${APP_SCHEME}://demo/embed`, 'will-frame-navigate', false)).toBe(false)
    expect(navigate('https://harness.example.com/embed', 'will-frame-navigate', false)).toBe(false)
    expect(navigate('file:///etc/hostname', 'will-frame-navigate', false)).toBe(true)

    // 弹窗一律拒（§20.2：应用窗口不得 window.open）。
    expect(win.webContents.windowOpenHandler?.({ url: 'https://harness.example.com/' })).toEqual({ action: 'deny' })
  })

  /**
   * F-05（2026-10-22 审计）：`window.open` 被 deny 时**必须有反馈**。
   *
   * 缺陷形态：一律 `deny` 且 `externalLinkNotice`/`downloadStartedNotice` 两条文案
   * **零消费方** —— 用户点外链什么都没发生（看起来像链接坏了）。
   *
   * 判据：http(s) 外链 ⇒ 仍 deny，但应用页面里被注入一条提示（正文来自
   * `app-window-copy.ts`，不是硬编码在适配器里）；非 http(s)（`file:`/`javascript:`）
   * ⇒ deny 且**不**注入（提示条只解释"外链去哪了"，不解释被拦下的攻击面）。
   *
   * 变异：删掉 `executeJavaScript` 那一支 ⇒ 第一条红；对任意 scheme 都注入 ⇒ 第二条红。
   */
  it('F-05：外链 window.open 被拒时给提示条（http(s) 才注入，非 http(s) 只拒）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, locale: () => 'zh' })
    const { handle, win } = createProbeWindow(adapter)
    adapter.installAppWindowGuards?.(handle, 'demo')

    expect(win.webContents.windowOpenHandler?.({ url: 'https://harness.example.com/docs?q=1' })).toEqual({ action: 'deny' })
    expect(win.webContents.executed).toHaveLength(1)
    const script = win.webContents.executed[0]!
    // 文案真源在 `app-window-copy.ts`（逐字断言在那里）；这里只钉"提示条真的注入了"。
    expect(script).toContain('已在浏览器窗口中打开 harness.example.com')
    expect(script).toContain('zeokeel-app-notice')

    // 非 http(s)：照样拒，但**不**注入提示条（file:/javascript: 不是"外链"）。
    for (const url of ['file:///etc/hostname', 'javascript:alert(1)']) {
      expect(win.webContents.windowOpenHandler?.({ url })).toEqual({ action: 'deny' })
    }
    expect(win.webContents.executed).toHaveLength(1)
  })

  /**
   * F-06（2026-10-22 审计）：应用窗口**没有刷新、没有返回**（全包 grep
   * `reload()`/`goBack()` = 0）。修后两条动作各有两个可发现面：右键菜单与键盘。
   *
   * 判据：右键菜单真的建出「刷新/返回」两项并能点到动作；Ctrl/Cmd+R 触发
   * `reload()`，Alt+← / Cmd+[ 触发 `navigationHistory.goBack()`；**不带修饰键的 r
   * 不刷新**（否则应用自己的输入框永远敲不出 r）。
   *
   * 变异：删掉 `before-input-event` 那一段 ⇒ 键盘两条红；删掉 `context-menu` 那段 ⇒
   * 菜单两条红。
   */
  it('F-06：右键菜单与键盘都能刷新/返回（普通按键不触发）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, locale: () => 'zh' })
    const { handle, win } = createProbeWindow(adapter)
    adapter.installAppWindowGuards?.(handle, 'demo')

    const key = (input: Record<string, unknown>): ReturnType<typeof vi.fn> => {
      const preventDefault = vi.fn()
      win.webContents.emit('before-input-event' as never, { preventDefault } as never, input as never)
      return preventDefault
    }

    // 不带修饰键的 r：不刷新（应用自己的输入要能工作）。
    expect(key({ type: 'keyDown', key: 'r' })).not.toHaveBeenCalled()
    expect(win.webContents.reloaded).toBe(0)

    expect(key({ type: 'keyDown', key: 'r', control: true })).toHaveBeenCalled()
    expect(win.webContents.reloaded).toBe(1)
    // keyUp 不重复触发。
    key({ type: 'keyUp', key: 'r', control: true })
    expect(win.webContents.reloaded).toBe(1)

    expect(key({ type: 'keyDown', key: 'ArrowLeft', alt: true })).toHaveBeenCalled()
    expect(win.webContents.navigationHistory.back).toBe(1)
    expect(key({ type: 'keyDown', key: '[', meta: true })).toHaveBeenCalled()
    expect(win.webContents.navigationHistory.back).toBe(2)

    // 右键菜单：两项、文案本地化、点得到动作。
    win.webContents.emit('context-menu' as never)
    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    const template = buildFromTemplate.mock.calls[0]![0] as Array<{ label: string, click: () => void }>
    expect(template.map(item => item.label)).toEqual(['刷新', '返回'])
    expect(menuPopup).toHaveBeenCalledTimes(1)
    template[0]!.click()
    expect(win.webContents.reloaded).toBe(2)
    template[1]!.click()
    expect(win.webContents.navigationHistory.back).toBe(3)
  })

  /**
   * P1-1（2026-09-20 审计）：**重定向走同一道闸门**。
   *
   * 只挂 `will-navigate`/`will-frame-navigate` 时，一次 302 就能把窗口换到外站或
   * **另一个应用的 origin**（换壳）—— 真机探针实测过（`temp/appwin-audit/probe-h1-h2.mjs`：
   * `nav:redirect-external = https://example.com/`、`nav:redirect-otherapp = zeokeel-app://appb/`）。
   *
   * 变异：删掉 `contents.on('will-redirect', …)` 那一行 ⇒ 本用例的 302 断言全红
   * （真机版本见 `temp/fix-appwin-r2/probe-appwin.mjs`，用真实 302 打）。
   */
  it('will-redirect 与 will-navigate 共用同一判据：跨 app / 外站 302 一律拒，同 app 302 放行', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { handle, win } = createProbeWindow(adapter)
    adapter.installAppWindowGuards?.(handle, 'demo')

    const redirected = (url: string, isMainFrame = true): boolean => {
      const event = { preventDefault: vi.fn(), defaultPrevented: false, url, isMainFrame }
      win.webContents.emit('will-redirect' as never, event as never)
      return event.preventDefault.mock.calls.length > 0
    }

    expect(redirected('https://example.com/')).toBe(true)
    expect(redirected(`${APP_SCHEME}://other-app/`)).toBe(true)
    expect(redirected('file:///etc/hostname')).toBe(true)
    // 同 app origin 的 302 必须放行（应用自己的跳转是正常功能）。
    expect(redirected(`${APP_SCHEME}://demo/after-login`)).toBe(false)
    // 子框架的重定向：跨 app 拒、http(s) 放行。
    expect(redirected(`${APP_SCHEME}://other-app/`, false)).toBe(true)
    expect(redirected('https://example.com/embed', false)).toBe(false)
    // 拒绝必须走**同一个**出口（日志文案与 will-navigate 一致：`refused a … navigation`）。
    expect(warned.filter(message => message.includes('refused a foreign-app navigation'))).toHaveLength(2)
    expect(warned.filter(message => message.includes('refused a external navigation'))).toHaveLength(2)
  })

  /**
   * F-04（P1，2026-10-22 审计）：会话过期页上的「重新登录」必须**真的能点开**。
   *
   * 页面本身是宿主渲染的（`pages.ts`），按钮是一个 `<a href>`；而应用窗口的导航闸门
   * 默认拒绝一切跨 origin 导航 ⇒ 没有这条精确 URL 白名单，那个按钮点了**毫无反应**
   * （正是审计要消灭的"断头路"）。
   *
   * 边界（每条都是判据）：①只放行**精确登记**的那一个 URL；②只对**顶层**导航放行
   * （子框架不许）；③其它 http(s) 目标仍然拒；④重新登记会覆盖旧值（不是无限追加）。
   */
  it('setNavigationAllowlist：只放行精确登记的登录页 URL（顶层），其它外链照旧拒', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)
    adapter.installAppWindowGuards?.(handle, 'demo')
    adapter.setNavigationAllowlist?.(['http://127.0.0.1:41234/login'])

    const navigate = (url: string, isMainFrame = true): boolean => {
      const event = { preventDefault: vi.fn(), defaultPrevented: false, url, isMainFrame }
      win.webContents.emit('will-navigate' as never, event as never, url as never)
      return event.preventDefault.mock.calls.length > 0
    }

    expect(navigate('http://127.0.0.1:41234/login')).toBe(false)
    // 精确匹配：同一 origin 的其它路径仍然拒（放行 origin 会给应用页一条"导航到客户端
    // 任意页面"的路）。
    expect(navigate('http://127.0.0.1:41234/settings')).toBe(true)
    // 只对顶层生效：子框架的 http(s) 本来就走另一条既有判据（平台 CSP 兜底），
    // 白名单不改变它（这里断言的是"白名单不是子框架的放行开关"）。
    expect(navigate('http://127.0.0.1:41234/login', false)).toBe(false)
    expect(navigate('https://example.com/embed', false)).toBe(false)
    // 其它外链（含应用内 window.open 之外的普通导航）仍然拒。
    expect(navigate('https://example.com/')).toBe(true)
    // 重新登记 = 覆盖（旧值失效）。
    adapter.setNavigationAllowlist?.(['http://127.0.0.1:41234/other'])
    expect(navigate('http://127.0.0.1:41234/login')).toBe(true)
    expect(navigate('http://127.0.0.1:41234/other')).toBe(false)
  })

  it('比例锁定原样转发给原生窗口，且权限守卫装在**应用分区**（不是默认 session）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = createProbeWindow(adapter)

    adapter.setAspectRatio?.(handle, 1.777, { width: 0, height: 0 })
    expect(win.aspectRatios).toEqual([{ ratio: 1.777, extraSize: { width: 0, height: 0 } }])

    adapter.ensureSessionGuard?.(PARTITION)
    expect(guardEnsureSession).toHaveBeenCalledTimes(1)
    // 装到**应用窗口真正落地的那个分区**：装默认 session 会一边保护不到应用窗口，
    // 一边用 last-wins 覆盖主窗口在同一 session 上的剪贴板白名单（P1-2 的耦合）。
    expect(guardEnsureSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ protocol: { handle: partitionHandle } }))
    expect(guardEnsureSession.mock.calls[0]?.[0]).not.toBe(session.defaultSession)
    expect(fromPartition).toHaveBeenCalledWith(PARTITION)

    // 非法分区不得静默退回默认 session。
    expect(() => adapter.ensureSessionGuard?.('')).toThrow(/partition/)
  })

  it('工作区取鼠标所在显示器（多显示器每次打开重新求值）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    expect(adapter.workArea?.()).toEqual({ x: 1, y: 2, width: 1600, height: 900 })
    expect(getCursorScreenPoint).toHaveBeenCalledTimes(1)
    expect(getDisplayNearestPoint).toHaveBeenCalledWith({ x: 5, y: 6 })
  })

  it('被后续导航顶掉的加载（ERR_ABORTED）不记成故障，其它失败照记', async () => {
    const warned: string[] = []
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const handle = adapter.createAppWindow({
      appId: 'demo',
      url: `${APP_SCHEME}://demo/`,
      title: '演示应用 · ZeoKeel Harness',
      appLabel: '演示应用',
      partition: PARTITION,
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      minimumWidth: 320,
      minimumHeight: 240,
    })
    const win = FakeBrowserWindow.created[FakeBrowserWindow.created.length - 1]!
    // 聚焦导航顶掉上一次加载：真机实测的 ERR_ABORTED (-3)。
    win.webContents.failNextLoad(Object.assign(new Error("ERR_ABORTED (-3) loading 'zeokeel-app://demo/notes'"), { code: 'ERR_ABORTED', errno: -3 }))
    adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/notes`)
    await Promise.resolve()
    await Promise.resolve()
    expect(warned.filter(message => message.includes('ERR_ABORTED'))).toEqual([])
    // 真正的失败仍然要能被看见。
    win.webContents.failNextLoad(new Error('ERR_CONNECTION_REFUSED'))
    adapter.focusAppWindow(handle, `${APP_SCHEME}://demo/other`)
    await Promise.resolve()
    await Promise.resolve()
    expect(warned.some(message => message.includes('ERR_CONNECTION_REFUSED'))).toBe(true)
  })

  it('非法应用源 scheme 一律构造期抛（fail-loud，别等窗口打开后每个导航都被拒）', () => {
    for (const bad of ['', 'App', 'https', 'zeokeel_app']) {
      expect(() => createRealElectronWindowAdapter({ appScheme: bad }), bad).toThrow()
    }
  })
})

/** 让恢复路径（`loadURL` 的 promise 链）跑完：恢复是异步的，事件监听是同步的。 */
async function settleRecovery(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * 应用文档的加载序列（排除骨架页/失败页这些 `data:` 独立文档）。
 *
 * U-01 之后 `win.loaded[0]` **恒为骨架页**，所以"应用文档被加载了几次/顺序如何"的
 * 判据必须过滤 `data:`；直接断言整个数组会把骨架的接线与每一条恢复用例耦死。
 */
function appDocumentLoads(win: FakeBrowserWindow): string[] {
  return win.loaded.filter(url => !url.startsWith('data:'))
}

/** 骨架页的加载序列（U-01 的接线判据）。 */
function skeletonLoads(win: FakeBrowserWindow): string[] {
  return win.loaded.filter(url => url.startsWith('data:') && decodeURIComponent(url).includes('id="zeokeel-loading-skeleton"'))
}

/** 失败页的加载序列（与骨架页区分：失败页带 `id="retry"`）。 */
function failureLoads(win: FakeBrowserWindow): string[] {
  return win.loaded.filter(url => url.startsWith('data:') && decodeURIComponent(url).includes('id="retry"'))
}

/**
 * R16B-19（第十六轮审计泳道 B，P1）：应用窗口的**崩溃 / 加载失败恢复**。
 *
 * 修前形态：`createAppWindow` 只挂 `page-title-updated`，唯一的加载处理是
 * `loadURL().catch(reportLoadFailure)`（一行 warn）。渲染进程崩了或首次加载失败 ⇒
 * **永久空白窗口**：没有错误面、没有重试、没有自动重载，用户与 AI 都看不到它坏了。
 * 对照 `desktop/src/electron-runtime.ts` 的 shell 窗口，那条路径两者都有。
 *
 * 修后形态（照 shell 的 `reloadOrShowCrashFallback` 的**形状**，简化版）：
 * 单飞 + 状态机（`idle → retrying → reloaded|failed`）、两个事件源共用同一入口、
 * 至多自动重载一次、之后显示带「重试」按钮的 `data:text/html` 失败页，重试目标在
 * 重载**之前**捕获。
 *
 * 变异验证：把 `render-process-gone` 的监听摘掉 ⇒ ①红；把 `did-fail-load` 的
 * `isMainFrame !== true` 早退删掉 ⇒ ③红；把单飞去掉（每次都新起一轮）⇒ ②/④红。
 */
describe('createRealElectronWindowAdapter — 崩溃 / 加载失败恢复（R16B-19）', () => {
  const APP_SCHEME = 'recovery-probe-app'
  const PARTITION = 'persist:agent-browser-alice'
  let warned: string[] = []

  beforeEach(() => {
    FakeBrowserWindow.created.length = 0
    warned = []
  })

  /** 建窗 + 返回替身实例（恢复路径要断言原生窗口收到的导航序列）。 */
  function openWindow(adapter: ReturnType<typeof createRealElectronWindowAdapter>, appId = 'demo') {
    const handle = adapter.createAppWindow({
      appId,
      url: `${APP_SCHEME}://${appId}/`,
      title: '演示应用 · ZeoKeel Harness',
      appLabel: '演示应用',
      partition: PARTITION,
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      minimumWidth: 320,
      minimumHeight: 240,
    })
    const win = FakeBrowserWindow.created[FakeBrowserWindow.created.length - 1]!
    return { handle, win }
  }

  /** 派发一次渲染进程崩溃（真机上的 `reason` 取值）。 */
  function crash(win: FakeBrowserWindow, reason = 'crashed'): void {
    win.webContents.emit('render-process-gone' as never, { preventDefault: () => {} } as never, { reason, exitCode: 139 } as never)
  }

  /** 派发一次 `did-fail-load`（第 5 参 `isMainFrame` 是顶层/子框架的唯一判据）。 */
  function failLoad(win: FakeBrowserWindow, options: { errorCode?: number, url?: string, isMainFrame?: boolean } = {}): void {
    win.webContents.emit(
      'did-fail-load' as never,
      { preventDefault: () => {} } as never,
      (options.errorCode ?? -105) as never,
      'NAME_NOT_RESOLVED' as never,
      (options.url ?? `${APP_SCHEME}://demo/`) as never,
      (options.isMainFrame ?? true) as never,
    )
  }

  it('①渲染进程崩溃后**自动重载一次**（否则永久空白窗口）', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { win } = openWindow(adapter)
    // U-01：先骨架、后应用文档；等初始应用加载落地再制造崩溃。
    await settleRecovery()
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`])

    crash(win)
    await settleRecovery()

    // 恰好多一次导航，且目标是**同一个应用 URL**（不是空白页、不是外站）。
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`, `${APP_SCHEME}://demo/`])
    // 崩溃必须有可见痕迹（诊断面）。
    expect(warned.some(message => message.includes('render-process-gone') || message.includes('crashed'))).toBe(true)
  })

  it('②重载之后再次崩溃 ⇒ 显示带「重试」按钮的失败页（不再自动重载）', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { win } = openWindow(adapter)
    await settleRecovery()

    crash(win)
    await settleRecovery()
    expect(appDocumentLoads(win)).toHaveLength(2)

    // 第二次崩溃：自动重载额度已用尽 ⇒ 只能给失败页。
    crash(win)
    await settleRecovery()

    expect(failureLoads(win)).toHaveLength(1)
    const page = failureLoads(win)[0]!
    const html = decodeURIComponent(page)
    // 失败页必须带**可点的重试入口**，且重试目标 = 崩溃前的应用 URL（重载前捕获）。
    expect(html).toContain('id="retry"')
    expect(html).toContain(`${APP_SCHEME}://demo/`)
    expect(html).toContain('location.href')
    expect(html).not.toContain('id="retry" disabled')
  })

  it('④同一 tick 的两个事件源（崩溃会同时派发进程级 + 导航级）只触发一次重载', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { win } = openWindow(adapter)
    await settleRecovery()

    // 真机上 `render-process-gone` 与 `did-fail-load` 会先后到达；非单飞的实现会
    // 并发发起两次 `loadURL`（错误页与 reload 谁后完成谁说了算）。
    crash(win)
    failLoad(win)
    await settleRecovery()

    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`, `${APP_SCHEME}://demo/`])
    // 并发事件加入同一轮恢复 ⇒ 不出现第二个失败页/第二次 reload。
    expect(failureLoads(win)).toHaveLength(0)
  })

  it('③子框架 did-fail-load（isMainFrame=false）**不**触发恢复；主框架 -3（被顶掉）也不', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { win } = openWindow(adapter)

    failLoad(win, { errorCode: -312, url: 'https://example.com/embed', isMainFrame: false })
    await settleRecovery()
    // 一次 iframe 失败把整个窗口重载（或换成失败页）会把用户的草稿与视图状态掀掉。
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`])
    expect(warned.some(message => message.includes('subframe'))).toBe(true)

    // 顶层但被后续导航顶掉（ERR_ABORTED）不是故障。
    failLoad(win, { errorCode: -3 })
    await settleRecovery()
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`])

    // 正对照：顶层真失败仍然走恢复（否则上一条断言只是因为"什么都不做"）。
    failLoad(win, { errorCode: -105 })
    await settleRecovery()
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`, `${APP_SCHEME}://demo/`])
  })

  it('健康状态订阅：崩溃⇒true、重载成功⇒false、失败页⇒true（模型面 crashed 的唯一真源）', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { handle, win } = openWindow(adapter)
    const health: boolean[] = []
    adapter.onAppWindowHealth?.(handle, snapshot => health.push(snapshot.crashed))
    // 订阅即回报当前状态（否则"崩溃发生在订阅之前"会被永久漏掉）。
    expect(health).toEqual([false])

    crash(win)
    await settleRecovery()
    // 重载成功 ⇒ 窗口真的好了。
    expect(health).toEqual([false, true, false])

    // 第二次崩溃 ⇒ 失败页 ⇒ 状态停在"坏"。
    crash(win)
    await settleRecovery()
    expect(health.at(-1)).toBe(true)
  })

  it('崩溃后再加载失败 ⇒ 状态仍是"坏"（失败页不是恢复）', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { handle, win } = openWindow(adapter)
    const health: boolean[] = []
    adapter.onAppWindowHealth?.(handle, snapshot => health.push(snapshot.crashed))

    // 自动重载也失败：`loadURL` reject（被顶掉的那类不算，所以用真错误）。
    win.webContents.failNextLoad(new Error('ERR_CONNECTION_REFUSED'))
    crash(win)
    await settleRecovery()

    // 序列 = 骨架 /（初始应用加载被崩溃作废）/ 自动重载（失败）/ 失败页。
    expect(skeletonLoads(win)).toHaveLength(1)
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`])
    expect(failureLoads(win)).toHaveLength(1)
    expect(health.at(-1)).toBe(true)
  })

  it('用户点窗口自己的关闭按钮 ⇒ 订阅者收到通知（R16B-20 的原生事件源）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME })
    const { handle, win } = openWindow(adapter)
    let closed = 0
    adapter.onAppWindowClosed?.(handle, () => { closed += 1 })
    expect(closed).toBe(0)
    // Electron 在用户关窗后派发 `closed`（宿主此前收不到任何回调）。
    win.emit('closed' as never)
    expect(closed).toBe(1)
  })

  it('clean-exit / killed 不算崩溃（正常退出与主动结束不得弹失败页）', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: APP_SCHEME, warn: message => warned.push(message) })
    const { win } = openWindow(adapter)
    for (const reason of ['clean-exit', 'killed']) crash(win, reason)
    await settleRecovery()
    expect(appDocumentLoads(win)).toEqual([`${APP_SCHEME}://demo/`])
    expect(failureLoads(win)).toHaveLength(0)
  })
})

/**
 * U-01（打开不再是纯白）与 U-03（应用窗口崩溃/白屏进错误上报链路）—— 2026-10-22
 * 生产级评审的两条 P1。
 *
 * 判据纪律：全部是**行为级**断言（第一次 `loadURL` 的目标、上报出口收到的对象、失败页
 * 的真实内容），不是"某个字符串常量存在"。
 *
 * 变异验证（实测记录见汇报）：
 *  - 删掉 `createAppWindow` 里的 `showLoadingSkeleton(...)`、改回直接
 *    `loadAppUrl(...)` ⇒ ①"首次加载目标是骨架"红；
 *  - 删掉 `reportAppWindowError(...)` 的三处调用 ⇒ ⑤⑥红；
 *  - 删掉 `webPreferences.preload` ⇒ ④红；
 *  - 删掉看门狗 `armLoadWatchdog(...)` ⇒ ③红。
 */
describe('U-01 骨架页 / U-03 应用窗口错误上报（2026-10-22 评审）', () => {
  const SCHEME = 'ux-probe-app'
  const PARTITION = 'persist:agent-browser-alice'
  let warned: string[] = []

  beforeEach(() => {
    FakeBrowserWindow.created.length = 0
    warned = []
  })

  /** 建一个应用窗口（第一/第二次加载的真实顺序由适配器决定）。 */
  function openApp(
    adapter: ReturnType<typeof createRealElectronWindowAdapter>,
    appId = 'demo',
    appLabel = '演示应用',
    url = `${SCHEME}://${appId}/`,
  ): { handle: ReturnType<ReturnType<typeof createRealElectronWindowAdapter>['createAppWindow']>, win: FakeBrowserWindow } {
    const handle = adapter.createAppWindow({
      appId,
      url,
      title: `${appLabel} · ZeoKeel Harness`,
      appLabel,
      partition: PARTITION,
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      minimumWidth: 320,
      minimumHeight: 240,
    })
    return { handle, win: FakeBrowserWindow.created[FakeBrowserWindow.created.length - 1]! }
  }

  /** 派发一次渲染进程崩溃（与真机 `render-process-gone` 同形）。 */
  function crash(win: FakeBrowserWindow, reason = 'crashed', exitCode = 139): void {
    win.webContents.emit('render-process-gone' as never, { preventDefault: () => {} } as never, { reason, exitCode } as never)
  }

  it('① 建窗后第一次加载目标是骨架页（含标题/主题适配），应用文档随后', async () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: SCHEME, locale: () => 'zh' })
    const { win } = openApp(adapter)

    // 第一次 `loadURL` 在 `createAppWindow` 返回前就已经发起（同步）。
    expect(win.loaded[0]!.startsWith('data:text/html')).toBe(true)
    const skeleton = decodeURIComponent(win.loaded[0]!)
    // 文案复用 `app-window-copy.ts` 的真源（应用名进了标题）。
    expect(skeleton).toContain('正在打开 演示应用…')
    expect(skeleton).toContain('首次打开可能需要几秒钟')
    // 暗色主题不闪白：媒体查询 + `color-scheme` 都在骨架页里。
    expect(skeleton).toContain('prefers-color-scheme: dark')
    expect(skeleton).toContain('color-scheme:light dark')
    // 骨架有自己的稳定标记（判据用它区分骨架 / 失败页，而不是靠文案前缀）。
    expect(skeleton).toContain('id="zeokeel-loading-skeleton"')

    await settleRecovery()
    // 应用文档在骨架**之后**加载（第二次 `loadURL`）。
    expect(win.loaded[1]).toBe(`${SCHEME}://demo/`)
    expect(appDocumentLoads(win)).toEqual([`${SCHEME}://demo/`])
  })

  it('①b 骨架页跟随宿主语言；暗色下窗口底色不是白色（消除首帧白闪）', async () => {
    const adapter = createRealElectronWindowAdapter({
      appScheme: SCHEME,
      locale: () => 'en',
      isDarkTheme: () => true,
    })
    const { win } = openApp(adapter, 'notes', 'Notes', `${SCHEME}://notes/`)
    expect(win.options.backgroundColor).toBe('#151517')
    const skeleton = decodeURIComponent(win.loaded[0]!)
    expect(skeleton).toContain('Opening Notes…')
    expect(skeleton).toContain('lang="en"')
  })

  it('③ 应用文档迟迟不完成加载 ⇒ 看门狗给可读失败页（不停在骨架）', async () => {
    const adapter = createRealElectronWindowAdapter({
      appScheme: SCHEME,
      locale: () => 'zh',
      warn: message => warned.push(message),
    })
    // U-01：宿主把"协议预算 + 余量"经 `setLoadTimeout` 注入（部署可抬高预算）。
    adapter.setLoadTimeout?.(10)
    const { win } = openApp(adapter)
    // 骨架那次加载已经同步发出；把**下一次**（应用文档）挂住。
    win.webContents.nextLoadHangs = true

    await new Promise(resolve => { setTimeout(resolve, 40) })

    expect(appDocumentLoads(win)).toEqual([`${SCHEME}://demo/`])
    expect(failureLoads(win)).toHaveLength(1)
    expect(decodeURIComponent(failureLoads(win)[0]!)).toContain('id="retry"')
    // 看门狗走 `{retry:false}`：加载还在飞时不再叠一次同目标导航。
    expect(appDocumentLoads(win)).toHaveLength(1)
    expect(warned.some(message => message.includes('did not finish loading'))).toBe(true)
  })

  it('④ 应用窗口装与 shell 同一份渲染错误 preload（分区不变）', () => {
    const preload = '/opt/product/lib/preload/renderer-error.cjs'
    const adapter = createRealElectronWindowAdapter({ appScheme: SCHEME, rendererErrorPreload: preload })
    const { win } = openApp(adapter)
    expect(win.options.webPreferences).toMatchObject({ preload, partition: PARTITION })
    // 没给路径时不写这个键（纯 Node 宿主/旧装配）。
    const bare = createRealElectronWindowAdapter({ appScheme: SCHEME })
    const { win: bareWin } = openApp(bare, 'other', 'Other', `${SCHEME}://other/`)
    expect((bareWin.options.webPreferences as Record<string, unknown>).preload).toBeUndefined()
  })

  it('⑤ render-process-gone ⇒ 上报出口收到带 app_id/windowKind 的事件（不再只 warn）', async () => {
    const reports: unknown[] = []
    const adapter = createRealElectronWindowAdapter({
      appScheme: SCHEME,
      reportRendererError: report => reports.push(report),
    })
    const { win } = openApp(adapter)
    await settleRecovery()

    crash(win)
    await settleRecovery()

    expect(reports).toContainEqual({
      type: 'render-process-gone',
      appId: 'demo',
      windowKind: 'app',
      reason: 'crashed',
      exitCode: 139,
      url: `${SCHEME}://demo/`,
    })
    // 恢复路径照旧（上报与恢复解耦）。
    expect(appDocumentLoads(win)).toEqual([`${SCHEME}://demo/`, `${SCHEME}://demo/`])
  })

  it('⑥ did-fail-load（顶层）与 unresponsive 也进上报链路；子框架/被顶掉的不进', async () => {
    const reports: Array<Record<string, unknown>> = []
    const adapter = createRealElectronWindowAdapter({
      appScheme: SCHEME,
      reportRendererError: report => reports.push(report as unknown as Record<string, unknown>),
    })
    const { win } = openApp(adapter)
    await settleRecovery()

    // 子框架失败：只记日志，不恢复、不上报。
    win.webContents.emit(
      'did-fail-load' as never,
      { preventDefault: () => {} } as never,
      -312 as never,
      'ERR_BLOCKED' as never,
      'https://example.com/embed' as never,
      false as never,
    )
    expect(reports).toHaveLength(0)

    // 顶层真失败：上报一条（带 app_id 与目标 URL）。
    win.webContents.emit(
      'did-fail-load' as never,
      { preventDefault: () => {} } as never,
      -105 as never,
      'NAME_NOT_RESOLVED' as never,
      `${SCHEME}://demo/` as never,
      true as never,
    )
    expect(reports).toContainEqual({
      type: 'did-fail-load',
      appId: 'demo',
      windowKind: 'app',
      reason: '-105: NAME_NOT_RESOLVED',
      url: `${SCHEME}://demo/`,
    })
    await settleRecovery()

    // 卡死（unresponsive）上报，但不触发重载（静默重载会掀掉未保存的草稿）。
    const before = appDocumentLoads(win).length
    win.webContents.emit('unresponsive' as never)
    expect(reports).toContainEqual({
      type: 'unresponsive',
      appId: 'demo',
      windowKind: 'app',
      reason: 'unresponsive',
      url: expect.stringContaining(`${SCHEME}://demo/`),
    })
    expect(appDocumentLoads(win)).toHaveLength(before)
  })

  it('⑦ 上报出口抛错不得阻断窗口/恢复（fail-soft）', async () => {
    const adapter = createRealElectronWindowAdapter({
      appScheme: SCHEME,
      reportRendererError: () => { throw new Error('sentry exploded') },
      warn: message => warned.push(message),
    })
    const { win } = openApp(adapter)
    await settleRecovery()
    expect(() => { crash(win) }).not.toThrow()
    await settleRecovery()
    // 崩溃后的自动重载照旧发生。
    expect(appDocumentLoads(win)).toEqual([`${SCHEME}://demo/`, `${SCHEME}://demo/`])
    expect(warned.some(message => message.includes('reporting an application window error failed'))).toBe(true)
  })

  it('⑧ 失败页带诊断块与「复制诊断」：app_id / URL / 错误 / 客户端版本', async () => {
    const adapter = createRealElectronWindowAdapter({
      appScheme: SCHEME,
      locale: () => 'zh',
      appVersion: '9.9.9',
      warn: message => warned.push(message),
    })
    const { win } = openApp(adapter)
    await settleRecovery()
    crash(win)
    await settleRecovery()
    crash(win)
    await settleRecovery()

    const page = decodeURIComponent(failureLoads(win)[0]!)
    expect(page).toContain('app_id: demo')
    expect(page).toContain(`url: ${SCHEME}://demo/`)
    expect(page).toContain('error: render-process-gone (crashed)')
    expect(page).toContain('client: 9.9.9')
    // 复制按钮 + 反馈行（点了必须有反馈，不能"点了没反应"）。
    expect(page).toContain('id="copy-diag"')
    expect(page).toContain('id="copy-state"')
    expect(page).toContain('navigator.clipboard')
    expect(page).toContain('已复制')
    expect(page).toContain('复制失败')
    // U-09：英文页面用 en 的 lang（同一页面的旧缺陷是写死 zh-CN）。
    expect(page).toContain('lang="zh-CN"')
  })

  it('⑨ 版本更新提示：注入可关闭的提示条 + 刷新（不静默 reload）', () => {
    const adapter = createRealElectronWindowAdapter({ appScheme: SCHEME, locale: () => 'zh' })
    const { handle, win } = openApp(adapter)
    adapter.showWindowNotice?.(handle, '应用有新版本，点击「刷新」后生效。')
    expect(win.webContents.executed).toHaveLength(1)
    const script = win.webContents.executed[0]!
    expect(script).toContain('应用有新版本')
    expect(script).toContain('location.reload')
    // 可关闭（提示不是不可关闭的打断）。
    expect(script).toContain('关闭')
    // 已销毁的窗口上是 no-op（不能抛）。
    adapter.closeAppWindow(handle)
    expect(() => adapter.showWindowNotice?.(handle, 'x')).not.toThrow()
  })
})
