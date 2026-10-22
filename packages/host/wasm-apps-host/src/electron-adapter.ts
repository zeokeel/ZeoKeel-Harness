/**
 * Electron seam for the `zeokeel-app://` origin — the ONLY module in this
 * package that touches Electron.
 *
 * `electron` 走 **peerDependencies**（照 `packages/host/browser` 的做法）：插件
 * 主体（`src/index.ts`）在纯 Node 下也要能加载（单测、profile 冒烟），所以它只
 * 依赖 {@link WasmAppsHostAdapter} 这个结构接口，由桌面壳在装配期把真实适配器
 * `provide` 进来。本模块是唯一静态 `import { protocol, session } from 'electron'`
 * 的地方，因此**只允许 Electron 主进程加载它**（desktop `src/main.ts`）。
 *
 * 两个入口的时序要求不同，都在这里给出：
 *  1. {@link registerAppScheme} 必须在 `app.whenReady()` **之前**执行
 *     （Electron 的 `registerSchemesAsPrivileged` 是启动期 API，晚于 ready 调用
 *     会静默无效或抛错），所以 desktop 壳在 `start()` 里、boot 之前调它；
 *  2. `protocol.handle` 是 per-session 的：默认 session 与每一个 `persist:` 分区
 *     都要注册，缺一个的表现是该分区里的应用页面直接
 *     `ERR_UNKNOWN_URL_SCHEME`（空白页）。
 *
 * @module @zeokeel/dsh-wasm-apps-host/electron-adapter
 */

import { BrowserWindow, Menu, net, protocol, safeStorage, screen, session } from 'electron'
import type { ClientRequest, Session as ElectronSession } from 'electron'
// 权限守卫与请求闸门**只有一份实现**（在 browser 包里，§16.1 要求浏览器与应用窗口
// 共用）；本包通过 workspace 依赖使用它，不再自己写第二份。
import { ensureSessionGuard, installAppSchemeRequestGate, type NativeSession as NativeGuardSession, type NativeWebRequestSession } from '@zeokeel/dsh-browser/guard'
import { APP_REQUEST_TIMEOUT_MS, DEFAULT_APP_SCHEME, isValidAppScheme } from './app-protocol.ts'
import {
  appWindowFailureCopy,
  backAction,
  dismissNoticeAction,
  externalLinkNotice,
  reloadAction,
} from './app-window-copy.ts'
import { createAppWindowRecovery, type AppWindowRecovery } from './app-window-recovery.ts'
import { renderAppWindowSkeletonPage } from './app-window-skeleton.ts'
import { DEFAULT_HOST_LOCALE, type HostLocale } from './locale.ts'
// 窗口几何/生命周期/状态文件的**纯逻辑**在 `windows.ts`（无 Electron 依赖，单测覆盖）；
// 本模块只实现它的原生动作面。类型从那里**再导出**（不复制第二份声明：两份声明
// 会在"给契约加一个成员"时静默漂移，而漂移的方向是`webContentsId` 之类的闸门判据
// 在真实适配器上缺席）。
import { classifyAppWindowNavigation, type AppWindowHandle, type AppWindowHealth, type WasmAppsWindowAdapter } from './windows.ts'

export type { AppWindowFailure, AppWindowFailureKind } from './app-window-recovery.ts'
export type { AppWindowHandle, AppWindowHealth, WasmAppsWindowAdapter } from './windows.ts'

/** 协议 handler 的形状（Electron `protocol.handle` 的回调）。 */
export type AppSchemeRequestHandler = (request: Request) => Promise<Response> | Response

/**
 * 应用 scheme 请求闸门（§16.1 导航闸门 / §23.2 N6）：只有**应用窗口**发出的
 * `<scheme>://…` 请求可以抵达协议 handler；任意 http(s) 页面里的
 * `<img src="<scheme>://…">`、`sendBeacon`、`prefetch`、SW 一律取消。
 *
 * 归属：与协议 handler **同一批注册点**（避免"注册了 handler 却没装闸门"的缝）。
 */
export interface AppSchemeRequestGate {
  /**
   * 该 `webContentsId` 是否是应用窗口（由窗口管理面维护）。
   * @param webContentsId - Electron `webRequest` details 里的发起者 id。
   */
  (webContentsId: number | undefined): boolean
}

/** 协议 handler 注册的入口（默认 session 与分区两类）。 */
export interface AppSchemeRegistrar {
  /** 在**默认 session** 上注册应用协议 handler。 */
  handleAppScheme(scheme: string, handler: AppSchemeRequestHandler): void
  /** 在指定分区（`persist:...`）的 session 上注册应用协议 handler。 */
  handleInSession(scheme: string, partition: string, handler: AppSchemeRequestHandler): void
  /**
   * 确保该 session（默认 session 或某个分区）的**权限守卫**已装（§16.1：归属 = 分区
   * 初始化，不是建 tab 时；幂等）。缺席 ⇒ 宿主记一条 warn（该 session 的 camera/mic
   * 面就没有守卫，而 Electron 缺 check handler 时默认放行）。
   */
  ensureSessionGuard?(partition?: string): void
  /**
   * 在指定 session 上装**应用 scheme 请求闸门**（§23.2 N6；幂等语义由调用方保证：
   * 与协议 handler 同一批注册点，每个 session 只装一次）。
   */
  installAppSchemeRequestGate?(scheme: string, isAppSurfaceWebContents: AppSchemeRequestGate, partition?: string): void
  /**
   * 清理**某个应用 origin** 在该分区里的浏览器存储（F-07，2026-10-22 审计）。
   *
   * 语义边界（每一条都是判据）：
   *  1. **精确到 origin**：`clearStorageData({ origin })`，**不是**整分区清 ——
   *     分区是按用户的，整分区清会把同一用户其它应用的 localStorage / IndexedDB
   *     一起打掉（那是数据丢失，不是"删干净"）；
   *  2. 分区由调用方传入（`currentPartition()`）：应用页面永远落在 `persist:` 分区里，
   *     拿默认 session 清等于什么都没清；
   *  3. 缺席 ⇒ 宿主记一条 warn 并**不假装清过**（纯 Node 宿主/测试替身没有 session）。
   */
  clearAppStorage?(partition: string, origin: string): Promise<void>
  /** 出站请求（缺省时插件用全局 fetch）。 */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /**
   * OS 钥匙串（§23.1：安装私钥优先存 `safeStorage`；不可用时 0600 明文 + warn）。
   * 由桌面壳给真实实现；纯 Node 宿主缺席 ⇒ 走明文兜底。
   */
  safeStorage?: {
    isEncryptionAvailable(): boolean
    encryptString(plainText: string): Buffer
    decryptString(encrypted: Buffer): string
  }
}

/**
 * 应用窗口载体（§16.1「建窗适配器扩 `WasmAppsHostAdapter`」）。
 *
 * **声明在 `windows.ts`**（那里是实现它的纯逻辑的消费者），本模块只 `export type`
 * 转出去 —— 见文件头的 import 注释。
 *
 * @see {@link WasmAppsWindowAdapter}
 */

/**
 * 桌面壳交给插件的最小 Electron 面。
 *
 * `handleAppScheme` / `handleInSession` 对应"默认 session"与"某个持久分区"两次
 * 注册；`fetch` 是出站通道（Chromium 栈，与 enterprise `gatewayFetch` 同源，
 * 走系统代理与证书策略）。`fetch` 可缺席：单测替身与极简宿主可以不给，此时
 * 插件回落到全局 `fetch`。
 */
export type WasmAppsHostAdapter = AppSchemeRegistrar

/** 已做过特权注册的 scheme（**按 scheme 记**，不是模块级布尔：渠道参数化后同一个
 * 进程里可能出现多个 scheme——热重载、单测与将来的多窗口宿主都会重复进入）。 */
const privilegedSchemes = new Set<string>()

/**
 * 把渠道注入的应用源 scheme 注册为特权 scheme（**必须在 `app.whenReady()` 之前调用**）。
 *
 * 权限位与契约 §2 逐字一致：`standard`（有 origin 语义，`<scheme>://demo` 是一个
 * origin）、`secure`（安全上下文，`isSecureContext === true`）、`supportFetchAPI`
 * （应用内 `fetch`/XHR 可达 handler）、`corsEnabled: false`（跨应用与"客户端 UI →
 * 应用"两个方向都必须被拦）、`stream`（流式响应体）、`codeCache`（V8 代码缓存，
 * 需 `standard`）。
 *
 * **scheme 是参数**（§7.8/§10/§16.1）：取值来自渠道包 `desktop.app_origin_scheme`
 * （desktop 壳在模块作用域读随包 channel.json），这里**不得**回落到任何猜出来的
 * 值。缺省参数只为官方构建/单测保留；非法 scheme 一律抛（启动期 fail-loud，
 * 比"页面打不开"早得多也清楚得多）。
 * @param scheme - 本安装的应用源 scheme（不含 `:`）。
 * @throws 当 scheme 形状非法或是保留 scheme 时。
 */
