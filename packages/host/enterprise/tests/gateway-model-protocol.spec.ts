import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, ImageVariantId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { MessageId, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GATEWAY_LLM_ROW_ID } from '../src/gateway-contract.ts'
import * as gatewayLlm from '../src/gateway-llm.ts'

const PROVIDER = 'deepseek-official'
const TOKEN = 'gateway-protocol-fixture-token'
const messages: GenerateOptions['messages'] = [{
  id: MessageId('user-protocol-fixture'), role: 'user', source: { kind: 'user' },
  content: [{ type: 'text', text: 'ping' }],
}]

const messagesSse = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`).join('')

function openaiSse(tool = false): string {
  const chunk = (delta: object, finish: string | null = null) => ({
    id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const data: object[] = tool
    ? [
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'weather', arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Hangzhou"}' } }] }),
      chunk({}, 'tool_calls'),
    ]
    : [chunk({ role: 'assistant', content: 'po' }), chunk({ content: 'ng' }), chunk({}, 'stop')]
  data.push({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
  return data.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
}

interface RequestRecord {
  url: string | undefined
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

const contexts: Context[] = []
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(closers.splice(0).map(close => close()))
})

/** 两种真实协议响应共用一个 HTTP 网关，错误的分派会被路径判据直接发现。 */
async function upstream(reply?: (request: RequestRecord, response: ServerResponse) => void) {
  const requests: RequestRecord[] = []
  let onRequest: (() => void) | undefined
  const requested = new Promise<void>((resolve) => { onRequest = resolve })
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const record: RequestRecord = {
        url: request.url, headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }
      requests.push(record)
      onRequest?.()
      if (reply !== undefined) { reply(record, response); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(request.url === '/v1/chat/completions' ? openaiSse() : messagesSse)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
  closers.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  return { origin: `http://127.0.0.1:${address.port}`, requests, requested }
}

interface LiveConfig {
  baseURL: string
  models: Array<{ id: string, maxTokens?: number, inputModalities?: string[] }>
  modelProtocols?: Record<string, string>
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
}

async function boot(origin: string, overrides: Partial<LiveConfig> = {}, sessionURL: string | null = origin) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.provide('settings', { configure: () => () => {} } as never)
  const resolve = vi.fn(async () => ({ value: TOKEN, source: 'fixture' }))
  ctx.provide('credentials', { resolve } as never)
  ctx.provide('zeokeelSession', {
    getSession: () => sessionURL === null ? null : { serverURL: sessionURL, username: 'fixture', token: TOKEN },
  } as never)
  const config: LiveConfig = {
    baseURL: `${origin}/v1`,
    models: [{ id: 'openai-model', maxTokens: 512 }, { id: 'anthropic-model' }, { id: 'legacy-model' }],
    modelProtocols: { 'openai-model': 'openai', 'anthropic-model': 'anthropic' },
    ...overrides,
  }
  await ctx.plugin({ name: GATEWAY_LLM_ROW_ID, inject: ['llm', 'credentials'], apply: gatewayLlm.apply } as never, config as never)
  return { ctx, config, resolve }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const call = (ctx: Context, model = 'openai-model', options: Partial<GenerateOptions> = {}) => collect(ctx.llm.stream({
  provider: PROVIDER, model, messages, ...options,
}))

