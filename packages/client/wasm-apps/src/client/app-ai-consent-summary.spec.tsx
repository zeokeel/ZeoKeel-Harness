// @vitest-environment jsdom
/**
 * F-09（2026-10-22 审计）：「应用 AI 授权」**汇总视图** + 一键撤销。
 *
 * 缺陷形态：撤销授权只有应用详情页一个入口（`AppAiPanel` 的注释自认），用户"授过几个
 * 应用、分别是哪些"在界面上无处可查；授权键是 用户 × 服务端 × 应用 三段，所以"列出来"
 * 必须先能枚举存储里属于**当前作用域**的键。
 *
 * 这一组钉住四件事：
 *  ① 枚举只认当前作用域（换账号/换服务端不继承，也不被误撤销）；
 *  ② 汇总视图真的渲染出已授权的 app_id 与条数；
 *  ③ 单条撤销 **先宿主后本地**（宿主拒绝时本地记录不动 —— 否则界面说"已撤销"而调用仍放行）；
 *  ④ 一键撤销逐条走同一条链，失败的条目留在列表里并如实报数。
 *
 * ---- 变异验证 ----
 *   - `listAppAiConsents` 忽略作用域前缀（列出存储里全部键）⇒ ① 红；
 *   - 汇总视图在 `grants.length === 0` 时也渲染 ⇒「没有授权不渲染」红；
 *   - 撤销顺序反过来（先删本地再同步宿主）⇒ ③ 红（宿主失败后本地已空）；
 *   - 「全部撤销」吞掉失败（清空列表并宣称全部成功）⇒ ④ 红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_AI_CONSENT_PREFIX,
  appAiConsentKey,
  listAppAiConsents,
  revokeAllAppAiConsents,
  type AppAiConsentStore,
  type AppAiScope,
} from './app-ai.ts'
import { AppAiConsentSummary } from './AppAiConsentSummary.tsx'
import { setActiveLocale } from './locales.ts'

// React 18 的 act() 需要这个标志（其余挂载类用例同口径）。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SCOPE: AppAiScope = { userId: 'alice', serverURL: 'https://harness.example.com' }
const OTHER_SERVER: AppAiScope = { userId: 'alice', serverURL: 'https://other.example.com' }
const OTHER_USER: AppAiScope = { userId: 'bob', serverURL: 'https://harness.example.com' }

/** 内存存储（带枚举成员：真 `localStorage` 用 `length`/`key`，替身直接给 `keys`）。 */
function memoryStore(seed: Record<string, string> = {}): AppAiConsentStore & { dump: () => Record<string, string> } {
  const data = new Map<string, string>(Object.entries(seed))
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: key => { data.delete(key) },
    keys: () => [...data.keys()],
    dump: () => Object.fromEntries(data),
  }
}

/** 把某个作用域下的授权放进去（走真实构键函数，键布局只有一份实现）。 */
function grant(store: AppAiConsentStore, scope: AppAiScope, appId: string): void {
  const key = appAiConsentKey(scope, appId)
  if (key === null) throw new Error('unreachable: scope/app must be valid')
  store.setItem(key, 'granted')
}

const okJson = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })

/** 本机持有性证明的引导路径（`host-proof.ts`；真实实现每次同步前先取一枚令牌）。 */
const HOST_PROOF_PATH = '/api/zeokeel/wasm-apps/host-proof'

/**
 * 统一的本机 fetch 替身：证明路由答令牌，其余交给 `respond`（并记录 URL）。
 * @param respond - 业务路由的应答。
 * @returns 记录调用 URL 的 fetch 替身。
 */
function hostFetch(respond: (url: string, init: RequestInit) => Response): { fetch: typeof fetch, urls: string[] } {
  const urls: string[] = []
  const fetchStub = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    if (url === HOST_PROOF_PATH) return okJson({ proof: 'p', expires_at: Date.now() + 60_000 })
    return respond(url, init ?? {})
  }) as unknown as typeof fetch
  return { fetch: fetchStub, urls }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  setActiveLocale('zh')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  setActiveLocale('zh')
})

