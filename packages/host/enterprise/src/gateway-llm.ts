/**
 * 企业网关模型 provider：固定路由身份，根据服务端模型目录选择协议。
 *
 * 背景（两层，缺一不可）：
 *  · **0.1.6**：上游给 `llm-deepseek` 加了 `protocol`（缺省 `messages`），messages 适配器
 *    只发 `x-api-key`、不发 `Authorization`，而本仓网关 `/v1/*` 挂在 `serverauth.BearerAuth`
 *    下（只认 `Authorization: Bearer`）⇒ 每个模型请求 401「缺少认证令牌」（2026-09-22 现场
 *    事故）。当时的修法是在组装期钉死 `protocol: chat-completions`。
 *  · **0.1.7-rc.2 引入、0.2.1-rc.2 复核仍成立**：`protocol` **被删除**
 *    （`llm-deepseek/src/config.ts:207`，配了直接抛错），适配器只剩 Messages 一条路径
 *    （端点固定 `<baseURL>/messages` → 网关 `/v1/messages`）。鉴权搬到**注册 provider 的一方**：
 *    `registerDeepSeekProvider(ctx, provider, { resolveAuth })` 返回的 `headers` 会被原样加到
 *    Messages 请求上（`adapter.ts:82` 每次请求调一次，契约见 `DeepSeekRequestAuth`，
 *    `types.ts:105`）。
 *    ⚠️ 这两条 claim 的锚点是**行为**不是版本号：升级上游时按"守卫是否仍在 / 请求头是否仍由
 *    `resolveAuth` 决定"复核（当前 pin `dsh-v0.2.1-rc.2` = 687f282e，三条都还在原位）。
 *
 * 本插件取代上游的 `@deepseek-ai/dsh-llm-deepseek-api-key`（它的 `resolveAuth` 硬编码
 * `x-api-key`，对只认 Bearer 的网关必然 401，且没有任何换头的接缝），用同一份 Config 形状
 * 注册同一个 provider 路由 `deepseek-official`，把**会话令牌作为 Bearer** 交给请求。
 * `modelProtocols` 是本插件拥有的逐模型元数据；旧目录缺失时走 Messages，OpenAI 模型
 * 复用公开 pi-ai 适配器。上游已删除的顶层 `protocol` 键仍拒绝，未修改上游 Config。
 * 组装期 `cordis.patch.yml` 把上游那一行 `disabled` 掉并插入本行（id `zeokeel-gateway-llm`）。
 *
 * 令牌来源是 `credentials` 服务（`gateway-model.ts` 在会话变化时写入 `TOKEN_ENV`），
 * **不再**经过 `apiKeyEnv`：0.1.7 起 base `llm-deepseek` Config 里没有这个键（0.2.1-rc.2
 * 复核：`src/config.ts` 零命中 `apiKeyEnv`），而 `SettingsForms.write` 对非 volatile 字段
 * 会直接抛 `Config field "apiKeyEnv" is not volatile`。
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey, LlmError, ReasoningEffortId, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { catalogModelInfo, deepSeekConfigFields, DeepSeekAdapter, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek'
import { GATEWAY_LLM_ROW_ID, TOKEN_ENV } from './gateway-contract.ts'
import { GatewayAdapter, gatewayModelProtocol, type GatewayProtocol } from './gateway-adapter.ts'
import { createGatewayOpenAiAdapter } from './gateway-openai.ts'

export { GATEWAY_LLM_ROW_ID, TOKEN_ENV }

export interface Config extends DeepSeekConfig {
  /** 模型协议由 bootstrap 下发；缺失保持旧服务端的 Messages 行为。 */
  modelProtocols: Volatile<Record<string, GatewayProtocol>>
}

export const Config = z.object({
  ...deepSeekConfigFields,
  modelProtocols: z.dict(z.union(['openai', 'anthropic'] as const)).default({}).volatile(),
})

/** Stable Cordis plugin name. */
export const name = 'gateway-llm'

/** Services consumed: the LLM registry and the credential store holding the gateway token. */
export const inject = ['llm', 'credentials']

/** The provider route `bootstrap.ts` points `agent-default-model` at. */
const PROVIDER = 'deepseek-official'

/**
 * 端点绑定失败的错误码（不在上游 `DEFAULT_RETRYABLE_CODES` 里 ⇒ 不做无谓重试：
 * 端点不会自己变对，重试只会把令牌再举一次）。
 */
export const ENDPOINT_MISMATCH_CODE = 'ENDPOINT_MISMATCH'

/**
 * 把一个网关地址归一成可比较的形状（`origin + 去尾斜杠的 pathname`）。
 *
 * 用 `URL` 解析而不是字符串比较：`https://HOST/v1` 与 `https://host/v1/` 是同一个端点，
 * 而 `https://host/v1/../v2`、带 userinfo 的地址、非法地址都必须**判不出来**（返回
 * `undefined` ⇒ fail-closed）。
 * @param value - 候选网关地址。
 * @returns 归一化后的端点，或 `undefined`（不可解析 ⇒ 调用方必须拒绝）。
 */
