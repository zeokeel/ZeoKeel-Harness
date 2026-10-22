/**
 * 应用面路由的**生命周期语义**（F-07 + 生命周期 UI 的宿主半边，2026-10-22）。
 *
 * 这一组刻意走**真路由**（`createWasmAppsRoute` 的 handler + 真 `proxyApp` 出站），
 * 而不是直接调 `lifecycleActionApplied()`：
 *
 *  - F-07 的缺陷形态是"清浏览器存储**零生产调用点**"（审计原话：全包 grep
 *    `clearStorageData|clearCache|session.clear` = 0）——只测那个纯函数会再次掩盖它。
 *    这里断言的是**广播事件真的发出去了**（`wasm-apps-host` 的接收侧在 `index.spec.ts`
 *    的「生命周期事件 ⇒ 清该 app origin 的浏览器存储」一组里钉住）。
 *  - 生命周期 UI 的两条员工面路由（部署历史 / 撤回，设计 §6.1；服务端
 *    `deployments.go` 已实现）：这里的判据是**宿主代理真的把请求按契约转发到正确的
 *    上游路径**（而不是"客户端一发就 404"）。
 *  - **冻结/解冻不清存储**（设计 §5.4：只读快照、数据保留）。这是本文件最容易写错的
 *    一条：服务端冻结与解冻都回 `changed:true`，若拿 `changed` 当判据，点一次
 *    「解冻」就替用户删一次 localStorage/IndexedDB（R-02）。
 *
 * ---- 变异验证 ----
 *   - 把 `emitLifecycle` 从 unpublish/restore 分支移走 ⇒ 对应用例红；
 *   - `changed:false` 时也发事件 ⇒「幂等重放不清存储」/「restore 幂等不发事件」红；
 *   - `lifecycleActionApplied` 里删掉 `if (action === 'freeze') return false`
 *     （回到按 `changed` 判）⇒「冻结/解冻不清存储」红；
 *   - 把 `restore` 从 `WASM_APP_LIFECYCLE_SUFFIXES` 里删掉 ⇒ restore 用例 404；
 *   - `deployments` / `withdraw` 分支删掉 ⇒ 对应的「转发到服务端」用例 404 红。
 */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createWasmAppsRoute, WASM_APP_LIFECYCLE_EVENT, type WasmAppsFence } from './wasm-apps.ts'

/** 一次记录下来的出站请求。 */
interface Forwarded {
  url: string
  method: string
  body: string
}

/**
 * 装配一个最小但真实的宿主面：假 ctx（只用到 logger/emit）+ 放行的围栏替身 +
 * 记录响应的假 res。
 * @param platform 平台侧的回答（按 URL 给 Response）。
 * @returns 路由、出站记录与事件记录。
 */
function harness(platform: (url: string, init: RequestInit) => Response): {
  route: { kind: 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }
  forwarded: Forwarded[]
  emitted: Array<{ event: string, payload: unknown }>
  call: (method: string, path: string, body?: string) => Promise<{ status: number, body: string }>
} {
  const forwarded: Forwarded[] = []
  const emitted: Array<{ event: string, payload: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    forwarded.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : '',
    })
    return platform(url, init ?? {})
  }))

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }) },
  } as unknown as Context

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const fence: WasmAppsFence = {
    guard: () => true,
    requireWriteProof: () => true,
    requireProof: () => true,
    writeGuard: () => true,
    // 发布者本人（真实会话由 auth-gate 提供；这里只要一个形状合法的会话）。
    session: () => ({ serverURL: 'https://harness.example.com', token: 'tok', username: 'alice' }),
    json,
    collectBody: async (req: IncomingMessage) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks)
    },
    hostLocale: () => 'zh',
    aiRowsConsent: {
      isEnabled: async () => false,
      setEnabled: async () => {},
    } as unknown as WasmAppsFence['aiRowsConsent'],
  }

  const route = createWasmAppsRoute(ctx, fence)
  const call = async (method: string, path: string, body?: string): Promise<{ status: number, body: string }> => {
    const request = {
      method,
      url: path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(body)
      },
    } as unknown as IncomingMessage
    const state = { status: 0, body: '', headersSent: false }
    const res = {
      get headersSent() { return state.headersSent },
      writeHead: (status: number) => { state.status = status; state.headersSent = true; return res },
      end: (chunk?: string | Uint8Array) => {
        state.body = chunk === undefined ? '' : (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      },
    } as unknown as ServerResponse
    await route.handler(request, res)
    return state
  }

  return { route, forwarded, emitted, call }
}

