/**
 * 在**客户端内**打开一个 WASM 应用（冻结契约
 * `docs/decisions/2026-09-19-wasm-client-internal-origin.md` §1/§4.5）。
 *
 * 应用只有一种打开方式：桌面客户端注册的自定义协议
 * `<app-origin-scheme>://<app_id>/`。因此本模块**没有** http(s) 入口链接、**没有**系统
 * 浏览器兜底（契约 §5 的删除清单）—— 那两条路是结构性错误，不是"暂时禁用"：
 * 服务端已不再下发 `entry_url`，应用也没有可贴进浏览器的地址。
 *
 * ## scheme 是**运行期**的渠道变量（CHN-2 / R2I-15 / UX-2）
 *
 * scheme 由渠道包 `desktop.app_origin_scheme` 决定（官方与每个品牌渠道各不相同），
 * 客户端 bundle 读不到渠道包 ⇒ 它来自宿主的本机只读路由
 * `GET /api/zeokeel/wasm-apps/channel`（`channel-seam.ts`）。本模块**不再有**写死的
 * `APP_PROTOCOL` 常量：拿不到 scheme 就当"还开不了"，给一个可辨的 reason
 * （{@link OpenFailureReason} 的 `scheme-unavailable`）并**一次请求都不发**。
 *
 * 客户端这一侧只做一件事：调**本机路由**（冻结接口，C3 实现）
 *
 * ```
 * POST /api/zeokeel/wasm-apps/open     body: {"app_id":"<app_id>"}
 *   → 200 {"url":"<app-origin-scheme>://<app_id>/", "opens":{"today":{"pv":N,"uv":M}}?}
 * ```
 *
 * 由宿主确保协议 handler 与分区就绪，并把该应用交给它自己的**独立窗口**加载；URL **由本机按
 * app_id 拼**，不接受调用方传入。本模块不复制任何服务端/协议逻辑（准入、静态、
 * 执行都在别处），只做五件事：本地预检、发一次请求、把失败翻译成**机器可读的
 * reason**、断言成功返回的是不是那个协议 URL、把 F16 的打开计数读出来。
 *
 * ## 持有性证明（**请求头**机制，2026-09-20 P0 订正）
 *
 * 本机写面要求 **`X-ZeoKeel-Host-Proof` 请求头**（宿主 seam 的实现，见
 * `packages/host/wasm-apps-host/src/host-request.ts` 与 §22.2 R2）：渲染层先用
 * `GET /api/zeokeel/wasm-apps/host-proof` 引导一枚短时令牌（内存持有），再在每个本机调用上
 * 带着它。**不是** cookie 机制 —— 旧注释写的"证明随同源 cookie 自动发出"是错的
 * （那是上一版 `write-proof.ts` 的形态，改成请求头正是 R2 的要求：零端口下没有
 * Cookie/Host/Origin/端口）。
 *
 * 由此三条推论写进了实现：
 *  - **拿不到令牌 ⇒ 不发请求**（发出去必然 401，还会把"证明没拿到"掩盖成"接口拒绝"）
 *    ⇒ reason `host-proof-unavailable`；
 *  - 调用回来 401 且错误码是 `proof_*` ⇒ **强制重取一枚令牌并重放一次**（只一次，
 *    绝不无限重试）；
 *  - 页面侧仍保留一条**形态预检**（{@link pageHoldsWriteProof}）：应用页/`file:`/`data:`
 *    文档根本不可能持有本机会话，这时一次请求都不发。
 *
 * ## 平台侧的 app-proof（§20/§23）与"客户端不重试"
 *
 * 平台端点 `request` / `open` 都要求 `X-ZeoKeel-App-Proof`
 * （{@link APP_PROOF_HEADER}，值由宿主持有并**只存内存**：客户端半边不持 bearer、
 * 也不签发 proof）。因此本模块：①发的是**本机**路由（宿主自己给平台请求带上 proof）；
 * ②**永不重试**：401 只翻译成 `not-signed-in`（会话过期/被吊销交给宿主与重登流程），
 * 不在这里静默重发、不自己续签 —— 重试与续签的落点是宿主层（§23.1）。
 *
 * ## 结果形态
 *
 * `{ok:true,url,counts?}` 或 `{ok:false,reason,error}`。`reason` 是稳定判据（UI 据此选文案、
 * 测试据此断言），`error` 是英文诊断细节（面向维护者；用户可见文案由面板从字典取）。
 * **成功时断言的是协议 URL 本身**（scheme 必须等于本安装的应用 origin scheme、host 必须
 * 等于请求的 app_id）—— 退回"fetch 没抛错就算打开"就是存在性断言，正是本仓点名的
 * 假绿形态。
 *
 * @module @zeokeel/dsh-wasm-apps/client/open-app
 */