export function registerAppScheme(scheme: string = DEFAULT_APP_SCHEME): void {
  if (!isValidAppScheme(scheme)) {
    throw new Error(`registerAppScheme: ${JSON.stringify(scheme)} is not a valid application origin scheme`)
  }
  if (privilegedSchemes.has(scheme)) return
  protocol.registerSchemesAsPrivileged([{
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      codeCache: true,
    },
  }])
  privilegedSchemes.add(scheme)
}

/**
 * 同源重定向的最大跳数（跨源**一跳都不跟**，见 {@link createPlatformFetch}）。
 *
 * 取 5 是因为平台 API 不该有重定向链：留几跳给"尾斜杠 307""HTTP→HTTPS 同源升级"
 * 这类正常情况，同时保证畸形/恶意链不会无限循环。
 */
export const PLATFORM_FETCH_MAX_REDIRECTS = 5

/**
 * 平台出站（**唯一实现**）：`net.request`（主进程原始 HTTP 客户端），**不是**
 * `session.fetch`。
 *
 * ## 为什么不能用 `session.fetch`（2026-09-20 真机实测，探针
 * `temp/appwin/electron-fetch-probe.cjs`）
 *
 * 契约 §4.3/§20.2 要求协议 handler 为每个应用请求**合成**
 * `Origin: <app scheme>://<app_id>`（自定义协议下浏览器不发 Origin，而平台对非幂等
 * 请求强制校验它）。`session.fetch` 是**浏览器语义**的客户端：请求一旦带 `Origin`
 * 就被当作跨源请求，Chromium 先发 CORS 预检 `OPTIONS`；平台对该路径没有 OPTIONS
 * 路由 ⇒ 404 ⇒ 整个请求以 `net::ERR_FAILED` 失败（实测：同头同体下 A/C/D 三种带
 * Origin 的形态全部 ERR_FAILED，去掉 Origin 才 200/401）。
 *
 * 症状极具误导性：**窗口开了、应用页却永远显示"暂时连不上服务端"**，宿主日志只有
 * 一行 `gateway request for <app> failed (net::ERR_FAILED)`，而服务端访问日志里只有
 * 一串 `OPTIONS … 404`（没有任何 `POST …/request`）——
 * 也就是"看起来像网络故障，实际是客户端自己的 CORS 预检"。
 *
 * `net.request` 不做 CORS，`Origin` 与自定义头原样送出（同一探针 E 组实测：同样的
 * 头拿到 401 `AUTH_FAILED`，说明请求真的到达了平台）。仍绑定同一个
 * `Session`（证书校验策略/代理/缓存都是那个 session 的网络上下文）。
 *
 * ## 重定向：**只跟同源**（2026-09-20 审计 P2-2）
 *
 * 这条出站通道每次都带 `Authorization: Bearer <员工令牌>` 与
 * `X-ZeoKeel-App-Proof`，而平台 API **没有**任何合法的跨源重定向用途。此前用
 * `redirect: 'follow'`：一次 302 到别的 host 就把这两件凭据原样送过去（审计实测
 * `net.request` 与 `session.fetch` **两代都这样** ⇒ 不是本实现引入的回归，但本实现
 * 有能力关掉它）。现在改成 `redirect: 'manual'` + 在 `redirect` 事件里**同步**判源：
 *  - 目标 origin 与请求 origin 相同 ⇒ `followRedirect()`（正常同源跳转照旧）；
 *  - 不同源 / 目标 URL 解析不出来 / 跳数超限 ⇒ **不发第二个请求**，直接以
 *    `createPlatformFetch: refused a cross-origin redirect …` 拒绝（fail-closed）。
 *
 * 响应整体缓冲成 `Response`：本包的三个调用点（协议 handler / 打开校验 / proof 签发）
 * 全都读 `status` + `text()`/`json()`，没有流式消费；平台侧本身也有 8 MiB 响应上限。
 * @param target - 出站使用的 session（缺省默认 session）。
 * @returns 与 `fetch` 同形的出站函数（交给插件做 `adapter.fetch`）。
 */
export function createPlatformFetch(target: ElectronSession = session.defaultSession): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers ?? undefined)
    const body = requestBodyBytes(init.body)
    return await new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined
      if (signal?.aborted === true) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('the request was aborted'))
        return
      }
      let request: ClientRequest
      try {
        // methods 之外的选项：`redirect: 'manual'`（**不**让 Chromium 自己跟跳：
        // 每一次重定向都要过下面的同源判据）、显式 session（证书校验策略/代理仍走该
        // session 的网络上下文）。
        request = net.request({ method, url, session: target, redirect: 'manual' })
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)))
        return
      }
      let settled = false
      let redirects = 0
      /** 初始 origin：所有被放行的跳都必须留在它上面（跨源一跳都不跟）。 */
      let origin: string | null
      try {
        origin = new URL(url).origin
      } catch {
        origin = null
      }
      const fail = (cause: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
      const onAbort = (): void => {
        try {
          request.abort()
        } catch {
          // 已经结束的请求 abort 会抛：忽略（结果由 fail() 给出）。
        }
        fail(signal?.reason instanceof Error ? signal.reason : new Error('the request was aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      request.on('error', fail)
      request.on('redirect', (status, _method, redirectUrl) => {
        // 判据唯一实现（`sameOriginRedirect`）：跨源一律 fail-closed，**不** follow。
        // 目标 URL 解析失败也按跨源处理（"看不懂就不跟"）。
        if (!sameOriginRedirect(origin, redirectUrl)) {
          fail(new Error(
            `createPlatformFetch: refused a cross-origin redirect (${status} ${url} -> ${redirectUrl}): `
            + 'credentials are never replayed to another origin',
          ))
          try {
            request.abort()
          } catch {
            // 同上：abort 的异常不影响已给出的结论。
          }
          return
        }
        redirects += 1
        if (redirects > PLATFORM_FETCH_MAX_REDIRECTS) {
          fail(new Error(`createPlatformFetch: too many redirects (> ${PLATFORM_FETCH_MAX_REDIRECTS})`))
          try {
            request.abort()
          } catch {
            // 同上。
          }
          return
        }
        try {
          // 必须在 `redirect` 事件里**同步**调用（Electron 的契约）：晚一步请求就以
          // "Redirect was cancelled" 结束。
          request.followRedirect()
        } catch (cause) {
          fail(cause)
        }
      })
      request.on('response', (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => { chunks.push(Buffer.from(chunk)) })
        response.on('error', fail)
        response.on('end', () => {
          if (settled) return
          // **先构造、再置 settled**（2026-09-20 审计 P2-1）：反过来的话
          // `buildResponse` 抛错时 `settled` 已是 true，`fail()` 直接 return —— promise
          // 永久 pending，调用方的 AbortSignal 也被摘掉，一次失败被放大成"永不返回"。
          // 触发面：status ∉ [200,599]（RangeError）或 statusText 含非 0x20–0x7E 字符
          // （TypeError）。
          let built: Response
          try {
            built = buildResponse(response.statusCode, response.statusMessage, response.headers, Buffer.concat(chunks))
          } catch (cause) {
            fail(cause)
            return
          }
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve(built)
        })
      })
      try {
        for (const [name, value] of headers) request.setHeader(name, value)
        if (body !== undefined) request.write(body)
        request.end()
      } catch (cause) {
        fail(cause)
      }
    })
  }
}

/**
 * 重定向目标是否与**初始请求**同源（`createPlatformFetch` 的唯一判据）。
 *
 * 同源 = 协议 + 主机 + 端口完全一致；相对 `Location`（`/next`）按初始 origin 解析。
 * 解析失败返回 false（"看不懂就不跟"，fail-closed）。
 * @param origin - 初始请求的 origin（`new URL(requestUrl).origin`）；null ⇒ 一律 false。
 * @param redirectUrl - `net.request` 的 `redirect` 事件给出的目标 URL。
 * @returns 是否可以继续跟随。
 */
function sameOriginRedirect(origin: string | null, redirectUrl: unknown): boolean {
  if (origin === null || typeof redirectUrl !== 'string' || redirectUrl === '') return false
  try {
    return new URL(redirectUrl, origin).origin === origin
  } catch {
    return false
  }
}