const ok = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

describe('F-07：生命周期动作生效 ⇒ 广播存储清理事件（幂等重放不发）', () => {
  it('下架生效（changed:true）⇒ 广播 unpublish；幂等重放（changed:false）⇒ 不发', async () => {
    const h = harness(() => ok({ app: { app_id: 'demo', enabled: false, changed: true } }))
    const changed = await h.call('POST', '/api/zeokeel/apps/wasm/demo/unpublish')
    expect(changed.status).toBe(200)
    expect(h.emitted).toEqual([
      { event: WASM_APP_LIFECYCLE_EVENT, payload: { app_id: 'demo', action: 'unpublish' } },
    ])
    // 事件名是**跨包契约**：`wasm-apps-host` 的接收侧按这个字面量注册监听器。
    expect(WASM_APP_LIFECYCLE_EVENT).toBe('zeokeel/wasm-app-lifecycle')

    const replay = harness(() => ok({ app: { app_id: 'demo', enabled: false, changed: false } }))
    const again = await replay.call('POST', '/api/zeokeel/apps/wasm/demo/unpublish')
    expect(again.status).toBe(200)
    // 幂等重放不清存储：否则"再点一次下架"就是一次静默的数据丢失。
    expect(replay.emitted).toEqual([])
  })

  it('冻结与解冻（两者服务端都回 changed:true）⇒ 都不广播：只读快照、数据保留（设计 §5.4）', async () => {
    // 修前这里按 `changed` 判 ⇒ 冻结清一次、**解冻再清一次**（R-02）。而界面上
    // 四处文案（`locales.ts` 的 frozenHint/freezeAria/freezeConfirm、英文的
    // openAppFrozenHint）都承诺"数据仍然保留" —— 清存储等于替用户删数据。
    const frozen = harness(() => ok({ app: { app_id: 'demo', frozen: true, changed: true, enabled: false } }))
    const freeze = await frozen.call('POST', '/api/zeokeel/apps/wasm/demo/freeze', JSON.stringify({ frozen: true }))
    expect(freeze.status).toBe(200)
    expect(frozen.emitted).toEqual([])

    // 解冻 = 同一个端点 + `{frozen:false}`（客户端 `setAppFrozen` 的形态）。服务端
    // 解冻同样回 `changed:true`（`lifecycle_actions.go` 的 `frozenAppJSON(..., true)`），
    // 所以"按 changed 判"在这一支必然会清 —— 这正是 R-02 的复现路径。
    const unfrozen = harness(() => ok({ app: { app_id: 'demo', frozen: false, changed: true, enabled: false } }))
    const unfreeze = await unfrozen.call('POST', '/api/zeokeel/apps/wasm/demo/freeze', JSON.stringify({ frozen: false }))
    expect(unfreeze.status).toBe(200)
    // 请求形态也钉住：body 原样转发（客户端靠它区分冻结/解冻）。
    expect(unfrozen.forwarded[0]?.body).toBe(JSON.stringify({ frozen: false }))
    expect(unfrozen.emitted).toEqual([])
  })

  it('恢复：真的恢复（顶层 changed:true）⇒ 广播 restore；幂等分支（changed:false）⇒ 不发', async () => {
    // 服务端 `restoreForApp` 的**真实形状**：`changed` 在顶层（不在 `app` 里）——
    // 判据读错位置就会变成"永远不清"或"永远清"，两种都错。
    const restored = harness(() => ok({
      app: { app_id: 'demo', deleted: false, enabled: false },
      changed: true,
      retention_cleared: true,
      note: '已恢复：应用回到下架状态（不自动上架）',
    }))
    const restore = await restored.call('POST', '/api/zeokeel/apps/wasm/demo/restore')
    expect(restore.status).toBe(200)
    expect(restored.forwarded[0]).toMatchObject({ method: 'POST' })
    expect(restored.forwarded[0]?.url.endsWith('/apps/wasm/demo/restore')).toBe(true)
    expect(restored.emitted).toEqual([
      { event: WASM_APP_LIFECYCLE_EVENT, payload: { app_id: 'demo', action: 'restore' } },
    ])

    // 幂等恢复（服务端 `deployments.go` 的"没删除过"分支回 `changed:false`）：
    // 状态没变，清存储就是删数据（R-05：修前这里无条件 `return true`）。
    const idempotent = harness(() => ok({
      app: { app_id: 'demo', deleted: false, enabled: true },
      changed: false,
      note: '应用未处于删除状态（幂等：未写审计）',
    }))
    const again = await idempotent.call('POST', '/api/zeokeel/apps/wasm/demo/restore')
    expect(again.status).toBe(200)
    expect(idempotent.emitted).toEqual([])

    // 失败（410 已清除 / 409）**不**广播：状态没变，清存储就是删数据。
    const refused = harness(() => ok({ error: { code: 'APP_PURGED', message: 'purged' } }, 410))
    const purge = await refused.call('POST', '/api/zeokeel/apps/wasm/demo/restore')
    expect(purge.status).toBe(410)
    expect(refused.emitted).toEqual([])
  })

  it('删除生效（deleted:true）⇒ 广播 delete；上架从不清存储', async () => {
    const deleted = harness(() => ok({ app: { app_id: 'demo', deleted: true } }))
    const response = await deleted.call('DELETE', '/api/zeokeel/apps/wasm/demo')
    expect(response.status).toBe(200)
    expect(deleted.forwarded[0]?.method).toBe('DELETE')
    expect(deleted.emitted).toEqual([
      { event: WASM_APP_LIFECYCLE_EVENT, payload: { app_id: 'demo', action: 'delete' } },
    ])

    const published = harness(() => ok({ app: { app_id: 'demo', enabled: true, changed: true } }))
    const up = await published.call('POST', '/api/zeokeel/apps/wasm/demo/publish')
    expect(up.status).toBe(200)
    expect(published.forwarded[0]?.url.endsWith('/apps/wasm/demo/publish')).toBe(true)
    // 上架不清任何东西（清的是"被停用之后残留的旧数据"）。
    expect(published.emitted).toEqual([])
  })
})