import { APP_ID_MAX_LENGTH, APP_ID_PATTERN } from './appcfg-contract.ts'
import { appOriginProtocol, refreshAppChannel } from './channel-seam.ts'
import {
  ensureHostProof,
  fetchWithHostProof,
  hostProofFailure,
  isHostProofErrorCode,
  readHostErrorCode,
  readHostPlatformReason,
  readHostPlatformRefusal,
  // `readJsonQuietly` 2026-09-23 起只有一份实现（`host-proof.ts`）；本文件原先那份与它
  // 逐字节相同，属三份重复之一（另见 `channel-seam.ts`）。
  readJsonQuietly,
  PLATFORM_APP_FROZEN_REASON,
  PLATFORM_NO_RELEASE_REASON,
} from './host-proof.ts'

/**
 * 本机打开路由（**冻结接口**：契约 §5.2 的表格；与 C3 的 `/api/zeokeel/wasm-apps`
 * 前缀路由逐字一致，两端不得各写一份路径）。
 *
 * 它是**路径**而不是渠道变量（§22.2 R1 的 `hostRequestSurface` seam：今天映射到
 * loopback 的 `ctx.webServer.register`，将来映射到零端口的宿主请求通道，路径不变），
 * 所以这里保留字面量常量 —— 与宿主常量的跨包对拍在
 * `packages/host/desktop/tests/wasm-app-open-route-parity.spec.ts`。
 * 会随渠道变的是 **scheme**（见模块注释），不是这条路径。
 */
export const OPEN_APP_PATH = '/api/zeokeel/wasm-apps/open'

/**
 * 平台 app-proof 头名（§20.1/§23.1 冻结）。
 *
 * 这个头**不由客户端设置**：值是宿主内存里的短时证明，客户端半边既不持 bearer 也不
 * 签发 proof（§5.1b：谁调用 = 宿主的本机打开路由）。这里导出它，是为了让"客户端这一侧
 * 没有第二份拼装点"可被断言（用例同时断言本模块源码里不出现它）。
 */
export const APP_PROOF_HEADER = 'X-ZeoKeel-App-Proof'

