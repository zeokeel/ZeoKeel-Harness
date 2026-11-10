import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GatewayProtocol } from './server-connector/config.ts'

export type { GatewayProtocol } from './server-connector/config.ts'

/** 只读自己的字典键，模型名 constructor / __proto__ 不会被当成协议。 */
export function gatewayModelProtocol(protocols: Readonly<Record<string, GatewayProtocol>>, model: string): GatewayProtocol {
  const protocol = Object.hasOwn(protocols, model) ? protocols[model] : undefined
  if (protocol === undefined) return 'anthropic'
  if (protocol !== 'openai' && protocol !== 'anthropic') {
    throw new LlmError(`gateway-llm: unsupported model protocol for "${model}"`, 'INVALID_CONFIG')
  }
  return protocol
}

/** 路由身份固定，选定模型的协议决定完整适配器（包含图片、能力与冻结调用）。 */
export class GatewayAdapter extends LlmAdapter {
  constructor(
    private readonly anthropic: LlmAdapter,
    private readonly openai: LlmAdapter,
    private readonly protocols: () => Readonly<Record<string, GatewayProtocol>>,
  ) { super() }

  private selected(model: string): LlmAdapter {
    return gatewayModelProtocol(this.protocols(), model) === 'openai' ? this.openai : this.anthropic
  }

  override providerInfo(provider: string) { return this.anthropic.providerInfo(provider) }
  override providerRetryPolicy(provider: string) { return this.anthropic.providerRetryPolicy(provider) }
  override listModels(provider: string) { return this.anthropic.listModels(provider) }
  override resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.selected(model).resolveModel(provider, model, signal)
  }
  override imageRequestPricing(provider: string, model: string) {
    return this.selected(model).imageRequestPricing(provider, model)
  }
  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    return this.selected(model).imageRequestTarget(provider, model, image)
  }
  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    // 不用基类的 stream 闭包：其稍后重新分派会把旧能力元数据配上新协议。
    return this.selected(model).prepareCall(provider, model, signal)
  }
  override stream(options: GenerateOptions) { return this.selected(options.model).stream(options) }
}