describe('生命周期 UI 的员工面路由（设计 §6.1；后端未就绪时先按契约转发）', () => {
  it('GET /:app_id/deployments ⇒ 转发到员工面部署历史（含 query）', async () => {
    const h = harness(() => ok({ current: '1.2.0', deployments: [] }))
    const response = await h.call('GET', '/api/zeokeel/apps/wasm/demo/deployments?limit=5')
    expect(response.status).toBe(200)
    expect(h.forwarded[0]).toMatchObject({
      method: 'GET',
      url: 'https://harness.example.com/api/client/v2/apps/wasm/demo/deployments?limit=5',
    })
  })

  it('POST /:app_id/deployments ⇒ 原样转发 {version,message}（回滚 = 再部署一次旧版本）', async () => {
    const h = harness(() => ok({ deployment: { version: '1.1.0', kind: 'rollback' }, changed: true }))
    const body = JSON.stringify({ version: '1.1.0', message: '退回上一版' })
    const response = await h.call('POST', '/api/zeokeel/apps/wasm/demo/deployments', body)
    expect(response.status).toBe(200)
    expect(h.forwarded[0]).toMatchObject({
      method: 'POST',
      url: 'https://harness.example.com/api/client/v2/apps/wasm/demo/deployments',
      body,
    })
  })

  it('POST /:app_id/releases/:version/withdraw ⇒ 转发到撤回端点（版本号进路径）', async () => {
    const h = harness(() => ok({ release: { version: '1.3.0', status: 'withdrawn' } }))
    const response = await h.call('POST', '/api/zeokeel/apps/wasm/demo/releases/1.3.0/withdraw')
    expect(response.status).toBe(200)
    expect(h.forwarded[0]).toMatchObject({
      method: 'POST',
      url: 'https://harness.example.com/api/client/v2/apps/wasm/demo/releases/1.3.0/withdraw',
    })
  })

  it('未知路径仍 404（新分支不得把整片路径吞掉）', async () => {
    const h = harness(() => ok({}))
    const response = await h.call('POST', '/api/zeokeel/apps/wasm/demo/deploy')
    expect(response.status).toBe(404)
    expect(h.forwarded).toEqual([])
  })
})