/**
 * 把 `RequestInit.body` 规范成 `ClientRequest.write` 能吃的字节。
 *
 * 只支持本包实际用到的三种（JSON 字符串 / `Uint8Array` / `ArrayBuffer`）：流式 body
 * 会与"整体缓冲响应"的实现假设打架，遇到就直接抛（fail-loud，而不是悄悄丢掉 body
 * 让平台回一个莫名其妙的 400）。
 * @param body - `RequestInit.body`。
 * @returns 字节，或 undefined（无 body）。
 * @throws 当 body 是不支持的形态时。
 */
function requestBodyBytes(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body))
  throw new Error('createPlatformFetch: unsupported request body (only string, Uint8Array and ArrayBuffer are supported)')
}

/**
 * 用 `net.request` 的响应三元组构造标准 `Response`。
 *
 * 逐跳/传输层头必须丢掉：`net.request` 交出来的体**已经解压**，而
 * `content-encoding`/`content-length`/`transfer-encoding` 描述的仍是线上形态 —— 原样
 * 带进 `Response` 会让消费者的解码与长度校验对不上（最典型的是 body 被截断或抛
 * `TypeError: incorrect header check`）。
 * @param status - HTTP 状态码。
 * @param statusMessage - HTTP 原因短语（可能为空）。
 * @param raw - `net.request` 的 `response.headers`（值可能是数组或单串）。
 * @param body - 已缓冲的响应体。
 * @returns 标准 `Response`。
 */
function buildResponse(status: number, statusMessage: string, raw: Record<string, string | string[]>, body: Buffer): Response {
  const headers = new Headers()
  const dropped = new Set(['content-encoding', 'content-length', 'transfer-encoding'])
  for (const [name, values] of Object.entries(raw)) {
    if (dropped.has(name.toLowerCase())) continue
    for (const value of (Array.isArray(values) ? values : [values])) headers.append(name, value)
  }
  // 204/304 与空体在 `Response` 构造上语义不同：带 body 会直接抛。
  const empty = body.length === 0 || status === 204 || status === 304
  return new Response(empty ? null : new Uint8Array(body), {
    status,
    ...(statusMessage === '' ? {} : { statusText: statusMessage }),
    headers,
  })
}

/**
 * 真实 Electron 适配器（默认 session + 任意分区 + Chromium 外出栈）。
 *
 * scheme 是**每次调用**的参数（不是适配器字段）：协议注册与 handler 注册必须用
 * 同一个值，把它放在调用参数上可以让"两处用了不同的 scheme"这类缺陷在类型层
 * 就无法表达。
 * @returns 交给插件（`provide('wasmAppsHostAdapter', …)`）的适配器实例。
 */
export function createRealElectronAdapter(): WasmAppsHostAdapter {
  return {
    handleAppScheme(scheme, handler) {
      session.defaultSession.protocol.handle(scheme, handler)
    },
    handleInSession(scheme, partition, handler) {
      session.fromPartition(partition).protocol.handle(scheme, handler)
    },
    ensureSessionGuard(partition) {
      const target = partition === undefined ? session.defaultSession : session.fromPartition(partition)
      ensureSessionGuard(target as unknown as NativeGuardSession)
    },
    installAppSchemeRequestGate(scheme, isAppSurfaceWebContents, partition) {
      const target = partition === undefined ? session.defaultSession : session.fromPartition(partition)
      installAppSchemeRequestGate(target as unknown as NativeWebRequestSession, {
        scheme,
        isAppSurfaceWebContents,
      })
    },
    // F-07：下架/删除/真的恢复之后清**这个应用 origin** 的浏览器存储
    //（**冻结/解冻不在此列**：只读快照、数据保留，见 `wasm-apps.ts` 的
    // `lifecycleActionApplied`）。
    // 必须带 `origin`（精确到应用）：分区是按用户的，整分区清会打掉同一账号下其它
    // 应用的数据 —— 那样"删除一个应用"就变成了"清空这个人的全部应用存储"。
    async clearAppStorage(partition, origin) {
      const target = typeof partition === 'string' && partition !== ''
        ? session.fromPartition(partition)
        : session.defaultSession
      await target.clearStorageData({ origin })
    },
    // 出站**不走** `session.fetch`：见 createPlatformFetch 的注释（Origin ⇒ CORS 预检
    // ⇒ 平台没有 OPTIONS 路由 ⇒ 应用页永远"连不上服务端"）。
    fetch: createPlatformFetch(),
    // OS 钥匙串（§23.1）：Windows DPAPI / macOS Keychain / Linux libsecret。
    // 不可用时 `isEncryptionAvailable()` 为 false，插件侧回落 0600 明文并记 warn。
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: plainText => safeStorage.encryptString(plainText),
      decryptString: encrypted => safeStorage.decryptString(encrypted),
    },
  }
}

/** {@link createRealElectronWindowAdapter} 的构造参数。 */
export interface RealAppWindowAdapterOptions {
  /**
   * 本安装的应用源 scheme（渠道注入，§10/§16.1）。
   *
   * 导航闸门按它判"同 app origin"；非法值一律**构造期**抛（fail-loud 比"窗口打开
   * 后每一个导航都被拒"早得多，也清楚得多）。
   */
  appScheme: string
  /** 诊断出口（拒绝导航 / 加载失败）。缺省丢弃。 */
  warn?: ((message: string) => void) | undefined
  /**
   * 宿主语言（**函数**，按调用求值）。
   *
   * 为什么是 thunk 而不是值：失败页文案要跟随应用内语言切换，而适配器是**启动期**
   * 构造的（那时用户还没法改语言）。任何把首次解析结果钉进闭包常量的写法都会让
   * "切了语言但失败页还是旧语言"（本仓已记录两次同根因 bug）。
   *
   * 缺席 ⇒ 产品缺省语言（`DEFAULT_HOST_LOCALE`）。
   */
  locale?: (() => HostLocale) | undefined
  /**
   * 应用窗口的**渲染进程错误 preload** 绝对路径（U-03，2026-10-22 评审）。
   *
   * 与 shell 窗口同一份 `preload/renderer-error.cjs`（桌面壳给路径；本包不认识
   * desktop 的目录布局）。它只把页面主世界的未捕获 `error`/`unhandledrejection`
   * 经 IPC 转给主进程 —— 不向页面暴露 API、不持有 DSN、不联网。
   *
   * **为什么是每窗口的 `webPreferences.preload`，而不是 `session.setPreloads`**：
   * 应用窗口落在**与内置浏览器共用**的按用户分区上；把 preload 装到 session 上会
   * 让浏览器标签里的任意网页也被注入（本功能只需要应用窗口的覆盖面，越窄越安全）。
   *
   * 缺席 ⇒ 不装（纯 Node 宿主/旧装配；应用窗口仍能开，只是渲染错误不进链路）。
   */
  rendererErrorPreload?: string | undefined
  /**
   * 主进程侧应用窗口故障的**上报出口**（U-03）。
   *
   * 为什么由桌面壳注入：`reportRendererError` 与 Sentry sink 都在 desktop 包里，而
   * 本包是它的依赖（不能反向 import）。本包只负责**把事件与 `app_id` 一起交出去**，
   * 落点（Sentry tag、限流、无 sink 时静默丢弃）由宿主决定。
   *
   * 调用永远是 fail-soft：上报出口抛错只记一条 warn，绝不阻断窗口/恢复路径。
   */
  reportRendererError?: ((report: AppWindowRendererErrorReport) => void) | undefined
  /**
   * 客户端版本（失败页诊断块里的 `client:` 一行；由桌面壳给 `app.getVersion()`）。
   */
  appVersion?: string | undefined
  /**
   * "骨架 → 应用文档"的**加载看门狗**上限（毫秒；U-01）。
   *
   * 缺省 {@link APP_REQUEST_TIMEOUT_MS}（75 s，与协议 handler 的单次出站预算同值）：
   * 协议 handler 自己超时后会把可读错误页作为文档返回，正常路径下看门狗不会先响；
   * 它防的是"加载既不 resolve 也不 reject"（handler 卡死/导航被吞）时骨架永久停留。
   * 单测用小值钉住行为。
   */
  loadTimeoutMs?: number | undefined
  /** 当前是否暗色主题（窗口 `backgroundColor` 跟它，避免暗色下白屏闪一帧）。 */
  isDarkTheme?: (() => boolean) | undefined
}

/**
 * 应用窗口的主进程侧故障报告（U-03）。
 *
 * 三种事件源：渲染进程消失、顶层文档加载失败、窗口 unresponsive。**都带 `app_id`**
 * （以及 `windowKind: 'app'`）—— 否则后台收到一条崩溃事件却不知道是哪个应用。
 */
