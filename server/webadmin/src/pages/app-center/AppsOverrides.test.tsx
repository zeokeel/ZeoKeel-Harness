/**
 * 应用列表的 per-app 限流覆盖**可发现面**（决策
 * `docs/decisions/2026-10-22-wasm-per-app-limits.md` §2.5；生产化评审管理员视角）。
 *
 * 咬的是**行为**（徽标跟随真实数据、筛选只作用于本页、读失败不冒充"没有覆盖"），
 * 不是"页面上出现过某个字符串"：
 *
 *   1. 有覆盖的行带徽标（含"高于全局"的强化形态），没有覆盖的行**不带**；
 *   2. 「只看有覆盖」开关：开启后本页只留带覆盖的行，关掉恢复；**分页/共 N 条语义不变**
 *      （「共 2 条」不会因为筛选变成 1，页面上明说"只筛本页"）；
 *   3. 覆盖清单读取失败 ⇒ 徽标不渲染 + 显式错误 + 开关禁用（不是"没有应用有覆盖"），
 *      点「重试覆盖清单」后恢复；
 *   4. 页头「限流覆盖（N）」用服务端清单的 N 打开总览对话框；
 *   5. 「只看有覆盖」筛空本页时给的是**另一句话**（本页没有 ≠ 全组织没有），并给出入口。
 *
 * 变异自证（删实现 ⇒ 红）：
 *   · 删掉行内 `app-override-badge-*` 渲染 ⇒ 第 1 条红；
 *   · 筛选改成"全局过滤/改 offset" ⇒ 第 2 条红（共 N 条/列表请求参数对不上）；
 *   · 读失败时渲染空徽标并静默 ⇒ 第 3 条红（错误条与禁用态不见）；
 *   · 页头按钮写死数字/不接线 ⇒ 第 4 条红（点击后没有对话框、计数不是 2）；
 *   · 筛空时复用「暂无应用」⇒ 第 5 条红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError, request } from '../../api'
import { setCurrentAdmin, type MeUser } from '../../lib/rbac'
import Apps from './Apps'
import { LIMIT_OVERRIDES_PATH, type AppLimitValues } from './app-limits'
import { WASM_APPS_PATH } from './apps-lifecycle'
import { OPENS_SUMMARY_PATH } from './opens-contract'
import { WASM_RUNTIME_PATH } from './app-runtime'

vi.mock('../../components/chart-lazy', () => ({ ChartLazy: () => <div data-testid="chart-mock" /> }))

const mockRequest = vi.mocked(request)

const SUPER: MeUser = { role: 'super_admin', permissions: ['capability:read', 'capability:write'] }

const GLOBAL: AppLimitValues = {
  app_running: 4,
  app_queue: 32,
  user_per_app_running: 2,
  user_per_app_queued: 4,
}

const BASE = {
  description: '团队共享的便签墙',
  owner: 'alice',
  enabled: true,
  access: 'login',
  purpose: '团队协作',
  data_sensitivity: '内部',
  current_release_id: 12,
  current_version: '1.0.0',
  pending_releases: [] as string[],
  pending_count: 0,
  created_at: '2026-10-01T02:00:00Z',
  updated_at: '2026-10-20T02:00:00Z',
}

/** 有覆盖（降额）：app_running 覆盖成 1（< 全局）。 */
const CAPPED = { ...BASE, app_id: 'capped', title: '共享便签' }
/** 有覆盖（放宽）：app_running 8 > 全局 4 ⇒ 徽标要强化形态。 */
const HOT = { ...BASE, app_id: 'hot', title: '热点应用', owner: 'bob' }
/** 没有覆盖：不得出现徽标。 */
const PLAIN = { ...BASE, app_id: 'plain', title: '普通应用', owner: 'carol' }

interface OverrideSpec {
  appId: string
  override: Partial<Record<keyof AppLimitValues, number | null>>
  updatedBy?: string
}

let apps: typeof CAPPED[]
let specs: OverrideSpec[]
let overridesMode: 'ok' | 'fail'
let listRequests: string[]

function allNull() {
  return { app_running: null, app_queue: null, user_per_app_running: null, user_per_app_queued: null }
}

function overridesView() {
  const axes = ['app_running', 'app_queue', 'user_per_app_running', 'user_per_app_queued'] as const
  const items = specs.map((spec) => {
    const override = { ...allNull(), ...spec.override }
    const effective = {} as AppLimitValues
    const exceeds: Record<string, boolean> = {}
    for (const key of axes) {
      effective[key] = override[key] ?? GLOBAL[key]
      exceeds[key] = effective[key] > GLOBAL[key]
    }
    return {
      app_id: spec.appId,
      global: GLOBAL,
      override,
      effective,
      exceeds_global: exceeds,
      updated_at: '2026-10-22T03:00:00Z',
      updated_by: spec.updatedBy ?? 'admin',
    }
  })
  return { global: GLOBAL, items, total: items.length }
}

function listView() {
  return {
    apps,
    review_required: false,
    setting_key: 'wasm.review_required',
    pending_count: 0,
    total: apps.length,
    truncated: false,
    limit: 20,
    offset: 0,
    access: '',
    retention_days: 7,
  }
}

const OPENS_EMPTY = { trend: [], apps: [], top_apps: [], today: { pv: 0, uv: 0 }, totals: { pv: 0, uv: 0 } }