/** 失败原因（机器可读；UI 与用例都按它分派，不要匹配 message 文本）。 */
export type OpenFailureReason =
  /** 本地预检就否掉了 app_id（形态不对）⇒ 一次请求都没发。 */
  | 'invalid-app-id'
  /** 本页面不可能持有写面证明（应用页/本地文档）⇒ 一次请求都没发。 */
  | 'proof-unavailable'
  /** 本机持有性令牌没拿到（引导 403/503/网络）⇒ **一次业务请求都没发**。 */
  | 'host-proof-unavailable'
  /**
   * 还没拿到本安装的应用 origin scheme（宿主只读路由未就绪 / 响应非法）
   * ⇒ 一次请求都没发（CHN-2：scheme 是渠道变量，猜不得）。
   */
  | 'scheme-unavailable'
  /** 客户端未登录（本机路由 401 AUTH_REQUIRED）。 */
  | 'not-signed-in'
  /**
   * 本机路由 401 `proof_required`：**本机证明闸**拒绝了我们的令牌
   * （重取令牌重放一次后仍然如此）。请求**发出去了** —— 文案不得说"没有发出请求"。
   */
  | 'proof-required'
  /** 本机路由 401 `proof_expired`（重取令牌重放一次后仍然如此）。 */
  | 'proof-expired'
  /**
   * **平台**（服务端）拒绝了这次打开（宿主信封的 `PLATFORM_*` 码，如
   * `PLATFORM_PROOF_REQUIRED`）。
   *
   * 为什么必须与 `proof-required` 分开：两层用**同名**的证明码，但语义与下一步
   * 完全不同 —— 本机码是客户端本机服务的凭据问题，平台码是服务端拒绝了这次调用
   * （客户端没能向服务端证明自己 / 登录态失效 / 应用被下架…）。混在一起会把一次
   * 平台拒绝显示成"本页面无法证明自己属于这个客户端窗口"（2026-09-20 真实故障的
   * 误归因现场）。
   */
  | 'platform-refused'
  /**
   * 平台说这个应用**被管理员冻结**（只读快照：数据仍然保留，但不能继续使用）。
   *
   * 为什么必须与 `app-not-found` 分开：平台为了不泄露存在性，把「冻结」与
   * 「软删 / 从未登记」放进**同一个 HTTP 404 + 同一个 `NOT_FOUND`**，唯一区分凭据是
   * 信封里的 `platform_reason`。不读它就等于把"被管理员停用（数据还在）"显示成
   * "这个应用不存在（可能已被删除或改名）" —— 用户会去重新要一个根本不存在的
   * 新应用，维护者也不会去看停用记录（本缺陷的现场）。
   */
  | 'app-frozen'
  /** 本机路由 404 / 平台 404 `app_not_found`：应用不存在（已被软删 / 从未登记）。 */
  | 'app-not-found'
  /**
   * 平台 410：这个应用**已下架**（发布者主动下架，数据仍然保留、可恢复）。
   *
   * 2026-10-23 U-04：修前 410 与"还没有可用版本"一起被归成 `app-not-found`，
   * 用户被告知"这个应用不存在（可能已被删除或改名）"，而目录里它明明还挂着
   * 「已下架」徽章 —— 这正是验收 §1.2 点名要避免的"把可恢复显示成应用没了"。
   * 下架是**可逆**的发布者动作：文案必须说"已下架、数据仍在、可联系管理员恢复"，
   * 不能再说"不存在"。
   */
  | 'app-offline'
  /**
   * 应用**已登记但还没有可用版本**（平台 404，且没有 `app_not_found` 理由）。
   *
   * 服务端 `open.go` 的几个 404 只有 `details.reason` 能分开：未登记/软删带
   * `reason=app_not_found`，冻结带 `reason=app_frozen`，而"还没有可用版本"那一支
   * （首版待审 / 被拒 / 审核通过但部署还没生效）**不带 reason** —— 所以
   * `status=404 + reason=null` 在今天的服务端只有一个含义：应用在、版本还没上线。
   * 说成"应用不存在"会让作者以为自己的应用被删了（U-02/U-04 同源）。
   */
  | 'no-release'
  /**
   * **平台暂时不可用**（平台侧 500/502/503，或宿主"无法确认应用版本"的 502）。
   *
   * 2026-10-23 U-04：修前落进 `unexpected-response` —— 文案说"客户端本机服务的响应
   * 与预期不一致…通常是客户端与服务端版本不一致"，把一次**重试就好**的平台抖动
   * （DB 短暂不可达、网关 502）指成了"去升级客户端"。这一档必须说"暂时不可用 +
   * 稍后重试"，不得暗示版本不一致。
   */
  | 'platform-unavailable'
  /**
   * **账号无权限**（平台 403：审计/受限账号、不在白名单里的账号）。
   *
   * 2026-10-23 U-04：修前 403 与 401 一起映射成 `not-signed-in`（"尚未登录，请先
   * 登录"）—— 审计账号登录多少次都不会通过，用户被指去做一件永远无效的事。
   * 401（未登录/会话过期）与 403（已登录、但这个账号被挡）必须分开。
   */
  | 'not-permitted'
  /** 本机路由 503：协议 handler / 分区还没就绪（不降级到浏览器）。 */
  | 'protocol-not-ready'
  /** 请求没到达宿主（网络层失败 / 宿主未启动）。 */
  | 'host-unreachable'
  /** 响应形状不是冻结接口承诺的那一个（含非 2xx 的其它状态码）。 */
  | 'unexpected-response'

/**
 * F16 的打开计数（服务端 `open` 端点在同一次调用里记账并回传）。
 *
 * 形状冻结在客户端这一侧：`{"opens":{"today":{"pv":N,"uv":M}}}`。**没有**它就是"服务端
 * 这一版还没给计数" ⇒ 界面不显示这一行（绝不拿别处的数字凑）。
 */