export interface AppWindowRendererErrorReport {
  /** 事件种类（与 shell 的 `render-process-gone` 同形，另有两条应用窗口专有）。 */
  type: 'render-process-gone' | 'did-fail-load' | 'unresponsive'
  /** 出事的应用 id（Sentry tag `zeokeel.app_id`）。 */
  appId: string
  /** 窗口种类（当前只有应用窗口走这条出口；保留字段供 shell 侧统一）。 */
  windowKind: 'app'
  /** 崩溃原因 / 错误描述 / `'timeout'`。 */
  reason: string
  /** `render-process-gone` 的退出码。 */
  exitCode?: number
  /** 出错时的文档 URL（应用窗口恒为 `<scheme>://<app_id>/…`）。 */
  url?: string
}

/**
 * 真实 Electron 应用窗口适配器（W-C 裁决的"独立窗口"原生面，§16.1）。
 *
 * 这里**只有原生动作**：几何计算、单应用单窗口、尺寸/比例记忆、状态文件都在
 * `windows.ts`（纯 Node 可测）。本函数是那条逻辑与 Electron 之间唯一的缝 ——
 * 所以它自己也要能被离线钉住（`electron-adapter.spec.ts` 用替身 `BrowserWindow`）。
 *
 * 冻结条款（逐条对应实现）：
 *  - **默认 session**：应用协议 handler 与 `onBeforeRequest` 闸门都由插件装在
 *    **默认 session**（`registerDefault()`）上；应用窗口跟着走同一个 session，
 *    否则页面直接 `ERR_UNKNOWN_URL_SCHEME`（§16.1「注册面 = 默认 session + 分区」）。
 *  - **标题不可被页面改写**（§7.2 防伪装）：`page-title-updated` 一律
 *    `preventDefault()`，窗口标题恒为宿主给的 `<应用名> · <产品名>`。
 *  - **同 app origin 的导航闸门**：`will-navigate` / `will-frame-navigate` /
 *    `setWindowOpenHandler` 三处都按 {@link classifyAppWindowNavigation} 判
 *    （跨 app = 换壳钓鱼 ⇒ 拒；http(s) 外链不在应用窗口导航 ⇒ 拒）。
 *  - **权限守卫**：建窗前 `ensureSessionGuard()` 显式确保（幂等；Electron 缺 check
 *    handler 时默认放行 camera/mic）。
 *  - **存活判据**（`isAlive`）：用户手动关窗后窗口管理器必须**重新建窗**，而不是
 *    聚焦一个已销毁的句柄（否则第二次 `open` 会回 `focused` 而**屏幕上一个窗口都
 *    没有**——正是本模块要消灭的那类"契约对、现象空"的缺陷）。
 *  - **崩溃 / 加载失败恢复**（R16B-19）：`render-process-gone` 与顶层 `did-fail-load`
 *    经 `app-window-recovery.ts` 的**单飞状态机**处理 —— 至多自动重载一次，之后显示
 *    带「重试」按钮的失败页（形态与 shell 窗口的 `reloadOrShowCrashFallback` 一致）。
 *  - **原生生命周期订阅**（R16B-20）：`win 'closed'` 与健康状态变化经
 *    {@link WasmAppsWindowAdapter.onAppWindowClosed} /
 *    {@link WasmAppsWindowAdapter.onAppWindowHealth} 即时通知窗口管理器；没有它，
 *    用户自己关掉的窗口只能靠 `isAlive()` 被"问一次"才发现。
 * @param options - 应用源 scheme、诊断出口与宿主语言。
 * @returns 交给桌面壳 `provide('wasmAppsWindowAdapter', …)` 的适配器实例。
 * @throws 当 `appScheme` 不是合法应用源 scheme 时。
 */
/**
 * 应用窗口内**提示条**的注入脚本（F-05，2026-10-22 审计）。
 *
 * 缺陷形态：应用里 `window.open` 一律 `deny`，而 `externalLinkNotice` /
 * `downloadStartedNotice` 两条文案**零消费方** —— 用户点了外链，界面上什么都没发生
 *（看起来像"链接坏了"）。应用窗口没有自绘 chrome，所以最小可用的反馈是把一个小提示
 * 条**注入应用页面**（8 s 后自动消失，重复点击只有一条）。
 *
 * 安全：文案用 `JSON.stringify` 序列化进脚本 —— 一个带引号/换行的 host 也拼不出可执行
 * 代码（提示条不得成为注入面）。注入失败不阻断 `deny`（提示是"有反馈"，不是许可）。
 * @param text - 提示条正文（已本地化）。
 * @returns 可直接交给 `webContents.executeJavaScript` 的脚本。
 */
export function appWindowNoticeScript(text: string): string {
  const payload = JSON.stringify(String(text))
  return `(() => {
  try {
    const existing = document.getElementById('zeokeel-app-notice')
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
    const host = document.createElement('div')
    host.id = 'zeokeel-app-notice'
    host.setAttribute('role', 'status')
    host.textContent = ${payload}
    host.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'z-index:2147483647;max-width:min(560px,90vw);padding:10px 16px;border-radius:10px;' +
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;' +
      'color:#fff;background:rgba(17,24,39,.92);box-shadow:0 6px 24px rgba(0,0,0,.28);' +
      'pointer-events:none;word-break:break-word'
    ;(document.body || document.documentElement).appendChild(host)
    setTimeout(() => { if (host.parentNode) host.parentNode.removeChild(host) }, 8000)
  } catch (error) { /* 提示失败不阻断 deny */ }
})()`
}

/**
 * 应用窗口的**版本更新提示条**脚本（U-06，2026-10-22 评审）。
 *
 * 缺陷形态：平台发了新版本、窗口还开着 ⇒ 窗口继续跑旧前端，而请求已被导到新版本的
 * 资源（`index.ts` 的 `changed` 只清缓存、不重载；`windows.ts` 同 URL 不重载）；
 * 全程没有"有新版本，刷新"的提示，`Ctrl/Cmd+R` 又只藏在右键菜单里。
 *
 * 形态：页面顶部一条**可关闭**的提示（`关闭` 按钮），`刷新` 按钮执行
 * `location.reload()` —— 不静默强制刷新：应用里可能有未保存的草稿，重载必须由用户按。
 * 注入是幂等的（重复收到同一版本通知不叠多条）。
 *
 * 安全：三个文案都用 `JSON.stringify` 序列化；节点只用 `textContent`，不拼 HTML。
 * @param options - 本地化文案（正文/刷新/关闭）。
 * @returns 可直接交给 `webContents.executeJavaScript` 的脚本。
 */
export function appWindowUpdateNoticeScript(options: { message: string, refresh: string, dismiss: string }): string {
  const message = JSON.stringify(String(options.message))
  const refresh = JSON.stringify(String(options.refresh))
  const dismiss = JSON.stringify(String(options.dismiss))
  return `(() => {
  try {
    const existing = document.getElementById('zeokeel-app-update')
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
    const host = document.createElement('div')
    host.id = 'zeokeel-app-update'
    host.setAttribute('role', 'status')
    host.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);' +
      'z-index:2147483647;display:flex;align-items:center;gap:10px;max-width:min(620px,92vw);' +
      'padding:10px 14px;border-radius:10px;font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;' +
      'color:#fff;background:rgba(17,24,39,.94);box-shadow:0 6px 24px rgba(0,0,0,.28);' +
      'pointer-events:auto;word-break:break-word'
    const text = document.createElement('span')
    text.textContent = ${message}
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.textContent = ${refresh}
    reload.style.cssText = 'padding:4px 10px;border:1px solid #2563eb;border-radius:7px;background:#2563eb;color:#fff;font:inherit;cursor:pointer'
    reload.addEventListener('click', () => { try { location.reload() } catch (error) {} })
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = ${dismiss}
    close.setAttribute('aria-label', ${dismiss})
    close.style.cssText = 'padding:4px 8px;border:0;border-radius:7px;background:transparent;color:#d1d5db;font:inherit;cursor:pointer'
    close.addEventListener('click', () => { if (host.parentNode) host.parentNode.removeChild(host) })
    host.appendChild(text)
    host.appendChild(reload)
    host.appendChild(close)
    ;(document.body || document.documentElement).appendChild(host)
  } catch (error) { /* 提示失败不阻断应用 */ }
})()`
}