beforeEach(() => {
  setCurrentAdmin(SUPER)
  apps = [CAPPED, HOT, PLAIN]
  specs = [
    { appId: 'capped', override: { app_running: 1 }, updatedBy: 'alice' },
    { appId: 'hot', override: { app_running: 8 }, updatedBy: 'bob' },
  ]
  overridesMode = 'ok'
  listRequests = []
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    const p = String(path)
    if (p === LIMIT_OVERRIDES_PATH) {
      if (overridesMode === 'fail') throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在')
      return overridesView()
    }
    // 总览对话框的应用目录（include_deleted=1）与应用列表（分页）是同一条路径，靠查询串区分。
    if (p.startsWith(`${WASM_APPS_PATH}?`) && p.includes('include_deleted=1')) {
      return { apps, truncated: false, total: apps.length, limit: 1000, offset: 0 }
    }
    if (p.startsWith(`${WASM_APPS_PATH}?`)) {
      listRequests.push(p)
      return listView()
    }
    if (p.startsWith(OPENS_SUMMARY_PATH)) return OPENS_EMPTY
    if (p === WASM_RUNTIME_PATH) return { runtime: {} }
    throw new Error(`unexpected request ${p}`)
  })
})

afterEach(() => {
  setCurrentAdmin(null)
})

describe('列表可发现：有覆盖的行带标记', () => {
  it('只给有覆盖的应用渲染徽标；高于全局的那一行是强化形态', async () => {
    render(<Apps />)
    await screen.findByTestId('app-override-badge-capped')

    expect(screen.getByTestId('app-override-badge-capped').textContent).toContain('限流覆盖')
    expect(screen.getByTestId('app-override-badge-capped').getAttribute('title')).toContain('该应用有单独限流覆盖')
    // 放宽到 8 > 全局 4：徽标要说出"高于全局"，否则例外里最危险的一类不可见。
    const hot = screen.getByTestId('app-override-badge-hot')
    expect(hot.textContent).toContain('高于全局')
    // 没有覆盖的行不得出现徽标（徽标 = "这个应用有例外"，多一个就是误导）。
    expect(screen.queryByTestId('app-override-badge-plain')).toBeNull()
  })
})

describe('「只看有覆盖」：只筛当前页，不改分页/共 N 条语义', () => {
  it('开启后只留带覆盖的行；关掉恢复；总数与列表请求不受影响', async () => {
    render(<Apps />)
    await screen.findByTestId('app-override-badge-capped')
    const requestsBefore = listRequests.slice()

    // 默认：三行都在（没有覆盖的行不带徽标）。
    expect(screen.queryByTestId('app-override-badge-plain')).toBeNull()
    expect(screen.getByText('普通应用')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: '只看有覆盖' }))

    await waitFor(() => expect(screen.queryByText('普通应用')).toBeNull())
    expect(screen.getByText('共享便签')).toBeInTheDocument()
    expect(screen.getByText('热点应用')).toBeInTheDocument()

    // 分页/共 N 条语义不变（仍是一页 3 条的全集标签），并且页面明说"只筛本页"。
    expect(screen.getByTestId('app-total').textContent).toContain('共 3 条')
    expect(screen.getByTestId('app-overrides-page-note').textContent).toContain('本页')
    // 筛选是**本页**行为：没有为了它重发列表请求（也就没有改 offset/limit/排序）。
    expect(listRequests).toEqual(requestsBefore)

    fireEvent.click(screen.getByRole('switch', { name: '只看有覆盖' }))
    await waitFor(() => expect(screen.getByText('普通应用')).toBeInTheDocument())
  })

  it('筛空本页：说"本页没有"而不是"没有应用"，并给出总览入口', async () => {
    apps = [PLAIN]
    specs = []
    render(<Apps />)
    await screen.findByText('普通应用')
    // 覆盖清单读到且为空 ⇒ 开关可用（"有 0 个应用有覆盖"是确定信息）。
    expect(screen.getByTestId('app-overrides-count-note').textContent).toContain('0')

    fireEvent.click(screen.getByRole('switch', { name: '只看有覆盖' }))
    const empty = await screen.findByText('本页没有带限流覆盖的应用')
    expect(empty).toBeInTheDocument()
    expect(screen.getByTestId('app-overrides-empty-open')).toBeInTheDocument()
    // 页面**没有**说"暂无应用"（那是另一句话，会让人以为应用没了）。
    expect(screen.queryByText('暂无应用')).toBeNull()
  })
})

describe('覆盖清单读不到：不冒充「没有覆盖」', () => {
  it('徽标缺席但显式报错、开关禁用；重试后徽标恢复', async () => {
    overridesMode = 'fail'
    render(<Apps />)

    const error = await screen.findByTestId('app-overrides-error')
    expect(error.textContent).toContain('这不是「没有应用有覆盖」')
    expect(screen.queryByTestId('app-override-badge-capped')).toBeNull()
    expect(screen.getByTestId('app-overrides-count-note').textContent).toContain('未读到')
    const toggle = screen.getByRole('switch', { name: '只看有覆盖' })
    expect(toggle).toBeDisabled()

    overridesMode = 'ok'
    fireEvent.click(screen.getByTestId('app-overrides-retry'))
    await screen.findByTestId('app-override-badge-capped')
    expect(screen.queryByTestId('app-overrides-error')).toBeNull()
  })
})

describe('页头入口：「限流覆盖（N）」打开总览', () => {
  it('计数来自服务端清单，点击打开对话框（对话框自己再取一份清单）', async () => {
    render(<Apps />)
    await waitFor(() => expect(screen.getByTestId('app-overrides-open').textContent).toContain('（2）'))

    fireEvent.click(screen.getByTestId('app-overrides-open'))
    await screen.findByTestId('limit-overrides-dialog')
    // 对话框里确实有这两行覆盖（标题来自应用目录）。
    await screen.findByTestId('limit-overrides-row-capped')
    expect(screen.getByTestId('limit-overrides-row-hot')).toBeInTheDocument()
  })
})