export function normalizeGatewayEndpoint(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    const path = url.pathname.replace(/\/+$/u, '')
    return `${url.origin}${path === '' ? '' : path}`
  } catch {
    return undefined
  }
}

/**
 * 当前会话允许把网关令牌送到的**唯一**端点。
 *
 * 基准是**当前会话的 `serverURL`**（员工登录的那台企业服务器），不是任何编译期字面量：
 * 渠道包把网关放在自己的域名下时，`defaults.server_url` 就是 `serverURL`，因此这条推导
 * 天然覆盖"渠道自己的网关"；管理员把网关搬到**别的**主机属于需要显式声明的合法异址
 * （见本模块末尾的取舍说明）。
 * @param serverURL - `ctx.zeokeelSession.getSession()?.serverURL`。
 * @returns 归一化的 `<serverURL>/v1`，会话缺席/地址非法时 `undefined`（= 拒绝）。
 */
export function allowedGatewayEndpoint(serverURL: string | null | undefined): string | undefined {
  const origin = normalizeGatewayEndpoint(serverURL ?? undefined)
  return origin === undefined ? undefined : `${origin}/v1`
}

/**
 * 硬边界：网关令牌只允许发给**当前会话的网关端点**。
 *
 * 为什么是 fail-closed（2026-09-28 UPG-4 认账残留的收口）：`gateway-model.ts` 在登录时
 * 把 `<serverURL>/v1` 写进行设置，登出时清空；但"已登录 + 设置写入失败"（数据根里的孤儿
 * 写锁、磁盘满、进程被杀）以及"登出后设置没清干净"这两种组合下，`baseURL` 可能是**旧值
 * 或回落值**，而凭据仍在 —— 那时请求会把员工令牌发到那个端点。员工令牌只应发给我们自己的
 * 网关：这不是功能开关，是安全边界，所以判据放在**发请求之前**、且在读取凭据之前。
 * @param baseURL - 本次请求实际要打的端点（`connection.baseURL`）。
 * @param allowed - {@link allowedGatewayEndpoint} 的结果。
 * @returns 可诊断的拒绝理由（点名两端、不含令牌），或 `undefined`（放行）。
 */
export function endpointMismatch(baseURL: string | undefined, allowed: string | undefined): string | undefined {
  const actual = normalizeGatewayEndpoint(baseURL)
  if (allowed === undefined) {
    return 'gateway-llm: refusing to send the gateway token because no signed-in session declares a gateway endpoint;'
      + ' sign in first (the session server URL is the trust anchor for the token)'
  }
  if (actual === undefined) {
    return `gateway-llm: refusing to send the gateway token to an unusable endpoint ${JSON.stringify(String(baseURL))};`
      + ` the signed-in session's gateway is ${allowed}`
  }
  if (actual !== allowed) {
    return `gateway-llm: refusing to send the gateway token to ${actual};`
      + ` the signed-in session's gateway is ${allowed}`
  }
  return undefined
}

/**
 * The failure a wrong row id would cause, or `undefined` when the row is the one
 * this plugin and `gateway-model.ts`/`bootstrap.ts` agree on.
 *
 * 行 id 就是设置命名空间（0.1.7 的 `SettingsForms` 按 profile 条目 id 找表单），而
 * `gateway-model.ts`/`bootstrap.ts` 按 {@link GATEWAY_LLM_ROW_ID} 写入同一个命名空间。
 * 行被改名时立即失败，而不是让"写进一个不存在的命名空间"在登录后才炸
 * （`No configurable plugin entry "…"`）。Loader 之外的挂载（单元测试）没有条目 id，
 * 这时按"无法判定"放行。
 * @param entryId - `ctx.fiber.entry?.options.id`, when this plugin runs as a profile row.
 * @returns the failure message, or `undefined` when the row id is acceptable.
 */
export function rowIdFailure(entryId: string | undefined): string | undefined {
  if (entryId === undefined || entryId === GATEWAY_LLM_ROW_ID) return undefined
  return `gateway-llm: this row must keep the id "${GATEWAY_LLM_ROW_ID}" (found "${entryId}");`
    + ' the settings namespace the gateway writes baseURL/models to is the row id'
}

/**
 * Register the gateway as the `deepseek-official` provider with per-model wire dispatch.
 *
 * `baseURL`/`models`/`reasoningEffort` stay exactly where 0.1.6 put them — the
 * row's own settings section, written by `gateway-model.ts` (login) and
 * `bootstrap.ts` (catalog). Only the credential plane changed.
 */