export interface AppOpenCounts {
  /** 今日打开次数（PV 式，每次打开 +1）。 */
  todayPv: number
  /** 今日打开人数（按 user 去重）。 */
  todayUv: number
}

/** 本机对"这次打开究竟做了什么"的回答（§5.2 冻结字段 `window`）。 */
export type OpenWindowOutcome = 'opened' | 'focused'

/** 打开成功：`url` 是本机确认的协议 URL。 */
export interface OpenSuccess {
  ok: true
  /** `<app-origin-scheme>://<app_id>/`（由本机返回，客户端只读不改）。 */
  url: string
  /** 本次调用记账后的今日打开计数；服务端未下发 ⇒ `undefined`（不编造）。 */
  counts?: AppOpenCounts
  /**
   * 本机开了新窗口（`opened`）还是聚焦了已有窗口（`focused`）。
   * 服务端未下发该字段 ⇒ `undefined`（界面就不说"已打开/已聚焦"）。
   */
  window?: OpenWindowOutcome
  /**
   * 软闸门结论（F-04，2026-10-22 审计）：宿主在"聚焦已开窗口、但平台版本暂时确认不了"
   * 时下发 `version-unverified`。
   *
   * 修前这个字段**产出了却没人读**（宿主 `requestOpen` 的 `warning`），用户看到的是
   * "静默显示旧内容"——不知道可能不是最新版。界面据此显示提示条（文案见
   * `appCenter.versionUnverified`，与宿主 `app-window-copy.ts` 同一句话）。
   */
  warning?: OpenWarning
}

/** 软闸门结论（目前只有一种；形状随宿主冻结字段增长时在这里加）。 */
export type OpenWarning = 'version-unverified'

/** 打开失败：`reason` 决定 UI 文案，`error` 是诊断细节。 */
export interface OpenFailure {
  ok: false
  reason: OpenFailureReason
  error: string
  /** HTTP 状态；`null` = 请求根本没到达宿主。 */
  status: number | null
  /**
   * 失败时拿到的**原始错误码**（宿主/平台信封的 `code`，如 `PLATFORM_NOT_FOUND`、
   * `OPEN_CHECK_FAILED`、`AUTH_REQUIRED`）；拿不到就是 `undefined`。
   *
   * 与 `reason` 分开保存的理由（U-04 的"错误上报保留原始 status/code"）：`reason`
   * 是给 UI 选文案的**类目**，`status`/`code` 是排障用的**事实** —— 上报里只有中文
   * 文案等于把原始信号丢掉，维护者无法把一次"平台 500"对回日志。
   */
  code?: string
}

/** {@link openAppEntry} 的结果。 */
export type OpenResult = OpenSuccess | OpenFailure

/** 可注入副作用（测试与 UI 共用同一条实现）。 */
export interface OpenAppDeps {
  fetch: typeof fetch
  /**
   * 页面侧可判定的"本页面不可能持有写面证明"判据（缺省
   * {@link pageHoldsWriteProof}）。返回 false 时**不发请求**。
   */
  holdsWriteProof: () => boolean
  /**
   * 本安装的应用协议前缀（缺省 {@link appOriginProtocol}，即渠道 seam 的注入值）。
   * 返回 `null` ⇒ `scheme-unavailable`（不发请求）。
   */
  protocol?: () => string | null
  /**
   * scheme 还没拿到时的**一次**补齐机会（缺省取一次宿主渠道路由）。缺席或仍拿不到
   * ⇒ `scheme-unavailable`。
   */
  ensureChannel?: () => Promise<unknown>
}

/** 默认依赖：真实 `fetch` + 页面 scheme 判据 + 渠道 seam。 */
function defaultDeps(): OpenAppDeps {
  return {
    fetch: (...args) => fetch(...args),
    holdsWriteProof: () => pageHoldsWriteProof(),
    protocol: () => appOriginProtocol(),
    ensureChannel: () => refreshAppChannel(),
  }
}