/**
 * 应用窗口的**右键菜单**（F-06）：刷新 / 返回。
 *
 * 为什么是右键菜单而不是自绘 chrome：应用窗口的几何已按作者声明锁定（`setAspectRatio`
 * 的 `extraSize` 是给 chrome 预留的，但自绘标题栏要先改窗口 creation 与渲染页），而
 * 右键菜单不需要动窗口版面，就能给"卡住了/想退一步"两个最常用的出口。键盘等价物
 * 同时挂上（Ctrl/Cmd+R、Alt+← / Cmd+[），见 {@link createRealElectronWindowAdapter}
 * 里 `installAppWindowGuards` 的 `before-input-event`。
 * @param win - 原生窗口（菜单锚点）。
 * @param locale - 宿主语言（每次弹菜单时求值）。
 * @param actions - 两个动作的实现（便于单测替身）。
 */
export function buildAppWindowMenu(
  win: BrowserWindow,
  locale: HostLocale,
  actions: { reload: () => void, back: () => void },
): { menu: Menu } {
  const menu = Menu.buildFromTemplate([
    { label: reloadAction(locale), click: () => { actions.reload() } },
    { label: backAction(locale), click: () => { actions.back() } },
  ])
  menu.popup({ window: win })
  return { menu }
}

export function createRealElectronWindowAdapter(options: RealAppWindowAdapterOptions): WasmAppsWindowAdapter {
  const { appScheme } = options
  if (!isValidAppScheme(appScheme)) {
    throw new Error(`createRealElectronWindowAdapter: ${JSON.stringify(appScheme)} is not a valid application origin scheme`)
  }
  const warn = options.warn ?? ((): void => {})
  const locale = options.locale ?? ((): HostLocale => DEFAULT_HOST_LOCALE)
  /**
   * 看门狗上限（U-01）。构造期由 `loadTimeoutMs` 给（单测用小值），运行期可经
   * {@link setLoadTimeout} 对齐插件的 `requestTimeoutMs`（见 windows.ts 的说明）。
   */
  let loadTimeoutMs = options.loadTimeoutMs
  /** 句柄 → 原生窗口。用注册表而不是 `instanceof`：单测的替身也是合法句柄。 */
  const handles = new WeakMap<object, BrowserWindow>()

  /**
   * 每个原生窗口的**恢复记账 + 诊断订阅**（R16B-19 / R16B-20）。
   *
   * 为什么挂在原生窗口对象上（WeakMap）而不是句柄上：句柄就是 `BrowserWindow` 本身
   * （见 {@link remember}），两者同生命周期；用 WeakMap 是为了不在窗口销毁后留下
   * 强引用。
   */
  interface AppWindowBookkeeping {
    /** 这台窗口的崩溃恢复状态机（单飞 + 至多自动重载一次 + 失败页）。 */
    recovery: AppWindowRecovery
    /**
     * **最近一次请求加载的应用 URL**（失败页的重试目标）。
     *
     * 为什么必须自己记：失败页显示期间 `webContents.getURL()` 是 `data:` 文档，
     * 拿它当重试目标会让第二次失败页的按钮变成禁用的（用户再无出路）。
     */
    desiredUrl: string
    /** 宿主的健康订阅（模型面 `crashed` 的消费者）。 */
    health: Set<(snapshot: AppWindowHealth) => void>
    /** 宿主的销毁订阅（R16B-20：用户点窗口自己的关闭按钮）。 */
    closed: Set<() => void>
    /**
     * 最近一次加载请求的序号（健康状态的**排序判据**）。
     *
     * 为什么必须有它：`loadURL` 的 promise 是按微任务结算的，而崩溃事件可能先到 ——
     * "崩溃前发出的那次加载成功了"于是会在崩溃之后把 `crashed` 抹回 false（用户与
     * 模型看到的是"窗口好好的"，而它其实已经崩了）。规则：加载结果只在它**仍是
     * 最新一次请求**时才作数；崩溃事件前移序号，作废所有在飞结果。
     */
    loadSeq: number
    /**
     * "骨架 → 应用文档"的看门狗（U-01）。应用文档 `did-finish-load`/失败/崩溃/关窗
     * 都会清掉它；只有"既不 resolve 也不 reject"的加载会让它响。
     */
    watchdog?: ReturnType<typeof setTimeout> | undefined
    /**
     * 应用文档是否**真的**完成过一次加载（U-01 看门狗的判据）。
     *
     * 为什么不用 `webContents.getURL()` 判：加载在飞时 `getURL()` 的语义随平台/时序
     * 漂移（Replace/committed 的差别），而看门狗的结论必须是确定的 —— 一个显式的
     * 布尔只会在"应用文档确实到了"时翻转。
     */
    appDocumentLoaded: boolean
  }

  /**
   * 允许在应用窗口里导航到的**精确 URL**（F-04：宿主渲染的会话过期页上的「重新登录」
   * 按钮）。只放行精确匹配；`setNavigationAllowlist` 由插件在装配期登记。
   */
  const allowedNavigations = new Set<string>()

  const books = new WeakMap<BrowserWindow, AppWindowBookkeeping>()

  /**
   * 一个 URL 是否是**本安装的应用文档**（`<scheme>://…`）。
   *
   * 用途只有一个：区分"应用真的加载好了"与"我们自己塞进去的失败页也加载完了"——
   * 后者是 `data:` 文档，绝不能把 `crashed` 抹回 false。
   * @param rawUrl - `webContents.getURL()` 的取值。
   * @returns 是否是应用文档 URL。
   */
  const isAppDocumentUrl = (rawUrl: unknown): rawUrl is string => {
    if (typeof rawUrl !== 'string' || rawUrl === '') return false
    try {
      return new URL(rawUrl).protocol === `${appScheme}:`
    } catch {
      return false
    }
  }

  /**
   * 解析应用窗口要落地的 session（**分区必填**）。
   *
   * 为什么在这里 fail-loud：Electron 把空/缺失的 `partition` 当"用默认 session"，
   * 于是"忘记传分区"这种缺陷的表现是**窗口照常打开**（只是跑在默认 session 上），
   * 离线单测与真机都看不出来 —— 这正是 2026-09-20 审计的 P1-2。宁可在建窗时抛。
   * @param partition - 插件按当前用户算出的分区名（`persist:...`）。
   * @returns 该分区的 Electron session。
   * @throws 当分区是空串/非字符串时。
   */
  const sessionForPartition = (partition: string): ElectronSession => {
    if (typeof partition !== 'string' || partition === '') {
      throw new Error('createRealElectronWindowAdapter: an explicit session partition is required for an application window')
    }
    return session.fromPartition(partition)
  }

  /**
   * 被后续导航顶掉的加载（`ERR_ABORTED`）不是故障。
   *
   * 真实序列：`createAppWindow` 发起的 `loadURL('/')` 还没完成，第二次 `open`（聚焦到
   * `/notes`）就把它顶掉 —— 第一次加载的 promise 以 `ERR_ABORTED (-3)` reject。把它当
   * "加载失败"记进日志会让诊断包出现一条永远存在的假故障（真机实测踩到）。
   * @param cause - `loadURL` 的 rejection。
   * @returns 是否是"被顶掉"。
   */
  const supersededLoad = (cause: unknown): boolean => {
    if (typeof cause !== 'object' || cause === null) return false
    const record = cause as { code?: unknown, errno?: unknown, message?: unknown }
    if (record.code === 'ERR_ABORTED' || record.errno === -3) return true
    return typeof record.message === 'string' && record.message.includes('ERR_ABORTED')
  }

  /** 统一的加载失败出口（被顶掉的不记）。 */
  const reportLoadFailure = (url: string, cause: unknown): void => {
    if (supersededLoad(cause)) return
    warn(`zeokeel-wasm-apps-host: loading ${url} in the application window failed (${cause instanceof Error ? cause.message : String(cause)})`)
  }

  const windowOf = (handle: AppWindowHandle): BrowserWindow | undefined =>
    (typeof handle === 'object' && handle !== null) ? handles.get(handle) : undefined

  /** 记录一个句柄并返回它（句柄就是 `BrowserWindow` 本身）。 */
  const remember = (win: BrowserWindow): AppWindowHandle => {
    handles.set(win, win)
    return win
  }

  /**
   * 在一个应用窗口里加载**应用 URL**（建窗与聚焦导航的唯一入口）。
   *
   * 加载结果同时决定健康状态（R16B-19）：成功 ⇒ `loaded()`（窗口真的好了）、失败 ⇒
   * `fail()`（进恢复路径）。**失败页不经过这里** —— 它由恢复状态机直接
   * `win.loadURL('data:text/html…')`，因此既不改 `desiredUrl`、也不算"应用加载成功"。
   * @param win - 原生窗口。
   * @param url - 应用 URL。
   * @returns 加载完成（失败已内部消化，调用方 `void` 掉即可）。
   */
  const loadAppUrl = async (win: BrowserWindow, url: string): Promise<void> => {
    const book = books.get(win)
    if (book === undefined) {
      try {
        await win.loadURL(url)
      } catch (cause) {
        reportLoadFailure(url, cause)
      }
      return
    }
    book.desiredUrl = url
    book.loadSeq += 1
    const seq = book.loadSeq
    try {
      await win.loadURL(url)
      // 只有"仍是最新一次请求"的加载成功才算窗口好了（见 `loadSeq` 的注释）。
      if (book.loadSeq === seq) {
        book.appDocumentLoaded = true
        book.recovery.loaded()
      }
    } catch (cause) {
      if (supersededLoad(cause)) return
      reportLoadFailure(url, cause)
      // 事件源之一：`loadURL` 的 rejection 比 `did-fail-load` 更早、也更可靠地
      // 覆盖"平台不可达"这类失败（两者都到达时由状态机的单飞合并）。
      if (book.loadSeq === seq) void book.recovery.fail({ kind: 'did-fail-load', reason: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  /**
   * 把主进程侧的应用窗口故障交给桌面壳的上报出口（U-03）。
   *
   * 三重 fail-soft：出口缺席（纯 Node/旧装配）⇒ 什么都不做；出口抛错 ⇒ 只记 warn；
   * 无论哪种情况都**不阻断**窗口/恢复路径（上报坏掉绝不能影响用户）。
   * @param report - 事件种类、`app_id` 与原因。
   */
  const reportAppWindowError = (report: AppWindowRendererErrorReport): void => {
    if (options.reportRendererError === undefined) return
    try {
      options.reportRendererError(report)
    } catch (cause) {
      warn(`zeokeel-wasm-apps-host: reporting an application window error failed (${cause instanceof Error ? cause.message : String(cause)})`)
    }
  }

  /** 清掉"骨架 → 应用文档"看门狗（幂等；窗口关闭/加载落地/崩溃都走它）。 */
  const clearLoadWatchdog = (book: AppWindowBookkeeping): void => {
    if (book.watchdog === undefined) return
    clearTimeout(book.watchdog)
    book.watchdog = undefined
  }

  /**
   * 武装加载看门狗（U-01）。
   *
   * 判据是"**应用文档**还没成为当前文档"：骨架是 `data:` 文档，失败页也是 —— 但失败页
   * 出现意味着恢复路径已经接管（那里会先清看门狗），所以这里只可能在"什么都没发生"时
   * 响。到点走 `{ retry: false }`：应用加载还在飞，自动重载只会叠一次同目标导航。
   * @param win - 原生窗口。
   * @param appId - 应用 id（上报用）。
   * @param url - 正在加载的应用 URL。
   */
  const armLoadWatchdog = (win: BrowserWindow, appId: string, url: string): void => {
    const book = books.get(win)
    if (book === undefined) return
    clearLoadWatchdog(book)
    const timeoutMs = loadTimeoutMs !== undefined && loadTimeoutMs > 0
      ? loadTimeoutMs
      : APP_REQUEST_TIMEOUT_MS
    const timer = setTimeout(() => {
      book.watchdog = undefined
      if (win.isDestroyed()) return
      if (book.appDocumentLoaded) return
      warn(`zeokeel-wasm-apps-host: the application document of ${appId} did not finish loading within ${String(timeoutMs)}ms; showing the failure page`)
      reportAppWindowError({ type: 'did-fail-load', appId, windowKind: 'app', reason: 'timeout', url })
      // 这次超时作废在飞的加载结果（它若迟到成功，不得把失败页当成"窗口好了"）。
      book.loadSeq += 1
      void book.recovery.fail({ kind: 'did-fail-load', reason: 'timeout' }, { retry: false })
    }, timeoutMs)
    // 不拖住进程退出（Electron 主进程的 Node timer 支持 unref）。
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
    book.watchdog = timer
  }

  /**
   * 建窗后**第一件**事：把骨架页加载进窗口（U-01）。
   *
   * 为什么先 `await` 这一次加载再加载应用：两次 `loadURL` 背靠背时后一次会顶掉前一次
   * （`ERR_ABORTED`），骨架一帧都画不出来 —— 那正好是这次要修的白屏。
   *
   * 返回 `false` 表示"不应该再继续加载应用"：窗口已销毁，或崩溃/恢复路径已经接管了
   * 这个窗口（`loadSeq` 被前移）。
   * @param win - 刚建好的原生窗口。
   * @param appId - 应用 id。
   * @param appLabel - 应用名（骨架标题）。
   * @param url - 随后要加载的应用 URL（先记成 `desiredUrl`，崩溃时恢复路径要用）。
   * @returns 是否继续加载应用文档。
   */
  const showLoadingSkeleton = async (win: BrowserWindow, appId: string, appLabel: string, url: string): Promise<boolean> => {
    const book = books.get(win)
    if (book === undefined) return false
    // 恢复路径的重试目标必须从建窗那一刻起就有效（崩溃可以发生在首帧）。
    book.desiredUrl = url
    book.loadSeq += 1
    const seq = book.loadSeq
    try {
      await win.loadURL(renderAppWindowSkeletonPage({ locale: locale(), appLabel }))
    } catch (cause) {
      // 骨架加载失败不阻断应用加载：它是"有反馈"的优化，不是建窗的前置条件。
      reportLoadFailure(`application window skeleton for ${appId}`, cause)
    }
    if (win.isDestroyed()) return false
    // 崩溃/恢复/其它导航已经接管：不要再把应用文档盖回去。
    return book.loadSeq === seq
  }

  /**
   * 建窗时挂上**故障 / 销毁 / 健康**三类原生订阅（R16B-19 / R16B-20）。
   *
   * 这是本模块与 `windows.ts` 之间唯一的生命周期缝：宿主（窗口管理器）订阅的是
   * "这个窗口坏了/没了"，而不是自己去轮询 `isAlive()` —— 后者只在被问到时才发现，
   * 于是用户自己关掉的窗口会以幽灵 surface 的形式继续留在模型面上。
   * @param win - 刚建好的原生窗口。
   * @param appId - 应用 id（诊断文案用）。
   * @returns 该窗口的记账对象。
   */
  const watchAppWindow = (win: BrowserWindow, appId: string): AppWindowBookkeeping => {
    const book: AppWindowBookkeeping = {
      desiredUrl: '',
      appDocumentLoaded: false,
      health: new Set(),
      closed: new Set(),
      loadSeq: 0,
      // 先占位、马上覆盖：`createAppWindowRecovery` 的 `onCrashStateChange` 需要
      // 引用 `book`，而 `book` 又需要 recovery —— 用两层赋值打破这个环。
      recovery: undefined as unknown as AppWindowRecovery,
    }
    books.set(win, book)
    book.recovery = createAppWindowRecovery({
      host: {
        isDestroyed: () => win.isDestroyed(),
        currentUrl: () => {
          if (win.isDestroyed()) return ''
          const current = win.webContents.getURL()
          // 当前文档是失败页（`data:`）时回落到"最近一次请求的应用 URL"。
          return isAppDocumentUrl(current) ? current : book.desiredUrl
        },
        load: async (url) => { await win.loadURL(url) },
      },
      copy: () => appWindowFailureCopy(locale()),
      // U-03：失败页上的诊断块（app_id / 出错 URL / 客户端版本）；U-09：`<html lang>`
      // 跟随宿主语言（写死 `zh-CN` 会让英文界面的读屏按中文发音）。
      diagnostics: () => ({
        appId,
        url: book.desiredUrl,
        ...(options.appVersion === undefined ? {} : { clientVersion: options.appVersion }),
      }),
      pageLang: () => locale(),
      warn,
      onCrashStateChange: (crashed) => {
        for (const listener of book.health) listener({ crashed })
      },
    })

    // 故障源 1：渲染进程消失（崩溃/OOM/被杀）。`clean-exit`/`killed` 是正常收尾，
    // 不是故障 —— 把它们也当崩溃会让"关闭窗口时进程正常退出"弹出一张失败页。
    win.webContents.on('render-process-gone', (_event, details) => {
      const reason = typeof details?.reason === 'string' ? details.reason : 'unknown'
      const exitCode = typeof details?.exitCode === 'number' ? details.exitCode : undefined
      warn(`zeokeel-wasm-apps-host: the renderer process of an application window is gone (app=${appId}, reason=${reason}, exitCode=${String(details?.exitCode ?? '')})`)
      // U-03：应用窗口崩溃此前**只 warn** —— 线上"某个应用全公司打不开"平台侧零信号。
      // 上报与恢复解耦：正常收尾也上报（reason 进 tag），但只有真崩溃才恢复。
      clearLoadWatchdog(book)
      reportAppWindowError({
        type: 'render-process-gone',
        appId,
        windowKind: 'app',
        reason,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(book.desiredUrl === '' ? {} : { url: book.desiredUrl }),
      })
      if (reason === 'clean-exit' || reason === 'killed') return
      // 崩溃前发出的那次加载即使"成功"也不能算窗口好了（见 `loadSeq`）。
      book.loadSeq += 1
      void book.recovery.fail({ kind: 'render-process-gone', reason })
    })

    // 故障源 2：顶层文档加载失败。
    //
    // 第 5 参 `isMainFrame` 才是"顶层文档"的判据（Electron 的签名是
    // `(event, errorCode, errorDescription, validatedURL, isMainFrame, …)`）。子框架
    // 失败**只记一行**：应用页里一个 `<iframe>` 挂掉就重载整窗（第二次再换成失败页）
    // 会把用户的草稿与视图状态掀掉 —— shell 窗口那边为同一件事写过长注释（B-01）。
    // 防御性判空（只认严格 `true`）：旧/新 Electron 少给参数时宁可少一次自动恢复。
    //
    // `errorCode === -3`（ERR_ABORTED）是"被后续导航顶掉"，不是故障。
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const target = typeof validatedURL === 'string' ? validatedURL : ''
      if (isMainFrame !== true) {
        warn(`zeokeel-wasm-apps-host: a subframe failed to load in an application window (${String(errorCode)}: ${String(errorDescription)}) ${target}`)
        return
      }
      if (errorCode === -3) return
      warn(`zeokeel-wasm-apps-host: the main frame of an application window failed to load (${String(errorCode)}: ${String(errorDescription)}) ${target}`)
      // U-03：加载失败同样进上报链路（带 app_id）；恢复路径不受上报影响。
      clearLoadWatchdog(book)
      reportAppWindowError({
        type: 'did-fail-load',
        appId,
        windowKind: 'app',
        reason: `${String(errorCode)}: ${String(errorDescription)}`,
        ...(target === '' ? {} : { url: target }),
      })
      // 同上：这次失败作废所有在飞的加载结果（否则"导航失败但上一次加载成功"
      // 的结算顺序会把状态抹回健康）。
      book.loadSeq += 1
      void book.recovery.fail({ kind: 'did-fail-load', reason: `${String(errorCode)}: ${String(errorDescription)}` })
    })

    // 故障源 3：窗口卡死（无响应）。Electron 的 `unresponsive` 不是崩溃（进程还在、
    // 只是主线程被占住），所以**不**走恢复/重载 —— 静默重载会把用户没保存的草稿掀掉。
    // 它必须进上报链路：这是"某个应用偶尔卡住"唯一能到达平台侧的信号。
    win.webContents.on('unresponsive', () => {
      const current = win.isDestroyed() ? '' : win.webContents.getURL()
      warn(`zeokeel-wasm-apps-host: an application window became unresponsive (app=${appId})`)
      reportAppWindowError({
        type: 'unresponsive',
        appId,
        windowKind: 'app',
        reason: 'unresponsive',
        ...(current === '' ? {} : { url: current }),
      })
    })

    // 恢复的唯一判据："**应用文档**加载完成"。失败页自己也是 `did-finish-load`，
    // 但它是 `data:` 文档 ⇒ 不算（否则失败页一渲染出来就把 crashed 抹成 false，
    // 模型会以为窗口恢复了）。用户点失败页上的「重试」成功时走的就是这一条。
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return
      if (!isAppDocumentUrl(win.webContents.getURL())) return
      // U-01：应用文档真的到了 ⇒ 骨架阶段的看门狗功成身退。
      clearLoadWatchdog(book)
      book.appDocumentLoaded = true
      book.recovery.loaded()
    })

    // R16B-20：用户点窗口自己的关闭按钮 ⇒ Electron 销毁窗口并派发 `closed`；
    // 宿主此前收不到任何回调（只能靠 `isAlive()` 被动发现）。
    win.on('closed', () => {
      clearLoadWatchdog(book)
      for (const listener of book.closed) listener()
    })
    return book
  }

  return {
    createAppWindow(geometry) {
      // 分区先解析（非法值在这里就抛，不建窗）：窗口必须落在**插件指定的按用户分区**
      // 上，既与内置浏览器共用 cookie/存储，又不再与主窗口共享默认 session。
      const target = sessionForPartition(geometry.partition)
      const win = new BrowserWindow({
        width: geometry.width,
        height: geometry.height,
        x: geometry.x,
        y: geometry.y,
        minWidth: geometry.minimumWidth,
        minHeight: geometry.minimumHeight,
        title: geometry.title,
        // 先开窗（骨架屏），内容随后加载：§19 Q12 的"先开窗再加载"以窗口可见为准。
        show: true,
        // U-01：窗口底色跟随主题。此前写死 `#ffffff`，暗色主题下从建窗到骨架文档
        // 首次绘制的这一帧会闪一整屏白光（独立文档的 `prefers-color-scheme` 只能
        // 管文档内部，管不到文档出现之前的窗口底色）。
        backgroundColor: options.isDarkTheme?.() === true ? '#151517' : '#f5f6f8',
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // 应用窗口在前台/后台都可能被 AI 操作，别让后台节流冻住它。
          backgroundThrottling: false,
          // §7.2/R2S-8 冻结：应用窗口复用内置浏览器的**按用户分区**（分区名由插件显式
          // 传入，适配器不猜用户）。协议 handler / 权限守卫 / 请求闸门都注册在同一个
          // session 上（插件侧 `ensurePartition`），三处对上才不会出现
          // `ERR_UNKNOWN_URL_SCHEME` 或"守卫装在一个没人用的 session 上"。
          partition: geometry.partition,
          // 兜底：session 与 webPreferences 必须指向同一个分区（`session.fromPartition`
          // 是幂等的，这里只是把"两者同源"写成断言，防将来有人只改一处）。
          session: target,
          // U-03：与 shell 窗口**同一份**渲染错误 preload。应用窗口此前完全没有
          // preload ⇒ 页面里的未捕获错误一条都到不了主进程/Sentry。用每窗口 preload
          // 而不是 `session.setPreloads`：分区与内置浏览器共用，装到 session 上会
          // 连任意网页一起注入（覆盖面只需应用窗口）。
          ...(options.rendererErrorPreload === undefined || options.rendererErrorPreload === ''
            ? {}
            : { preload: options.rendererErrorPreload }),
        },
      })
      win.setMenuBarVisibility(false)
      // 标题恒为宿主给的 `<应用名> · <产品名>`：应用 HTML 的 `<title>` 不得改写它
      // （否则应用可以伪装成"设置""登录"等宿主界面）。
      win.on('page-title-updated', (event) => { event.preventDefault() })
      // 订阅必须在**第一次加载之前**挂好：崩溃可以发生在首帧（正是"首次加载失败"）。
      watchAppWindow(win, geometry.appId)
      const handle = remember(win)
      // U-01：第一次 `loadURL` 的目标是**骨架页**（在应用文档就绪前给出可读反馈），
      // 骨架真正画出来之后才加载应用文档。变异：把这里改回 `loadAppUrl(...)` ⇒
      // `electron-adapter.spec.ts` 的"首次加载目标是骨架"用例必红。
      void showLoadingSkeleton(win, geometry.appId, geometry.appLabel, geometry.url).then((ready) => {
        if (!ready) return
        void loadAppUrl(win, geometry.url)
        armLoadWatchdog(win, geometry.appId, geometry.url)
      })
      win.focus()
      return handle
    },
    focusAppWindow(handle, url) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      const current = win.webContents.getURL()
      if (current !== url) {
        void loadAppUrl(win, url)
      }
      // 最小化/隐藏状态下"聚焦"必须先把窗口带回来，否则用户点了打开却什么都没发生。
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
    },
    onAppWindowHealth(handle, listener) {
      const win = windowOf(handle)
      if (win === undefined) return
      const book = books.get(win)
      if (book === undefined) return
      book.health.add(listener)
      // 订阅即回报当前状态：崩溃可以发生在宿主订阅之前（建窗与订阅不是同一个调用），
      // 只报"变化"会让那一次崩溃永久不可见。
      listener({ crashed: book.recovery.crashed() })
    },
    onAppWindowClosed(handle, listener) {
      const win = windowOf(handle)
      if (win === undefined) return
      const book = books.get(win)
      if (book === undefined) return
      book.closed.add(listener)
      // 已经销毁的窗口（订阅晚于关窗）必须**立刻**回报，否则宿主要等到下一次
      // `isAlive()` 才发现 —— 那正是"幽灵 surface"的窗口期。
      if (win.isDestroyed()) listener()
    },
    closeAppWindow(handle) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      win.close()
    },
    setLoadTimeout(timeoutMs) {
      // 非正/非有限值一律忽略（保留原值），避免一处误配置把看门狗变成"立刻失败页"。
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return
      loadTimeoutMs = timeoutMs
    },
    showWindowNotice(handle, message) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      // U-06 / §5.1b：不静默强制刷新（应用可能有未保存的草稿）；提示条给「刷新」与
      // 「关闭」。注入失败不阻断任何宿主动作（提示是"告知"，不是许可）。
      try {
        const executor = (win.webContents as unknown as { executeJavaScript?: (code: string) => Promise<unknown> }).executeJavaScript
        if (typeof executor !== 'function') return
        const current = locale()
        void executor.call(win.webContents, appWindowUpdateNoticeScript({
          message,
          refresh: reloadAction(current),
          dismiss: dismissNoticeAction(current),
        })).catch(() => undefined)
      } catch { /* 提示失败不阻断应用 */ }
    },
    setNavigationAllowlist(urls) {
      allowedNavigations.clear()
      for (const url of urls) {
        if (typeof url === 'string' && url !== '') allowedNavigations.add(url)
      }
    },
    setAspectRatio(handle, ratio, extraSize) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      win.setAspectRatio(ratio, extraSize)
    },
    installAppWindowGuards(handle, appId) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return
      const contents = win.webContents
      /**
       * 导航闸门（**三处事件共用这一份判据**）：顶层与子框架都过
       * {@link classifyAppWindowNavigation}。
       * @param event - Electron 事件（`preventDefault` 即取消该次导航）。
       * @param url - 目标 URL。
       * @param isMainFrame - 是否顶层文档。
       */
      const refuse = (event: { preventDefault: () => void }, url: unknown, isMainFrame: boolean): void => {
        const verdict = classifyAppWindowNavigation(url, appId, appScheme, isMainFrame)
        if (verdict.verdict === 'allow') return
        // F-04：宿主自己渲染的会话过期页上有「重新登录」按钮 —— 那是**唯一**允许
        // 应用窗口导航到的跨 origin 目标（精确 URL，登录页）。不做成"放行 origin"：
        // 那会给应用页一条把窗口导航到客户端任意页面的路。
        if (isMainFrame && typeof url === 'string' && allowedNavigations.has(url)) return
        event.preventDefault()
        warn(`zeokeel-wasm-apps-host: refused a ${verdict.reason} navigation in an application window (app=${appId})`)
      }
      contents.on('will-navigate', (details) => { refuse(details, details.url, details.isMainFrame !== false) })
      contents.on('will-frame-navigate', (details) => {
        refuse(details, details.url, details.isMainFrame !== false)
      })
      // **重定向也要过同一道闸门**（2026-09-20 审计 P1-1）：`will-navigate` 只覆盖
      // 发起方直接发起的导航，302/303/307 是**服务端**发起的第二次导航 —— 只挂前两个
      // 钩子时，一次 302 就能把窗口换到外站或**另一个应用**的 origin（换壳）。时序上
      // `will-redirect` 在 `will-navigate` 之后、导航真正发生之前触发，
      // `preventDefault()` 取消的是整个导航（窗口留在原页面）。子框架的重定向同样
      // 走这里（`details.isMainFrame` 为假时按子框架规则判）。
      contents.on('will-redirect', (details) => { refuse(details, details.url, details.isMainFrame !== false) })
      /**
       * 刷新 / 返回（F-06）：应用窗口此前**两个动作都没有**（全包 grep
       * `reload()`/`goBack()` = 0），卡住或走进坏页面只能关窗重开。
       *
       * 返回走 `navigationHistory.goBack()`（Electron 32+ 的新面），旧面
       * `webContents.goBack()` 作为兜底 —— 两个都不在就静默（刷新仍然可用）。
       */
      const goBack = (): void => {
        if (win.isDestroyed()) return
        const nav = (contents as unknown as { navigationHistory?: { goBack?: () => void } }).navigationHistory
        if (typeof nav?.goBack === 'function') { nav.goBack(); return }
        const legacy = (contents as unknown as { goBack?: () => void }).goBack
        if (typeof legacy === 'function') legacy.call(contents)
      }
      const reload = (): void => {
        if (win.isDestroyed()) return
        contents.reload()
      }
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return
        const key = typeof input.key === 'string' ? input.key : ''
        const modified = input.control === true || input.meta === true
        if (modified && (key === 'r' || key === 'R')) { event.preventDefault(); reload(); return }
        if (modified && (key === '[' || key === 'ArrowLeft')) { event.preventDefault(); goBack(); return }
        // Alt+← 是浏览器习惯的第二条返回路径（Windows/Linux 上最常用）。
        if (input.alt === true && key === 'ArrowLeft') { event.preventDefault(); goBack() }
      })
      // 右键菜单：同两个动作的可发现面（没有自绘 chrome 时的最小替代）。
      contents.on('context-menu', () => {
        buildAppWindowMenu(win, locale(), { reload, back: goBack })
      })
      contents.setWindowOpenHandler((details) => {
        // §20.2：应用窗口不得弹窗。§19 Q9 的 UX 半边（F-05）：deny 必须**有反馈** ——
        // http(s) 外链给一条提示条（文案真源 `app-window-copy.ts` 的
        // `externalLinkNotice`，此前零消费方），否则用户点了链接什么都看不到。
        //
        // 为什么仍是 deny 而不是"转内置浏览器新标签"：本安装没有"打开一个浏览器标签"
        // 的宿主服务（`browserSurface` 只 provide 应用窗口 surface 的注册表），转标签
        // 需要产品先定那个服务面；在那之前"有反馈的 deny"既比静默 deny 好，也不会
        // 多开一个可被钓鱼的窗口。
        const target = typeof (details as { url?: unknown }).url === 'string' ? (details as { url: string }).url : ''
        const external = ((): URL | null => {
          try {
            return target === '' ? null : new URL(target)
          } catch {
            return null
          }
        })()
        if (external !== null && (external.protocol === 'http:' || external.protocol === 'https:')) {
          try {
            const executor = (contents as unknown as { executeJavaScript?: (code: string) => Promise<unknown> }).executeJavaScript
            if (typeof executor === 'function') {
              void executor.call(contents, appWindowNoticeScript(externalLinkNotice(locale(), external.host))).catch(() => undefined)
            }
          } catch { /* 提示失败不阻断 deny（与上面同一条取向） */ }
        }
        warn(`zeokeel-wasm-apps-host: refused a window.open from an application window (app=${appId})`)
        return { action: 'deny' }
      })
    },
    ensureSessionGuard(partition) {
      // 幂等（browser 包按 session 记）；这里再要求一次是**显式**保证：应用窗口可以
      // 在一张浏览器标签都没开过时创建（深链、应用中心直达）。
      //
      // 装的是**应用窗口真正落地的那个分区**（不是默认 session）：默认 session 上
      // 主窗口装着剪贴板白名单（desktop `electron-runtime.ts`），而 Electron 的
      // `setPermissionRequestHandler` 是 last-wins —— 装错 session 会一边保护不到应用
      // 窗口，一边静默废掉主窗口的剪贴板（2026-09-20 审计点名的无判据耦合）。
      ensureSessionGuard(sessionForPartition(partition) as unknown as NativeGuardSession)
    },
    webContentsId(handle) {
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return undefined
      return win.webContents.id
    },
    webContents(handle) {
      // surface 注册用（§16.1）：把**真实** webContents 交给 browser runtime 的 CDP
      // 附着路径。它是唯一能让 `browser_*` 工具真正驱动应用窗口的句柄 —— 只传 id
      // 是驱动不了的（CdpSession 要的是 webContents.debugger）。
      const win = windowOf(handle)
      if (win === undefined || win.isDestroyed()) return undefined
      return win.webContents
    },
    isAlive(handle) {
      const win = windowOf(handle)
      return win !== undefined && !win.isDestroyed()
    },
    workArea() {
      // 每次打开重新求值（多显示器）：鼠标所在显示器的工作区，取不到时回落主显示器。
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
      return { x: area.x, y: area.y, width: area.width, height: area.height }
    },
  }
}