/**
 * 挂载汇总视图并等一次微任务链（身份是父组件异步给的，组件挂载后才 refresh）。
 * @param element - 组件树。
 */
async function mount(element: React.ReactElement): Promise<void> {
  await act(async () => { root.render(element) })
  await act(async () => { await Promise.resolve() })
}

describe('授权汇总的枚举：只认当前作用域（用户 × 服务端）', () => {
  it('列出已授权的应用（按 app_id 排序），别的账号/别的服务端的授权不算', () => {
    const store = memoryStore()
    grant(store, SCOPE, 'zeta-app')
    grant(store, SCOPE, 'alpha-app')
    grant(store, OTHER_SERVER, 'other-server-app')
    grant(store, OTHER_USER, 'other-user-app')
    // 未授权的键（值不是 granted）不列出：撤销过一次之后残留的键不该出现在清单里。
    const stale = appAiConsentKey(SCOPE, 'stale-app')
    if (stale !== null) store.setItem(stale, '')

    expect(listAppAiConsents(SCOPE, store).map(row => row.appId)).toEqual(['alpha-app', 'zeta-app'])
    // 另一个作用域看到的是它自己那一条 —— 汇总视图不是"全局列表"。
    expect(listAppAiConsents(OTHER_SERVER, store).map(row => row.appId)).toEqual(['other-server-app'])
  })

  it('作用域缺失（未登录/缺服务端）⇒ 空数组（不知道是谁就不猜）', () => {
    const store = memoryStore()
    grant(store, SCOPE, 'alpha-app')
    expect(listAppAiConsents(null, store)).toEqual([])
    expect(listAppAiConsents({ userId: '', serverURL: SCOPE.serverURL }, store)).toEqual([])
    // 存储不支持枚举（隐私模式/替身只给 get/set/remove）⇒ 空数组，不是抛错。
    const opaque: AppAiConsentStore = {
      getItem: () => 'granted',
      setItem: () => {},
      removeItem: () => {},
    }
    expect(listAppAiConsents(SCOPE, opaque)).toEqual([])
  })

  it('一键撤销只清当前作用域，返回被撤销的 app_id', () => {
    const store = memoryStore()
    grant(store, SCOPE, 'alpha-app')
    grant(store, SCOPE, 'zeta-app')
    grant(store, OTHER_SERVER, 'other-server-app')

    const revoked = revokeAllAppAiConsents(SCOPE, store)
    expect(revoked.sort()).toEqual(['alpha-app', 'zeta-app'])
    expect(listAppAiConsents(SCOPE, store)).toEqual([])
    // 别的作用域的授权**不在**这次点击的影响面里。
    expect(listAppAiConsents(OTHER_SERVER, store).map(row => row.appId)).toEqual(['other-server-app'])
    // 前缀常量在键里（面板与宿主两侧都靠它识别这类键）。
    expect(appAiConsentKey(SCOPE, 'alpha-app')).toContain(APP_AI_CONSENT_PREFIX)
  })
})