/**
 * 这个页面是否**可能**持有本机写面的持有性证明。
 *
 * 判据只有一条：文档是不是由本机宿主服务的 http(s) 页面。HttpOnly cookie 本身读不到，
 * 所以这里刻意**不**假装能验证证明 —— 它只拦下**明确不可能**持有证明的文档：
 *
 *  - 应用页自己（`<本安装的 app scheme>://…`）：协议页面没有 http(s) origin，也不该有能力驱动
 *    客户端的本机写面（契约 §3 的隔离实测）；
 *  - `file:` / `data:` / `blob:` 等本地文档：没有宿主服务，也就没有证明。
 *
 * 其余情况（正常的桌面客户端窗口 / `dsh web` 页面）交给服务端的证明闸判定，403 与
 * 503 分别是 `proof-required` 与 `protocol-not-ready`。
 * @param page - 只用到 `protocol` 的文档位置（缺省取 `window.location`）。
 * @returns true = 可以发请求（证明是否存在由服务端裁决）。
 */
export function pageHoldsWriteProof(
  page: { protocol?: unknown } | undefined = typeof window === 'undefined' ? undefined : window.location,
): boolean {
  const protocol = typeof page?.protocol === 'string' ? page.protocol : ''
  return protocol === 'http:' || protocol === 'https:'
}

/**
 * 校验 App 协议 URL 是否是"这个 app 的入口"。
 *
 * 冻结接口承诺 `<本安装的 app origin scheme>://<app_id>/`：scheme 必须**等于本安装的
 * 渠道 scheme**（`protocol`；不是任何写死的常量），host 必须**等于**请求的 app_id
 * （返回别的应用 = 本机拼错了，客户端不得替它圆场）。
 * @param raw - 本机路由返回的 `url`。
 * @param appId - 本次请求的 app_id。
 * @param protocol - 本安装的应用协议前缀；`null`/缺省时取渠道 seam 的注入值。
 * @returns 规范化后的 URL，或 null（形状不对）。
 */
export function parseAppProtocolURL(
  raw: unknown,
  appId: string,
  protocol: string | null = appOriginProtocol(),
): string | null {
  if (protocol === null || protocol === '') return null
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== protocol) return null
  if (url.hostname === '' || url.hostname !== appId) return null
  return url.toString()
}

/**
 * 从成功响应里读 F16 的打开计数。
 *
 * 单一权威形状（见 {@link AppOpenCounts}）：`{"opens":{"today":{"pv":N,"uv":M}}}`。
 * 任何一个数字缺失/非法/为负 ⇒ 整块读作"没有"（`undefined`）—— 半块计数（只有 pv 没有
 * uv）渲染出来只会让人以为数据是真的。
 * @param payload - `open` 路由的响应体。
 * @returns 计数，或 `null`（服务端未下发 / 形状不符）。
 */
export function parseAppOpenCounts(payload: unknown): AppOpenCounts | null {
  if (payload === null || typeof payload !== 'object') return null
  const opens = (payload as { opens?: unknown }).opens
  if (opens === null || typeof opens !== 'object') return null
  const today = (opens as { today?: unknown }).today
  if (today === null || typeof today !== 'object') return null
  const pv = (today as { pv?: unknown }).pv
  const uv = (today as { uv?: unknown }).uv
  if (!isCount(pv) || !isCount(uv)) return null
  return { todayPv: pv, todayUv: uv }
}

/**
 * 从成功响应里读 §5.2 的 `window` 字段。
 * @param payload - `open` 路由的响应体。
 * @returns `'opened' | 'focused'`；缺席 / 取值不认识 ⇒ `null`（不猜）。
 */
export function parseOpenWindow(payload: unknown): OpenWindowOutcome | null {
  const value = (payload as { window?: unknown } | null)?.window
  return value === 'opened' || value === 'focused' ? value : null
}

/**
 * 从成功响应里读软闸门结论（F-04）。
 *
 * 只认**已知取值**：未知的 warning 串按"没有结论"处理（`undefined`）——拿一个不认识
 * 的码去查字典会显示空白提示条，那比不显示更糟。
 * @param payload - `open` 路由的响应体。
 * @returns 已知的结论，或 `null`。
 */
export function parseOpenWarning(payload: unknown): OpenWarning | null {
  const value = (payload as { warning?: unknown } | null)?.warning
  return value === 'version-unverified' ? value : null
}

