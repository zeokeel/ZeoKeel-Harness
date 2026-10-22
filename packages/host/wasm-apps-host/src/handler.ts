/**
 * 协议 handler：`zeokeel-app://<app_id>/<path>?<query>` → 平台 JSON 信封 →
 * Chromium `Response`（契约 §2 的五步，逐字实现）。
 *
 * 这一层**只做传输与身份注入**：
 *  - 它不判定准入、不读静态、不执行 wasm（那些全在服务端 `appserver.serveApp`）；
 *  - 身份唯一来源是 `ctx.zeokeelSession` 的员工令牌，以 `Authorization: Bearer`
 *    发给平台（**绝不**进信封 —— 信封会交给应用自己的请求管线）；
 *  - 它是本模型的**信任边界**：`Origin` 必须由它合成（§4.3：自定义协议下
 *    浏览器一个 Origin/Referer/Sec-Fetch-* 都不发），因此这里 fail-closed：
 *    畸形 URL / 超限体积 / 非信封响应一律给可读错误，绝不"尽力转发"。
 *
 * 依赖全部注入（`deps.fetch` / `deps.session` / `deps.clearSession`），所以本模块
 * 不 import electron、可在纯 Node 下单测。
 *
 * @module @zeokeel/dsh-wasm-apps-host/handler
 */

import {
  APP_METHODS,
  APP_REQUEST_BODY_MAX_BYTES,
  APP_REQUEST_PATH,
  APP_REQUEST_TIMEOUT_MS,
  APP_RESPONSE_BODY_MAX_BYTES,
  appOrigin,
  buildRequestEnvelope,
  decodeBase64Body,
  isHtmlResponse,
  parseAppUrl,
  parseResponseEnvelope,
  responseHeadersOf,
  wantsHtml,
} from './app-protocol.ts'
import {
  frozenAppHint,
  frozenAppTitle,
  missingAppTitle,
  retiredAppTitle,
} from './app-window-copy.ts'
import type { CacheConditionalResult, CacheEntryInput, CacheScope, CachedResponse } from './cache.ts'
import { securityHeaders } from './cache.ts'
import { hostCopy, type HostLocale } from './locale.ts'
import { AI_CHAT_BODY_MAX_BYTES, AI_CHAT_PATH, AI_CHAT_SSE_HEADERS, type AiChatOutcome } from './ai-chat.ts'
import { APP_PROOF_HEADER } from './app-proof.ts'
import { APP_VERSION_HEADER } from './open-gate.ts'
import { isReservedHostPath } from './host-request.ts'
// `normalizeServerURL` 2026-09-23 起只有一份实现（`server-url.ts`）：本文件原先那份与
// `open-gate.ts` / `window-catalog.ts` 里的逐字节相同。
import { normalizeServerURL } from './server-url.ts'
import {
  appErrorPage,
  invalidRequestPage,
  readPlatformError,
  retryLoginActions,
  sessionExpiredPage,
  signInRequiredPage,
} from './pages.ts'
import type { AppSession } from './session.ts'