export function apply(ctx: Context, config: Config): void {
  const rowFailure = rowIdFailure(ctx.fiber.entry?.options.id)
  if (rowFailure !== undefined) throw new Error(rowFailure)
  const options = () => {
    const raw = plainOptions(config) as ReturnType<typeof plainOptions> & { modelProtocols?: unknown }
    const modelProtocols = raw.modelProtocols ?? {}
    if (typeof modelProtocols !== 'object' || modelProtocols === null || Array.isArray(modelProtocols)) {
      throw new Error('gateway-llm: model protocols must be an object')
    }
    for (const [model, protocol] of Object.entries(modelProtocols)) {
      if (protocol !== 'openai' && protocol !== 'anthropic') {
        throw new Error(`gateway-llm: unsupported protocol for model "${model}"`)
      }
    }
    return {
      ...resolveAdapterOptions(raw, launchEnvironmentOf(ctx)),
      modelProtocols: Object.fromEntries(Object.entries(modelProtocols)) as Record<string, GatewayProtocol>,
    }
  }
  // 组装期即解析一次：配置非法（例如有人把删除掉的 `protocol` 加回来）在装载时就响亮失败，
  // 而不是等到第一次对话。
  options()
  const projectedEfforts = new Set<string>()
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    if (resolved.provider !== PROVIDER || resolved.reasoningEffort === undefined || resolved.reasoningEffort === 'off'
      || gatewayModelProtocol(options().modelProtocols, resolved.model) !== 'openai') return resolved
    // 存量会话可能保存了旧 Messages 的 high/max；在能力校验前投影为新协议默认，
    // 不篡改持久化选择，也不向未知能力的 OpenAI 模型虚报执行了思考强度。
    const key = `${resolved.model}\u0000${resolved.reasoningEffort}`
    if (!projectedEfforts.has(key)) {
      projectedEfforts.add(key)
      ctx.logger.warn(`gateway-llm: OpenAI model "${resolved.model}" has no declared reasoning capability; using provider default instead of stored effort "${resolved.reasoningEffort}"`)
    }
    return { ...resolved, reasoningEffort: ReasoningEffortId('off') }
  }, { prepend: true })
  const ref = credentialRef(TOKEN_ENV)
  // 失败语义：抛出的错误由适配器透传（`LlmError` 原样上抛，其它被包成 TRANSPORT），
  // 请求**不会**发出去 —— 缺令牌时是"没有请求"而不是"一个无凭据的请求"。
  const resolveToken = async (connection: { baseURL?: string }): Promise<string> => {
    // 硬边界先于凭据解析：端点不对时**连令牌都不读**（读也不发，但少一次凭据面接触）。
    const session = ctx.get('zeokeelSession')?.getSession?.() ?? null
    const refusal = endpointMismatch(connection?.baseURL, allowedGatewayEndpoint(session?.serverURL))
    if (refusal !== undefined) throw new LlmError(refusal, ENDPOINT_MISMATCH_CODE)
    const hit = await ctx.credentials.resolve(ref)
    if (hit === undefined) {
      throw new LlmError(
        `gateway-llm: no gateway token for provider route "${PROVIDER}"; sign in so the session`
        + ` service stores ${ref} in the credentials service`,
        'MISSING_CREDENTIAL',
      )
    }
    return assertUsableApiKey(hit.value, 'gateway-llm', ref)
  }
  // 对齐上游 registerDeepSeekProvider 的 Host 接线，协议适配器由本行统一注册。
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  let userId: AnonymousUserId | undefined
  const degradedReplays = new Set<string>()
  const omittedRoutes = new Set<string>()
  const unacceptedRoutes = new Set<string>()
  const anthropic = new DeepSeekAdapter({
    options,
    providerName: 'DeepSeek',
    resolveAuth: async connection => ({ headers: { Authorization: `Bearer ${await resolveToken(connection)}` } }),
    discoverModels: provider => Promise.resolve(options().models.map(model => catalogModelInfo(provider, model))),
    resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, image) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), image,
    ),
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
    onReplayDegrade: ({ provider, model, reason }) => {
      const key = `${provider}/${model}\u0000${reason}`
      if (degradedReplays.has(key)) return
      degradedReplays.add(key)
      ctx.logger.warn(`gateway-llm: unusable Messages replay state for route "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
    onExtensionsOmitted: ({ provider, model, fields, error }) => {
      const route = `${provider}/${model}`
      if (omittedRoutes.has(route)) return
      omittedRoutes.add(route)
      ctx.logger.warn(`gateway-llm: sending route "${route}" without request extension fields ${fields.join(', ')} because they failed to serialize: %o`, error)
    },
    onExtensionsUnaccepted: ({ provider, model, error }) => {
      const route = `${provider}/${model}`
      if (unacceptedRoutes.has(route)) return
      unacceptedRoutes.add(route)
      ctx.logger.warn(`gateway-llm: route "${route}" request extension acceptance failed; contributors resend on a later request: %o`, error)
    },
  })
  const openai = createGatewayOpenAiAdapter(ctx, PROVIDER, options, resolveToken)
  const adapter = new GatewayAdapter(anthropic, openai, () => options().modelProtocols)
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  ctx.on('loader/volatile-update', () => {
    let policy: typeof registeredPolicy
    try { policy = options().retryPolicy }
    catch (error) { ctx.logger.warn(error); return }
    if (JSON.stringify(policy) === JSON.stringify(registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  })
  // 与上游 api-key 行同面：把 provider 关联到**本行**的设置表单（表单值就是行 config）。
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: ctx.fiber.entry?.options.id ?? GATEWAY_LLM_ROW_ID, settingsPath: [] },
  ])
}