/**
 * 计数是不是一个合法的非负整数。
 * @param value - 响应里的原始值。
 * @returns true = 可用作计数。
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 本机路由失败状态 → reason（冻结接口只定义了 401/400/503，其余按语义就近归属）。
 *
 * 401 的两义性在调用点已经分流：`proof_*` ⇒ `proof-required|proof-expired`；
 * 其余 401（宿主的 `AUTH_REQUIRED`）⇒ `not-signed-in`。所以这里保持最保守的映射。
 *
 * **本机 403 不是"账号没权限"**（U-04 的边界）：本机路由的 403 只来自本机证明闸
 * （`proof` 校验），账号级 403 走的是平台信封（`PLATFORM_*`）那一支，由
 * {@link reasonForPlatformRefusal} 归成 `not-permitted`。两条不能混。
 *
 * **`502` 也不再说"版本不一致"**（U-04）：宿主用 502 `OPEN_CHECK_FAILED` 表达
 * "平台版本确认不了"（`index.ts` 的闸门 `unreachable` 分支）—— 那是**平台/网络**
 * 暂时不可用，正确下一步是重试。修前它落进 `unexpected-response`（提示"升级客户端"）。
 * 本机 500 没有定义语义（宿主不发它）⇒ 仍按"未预期形状"兜底，不冒充平台不可用。
 */
function reasonForStatus(status: number): OpenFailureReason {
  switch (status) {
    case 401: return 'not-signed-in'
    case 400: return 'invalid-app-id'
    case 403: return 'proof-required'
    case 404: return 'app-not-found'
    case 410: return 'app-offline'
    case 502: return 'platform-unavailable'
    case 503: return 'protocol-not-ready'
    default: return 'unexpected-response'
  }
}

/**
 * **平台**拒绝（宿主信封 `PLATFORM_*`）→ reason。
 *
 * 与 {@link reasonForStatus} 分开的理由：平台的信封带**它自己的**语义（证明失效 /
 * 登录态失效 / 应用被冻结 / 应用没了 / 已下架 / 暂时不可用），比"HTTP 状态"精确。
 *
 * **原因先于状态**：冻结与"不存在"同码同状态（404 + `NOT_FOUND`），先按 `status`
 * 分流就永远读不到 `platform_reason` —— 那正是"打开一个仅被冻结的应用被告知应用
 * 不存在"的缺陷本体。原因只在 404 上参与分流（410 是另一档契约，不允许被一个原因
 * 字段改写成"冻结"）。
 *
 * ### 三档可恢复 / 可解释的失败（2026-10-23 U-04）
 *
 * 修前这里是"状态码就近归属"：410 与 404 一起说"应用不存在"、403 被并进"尚未
 * 登录"、500/502 落进"响应与预期不一致（通常是版本不一致）"。三句话都把用户指向
 * 一个**无效**的下一步（去要新应用 / 再登录一次 / 升级客户端）。现在逐档分开：
 *
 * | 状态 | 平台证据 | reason | 下一步 |
 * |---|---|---|---|
 * | 500/502/503 | 任何 | `platform-unavailable` | 稍后重试（不是升级客户端） |
 * | 401 | 非 `proof_*` | `not-signed-in` | 重新登录 |
 * | 403 | 任何 | `not-permitted` | 找管理员（再登录也没用） |
 * | 404 | `app_frozen` | `app-frozen` | 发布者解冻 / 找管理员 |
 * | 404 | `app_not_found` / 其它已知理由 | `app-not-found` | 目录里确认、找发布者 |
 * | 404 | **无** reason / `no_release` | `no-release` | 等审核 / 找发布者 |
 * | 410 | 任何 | `app-offline` | 联系管理员恢复（数据仍在） |
 *
 * `404 + 无 reason ⇒ no-release` 的依据是服务端现状（`open.go`）：未登记/软删与
 * 冻结两条 404 **都**带 `details.reason`，唯一不带的是"应用还没有可用版本"。
 * 平台将来给这一档补上 `reason=no_release` 时（本函数已认），这条推断自动失效为
 * 显式约定。
 *
 * `proof_*` 判据取前缀而不是枚举：平台新增证明类码（如 `proof_replayed`）时，客户端
 * 不该把它误判成"未登录"。
 * @param status - HTTP 状态。
 * @param platformCode - 平台原码（已归一化为小写，见 `readHostPlatformRefusal`）。
 * @param platformReason - 平台结构化原因（已归一化，见 `readHostPlatformReason`）；
 *   缺省 ⇒ 404 上按"还没有可用版本"解释（见上），其它状态不受它影响。
 *   **不崩溃也不当成功**。
 * @returns 失败原因。
 */
