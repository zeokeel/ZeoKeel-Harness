/** OpenAI 网关复用上游的完整 Harness ↔ pi-ai 转换，凭据仍由企业会话拥有。 */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import type { DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

/** 缺少可信模型级能力时，off 表示不覆盖服务端/模型默认，不宣称能关闭其内部思考。 */
function providerDefaultReasoning(model: LlmResolvedModelInfo): LlmResolvedModelInfo {
  return {
    ...model,
    reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Default' }], defaultEffort: ReasoningEffortId('off') },
  }
}

class GatewayOpenAiAdapter extends PiAiAdapter {
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return providerDefaultReasoning(await super.resolveModel(provider, model, signal))
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await super.prepareCall(provider, model, signal)
    return { ...prepared, model: providerDefaultReasoning(prepared.model) }
  }
}

/**
 * 创建只服务企业网关的 OpenAI 适配器。静态 Provider 仅指定公开 pi-ai 协议实现，
 * 不注册上游插件的登录/发现面，也不读取环境中的其他供应商密钥。
 */
export function createGatewayOpenAiAdapter(
  ctx: Context,
  provider: string,
  options: () => DeepSeekConnectionOptions,
  resolveToken: (connection: { baseURL?: string }) => Promise<string>,
): PiAiAdapter {
  const api = openAICompletionsApi()
  // 同 Messages transport 一样拒绝重定向；SDK 默认跟随跳转会改变会话令牌的目的地。
  const guardedFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' })
  let previousKey: string | undefined
  let profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const current = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const connection = options()
    const key = JSON.stringify(connection)
    if (key === previousKey && profiles !== undefined) return profiles
    const models: Model<'openai-completions'>[] = connection.models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      provider,
      api: 'openai-completions',
      baseUrl: connection.baseURL,
      input: [...model.inputModalities ?? ['text']],
      contextWindow: model.contextWindow ?? connection.defaultContextWindow,
      // 仅用于 SDK 的模型描述；没有显式请求上限时不能把描述值写进 wire。
      maxTokens: model.maxTokens ?? 32_768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // 协议不能证明模型支持 reasoning_effort；普通聊天模型会拒绝该字段。
      reasoning: false,
      compat: { supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
    }))
    const piProvider: Provider = {
      id: provider,
      name: 'DeepSeek',
      baseUrl: connection.baseURL,
      auth: {
        apiKey: {
          name: 'Gateway session',
          resolve: ({ credential }) => Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: 'Gateway session',
          }),
        },
      },
      getModels: () => models,
      stream: (model, context, request) => api.stream(model, context, { ...request, fetch: guardedFetch }),
      streamSimple: (model, context, request) => api.streamSimple(model, context, {
        ...request,
        fetch: guardedFetch,
        // pi-ai streamSimple 会自行补 model.maxTokens。网关已有自己的默认参数，
        // 只有调用者/模型目录明确给出的上限才应覆盖它；保留其它 payload hook。
        ...request?.maxTokens !== undefined ? {} : {
          onPayload: async (payload, descriptor) => {
            const replacement = await request?.onPayload?.(payload, descriptor)
            const value = replacement === undefined ? payload : replacement
            if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
            const { max_tokens: _maxTokens, max_completion_tokens: _maxCompletionTokens, ...withoutCap } = value as Record<string, unknown>
            return withoutCap
          },
        },
      }),
    }
    const profile: ResolvedPiAiProviderProfile = {
      provider,
      displayName: 'DeepSeek',
      api: 'openai-completions',
      baseURL: connection.baseURL,
      piProvider,
      streamIdleTimeoutMs: connection.streamIdleTimeoutMs,
      maxRequestImageBytes: connection.maxInlineRequestImageBytes,
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: 1024 * 1024,
      retryPolicy: connection.retryPolicy,
      modelErrors: new Map(),
      configuredMaxTokens: new Map(connection.models.flatMap(model => model.maxTokens === undefined ? [] : [[model.id, model.maxTokens] as const])),
      reasoning: 'off',
    }
    profiles = new Map([[provider, profile]])
    previousKey = key
    return profiles
  }
  return new GatewayOpenAiAdapter({
    profiles: current,
    resolveApiKey: (_provider, profile) => resolveToken(profile),
    // 会话令牌只经 resolveApiKey 逐请求传入；这里没有持久化或 ambient auth 的后门。
    auth: {
      credentials: {
        read: () => Promise.resolve(undefined),
        list: () => Promise.resolve([]),
        modify: () => Promise.resolve(undefined),
        delete: () => Promise.resolve(),
      },
      authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    onReplayDegrade: ({ provider: route, model, reason }) => {
      ctx.logger.warn(`gateway-llm: unusable OpenAI replay state for route "${route}/${model}"; sending provider-neutral content (${reason})`)
    },
  })
}