/** handler 的注入依赖（全部可替身，便于单测）。 */
export interface AppSchemeHandlerDeps {
  /**
   * 本安装的应用源 scheme（渠道包 `desktop.app_origin_scheme`，组装期注入）。
   *
   * §7.8 冻结：**不在这里写死** `zeokeel-app`。它是 Origin 合成与 URL 校验的
   * 唯一依据，也是"别的渠道的链接进不来"的隔离面。
   */
  appOriginScheme: string
  /** 当前员工会话（探测式：缺席/残缺 = 未登录）。 */
  session: () => AppSession | null
  /** 出站 fetch（桌面适配器给 Chromium 栈；单测给假实现）。 */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** 平台返回 401 时清掉本地会话（与 enterprise 出站约定一致）。 */
  clearSession: () => void
  /**
   * 会话在**应用窗口里**过期时的通知（U-08，2026-10-22 评审）。
   *
   * 为什么需要它：`clearSession()` 会触发作用域清理，而清理链**同步**关掉全部应用
   * 窗口（§7.2）—— 于是刚渲染出来的「登录已过期」页连一帧都看不见，窗口直接消失；
   * 重登后也回不到那个应用。宿主拿到 `{appId, path}` 就能在清理时保留这一扇窗口，
   * 并在重登后把同一应用/路径再打开。
   *
   * 在 {@link clearSession} **之前**调用（宿主需要在会话事件到达时就知道"这是过期"）。
   * 缺席 ⇒ 行为与修前一致（只有页面，没有保留窗口）。
   */
  onSessionExpired?: ((expired: { appId: string, path: string }) => void) | undefined
  /** 宿主语言解析（**按调用**，禁止模块级冻结）。 */
  hostLocale: (acceptLanguage: string | null) => HostLocale
  /**
   * 客户端持有性证明（§20.1/§23.1）：`request` 与 `open` 都必须带
   * `X-ZeoKeel-App-Proof`。缺席（异常宿主/单测）⇒ 不带该头，平台会拒（fail-closed）。
   */
  appProof?: { get(appId: string, force?: boolean): Promise<string | null>, invalidate(): void } | undefined
  /** 应用 AI 桥（§21；本地处理 `/__zeokeel/ai/chat`，绝不转发平台）。缺席 ⇒ 503。 */
  aiChat?: ((appId: string, body: Uint8Array, signal: AbortSignal) => Promise<AiChatOutcome>) | undefined
  /**
   * 本机内容缓存（§7.5 / F11）。缺席 ⇒ 一律回源（**不是**"缓存坏了"，只是不缓存）。
   *
   * 只影响**静态子资源**：文档导航与 `/api/*` 永远回源（{@link AppSchemeCache.isStaticSubresource}
   * 是那条判据的唯一实现）—— 否则本地缓存会变成绕过准入/下架的第二入口。
   */
  cache?: AppSchemeCache | undefined
  /** 当前会话作用域（server+user 哈希；§7.5 R1-SEC-3）。缺席/未登录 ⇒ 不读不写缓存。 */
  cacheScope?: (() => CacheScope | undefined) | undefined
  /**
   * 某应用**当前已知的生效版本**（缓存键的第三段；唯一来源是平台响应头
   * `X-ZeoKeel-App-Version`，由打开校验记下）。未知 ⇒ 不读不写缓存
   * （拿一个猜出来的版本号当键 = 改版后继续发旧内容）。
   */
  cacheVersion?: ((appId: string) => string | undefined) | undefined
  /**
   * 客户端登录页 URL（F-04）：会话过期/未登录页上「重新登录」按钮的目标。
   *
   * 为什么不在这里拼：本机 webServer 的 origin 只有宿主（`index.ts`）知道（端口是
   * 动态绑定的），而 `pages.ts` 是纯模板。拿不到 ⇒ 不渲染那个按钮（渲染一个点了没
   * 反应的按钮比不渲染更糟 —— 那正是修前的形态）。
   */
  signInHref?: (() => string | undefined) | undefined
  /** 单次出站预算（毫秒）；缺省 {@link APP_REQUEST_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 诊断出口（缺省丢弃）。 */
  warn?: (message: string) => void
}

/**
 * 内容缓存的最小面（`cache.ts` 的 `WasmAppsCache` 满足它；单测给替身）。
 *
 * 为什么是结构化接口而不是直接依赖类：handler 的单测不该落盘；而"handler 真的调了
 * `get`/`put`/`conditional`"这件事必须能在不碰文件系统的前提下被打红（见
 * `handler.spec.ts` 的静态资源缓存用例）。
 */
export interface AppSchemeCache {
  get(scope: CacheScope, appId: string, version: string, path: string): Promise<CachedResponse | null>
  put(scope: CacheScope, entry: CacheEntryInput): Promise<void>
  conditional(scope: CacheScope, appId: string, version: string, path: string, ifNoneMatch: string | undefined): Promise<CacheConditionalResult>
  isStaticSubresource(path: string, headers: Record<string, string>): boolean
}