export function reasonForPlatformRefusal(
  status: number,
  platformCode: string,
  platformReason: string | null,
): OpenFailureReason {
  // 平台侧 5xx 先判：任何码（含 `HTTP_502` 这种没有信封的形态）都只能是"平台暂时
  // 不可用"。放在证明码之前 —— 证明码与 5xx 不会同现，但 5xx 的下一步（重试）比
  // "重取证明"更接近事实。
  if (status === 500 || status === 502 || status === 503) return 'platform-unavailable'
  if (platformCode.startsWith('proof_')) return 'platform-refused'
  if (status === 401) return 'not-signed-in'
  if (status === 403) return 'not-permitted'
  if (status === 404) {
    if (platformReason === PLATFORM_APP_FROZEN_REASON) return 'app-frozen'
    if (platformReason === null || platformReason === PLATFORM_NO_RELEASE_REASON) return 'no-release'
    // 认得出理由（`app_not_found`）或认不出（平台新增档位）⇒ 保守说"不存在"：
    // 不能把一次"应用被删"说成"还有版本没上线"。
    return 'app-not-found'
  }
  if (status === 410) return 'app-offline'
  return 'unexpected-response'
}

/**
 * 在客户端内打开一个应用（唯一的打开路径）。
 *
 * 失败**永不抛**：每一种失败都是一个带 `reason` 的结果（UI 据此给出可读原因）。
 * @param rawAppId - 应用标识（服务端目录行里的 `app_id`；不是可信输入，先本地预检）。
 * @param deps - 可注入的 fetch / 证明判据（测试与 UI 共用同一条实现）。
 * @returns 成功（含协议 URL）或结构化失败。
 */