describe('汇总视图（F-09）：列出已授权应用 + 一键撤销', () => {
  it('渲染已授权的应用与条数；没有授权时**不渲染**这一块', async () => {
    const store = memoryStore()
    grant(store, SCOPE, 'roster')
    grant(store, SCOPE, 'invoices')
    await mount(<AppAiConsentSummary scope={SCOPE} store={store} deps={{ fetch: vi.fn() as unknown as typeof fetch }} />)
    const summary = container.querySelector('[data-role="ai-consent-summary"]')!
    expect(summary).not.toBeNull()
    expect(summary.textContent).toContain('应用 AI 授权 (2)')
    const rows = [...container.querySelectorAll('[data-role="ai-consent-row"]')]
    expect(rows.map(row => row.getAttribute('data-app-id'))).toEqual(['invoices', 'roster'])
    // 文案说清"应用数据读取授权是另一项"（F-08 的指路）。
    expect(container.querySelector('[data-role="ai-consent-hint"]')!.textContent).toContain('数据')

    const empty = memoryStore()
    await mount(<AppAiConsentSummary scope={SCOPE} store={empty} deps={{ fetch: vi.fn() as unknown as typeof fetch }} />)
    expect(container.querySelector('[data-role="ai-consent-summary"]')).toBeNull()
  })

  it('单条撤销：先同步宿主、再删本地记录（宿主拒绝时本地不动）', async () => {
    const store = memoryStore()
    grant(store, SCOPE, 'roster')
    const bodies: unknown[] = []
    const { fetch: fetchStub } = hostFetch((url, init) => {
      if (url !== '/api/zeokeel/wasm-apps/ai/consent') return new Response('nope', { status: 404 })
      bodies.push(JSON.parse(String(init.body ?? 'null')))
      return okJson({ app_id: 'roster', granted: false })
    })
    await mount(<AppAiConsentSummary scope={SCOPE} store={store} deps={{ fetch: fetchStub }} />)

    const revoke = container.querySelector<HTMLButtonElement>('.zeokeel-app-center-ai-consent-revoke')!
    await act(async () => { revoke.click() })
    await act(async () => { await Promise.resolve() })
    expect(bodies).toEqual([{ app_id: 'roster', granted: false }])
    expect(listAppAiConsents(SCOPE, store)).toEqual([])

    // 宿主拒绝（500）⇒ 本地记录必须**还在**：界面不能说"已撤销"而闸门仍开着。
    const store2 = memoryStore()
    grant(store2, SCOPE, 'roster')
    const { fetch: refusing } = hostFetch(() => new Response('nope', { status: 500 }))
    await mount(<AppAiConsentSummary scope={SCOPE} store={store2} deps={{ fetch: refusing }} />)
    await act(async () => { container.querySelector<HTMLButtonElement>('.zeokeel-app-center-ai-consent-revoke')!.click() })
    await act(async () => { await Promise.resolve() })
    expect(listAppAiConsents(SCOPE, store2).map(row => row.appId)).toEqual(['roster'])
    expect(container.querySelector('[data-role="ai-consent-error"]')).not.toBeNull()
  })

  it('一键撤销：逐条同步宿主，全部成功才说"已全部撤销"；有失败就留下并如实报数', async () => {
    const store = memoryStore()
    grant(store, SCOPE, 'roster')
    grant(store, SCOPE, 'invoices')
    const seen: string[] = []
    const { fetch: fetchStub } = hostFetch((url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { app_id?: string }
      if (url === '/api/zeokeel/wasm-apps/ai/consent') seen.push(String(body.app_id))
      return okJson({ app_id: body.app_id, granted: false })
    })
    await mount(<AppAiConsentSummary scope={SCOPE} store={store} deps={{ fetch: fetchStub }} />)
    await act(async () => { container.querySelector<HTMLButtonElement>('.zeokeel-app-center-ai-consent-revoke-all')!.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(seen.sort()).toEqual(['invoices', 'roster'])
    expect(listAppAiConsents(SCOPE, store)).toEqual([])
    expect(container.querySelector('[data-role="ai-consent-notice"]')!.textContent).toContain('已全部撤销')

    // 一半失败：只撤掉成功的那些，失败的仍在列表里，提示"其余没有撤成功"。
    const store2 = memoryStore()
    grant(store2, SCOPE, 'roster')
    grant(store2, SCOPE, 'invoices')
    const { fetch: partial } = hostFetch((_url, init) => {
      const body = JSON.parse(String(init.body ?? '{}')) as { app_id?: string }
      return body.app_id === 'roster'
        ? new Response('nope', { status: 500 })
        : okJson({ app_id: body.app_id, granted: false })
    })
    await mount(<AppAiConsentSummary scope={SCOPE} store={store2} deps={{ fetch: partial }} />)
    await act(async () => { container.querySelector<HTMLButtonElement>('.zeokeel-app-center-ai-consent-revoke-all')!.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(listAppAiConsents(SCOPE, store2).map(row => row.appId)).toEqual(['roster'])
    expect(container.querySelector('[data-role="ai-consent-notice"]')!.textContent).toContain('已撤销')
    expect(container.querySelector('[data-role="ai-consent-error"]')).not.toBeNull()
  })
})