/** HTML 响应（本地页面）。 */
function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/** JSON 错误响应（应用自己的 fetch 读它；与平台信封同形）。 */
function jsonError(
  status: number,
  code: string,
  message: string,
  hints?: readonly string[],
): Response {
  const error: Record<string, unknown> = { code, message }
  if (hints !== undefined && hints.length > 0) error.hints = [...hints]
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * 构造协议 handler。
 * @param deps - 会话/出站/语言/诊断。
 * @returns `protocol.handle(APP_SCHEME, handler)` 用的处理函数。
 */
export function createAppSchemeHandler(
  deps: AppSchemeHandlerDeps,
): (request: Request) => Promise<Response> {
  const warn = deps.warn ?? ((): void => {})
  const timeoutMs = deps.timeoutMs ?? APP_REQUEST_TIMEOUT_MS
  /**
   * 本地错误/会话页的动作（F-04）：重试 = 重新发起**这一次**请求，重新登录 = 客户端
   * 登录页。重试目标用请求自身的 URL（协议 handler 会重新过闸门，会话恢复后同一条
   * 请求就能成功）。
   * @param request - 这次请求。
   * @returns 页面动作（拿不到登录页地址时只有重试）。
   */
  const pageActionsFor = (request: Request): { retryHref: string, signInHref?: string } => {
    const signIn = deps.signInHref?.()
    return {
      retryHref: request.url,
      ...(signIn === undefined || signIn === '' ? {} : { signInHref: signIn }),
    }
  }

  /**
   * 本地错误：文档导航给可读 HTML，应用自己的 fetch 给 JSON 信封。
   *
   * **导航页一定带动作**（F-04 / 反证审计 R-04）：修前只有 401 两页有「重试/重新登录」，
   * 而最常见的失败形态（编译失败、本地 DB 故障、405、平台信封 404/410/500）都是
   * `localError` 出来的页面 —— 用户看到的是一句"打不开"，却没有任何可点的东西，
   * 只能自己关窗回主窗口。重试目标就是**这一次请求的 URL**（协议 handler 会重新过
   * 闸门，瞬时故障/会话恢复后同一条请求就能成功；`<a>` 形态发出的是 GET，对错误页
   * 已经足够 —— 失败的那次请求本来就没有可重放的字节）。
   * @param request - 这次请求（重试目标来自它的 URL）。
   * @param locale - 宿主语言。
   * @param navigation - 是否文档导航（否则给 JSON 信封）。
   * @param options - 状态/码/文案。
   * @returns HTML 或 JSON 响应。
   */
  const localError = (
    request: Request,
    locale: HostLocale,
    navigation: boolean,
    options: {
      status: number
      code: string
      message: string
      hints?: readonly string[]
      detail?: string
      title?: string
    },
  ): Response => {
    if (!navigation) {
      return jsonError(options.status, options.code, options.message, options.hints)
    }
    return htmlResponse(options.status, appErrorPage(locale, {
      title: options.title ?? hostCopy(locale, '无法打开这个应用', 'This app cannot be opened'),
      message: options.message,
      ...(options.hints === undefined ? {} : { hints: options.hints }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      // F-04/R-04：错误页必须能自救 —— 重试（+ 会话拿得到时"重新登录"）。
      actions: retryLoginActions(locale, pageActionsFor(request)),
    }))
  }

  return async (request: Request): Promise<Response> => {
    const navigation = wantsHtml(request.headers)
    // 语言按**每次调用**解析（宿主语言可以在运行中改变）。
    const locale = deps.hostLocale(request.headers.get('accept-language'))
    const url = parseAppUrl(request.url, deps.appOriginScheme)
    if (url === null) {
      // 只记 pathname（query 可能带应用数据），且截断长度。
      const rawPath = (() => {
        try {
          return new URL(request.url).pathname.slice(0, 200)
        } catch {
          return ''
        }
      })()
      warn(`zeokeel-wasm-apps-host: refused a malformed app URL (${rawPath})`)
      return htmlResponse(400, invalidRequestPage(locale, `url=${rawPath}`))
    }
    const method = request.method.toUpperCase()
    if (!(APP_METHODS as readonly string[]).includes(method)) {
      warn(`zeokeel-wasm-apps-host: refused method ${method} for app ${url.appId}`)
      return localError(request, locale, navigation, {
        status: 405,
        code: 'METHOD_NOT_ALLOWED',
        message: hostCopy(locale, '不支持这个请求方法。', 'This request method is not supported.'),
        detail: `method=${method}`,
      })
    }
    if (method === 'OPTIONS') {
      // 自定义协议 corsEnabled:false ⇒ 不需要 CORS 预检；给一个明确答复，
      // 免得应用把 405 误读成"网关坏了"。
      return new Response(null, { status: 204, headers: { Allow: APP_METHODS.join(', ') } })
    }
    const session = deps.session()
    if (session === null) {
      // 契约 §2：一律要求登录，没有匿名面。这里给**可读页面**（不是空白页）。
      warn(`zeokeel-wasm-apps-host: refused ${url.appId} without a session`)
      return htmlResponse(401, signInRequiredPage(locale, pageActionsFor(request)))
    }

    // ---- `__zeokeel` 命名空间是**宿主保留面**：只有 AI 桥这一条路径存在 ----
    // §21.2 规则②③（R2-X-3）：其余 `__zeokeel/*` 一律 **404**，**绝不**当普通应用
    // 请求转发平台 —— 否则"保留路径"就成了一句空话（转发出去等于把宿主内部命名空间
    // 暴露成应用可探测/可打穿的面，且平台会把它当应用自己的路径处理）。
    //
    // R2-L2-3：**`/__zeokeel`（无尾斜杠）也是保留面**。只判 `startsWith('/__zeokeel/')`
    // 会把该形态漏进"普通应用请求"分支（转发平台）。判据集中在
    // {@link isReservedHostPath}，与服务端 `reservedPathPrefix` 的口径一致（两端一起改）。
    if (isReservedHostPath(url.path) && url.path !== AI_CHAT_PATH) {
      warn(`zeokeel-wasm-apps-host: refused a reserved host path (${url.path.slice(0, 80)})`)
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such host bridge' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    // ---- 应用 AI 桥（§21.2）：**保留路径，本地处理，绝不转发平台** ----
    if (url.path === AI_CHAT_PATH) {
      if (method !== 'POST') {
        return new Response(JSON.stringify({ error: { code: 'app_ai_invalid', message: 'POST is required for the AI bridge' } }), {
          status: 405,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      if (deps.aiChat === undefined) {
        return new Response(JSON.stringify({ error: { code: 'app_ai_unavailable', message: 'the application AI bridge is not available in this client' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      let aiBody: Uint8Array
      try {
        aiBody = new Uint8Array(await request.arrayBuffer())
      } catch {
        return new Response(JSON.stringify({ error: { code: 'app_ai_invalid', message: 'the request body is unreadable' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      // AI 桥的体量判据用**AI 自己的**上限（`AI_CHAT_BODY_MAX_BYTES` = 64 条 × 16 KiB
      // + 64 KiB 信封余量），不是通用应用请求的 1 MiB：后者恰好等于 contract 上限的
      // content 字节数，满额合法请求会被这里 413（反证审计 R-09）。
      if (aiBody.byteLength > AI_CHAT_BODY_MAX_BYTES) {
        return new Response(JSON.stringify({ error: { code: 'app_ai_invalid', message: 'the AI request body is too large' } }), {
          status: 413,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      }
      // 页面关闭 / 用户取消：把请求自身的 signal 传给 AI 桥（§21.6「页面关闭 ⇒ 该轮
      // 被 cancel，无孤儿循环」）。Electron 的 `Request.signal` 在导航离开/关闭时 abort。
      const outcome = await deps.aiChat(url.appId, aiBody, request.signal)
      return outcomeToResponse(outcome, request.signal)
    }

    // 体积闸门第一档：先看声明值，别把一个 100 MiB 的体读进内存。
    const declared = Number(request.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > APP_REQUEST_BODY_MAX_BYTES) {
      return htmlResponse(413, invalidRequestPage(locale, `content-length=${String(declared)}`))
    }

    // ---- 本机内容缓存（§7.5 / F11）：**读路径** ----
    //
    // 位置固定在"出站之前"：缓存命中就完全不出网（这是 F11 的性能承诺）。
    // 只对静态子资源生效 —— 判据在 `cache.isStaticSubresource`（`/api/*` 与文档导航
    // 一律回源，见那里的注释：本地缓存不得成为绕过准入/下架的第二入口）。
    // 缓存键的版本段**只能**来自平台响应头（打开校验记下的 `knownVersions`）；
    // 版本未知 ⇒ 整个读写路径跳过，绝不用猜出来的键。
    const cachePath = url.query === '' ? url.path : `${url.path}?${url.query}`
    const cacheVersion = deps.cacheVersion?.(url.appId)
    const cacheScope = deps.cacheScope?.()
    const cacheable = method === 'GET'
      && deps.cache !== undefined
      && typeof cacheVersion === 'string' && cacheVersion !== ''
      && cacheScope !== undefined
      && deps.cache.isStaticSubresource(cachePath, Object.fromEntries(request.headers))
    if (cacheable) {
      const ifNoneMatch = request.headers.get('if-none-match') ?? undefined
      if (ifNoneMatch !== undefined) {
        // 304 只在**本地已有同 ETag 的静态副本**时给（Chromium 据此直接用自己的副本，
        // 连 body 都不过协议边界）。判据的唯一实现在 cache.conditional。
        const conditional = await deps.cache!.conditional(cacheScope!, url.appId, cacheVersion!, cachePath, ifNoneMatch)
        if (conditional !== 'miss') {
          // 304 必须带**当前**宿主安全头（缓存里存的字节不含它们，见 cache.ts 的
          // securityHeaders 注释）；ETag 原样回显请求里的那个 —— `conditional` 已经
          // 保证它与我们存的那份逐字相同。
          return new Response(null, {
            status: 304,
            headers: { ...securityHeaders(), [APP_VERSION_HEADER]: cacheVersion!, ETag: ifNoneMatch },
          })
        }
      }
      const cached = await deps.cache!.get(cacheScope!, url.appId, cacheVersion!, cachePath)
      if (cached !== null) {
        return new Response(cached.body.byteLength === 0 ? null : new Uint8Array(cached.body), {
          status: cached.status,
          headers: { ...cached.headers, [APP_VERSION_HEADER]: cacheVersion! },
        })
      }
    }

    let body: Uint8Array
    try {
      body = new Uint8Array(await request.arrayBuffer())
    } catch (cause) {
      warn(`zeokeel-wasm-apps-host: reading the app request body failed (${cause instanceof Error ? cause.message : String(cause)})`)
      return htmlResponse(400, invalidRequestPage(locale, 'request body unreadable'))
    }
    const built = buildRequestEnvelope({ scheme: deps.appOriginScheme, url, method, headers: request.headers, body })
    if (!built.ok) {
      warn(`zeokeel-wasm-apps-host: refused an oversized app request (${built.reason} ${String(built.actual)} > ${String(built.limit)})`)
      return htmlResponse(413, invalidRequestPage(locale, `${built.reason}: ${String(built.actual)} > ${String(built.limit)}`))
    }

    const endpoint = `${normalizeServerURL(session.serverURL)}${APP_REQUEST_PATH}/${encodeURIComponent(url.appId)}/request`
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    /**
     * 出站预算**不依赖适配器是否尊重 AbortSignal**（Electron `net.fetch` 支持它，
     * 但那是实现细节）：与一个到点即 reject 的 promise 竞速，到点一定返回可读
     * 错误，而不是让应用页面永久转圈。
     */
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`app request budget exceeded (${String(timeoutMs)}ms)`))
      }, timeoutMs)
    })

    /**
     * 一次出站尝试：带 `X-ZeoKeel-App-Proof`（§20.1/§23.1：`request` 与 `open` 都带）。
     * @param forceProof - true 时强制重新签发（401 重签一次再重试）。
     * @returns 平台响应。
     */
    const attempt = async (forceProof: boolean): Promise<Response> => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // §4.3：Origin 由 handler 合成（信封里的 origin 同源同值）。
        Origin: appOrigin(deps.appOriginScheme, url.appId),
        Authorization: `Bearer ${session.token}`,
      }
      const proof = await deps.appProof?.get(url.appId, forceProof)
      if (typeof proof === 'string' && proof !== '') headers[APP_PROOF_HEADER] = proof
      const pending = deps.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(built.envelope),
        signal: controller.signal,
      })
      // 竞速落败的一方（超时后 abort 触发的迟到 rejection）必须被消费掉：宿主把
      // 未处理的 promise rejection 当致命错误（installFailLoud），一次超时不该
      // 让整个应用退出。
      pending.catch(() => {})
      return await Promise.race([pending, budget])
    }

    let upstream: Response
    try {
      upstream = await attempt(false)
      if (upstream.status === 401 && deps.appProof !== undefined) {
        // §20/§23.1 + R2-X-5：**只有 proof 失效**才重签（会话失效的 401 重签毫无意义，
        // 而且会让"会话过期"多绕一次往返才报出来）。判据 = 平台错误码前缀 `proof_`。
        const peek = await upstream.clone().text().catch(() => '')
        const code = readPlatformError((() => {
          try {
            return peek === '' ? undefined : JSON.parse(peek) as unknown
          } catch {
            return undefined
          }
        })())?.code ?? ''
        if (code.startsWith('proof_')) {
          deps.appProof.invalidate()
          upstream = await attempt(true)
        }
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      warn(`zeokeel-wasm-apps-host: gateway request for ${url.appId} failed (${detail})`)
      const timeout = controller.signal.aborted
      return localError(request, locale, navigation, {
        status: 502,
        code: timeout ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNAVAILABLE',
        message: hostCopy(
          locale,
          '暂时连不上服务端，请稍后重试。',
          'The server is unreachable right now; please try again later.',
        ),
        hints: hostCopy(
          locale,
          ['确认客户端已连接到公司服务器（可在设置里查看服务端地址）。'],
          ['Check that the client is connected to your company server (see Settings).'],
        ),
        detail,
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await upstream.text().catch(() => '')
    if (upstream.status === 401) {
      // 401 的两种来源必须分开：`proof_*` = 本机 proof 失效（重签已试过一次，仍失败
      // 说明是服务端不认这个安装/绑定），**不能**当成"会话过期"把用户踢下线；
      // 其余 401（`AUTH_REQUIRED`/`AUTH_FAILED`）= 会话失效，按既有约定清会话。
      const body = (() => {
        try {
          return text === '' ? undefined : JSON.parse(text) as unknown
        } catch {
          return undefined
        }
      })()
      const code = readPlatformError(body)?.code ?? ''
      if (code.startsWith('proof_')) {
        warn(`zeokeel-wasm-apps-host: the platform rejected the app proof for ${url.appId} (${code})`)
        return localError(request, locale, navigation, {
          status: 401,
          code,
          message: hostCopy(locale, '客户端证明无效，请重新登录后再试。', 'This client could not prove it is genuine; please sign in again and retry.'),
          hints: hostCopy(
            locale,
            ['若反复出现，请在客户端重新登录；仍不行请联系管理员。'],
            ['If this keeps happening, sign out and sign in again; contact your administrator if it persists.'],
          ),
          detail: `status=401 code=${code}`,
        })
      }
      // U-08：先把"哪一扇应用窗口、哪个路径"告诉宿主，再清会话 —— 清理链会同步关掉
      // 全部应用窗口，晚一步宿主就只剩一个已经消失的窗口 id（sessionExpiredPage 那
      // 张"能自救"的页在真实链路上永远不可达）。通知失败不阻断清会话（异常处理面
      // 绝不能反过来把会话留着）。
      try {
        deps.onSessionExpired?.({ appId: url.appId, path: url.path })
      } catch (cause) {
        warn(`zeokeel-wasm-apps-host: recording the expired application window failed (${cause instanceof Error ? cause.message : String(cause)})`)
      }
      // 与 enterprise 出站约定一致：401 清会话（渲染层的 tripwire 会回登录页）。
      deps.clearSession()
      warn(`zeokeel-wasm-apps-host: the platform rejected the session while serving ${url.appId}`)
      return htmlResponse(401, sessionExpiredPage(locale, pageActionsFor(request)))
    }
    let parsed: unknown
    try {
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    // ① 平台自己的业务错误信封（外层 HTTP 状态 ≥ 400）。
    const platformError = readPlatformError(parsed)
    if (!upstream.ok && platformError !== null) {
      // §19 Q3（R2-X-2）：三档文案**不得塌缩**。平台给 `reason=app_frozen` ⇒ 说"已被
      // 管理员停用"（不是"应用不存在"）；410 = 已下架；404 = 不存在。文案真源在
      // `app-window-copy.ts`（逐字断言在那里）。
      const reason = platformError.reason ?? ''
      const title = reason === 'app_frozen' || platformError.code === 'app_frozen'
        ? frozenAppTitle(locale)
        : upstream.status === 410
          ? retiredAppTitle(locale)
          : upstream.status === 404
            ? missingAppTitle(locale)
            : undefined
      const extraHints = reason === 'app_frozen' ? [frozenAppHint(locale)] : undefined
      return localError(request, locale, navigation, {
        status: upstream.status,
        code: platformError.code,
        ...(title === undefined ? {} : { title }),
        // 冻结时**不**回显平台的英文/技术 message：可辨文案优先（用户看到的必须是"被停用"）。
        message: title === undefined ? platformError.message : title,
        ...(platformError.hints === undefined && extraHints === undefined
          ? {}
          : { hints: [...(platformError.hints ?? []), ...(extraHints ?? [])] }),
        detail: `status=${String(upstream.status)} code=${platformError.code}${reason === '' ? '' : ` reason=${reason}`}`,
      })
    }
    // ② 响应信封（§4.2）。
    const envelope = parseResponseEnvelope(parsed)
    if (!envelope.ok) {
      warn(`zeokeel-wasm-apps-host: invalid platform response for ${url.appId} (${envelope.reason})`)
      return localError(request, locale, navigation, {
        status: 502,
        code: 'INVALID_PLATFORM_RESPONSE',
        message: hostCopy(locale, '服务端返回了无法识别的响应。', 'The server returned a response this client cannot read.'),
        hints: hostCopy(
          locale,
          ['客户端与服务端必须同版本升级（旧客户端无法再打开应用）。'],
          ['The client and the server must be upgraded to the same version (older clients can no longer open apps).'],
        ),
        detail: `status=${String(upstream.status)} ${envelope.reason}`,
      })
    }
    if (!upstream.ok) {
      // 外层非 2xx 但体是合法信封：按平台错误呈现（不回给渲染器一个"成功页面"）。
      return localError(request, locale, navigation, {
        status: upstream.status,
        code: 'PLATFORM_ERROR',
        message: hostCopy(locale, '服务端拒绝了这次请求。', 'The server rejected this request.'),
        detail: `status=${String(upstream.status)}`,
      })
    }
    const bytes = decodeBase64Body(envelope.envelope.body)
    if (bytes === null) {
      warn(`zeokeel-wasm-apps-host: undecodable base64 body for ${url.appId}`)
      return localError(request, locale, navigation, {
        status: 502,
        code: 'INVALID_PLATFORM_RESPONSE',
        message: hostCopy(locale, '服务端返回了无法识别的响应。', 'The server returned a response this client cannot read.'),
        detail: 'body is not valid base64',
      })
    }
    if (envelope.envelope.truncated) {
      // §5.1 / R2S-10 冻结：兜底截断**不得**当成功交给渲染器 —— 截断的字节不是
      // 应用要的页面（半截 HTML 会渲染成乱码、半截 JSON 会解析失败），按 502/
      // `INVALID_PLATFORM_RESPONSE` 处理并给出可读错误页。
      warn(`zeokeel-wasm-apps-host: the platform truncated the response body for ${url.appId}`)
      return localError(request, locale, navigation, {
        status: 502,
        code: 'INVALID_PLATFORM_RESPONSE',
        message: hostCopy(locale, '响应体不完整，已中止本次加载。', 'The response was incomplete, so this load was aborted.'),
        hints: hostCopy(
          locale,
          ['这通常是应用返回了过大的内容；请联系应用负责人。'],
          ['This usually means the app returned too much data; please contact the app owner.'],
        ),
        detail: 'truncated=true',
      })
    }
    const headers = responseHeadersOf(envelope.envelope.headers)
    const status = envelope.envelope.status
    let payload = bytes
    // 兜底截断（权威上限在服务端：超限整单失败；这里只保证不会把超过 8 MiB
    // 的字节交给渲染器）。
    let locallyTruncated = false
    if (payload.byteLength > APP_RESPONSE_BODY_MAX_BYTES) {
      warn(`zeokeel-wasm-apps-host: truncating a ${String(payload.byteLength)}-byte response for ${url.appId}`)
      payload = payload.subarray(0, APP_RESPONSE_BODY_MAX_BYTES)
      locallyTruncated = true
    }
    // ③ 应用自己的错误体 + 文档导航 ⇒ 渲染成可读页面（否则用户看到的是一屏裸 JSON）。
    if (status >= 400 && navigation && !isHtmlResponse(headers)) {
      const inner = readPlatformError(safeJson(payload))
      return htmlResponse(status, appErrorPage(locale, {
        title: hostCopy(locale, '应用返回了错误', 'The app returned an error'),
        message: inner?.message ?? hostCopy(locale, '应用无法处理这次请求。', 'The app could not handle this request.'),
        ...(inner?.hints === undefined ? {} : { hints: inner.hints }),
        detail: `status=${String(status)}${inner === null ? '' : ` code=${inner.code}`}`,
        // F-04/R-04：平台信封错误页（404「应用不存在」/410「已下架」/500）同样给动作 ——
        // 这一档是用户最常撞到的页面，修前它与 401 两页的唯一区别就是"没有按钮"。
        actions: retryLoginActions(locale, pageActionsFor(request)),
      }))
    }
    const bodyAllowed = method !== 'HEAD' && status !== 204 && status !== 304
    // ---- 本机内容缓存（§7.5 / F11）：**写路径** ----
    //
    // 写判据与读判据**必须同源**，但用**响应头**判形态：路径像 `.json` 而响应是
    // `text/html`（准入/错误页！）时，按响应头判会拒绝缓存 —— 这正是"文档导航与
    // 错误页永不进缓存"这条规则的落点。`put` 自身还会再挡 no-store / 非 2xx /
    // 超容量（三处判据都在 cache.ts，一处实现）。
    const responseHeaders: Record<string, string> = {}
    for (const [name, value] of headers) responseHeaders[name] = value
    if (cacheable && bodyAllowed && !locallyTruncated && status >= 200 && status < 300
      && deps.cache!.isStaticSubresource(cachePath, responseHeaders)) {
      await deps.cache!.put(cacheScope!, {
        appId: url.appId,
        version: cacheVersion!,
        path: cachePath,
        body: new Uint8Array(payload),
        headers: responseHeaders,
        status,
      })
    }
    // 版本头（§5.1 / DAT-12）：即使平台没在信封头里给（旧服务端），只要宿主知道
    // 当前生效版本就补上 —— 它是客户端缓存键的唯一来源，缺了它客户端只能当"未知"。
    if (status >= 200 && status < 300 && typeof cacheVersion === 'string' && cacheVersion !== '') {
      headers.set(APP_VERSION_HEADER, cacheVersion)
    }
    // 拷进一个独立的 ArrayBuffer：`decodeBase64Body` 返回的是 Node Buffer 池上的
    // 视图（`payload.buffer` 比视图大，且类型上是 `ArrayBufferLike`），直接交给
    // `Response` 既会带上别的字节、也过不了 `BodyInit` 的类型面。
    return new Response(bodyAllowed ? new Uint8Array(payload) : null, { status, headers })
  }
}

/** 尽力把字节解析成 JSON（失败给 undefined）。 */
function safeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return undefined
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 把 AI 桥的处理结果变成 `Response`（§21.2：非流式 JSON / 流式 SSE）。
 * @param outcome - 桥的结论。
 * @param signal - 页面请求的取消信号（关闭页面 ⇒ 流自然结束）。
 * @returns Chromium `Response`。
 */
function outcomeToResponse(outcome: AiChatOutcome, signal: AbortSignal): Response {
  if (outcome.kind === 'json') {
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of outcome.frames) {
          if (signal.aborted) break
          controller.enqueue(encoder.encode(frame))
        }
      } catch {
        // 帧生成失败：连接已建立，只能结束（错误帧由生成器负责发）。
      } finally {
        try {
          controller.close()
        } catch {
          // 已经关闭（页面在期间离开）：忽略。
        }
      }
    },
  })
  return new Response(stream, { status: 200, headers: { ...AI_CHAT_SSE_HEADERS } })
}