export async function openAppEntry(rawAppId: unknown, deps: OpenAppDeps = defaultDeps()): Promise<OpenResult> {
  const appId = typeof rawAppId === 'string' ? rawAppId.trim() : ''
  // 本地预检只做**加法**（与发布表单同一口径）：形态不对的 app_id 必然是服务端
  // 也会拒的（400 VALIDATION），提前拦下可以省一次往返、也不让请求带着垃圾出去。
  if (appId === '' || appId.length > APP_ID_MAX_LENGTH || !APP_ID_PATTERN.test(appId)) {
    return {
      ok: false,
      reason: 'invalid-app-id',
      error: `refusing to open ${JSON.stringify(rawAppId)}: not a valid app id (expected ${APP_ID_PATTERN.source})`,
      status: null,
    }
  }
  // 证明预检：明确不可能持有证明的文档不发请求（见 pageHoldsWriteProof）。
  if (!deps.holdsWriteProof()) {
    return {
      ok: false,
      reason: 'proof-unavailable',
      error: 'the app center must run in the client window: this document cannot hold the browser-session proof the local open route requires, so no request was sent',
      status: null,
    }
  }
  // scheme 预检（CHN-2）：应用协议 scheme 是渠道变量，必须先从宿主只读路由拿到。
  // 拿不到就**不发请求**——猜一个 scheme 既会让校验失效，也会让一次真实打开变成 404。
  // 先给一次补齐机会（挂载期取数失败/尚未完成时），仍拿不到才停。
  const readProtocol = deps.protocol ?? (() => appOriginProtocol())
  let protocol = readProtocol()
  if (protocol === null && deps.ensureChannel !== undefined) {
    try {
      await deps.ensureChannel()
    } catch { /* 补齐失败按"没拿到"处理，不把异常抛给调用方 */ }
    protocol = readProtocol()
  }
  if (protocol === null || protocol === '') {
    return {
      ok: false,
      reason: 'scheme-unavailable',
      error: 'the app origin scheme for this installation is unknown: the host channel route (/api/zeokeel/wasm-apps/channel) has not answered with a usable appOriginScheme, so no request was sent',
      status: null,
    }
  }

  // 本机持有性证明（§22.2 R2）：引导一次拿令牌 ⇒ 带上头 ⇒ 401 `proof_*` 时重取一次。
  // 先确保有令牌：拿不到就**不发业务请求**（见模块注释的三条推论）。
  if (await ensureHostProof(deps.fetch === undefined ? {} : { fetch: deps.fetch }) === null) {
    const failure = hostProofFailure()
    return {
      ok: false,
      reason: 'host-proof-unavailable',
      error: `no host proof could be obtained, so the open route was not called: ${failure?.message ?? 'unknown'}`,
      status: failure?.status ?? null,
    }
  }

  let response: Response | null
  try {
    response = await fetchWithHostProof(OPEN_APP_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId }),
      credentials: 'same-origin',
    }, deps.fetch === undefined ? {} : { fetch: deps.fetch })
  } catch (cause) {
    return {
      ok: false,
      reason: 'host-unreachable',
      error: `the local open route is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      status: null,
    }
  }
  if (response === null) {
    // 重取令牌也没成功（重放前的那一次引导失败）。
    const failure = hostProofFailure()
    return {
      ok: false,
      reason: 'host-proof-unavailable',
      error: `the host proof could not be refreshed after a rejection: ${failure?.message ?? 'unknown'}`,
      status: failure?.status ?? null,
    }
  }

  if (!response.ok) {
    const payload = await readJsonQuietly(response)
    const code = readHostErrorCode(payload)
    // 平台拒绝**先判**：它带着 `PLATFORM_` 前缀（宿主封装），不能落进"本机证明被拒"
    // 那一支 —— 那正是 2026-09-20 把"平台说没带持有性证明"显示成"本页面无法证明
    // 自己属于这个客户端窗口"的误归因路径。
    const platformCode = readHostPlatformRefusal(payload)
    // `platform_reason` 必须与码**同处**读取（唯一实现在 host-proof.ts）：冻结与
    // "不存在"同码同状态，它是唯一的区分凭据。缺省 ⇒ `null`，分流点按 not-found 回落。
    const platformReason = readHostPlatformReason(payload)
    const reason = platformCode === null
      ? (response.status === 401 && isHostProofErrorCode(code)
        ? (code === 'proof_expired' ? 'proof-expired' : 'proof-required')
        : reasonForStatus(response.status))
      : reasonForPlatformRefusal(response.status, platformCode, platformReason)
    return {
      ok: false,
      reason,
      error: `the local open route refused ${JSON.stringify(appId)} (HTTP ${String(response.status)}${code === null ? '' : `, ${code}`}${platformReason === null ? '' : `, ${platformReason}`}): ${reason}`,
      status: response.status,
      // 原始码原样带出去（上报/诊断要的是事实，不是本地化文案）。
      ...(code === null ? {} : { code }),
    }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    return {
      ok: false,
      reason: 'unexpected-response',
      error: `the local open route returned a non-JSON body: ${cause instanceof Error ? cause.message : String(cause)}`,
      status: response.status,
    }
  }
  const rawURL = (payload as { url?: unknown } | null)?.url
  const url = parseAppProtocolURL(rawURL, appId, protocol)
  if (url === null) {
    return {
      ok: false,
      reason: 'unexpected-response',
      error: `the local open route must answer {"url":"${protocol}//${appId}/"}; got ${JSON.stringify(rawURL)}`,
      status: response.status,
    }
  }
  // F16 的打开计数：服务端在这同一次调用里记账并回传（形状见 parseAppOpenCounts）；
  // 没下发就不带 —— 界面据此决定要不要渲染"今日已被打开 N 次"。
  const counts = parseAppOpenCounts(payload)
  const window = parseOpenWindow(payload)
  // F-04 的软闸门结论：宿主产出了就必须显示（修前这条字段没人读 ⇒ 静默显示旧内容）。
  const warning = parseOpenWarning(payload)
  // 成功 = 本机确认协议 URL 已就绪，且该应用的独立窗口正在加载它（契约 §5.2 的打开路径）。
  return {
    ok: true,
    url,
    ...(counts === null ? {} : { counts }),
    ...(window === null ? {} : { window }),
    ...(warning === null ? {} : { warning }),
  }
}
