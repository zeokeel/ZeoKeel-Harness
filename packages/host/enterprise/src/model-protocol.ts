import type { BootstrapModel, GatewayProtocol } from './server-connector/config.ts'

/** 缺字段才兼容旧服务端；显式非法/空列表不能被误当成 Messages。 */
export function gatewayProtocols(raw: unknown): GatewayProtocol[] {
  if (raw === undefined) return ['anthropic']
  if (!Array.isArray(raw)) return []
  return (['anthropic', 'openai'] as const).filter(protocol => raw.includes(protocol))
}

/** 两种协议皆可用时沿用现有 Anthropic 行为，不在请求失败后换协议重试。 */
export function gatewayProtocol(model: BootstrapModel): GatewayProtocol | undefined {
  return gatewayProtocols(model.protocols)[0]
}

function modalities(model: BootstrapModel): string[] {
  const input = model.input_modalities
  if (!Array.isArray(input)) return ['text']
  if (input.length === 0) return []
  const known = input.filter((value): value is string => value === 'text' || value === 'image')
  return known.length === 0 ? ['text'] : [...new Set(known)]
}

/** 兼容旧目录的同名多上游；能力取交集，避免对某条转发路径虚报图片支持。 */
export function usableGatewayModels(models: readonly BootstrapModel[]): BootstrapModel[] {
  const byId = new Map<string, BootstrapModel>()
  for (const model of models) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string'
      || model.id.length === 0 || gatewayProtocol(model) === undefined) continue
    const previous = byId.get(model.id)
    if (previous === undefined) {
      byId.set(model.id, { ...model })
      continue
    }
    const candidateInput = modalities(model)
    byId.set(model.id, {
      ...previous,
      protocols: gatewayProtocols([...gatewayProtocols(previous.protocols), ...gatewayProtocols(model.protocols)]),
      input_modalities: modalities(previous).filter(input => candidateInput.includes(input)),
    })
  }
  // 空交集会被适配器 schema 当成缺字段补为 text，必须在目录入口先拒绝。
  return [...byId.values()].filter(model => model.input_modalities?.length !== 0)
}