describe('gateway model protocol adaptation', () => {
  it('按所选模型分派，旧服务端缺协议仍走 Messages，目录和 provider 身份保持一致', async () => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin)
    for (const model of ['openai-model', 'anthropic-model', 'legacy-model']) {
      expect((await call(ctx, model)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    }
    expect(remote.requests.map(request => request.url)).toEqual(['/v1/chat/completions', '/v1/messages', '/v1/messages'])
    expect(remote.requests.map(request => request.body.model)).toEqual(['openai-model', 'anthropic-model', 'legacy-model'])
    for (const request of remote.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(request.headers['x-api-key']).toBeUndefined()
      expect(request.headers['user-agent']).toContain('deepseek-harness/')
    }
    expect(remote.requests[0]?.body.max_tokens).toBe(512)
    const catalog = await ctx.llm.listModels(PROVIDER)
    expect(catalog.map(model => model.id)).toEqual(['openai-model', 'anthropic-model', 'legacy-model'])
  })

  it('OpenAI 文本增量与 usage 经真实 SSE 转换，省略协议整段时兼容旧设置', async () => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin)
    const chunks = await call(ctx)
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')).toBe('pong')
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } })
    const legacy = await boot(remote.origin, { modelProtocols: undefined } as never)
    await call(legacy.ctx)
    expect(remote.requests.at(-1)?.url).toBe('/v1/messages')
  })

  it('OpenAI 未声明输出上限时不覆盖服务端默认，用户显式上限和目录上限仍生效', async () => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin, { models: [{ id: 'openai-model' }, { id: 'bounded-model', maxTokens: 512 }], modelProtocols: { 'openai-model': 'openai', 'bounded-model': 'openai' } })
    await call(ctx)
    await call(ctx, 'openai-model', { maxTokens: 123 })
    await call(ctx, 'bounded-model')
    expect(remote.requests[0]?.body.max_tokens).toBeUndefined()
    expect(remote.requests[0]?.body.max_completion_tokens).toBeUndefined()
    expect(remote.requests[1]?.body.max_tokens).toBe(123)
    expect(remote.requests[2]?.body.max_tokens).toBe(512)
  })

  it.each(['high', 'max'] as const)('OpenAI 未知思考能力时不继承 Messages 默认 %s，只提供默认档', async (reasoningEffort) => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin, { reasoningEffort })
    await call(ctx)
    await call(ctx, 'openai-model', { reasoningEffort: 'off' as GenerateOptions['reasoningEffort'] })
    expect(remote.requests.map(request => request.body.reasoning_effort)).toEqual([undefined, undefined])
    expect((await ctx.llm.resolveModelInfo(PROVIDER, 'openai-model')).reasoning).toMatchObject({
      efforts: [{ id: 'off' }], defaultEffort: 'off',
    })
    for (const request of remote.requests) {
      expect(request.body.thinking).toBeUndefined()
      expect(request.body.enable_thinking).toBeUndefined()
      expect(request.body.chat_template_kwargs).toBeUndefined()
    }
  })

  it('OpenAI 未知思考能力时显式高强度明确拒绝，不假装支持也不发出付费请求', async () => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin)
    expect((await call(ctx, 'openai-model', { reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] })).at(-1))
      .toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } })
    expect(remote.requests).toEqual([])
  })

  it.each(['high', 'max'] as const)('Agent 请求投影旧会话 %s 为 OpenAI 默认档，后续模型覆盖也会被正确识别', async (reasoningEffort) => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin)
    // 模拟其他 Agent 配置监听器选定最终模型；网关监听器必须在 next() 后检查路由。
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), model: 'openai-model' }))
    const persisted = Object.freeze({ provider: PROVIDER, model: 'anthropic-model', reasoningEffort })
    const resolved = await agentEvents(ctx, {} as Agent).waterfall('agent/request', {
      turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve(persisted as never))
    expect(resolved).toMatchObject({ provider: PROVIDER, model: 'openai-model', reasoningEffort: 'off' })
    expect(persisted).toEqual({ provider: PROVIDER, model: 'anthropic-model', reasoningEffort })
    const prepared = await ctx.llm.prepareCall(resolved)
    expect((await collect(prepared.stream({ ...prepared.config, messages }))).at(-1))
      .toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(remote.requests[0]?.url).toBe('/v1/chat/completions')
    expect(remote.requests[0]?.body.reasoning_effort).toBeUndefined()
  })

  it('Agent 请求参数投影保留 Anthropic、其他 provider 和已选默认档的原对象', async () => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin)
    const dispatch = agentEvents(ctx, {} as Agent)
    for (const selection of [
      { provider: PROVIDER, model: 'anthropic-model', reasoningEffort: 'high' },
      { provider: 'unrelated-provider', model: 'openai-model', reasoningEffort: 'high' },
      { provider: PROVIDER, model: 'openai-model', reasoningEffort: 'off' },
    ]) {
      const selected = Object.freeze(selection)
      expect(await dispatch.waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve(selected as never)))
        .toBe(selected)
    }
  })

  it('OpenAI 分片工具调用和工具结果回传保持工具身份、参数与标准 wire 结构', async () => {
    let serveTool = true
    const remote = await upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(openaiSse(serveTool))
      serveTool = false
    })
    const { ctx } = await boot(remote.origin)
    const tools = [{ name: 'weather', description: 'fixture weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
    const chunks = await call(ctx, 'openai-model', { tools })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_fixture', name: 'weather', arguments: '{"city":"Hangzhou"}' } })
    await call(ctx, 'openai-model', { tools, messages: [
      ...messages,
      { id: MessageId('assistant-tool'), role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: 'openai-model' }, content: [{ type: 'tool-call', id: ToolCallId('call_fixture'), name: 'weather', arguments: '{"city":"Hangzhou"}' }] },
      { id: MessageId('tool-result'), role: 'tool', source: { kind: 'tool', callId: ToolCallId('call_fixture') }, toolCallId: ToolCallId('call_fixture'), content: [{ type: 'text', text: 'sunny' }] },
    ] })
    expect(remote.requests[0]?.body.tools).toEqual([expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'weather' }) })])
    expect(remote.requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call_fixture', function: { name: 'weather', arguments: '{"city":"Hangzhou"}' } })] }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_fixture', content: 'sunny' }),
    ]))
  })

  it('prepareCall 冻结协议与连接，下一次请求才读取新的模型协议', async () => {
    const remote = await upstream()
    const { ctx, config } = await boot(remote.origin)
    const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: 'openai-model' })
    config.modelProtocols = { 'openai-model': 'anthropic' }
    await collect(prepared.stream({ ...prepared.config, messages }))
    await call(ctx)
    expect(remote.requests.map(request => request.url)).toEqual(['/v1/chat/completions', '/v1/messages'])
  })

  it('OpenAI 令牌每请求解析，缺凭据时拒绝并且不发请求', async () => {
    const remote = await upstream()
    const { ctx, resolve } = await boot(remote.origin)
    resolve.mockResolvedValueOnce({ value: 'fixture-token-1', source: 'fixture' })
    resolve.mockResolvedValueOnce({ value: 'fixture-token-2', source: 'fixture' })
    await call(ctx)
    await call(ctx)
    expect(remote.requests.map(request => request.headers.authorization)).toEqual(['Bearer fixture-token-1', 'Bearer fixture-token-2'])
    resolve.mockResolvedValue(undefined as never)
    expect((await call(ctx)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } } })
    expect(remote.requests).toHaveLength(2)
  })

  it.each([null, 'https://harness.example.com'])('OpenAI 在会话端点 %s 不匹配时不读取令牌、不发请求', async (sessionURL) => {
    const remote = await upstream()
    const { ctx, resolve } = await boot(remote.origin, {}, sessionURL)
    expect((await call(ctx)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'ENDPOINT_MISMATCH' } } })
    expect(resolve).not.toHaveBeenCalled()
    expect(remote.requests).toEqual([])
  })

  it('OpenAI 不跟随 HTTP 重定向，第二个端点永远收不到凭据', async () => {
    const destination = await upstream()
    const remote = await upstream((_request, response) => {
      response.writeHead(307, { location: `${destination.origin}/v1/chat/completions` })
      response.end()
    })
    const { ctx } = await boot(remote.origin)
    expect((await call(ctx)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(remote.requests).toHaveLength(1)
    expect(destination.requests).toEqual([])
  })

  it('OpenAI 取消会终止真实 HTTP 流', async () => {
    let closed: (() => void) | undefined
    const disconnected = new Promise<void>((resolve) => { closed = resolve })
    const remote = await upstream((_request, response) => {
      response.on('close', () => closed?.())
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"id":"pending","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n')
    })
    const { ctx } = await boot(remote.origin)
    const abort = new AbortController()
    const result = call(ctx, 'openai-model', { signal: abort.signal })
    await remote.requested
    abort.abort()
    expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    await disconnected
  })

  it('OpenAI 图片沿当前 attachment 服务投影为 data URL，保留文本和图片顺序', async () => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin, { models: [{ id: 'openai-model', inputModalities: ['text', 'image'] }] })
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', width: 1, height: 1, bytes: 3,
    }
    const readImageRequest = vi.fn(async () => ({
      variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), attachment: ref,
      data: Uint8Array.of(1, 2, 3), mediaType: 'image/png', bytes: 3,
      width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true,
    }))
    ctx.provide('attachments', { readImageRequest, imageHostPath: () => undefined } as never)
    const chunks = await call(ctx, 'openai-model', { messages: [{
      id: MessageId('vision-user'), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }],
    }] })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(readImageRequest).toHaveBeenCalledWith(ref, { width: 1, height: 1, maxBytes: 1024 * 1024 }, expect.any(AbortSignal))
    expect(remote.requests[0]?.body.messages).toEqual([
      expect.objectContaining({ role: 'user', content: [
        { type: 'text', text: 'look' },
        expect.objectContaining({ type: 'text' }),
        expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: 'data:image/png;base64,AQID' }) }),
      ] }),
    ])
  })

  it.each([[401, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER']] as const)('OpenAI HTTP %s 映射错误且 SDK 不隐式重试', async (status, code) => {
    const remote = await upstream((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `fixture ${status}` } }))
    })
    const { ctx } = await boot(remote.origin)
    expect((await call(ctx)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code } } })
    expect(remote.requests).toHaveLength(1)
  })

  it('未知协议配置在装载时拒绝，不退回其他协议', async () => {
    const remote = await upstream()
    let message: string | undefined
    try { await boot(remote.origin, { modelProtocols: { 'openai-model': 'future-protocol' } }) }
    catch (error) { message = error instanceof Error ? error.message : String(error) }
    expect(message).toContain('protocol')
    expect(remote.requests).toEqual([])
  })

  it('模型 id 与对象原型同名时，未下发协议仍正确回落 Messages', async () => {
    const remote = await upstream()
    const { ctx } = await boot(remote.origin, { models: [{ id: 'constructor' }, { id: '__proto__' }, { id: 'toString' }], modelProtocols: {} })
    for (const model of ['constructor', '__proto__', 'toString']) await call(ctx, model)
    expect(remote.requests.map(request => request.url)).toEqual(['/v1/messages', '/v1/messages', '/v1/messages'])
  })
})
