/**
 * 应用中心 · 生命周期动作面（设计 `docs/planning/2026-10-22-wasm-lifecycle-redesign.md` §6/§7；
 * 审计 C-01…C-04 / C-07 / C-11 / C-13）。
 *
 * 这一组用例咬的是**行为与语义**，不是"页面上出现过某个字符串"：
 *
 *   - 部署选择器里**只出现 approved 版本**（夹具里故意混入 pending/rejected；去掉过滤即红），
 *     当前版本不可选；
 *   - 已删除行**不渲染**冻结/上下架/删除/部署（渲染出来必然 404，C-11），只留只读详情 + 恢复 + 导出，
 *     已清除（purged）行连恢复都不渲染；
 *   - 删除/冻结确认框的承诺与设计 §5.4/§5.5 的**真实语义**一致：快照是清理的前置条件、
 *     清理日期是具体时刻（由保留期推算，冻结后以服务端 purge_after 为准）、不出现"后台任务"；
 *   - 删除 404 的「如需恢复请联系平台管理员」被替换成管理台真实存在的恢复入口（C-04）；
 *   - 待审队列跨应用、内联处置、**拒绝理由必填**（空理由不发请求）；
 *   - 管理列表请求带 `limit/offset`（C-13 的前端半边）；
 *   - 导出的三种形态打到契约里的查询串，文件名来自 Content-Disposition；410 APP_PURGED 原地可见。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError, request } from '../../api'
import { setCurrentAdmin, type MeUser } from '../../lib/rbac'
import Apps from './Apps'
import {
  deployCandidates,
  lifecycleErrorText,
  lifecycleRows,
  parseDeployments,
  purgePlan,
  retentionDaysOf,
  DELETED_RECOVERY_GUIDE,
  type ReleaseRow,
} from './apps-lifecycle'
import { downloadAppExport } from './app-export'

vi.mock('../../components/chart-lazy', () => ({ ChartLazy: () => <div data-testid="chart-mock" /> }))

const mockRequest = vi.mocked(request)

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const BASE = {
  description: '团队共享的便签墙',
  owner: 'alice',
  enabled: true,
  access: 'login',
  purpose: '团队协作',
  data_sensitivity: '内部',
  pending_releases: [] as string[],
  pending_count: 0,
  frozen_at: null as string | null,
  deleted_at: null as string | null,
  purge_after: null as string | null,
  snapshot_at: null as string | null,
  purged_at: null as string | null,
  created_at: '2026-10-01T02:00:00Z',
  updated_at: '2026-10-20T02:00:00Z',
}

/** 在架应用：当前版本 1.3.0（= 最新 approved），另有一个更旧的 approved 1.1.0。 */
const LIVE = {
  ...BASE,
  app_id: 'share-note',
  title: '共享便签',
  current_release_id: 30,
  current_version: '1.3.0',
}

/** 已删除（保留期内）：有快照、有 purge_after；可在管理台恢复。 */
const DELETED_APP = {
  ...BASE,
  app_id: 'gone-app',
  title: '已删除应用',
  owner: 'erin',
  enabled: false,
  current_release_id: 9,
  current_version: '0.9.0',
  frozen_at: '2026-10-01T00:00:00Z',
  deleted_at: '2026-10-01T00:00:00Z',
  purge_after: '2026-12-30T00:00:00Z',
  snapshot_at: '2026-10-01T00:00:05Z',
}

/** 已清除（purged）：数据已删，restore/数据面一律 410（设计 §3.1）。 */
const PURGED_APP = {
  ...BASE,
  app_id: 'purged-app',
  title: '已清除应用',
  owner: 'frank',
  enabled: false,
  current_release_id: 0,
  current_version: '',
  frozen_at: '2026-09-01T00:00:00Z',
  deleted_at: '2026-09-01T00:00:00Z',
  purge_after: '2026-11-30T00:00:00Z',
  snapshot_at: '2026-09-01T00:00:05Z',
  purged_at: '2026-12-01T00:00:00Z',
}

/**
 * 版本清单夹具：**故意混入 pending / rejected**（id 更大）。
 *
 * 若前端的 approved 过滤被删掉，pending 1.4.0 会出现在部署选择器里 —— 第一条用例即红。
 */
const RELEASES_MIX: ReleaseRow[] = [
  { id: 31, version: '1.4.0', status: 'pending', publisher: 'alice', created_at: '2026-10-21T00:00:00Z' },
  { id: 30, version: '1.3.0', status: 'approved', publisher: 'alice', created_at: '2026-10-20T00:00:00Z' },
  { id: 20, version: '1.1.0', status: 'approved', publisher: 'alice', created_at: '2026-10-10T00:00:00Z' },
  { id: 10, version: '1.0.0', status: 'rejected', publisher: 'alice', created_at: '2026-10-01T00:00:00Z' },
]

/** 部署历史（设计 §7：id/version/kind/actor/actor_role/created_at/current）。 */
const DEPLOYMENTS = {
  app_id: 'share-note',
  current_version: '1.3.0',
  current_deployment_id: 42,
  deployments: [
    { id: 42, version: '1.3.0', kind: 'review', actor: 'admin', actor_role: 'admin_session', message: '', created_at: '2026-10-20T03:00:00Z', current: true },
    { id: 41, version: '1.1.0', kind: 'rollback', actor: 'alice', actor_role: 'owner', message: '回滚观察', created_at: '2026-10-15T03:00:00Z', current: false },
    { id: 40, version: '1.1.0', kind: 'legacy', actor: '', actor_role: 'legacy', message: '迁移回填（0086）', created_at: '2026-10-01T00:00:00Z', current: false },
  ],
}

/**
 * 跨应用待审清单（设计 §5.7 / 反证 F-8）。
 *
 * 形状**逐键取自服务端真实下发面**（`wasmapp/api/deployments.go` 的
 * `pendingReleaseQueueRows`）：只有 app_id/title/version/publisher/created_at/
 * age_seconds/current_version + 顶层 total。旧夹具额外给了 `id`/`size`/`changelog`，
 * 把"服务端从不下发的字段"钉成了契约（生产环境那一行永远不出现）。
 */
const PENDING_QUEUE = {
  // 后端真实信封（键是 `pending`）：total = 与页头徽标同源的全量计数。
  total: 2,
  pending: [
    { app_id: 'share-note', title: '共享便签', version: '1.4.0', publisher: 'alice', age_seconds: 7200, current_version: '1.3.0', created_at: '2026-10-22T00:00:00Z' },
    { app_id: 'gone-app', title: '已删除应用', version: '0.9.9', publisher: 'erin', age_seconds: 90, current_version: '0.9.0', created_at: '2026-10-22T02:00:00Z' },
  ],
}

const SUPER: MeUser = { role: 'super_admin', permissions: ['capability:read', 'capability:write'] }

/** 用例级可变状态（模拟服务端的真值变化，让"回填后列表"与写动作自洽）。 */
let appsFixture: Record<string, any>[] = []
let deletedIds = new Set<string>()
let currentVersions: Record<string, string> = {}
let pendingQueueMode: 'ok' | 'empty' | 'drift' | 'missing' = 'ok'
let deploymentsMode: 'ok' | 'empty' | 'drift' | 'missing' = 'ok'
let deleteFails: ApiError | null = null
let pageTruncated = false

function listPage(params: URLSearchParams) {
  const limit = Number(params.get('limit') ?? 20)
  const offset = Number(params.get('offset') ?? 0)
  const status = params.get('status') ?? 'all'
  const includeDeleted = params.get('include_deleted') === '1' || status === 'deleted'
  const withState = appsFixture.map((a) => ({
    ...a,
    current_version: currentVersions[a.app_id] ?? a.current_version,
    ...(deletedIds.has(a.app_id)
      ? {
          deleted_at: '2026-10-22T00:00:00Z',
          frozen_at: '2026-10-22T00:00:00Z',
          purge_after: '2027-01-20T00:00:00Z',
          snapshot_at: '2026-10-22T00:00:05Z',
          enabled: false,
        }
      : {}),
  }))
  let rows = includeDeleted ? withState : withState.filter((a) => (a.deleted_at ?? null) === null)
  if (status === 'deleted') rows = rows.filter((a) => a.deleted_at !== null)
  if (status === 'published') rows = rows.filter((a) => a.enabled && a.frozen_at === null && a.deleted_at === null)
  return {
    apps: rows.slice(offset, offset + limit),
    review_required: false,
    setting_key: 'wasm.review_required',
    pending_count: PENDING_QUEUE.total,
    total: pageTruncated ? 25 : rows.length,
    truncated: pageTruncated ? offset + limit < 25 : offset + limit < rows.length,
    limit,
    offset,
    access: params.get('access') ?? '',
    retirement_snapshot_retention_days: 90,
  }
}

beforeEach(() => {
  setCurrentAdmin(SUPER)
  appsFixture = [LIVE, DELETED_APP, PURGED_APP]
  deletedIds = new Set()
  currentVersions = {}
  pendingQueueMode = 'ok'
  deploymentsMode = 'ok'
  deleteFails = null
  pageTruncated = false
  window.history.replaceState({}, '', '/admin/app-center')
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const raw = String(path)
    const base = raw.split('?')[0]!
    const params = new URLSearchParams(raw.split('?')[1] ?? '')
    const method = (init?.method ?? 'GET').toUpperCase()

    if (base === '/api/server/admin/wasm-apps') return listPage(params)

    // 跨应用待审清单（静态段：必须在 /:app_id 通配之前命中）
    if (base === '/api/server/admin/wasm-apps/releases/pending') {
      if (pendingQueueMode === 'missing') throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在')
      if (pendingQueueMode === 'drift') return { pending_count: 2 }
      if (pendingQueueMode === 'empty') return { pending_count: 0, releases: [] }
      return PENDING_QUEUE
    }

    // 部署历史 / 部署
    if (base.endsWith('/deployments')) {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { version: string; message?: string }
        const kind = body.version === '1.3.0' ? 'publish' : 'rollback'
        currentVersions['share-note'] = body.version
        // 与 serverstore.DeployWasmRelease + deploymentJSON 的真实响应对齐：
        // version/kind 在 deployment 段、current_version 在 app 段，顶层没有 version/kind。
        return {
          app: { app_id: 'share-note', current_version: body.version, current_release_id: 20, current_deployment_id: 43 },
          deployment: { id: 43, app_id: 'share-note', release_id: 20, version: body.version, kind, actor: 'admin', actor_role: 'admin_session', message: body.message ?? '', created_at: '2026-10-22T00:00:00Z', current: true },
          changed: true,
        }
      }
      if (deploymentsMode === 'missing') throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在')
      if (deploymentsMode === 'drift') return { app_id: 'share-note' }
      if (deploymentsMode === 'empty') return { app_id: 'share-note', current_version: '1.3.0', deployments: [] }
      return DEPLOYMENTS
    }

    // 版本清单（审核闭环 + 部署选择器）
    if (base.endsWith('/releases')) {
      const wanted = params.get('status') ?? 'pending'
      const releases = wanted === 'all' ? RELEASES_MIX : RELEASES_MIX.filter((r) => r.status === wanted)
      return { app_id: 'share-note', status: wanted, current_version: currentVersions['share-note'] ?? '1.3.0', releases, pending_count: 1 }
    }

    if (base.endsWith('/restore')) {
      deletedIds.delete('gone-app')
      currentVersions['gone-app'] = '0.9.0'
      appsFixture = appsFixture.map((a) => (a.app_id === 'gone-app' ? { ...a, deleted_at: null, frozen_at: null, purge_after: null } : a))
      return { app: { app_id: 'gone-app', deleted: false, deleted_at: null, frozen_at: null, purge_after: null, enabled: false, snapshot_at: '2026-10-01T00:00:05Z' } }
    }

    if (base.endsWith('/approve')) return { app_id: 'share-note', version: '1.4.0', status: 'approved', changed: true }
    if (base.endsWith('/reject')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { reason?: string }
      if (!body.reason) throw new ApiError(400, 'VALIDATION', '拒绝必须填写理由')
      return { app_id: 'share-note', version: '1.4.0', status: 'rejected', changed: true }
    }
    if (base.endsWith('/freeze')) return { app: { app_id: 'share-note', frozen: true, changed: true, frozen_at: '2026-10-22T00:00:00Z', purge_after: '2027-01-20T00:00:00Z', enabled: false } }
    if (base.endsWith('/diagnostics')) {
      return { diagnostics: { app_id: 'share-note', app_enabled: true, app_frozen: false, app_deleted: false, owner: 'alice', window_minutes: 1440, retention_days: 30, summary: { total: 0, ok: 0, error: 0, killed: 0, failed: 0, reasons: [], hints: [], last_failure_at: null }, failures: [], hints: [] } }
    }
    if (base.endsWith('/opens/summary')) {
      return { days: 7, top: 10, today: { day: '2026-10-22', pv: 0, uv: 0 }, totals: { pv: 0, uv: 0 }, trend: [], apps: [], top_apps: [], detail_retention_days: 90 }
    }
    if (base.endsWith('/opens')) {
      return { app_id: 'share-note', from: '2026-10-01', to: '2026-10-22', granularity: params.get('granularity') === 'dept' ? 'dept' : 'day', total_pv: 0, total_uv: 0, points: [], detail_retention_days: 90 }
    }
    if (base.endsWith('/ai-usage')) {
      return { app_id: 'share-note', from: '2026-10-01', to: '2026-10-22', days: [], total: { day: '', requests: 0, prompt_tokens: 0, completion_tokens: 0, cache_prompt_tokens: 0, cost: 0 }, attribution_available: false }
    }
    // DELETE /wasm-apps/:app_id（路径就是应用本身 ⇒ 放在最后按方法判定）
    if (method === 'DELETE') {
      if (deleteFails !== null) throw deleteFails
      const appId = base.split('/').pop()!
      deletedIds.add(appId)
      appsFixture = appsFixture.map((a) => (a.app_id === appId ? { ...a, enabled: false } : a))
      // **真实信封**（反证 F-9；`wasmapp/api/lifecycle_actions.go` 的 deleteWasmApp）：
      // 快照时刻在 `app.snapshot_at`，`snapshot` 段只有 path/has_database（**没有** ok/at）。
      // 旧夹具给了 `snapshot:{ok,at}` ⇒ 删掉「app.snapshot_at 回退」也能全绿。
      return {
        app: {
          app_id: appId,
          deleted: true,
          deleted_at: '2026-10-22T00:00:00Z',
          frozen_at: '2026-10-22T00:00:00Z',
          purge_after: '2027-01-20T00:00:00Z',
          snapshot_at: '2026-10-22T00:00:05Z',
          purged_at: null,
        },
        retention_days: 90,
        snapshot: {
          path: `<data_root>/apps/${appId}/snapshots/2026-10-22T00-00-05Z`,
          has_database: true,
        },
        note: '已软删（保留期内可恢复）；只读快照已生成，保留期结束后由 wasm_retirement 调度器真删',
      }
    }
    return {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setCurrentAdmin(null)
  window.history.replaceState({}, '', '/admin/app-center')
})

async function renderList() {
  render(<Apps />)
  expect(await screen.findByText('共享便签')).toBeInTheDocument()
}

function rowOf(appId: string): HTMLElement {
  const cell = screen.getByText(appId)
  const tr = cell.closest('tr')
  if (tr === null) throw new Error(`未找到 ${appId} 所在的行`)
  return tr
}

function listCalls() {
  return mockRequest.mock.calls.filter(([p]) => String(p).startsWith('/api/server/admin/wasm-apps?'))
}

/** 切到「已删除」筛选（软删行默认不下发）。 */
async function filterDeleted() {
  fireEvent.click(screen.getByRole('combobox', { name: '状态筛选' }))
  fireEvent.click(await screen.findByRole('option', { name: '已删除' }))
  expect(await screen.findByText('已删除应用')).toBeInTheDocument()
}

// ---------------------------------------------------------------------------
// 部署 / 回滚（C-03）
// ---------------------------------------------------------------------------

describe('应用中心 · 部署与回滚（C-03）', () => {
  it('版本选择器只列 approved：pending/rejected 不出现，标当前/最新，当前版本不可选', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '部署' }))
    const dialog = await screen.findByTestId('deploy-dialog')

    // 契约假设得到验证：选择器加载的是该应用的 approved 版本清单
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/wasm-apps/share-note/releases?status=approved')
    })
    // 两个 approved 都出现
    expect(await within(dialog).findByTestId('deploy-option-1.3.0')).toBeInTheDocument()
    expect(within(dialog).getByTestId('deploy-option-1.1.0')).toBeInTheDocument()
    // 非 approved（pending 1.4.0 / rejected 1.0.0）一个都不许出现
    expect(within(dialog).queryByTestId('deploy-option-1.4.0')).toBeNull()
    expect(within(dialog).queryByTestId('deploy-option-1.0.0')).toBeNull()

    // 当前版本不可选（服务端会回 changed:false）；最新 approved 有标记
    const currentOption = within(dialog).getByTestId('deploy-option-1.3.0')
    expect(currentOption).toBeDisabled()
    expect(currentOption).toHaveTextContent('当前')
    expect(currentOption).toHaveTextContent('最新')
    expect(within(dialog).getByTestId('deploy-option-1.1.0')).not.toBeDisabled()
  })

  it('选旧版本部署 → POST deployments {version,message}，回执按 kind 说「回滚」且行版本回填', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '部署' }))
    const dialog = await screen.findByTestId('deploy-dialog')
    fireEvent.click(await within(dialog).findByTestId('deploy-option-1.1.0'))
    fireEvent.change(within(dialog).getByTestId('deploy-message'), { target: { value: '回滚观察' } })
    fireEvent.click(within(dialog).getByTestId('deploy-submit'))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/share-note/deployments',
        { method: 'POST', body: JSON.stringify({ version: '1.1.0', message: '回滚观察' }) },
      )
    })
    // 回执：kind=rollback ⇒ 说「回滚」而不是笼统的「已操作」
    const flashMsg = await screen.findByTestId('apps-flash')
    expect(flashMsg).toHaveTextContent('回滚')
    expect(flashMsg).toHaveTextContent('v1.1.0')
    // 对话框关闭 + 该行当前版本回填为 1.1.0（服务端真值）
    await waitFor(() => {
      expect(screen.queryByTestId('deploy-dialog')).toBeNull()
    })
    await waitFor(() => {
      expect(within(rowOf('share-note')).getByText('1.1.0')).toBeInTheDocument()
    })
  })

  it('服务端回 changed:false ⇒ 回执明说「没有变更」，不假装部署成功', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      const base = String(path).split('?')[0]!
      const params = new URLSearchParams(String(path).split('?')[1] ?? '')
      if (base === '/api/server/admin/wasm-apps') return listPage(params)
      if (base.endsWith('/releases')) return { releases: RELEASES_MIX, current_version: '1.3.0' }
      if (base.endsWith('/deployments') && (init?.method ?? 'GET') === 'POST') {
        return {
          app: { app_id: 'share-note', current_version: '1.1.0' },
          deployment: { id: 43, version: '1.1.0', kind: 'rollback', actor: 'admin', actor_role: 'admin_session', message: '', created_at: '2026-10-22T00:00:00Z', current: true },
          changed: false,
          note: '目标版本已经是当前生效版本（幂等：未追加部署历史，未写审计）',
        }
      }
      if (base.endsWith('/deployments')) return DEPLOYMENTS
      return {}
    })
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '部署' }))
    const dialog = await screen.findByTestId('deploy-dialog')
    fireEvent.click(await within(dialog).findByTestId('deploy-option-1.1.0'))
    fireEvent.click(within(dialog).getByTestId('deploy-submit'))
    const flashMsg = await screen.findByTestId('apps-flash')
    expect(flashMsg).toHaveTextContent('没有变更')
  })

  it('部署失败把服务端的错误码翻译成可执行指引（RELEASE_NOT_DEPLOYABLE ⇒ 只有 approved 可部署）', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      const base = String(path).split('?')[0]!
      const params = new URLSearchParams(String(path).split('?')[1] ?? '')
      if (base === '/api/server/admin/wasm-apps') return listPage(params)
      if (base.endsWith('/releases')) return { releases: RELEASES_MIX, current_version: '1.3.0' }
      if (base.endsWith('/deployments') && (init?.method ?? 'GET') === 'POST') {
        throw new ApiError(409, 'RELEASE_NOT_DEPLOYABLE', '该版本不可部署')
      }
      return {}
    })
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '部署' }))
    const dialog = await screen.findByTestId('deploy-dialog')
    fireEvent.click(await within(dialog).findByTestId('deploy-option-1.1.0'))
    fireEvent.click(within(dialog).getByTestId('deploy-submit'))
    const err = await within(dialog).findByTestId('deploy-error')
    expect(err).toHaveTextContent('只有状态为 approved 的版本可以部署')
  })
})

// ---------------------------------------------------------------------------
// 已删除行（C-11）与恢复/导出
// ---------------------------------------------------------------------------

describe('应用中心 · 已删除行只保留只读详情 + 恢复 + 导出（C-11）', () => {
  it('已删除行不渲染冻结/上下架/删除/部署/转移归属，只渲染详情 + 恢复 + 导出', async () => {
    await renderList()
    await filterDeleted()
    const row = rowOf('gone-app')
    // 允许的动作
    expect(within(row).getByRole('button', { name: '详情' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '导出' })).toBeInTheDocument()
    // 不允许的动作：**不渲染**（不是禁用 —— 禁用意味着"现在不能"，语义是"删了就没有"）
    for (const name of ['冻结', '解冻', '上架', '下架', '删除', '部署', '转移归属']) {
      expect(within(row).queryByRole('button', { name }), `已删除行不渲染「${name}」`).toBeNull()
    }
    // 变异验证：删掉 deleted 守卫 ⇒ 上面这批 queryByRole 立刻拿到按钮 ⇒ 红。
  })

  it('已清除（purged）行连恢复都不渲染；详情显示「数据已清除，不可恢复」', async () => {
    await renderList()
    await filterDeleted()
    const row = rowOf('purged-app')
    expect(within(row).queryByRole('button', { name: '恢复' })).toBeNull()
    expect(within(row).getByRole('button', { name: '导出' })).toBeInTheDocument()

    fireEvent.click(within(row).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByTestId('lifecycle-purged')).toHaveTextContent('数据已清除，不可恢复')
  })

  it('恢复 → POST restore，回执明说「不自动上架」，行从「已删除」筛选里消失', async () => {
    await renderList()
    await filterDeleted()
    fireEvent.click(within(rowOf('gone-app')).getByRole('button', { name: '恢复' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/wasm-apps/gone-app/restore', { method: 'POST' })
    })
    const flashMsg = await screen.findByTestId('apps-flash')
    expect(flashMsg).toHaveTextContent('已恢复')
    expect(flashMsg).toHaveTextContent('不自动上架')
    // 服务端清零 deleted_at ⇒ 该行不再命中「已删除」筛选
    await waitFor(() => {
      expect(screen.queryByText('已删除应用')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// 删除（C-01 的承诺对齐）
// ---------------------------------------------------------------------------

describe('应用中心 · 删除确认框的真实语义（C-01 / 设计 §5.5）', () => {
  it('确认框写清「删除前必须快照」与 purge_after 具体日期，且不再出现未实现的「后台任务」', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '删除' }))
    const dialog = await screen.findByTestId('delete-confirm-dialog')

    // 删除前置条件：快照失败 = 删除失败（fail-closed）
    expect(dialog).toHaveTextContent('删除前必须生成只读快照')
    expect(dialog).toHaveTextContent('快照生成失败 = 删除失败')
    // 保留期天数与**具体清理日期**（夹具下发 90 天）
    expect(dialog).toHaveTextContent('保留期 90 天')
    const expected = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    expect(dialog).toHaveTextContent(`${expected.getFullYear()}/${expected.getMonth() + 1}/${expected.getDate()}`)
    // 可恢复性与不可逆边界都要说全
    expect(dialog).toHaveTextContent('保留期内')
    expect(dialog).toHaveTextContent('不可恢复')
    // 禁止再出现没有执行者的措辞
    expect(dialog).not.toHaveTextContent('后台任务')
    expect(dialog).not.toHaveTextContent('未实现')

    fireEvent.click(screen.getByTestId('delete-confirm'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/wasm-apps/share-note', { method: 'DELETE' })
    })
    // 回执按服务端回传的快照/purge_after 写（不是一句「已删除」）
    const flashMsg = await screen.findByTestId('apps-flash')
    expect(flashMsg).toHaveTextContent('只读快照已生成')
    expect(flashMsg).toHaveTextContent('清理日期')
    // 已软删 ⇒ 默认列表不再包含该行（服务端 include_deleted 缺省为假）
    await waitFor(() => {
      expect(screen.queryByText('共享便签')).toBeNull()
    })
  })

  it('冻结回执按后端真实响应写：快照已生成（时刻）+ purge_after 具体日期', async () => {
    // 后端真实形状（wasmapp/api/lifecycle_actions.go 的 freezeForApp）：
    // 快照结果在 app 段（snapshot_ok/snapshot_at），purge_after 也在 app 段。
    mockRequest.mockImplementation(async (path: string) => {
      const base = String(path).split('?')[0]!
      const params = new URLSearchParams(String(path).split('?')[1] ?? '')
      if (base === '/api/server/admin/wasm-apps') return listPage(params)
      if (base.endsWith('/freeze')) {
        return {
          app: {
            app_id: 'share-note', changed: true, enabled: false, frozen: true,
            frozen_at: '2026-10-22T00:00:00Z',
            purge_after: '2027-01-20T00:00:00Z',
            snapshot_at: '2026-10-22T00:00:05Z',
            snapshot_ok: true,
            snapshot_path: '<data_root>/apps/share-note/snapshots/2026-10-22T00-00-05Z',
          },
          note: '冻结已生效；只读快照已生成，保留期结束后由 wasm_retirement 调度器真删（不可恢复）',
        }
      }
      if (base.endsWith('/releases')) return { releases: [], current_version: '1.3.0' }
      if (base.endsWith('/deployments')) return DEPLOYMENTS
      return {}
    })
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '冻结' }))
    fireEvent.click(await screen.findByTestId('freeze-confirm'))
    const flashMsg = await screen.findByTestId('apps-flash')
    expect(flashMsg).toHaveTextContent('只读快照已生成')
    expect(flashMsg).toHaveTextContent(new Date('2026-10-22T00:00:05Z').toLocaleString('zh-CN', { hour12: false }))
    // purge_after 是**服务端登记的那一天**，不是页面自己按保留期推的
    expect(flashMsg).toHaveTextContent(new Date('2027-01-20T00:00:00Z').toLocaleString('zh-CN', { hour12: false }))
  })

  it('删除 404 的「如需恢复请联系平台管理员」被换成管理台真实入口（C-04）', async () => {
    deleteFails = new ApiError(404, 'NOT_FOUND', '已删除的应用不能再修改;如需恢复请联系平台管理员')
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '删除' }))
    await screen.findByTestId('delete-confirm-dialog')
    fireEvent.click(screen.getByTestId('delete-confirm'))

    const err = await screen.findByTestId('delete-error')
    // 误导指向一个不存在的能力（管理员就是平台管理员）⇒ 必须换成真实入口
    expect(err).not.toHaveTextContent('联系平台管理员')
    expect(err).toHaveTextContent('「已删除」')
    expect(err).toHaveTextContent('恢复')
    // 行没有被删（失败不乐观更新）
    expect(screen.getByText('共享便签')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 生命周期块 + 部署历史（设计 §7）
// ---------------------------------------------------------------------------

describe('应用中心 · 详情抽屉的生命周期块与部署历史（§7）', () => {
  it('生命周期块渲染六个时间点（含两阶段真删的 data_cleaned_at）', async () => {
    await renderList()
    await filterDeleted()
    fireEvent.click(within(rowOf('gone-app')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    const block = await within(dialog).findByTestId('lifecycle-block')
    const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false })
    expect(within(block).getByTestId('lifecycle-frozen_at')).toHaveTextContent(fmt(DELETED_APP.frozen_at))
    expect(within(block).getByTestId('lifecycle-deleted_at')).toHaveTextContent(fmt(DELETED_APP.deleted_at))
    expect(within(block).getByTestId('lifecycle-purge_after')).toHaveTextContent(fmt(DELETED_APP.purge_after))
    expect(within(block).getByTestId('lifecycle-snapshot_at')).toHaveTextContent(fmt(DELETED_APP.snapshot_at))
    expect(within(block).getByTestId('lifecycle-purged_at')).toHaveTextContent('—')
  })

  it('部署历史渲染 id/version/kind/actor/actor_role/时间/当前标记', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    const block = await within(dialog).findByTestId('deployments-block')
    await within(block).findByTestId('deployments-table')
    expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/wasm-apps/share-note/deployments')

    const current = within(block).getByTestId('deployment-row-42')
    expect(current).toHaveTextContent('v1.3.0')
    expect(within(current).getByTestId('deployment-kind-42')).toHaveTextContent('审批上线')
    expect(within(current).getByTestId('deployment-role-42')).toHaveTextContent('管理员会话')
    expect(current).toHaveTextContent('admin')
    expect(within(current).getByTestId('deployment-current-42')).toBeInTheDocument()

    const rollback = within(block).getByTestId('deployment-row-41')
    expect(within(rollback).getByTestId('deployment-kind-41')).toHaveTextContent('回滚')
    expect(within(rollback).getByTestId('deployment-role-41')).toHaveTextContent('作者')
    expect(within(rollback).queryByTestId('deployment-current-41')).toBeNull()
    expect(within(block).getByTestId('deployment-row-40')).toHaveTextContent('迁移回填')
  })

  it('部署历史端点 404（后端未合入）⇒ 明说「服务端尚未提供该端点」，不渲染成「没有部署记录」', async () => {
    deploymentsMode = 'missing'
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    const err = await within(dialog).findByTestId('deployments-error')
    expect(err).toHaveTextContent('尚未提供该端点')
    expect(within(dialog).queryByTestId('deployments-empty')).toBeNull()
  })

  it('生命周期字段服务端一个都没下发 ⇒ 明说「服务端未下发」，不把五个「—」当成「从未冻结」', async () => {
    const bare = {
      app_id: 'bare-app', title: '无生命周期列', description: '', owner: 'alice', enabled: true,
      access: 'login', purpose: '', data_sensitivity: '', current_release_id: 1, current_version: '1.0.0',
      pending_releases: [], pending_count: 0, created_at: '2026-10-01T02:00:00Z', updated_at: '2026-10-20T02:00:00Z',
      // 刻意**不带**任何生命周期字段（模拟后端尚未下发这些列）。
    }
    appsFixture = [bare]
    render(<Apps />)
    expect(await screen.findByText('无生命周期列')).toBeInTheDocument()
    fireEvent.click(within(rowOf('bare-app')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByTestId('lifecycle-unavailable')).toHaveTextContent('服务端没有下发生命周期字段')
  })
})

// ---------------------------------------------------------------------------
// 待审队列（C-07）
// ---------------------------------------------------------------------------

describe('应用中心 · 跨应用待审队列（C-07）', () => {
  async function openQueue() {
    await renderList()
    // 页头「待审 N」徽标可点（此前没有任何 onClick）
    fireEvent.click(screen.getByTestId('org-pending-count'))
    return screen.findByTestId('pending-queue-dialog')
  }

  it('页头「待审 N」可点开跨应用清单：列出 app_id/版本/提交人/当前生效版本', async () => {
    const dialog = await openQueue()
    expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/wasm-apps/releases/pending')
    const rowA = await within(dialog).findByTestId('pending-queue-row-share-note-1.4.0')
    expect(rowA).toHaveTextContent('共享便签')
    expect(rowA).toHaveTextContent('v1.4.0')
    expect(rowA).toHaveTextContent('alice')
    expect(rowA).toHaveTextContent('2 小时前')
    expect(rowA).toHaveTextContent('v1.3.0')
    // 第二个应用（跨应用，不是"按应用筛"）
    expect(within(dialog).getByTestId('pending-queue-row-gone-app-0.9.9')).toHaveTextContent('1 分钟前')
  })

  it('内联通过 → POST 到**该行自己的** app_id 的 approve，并刷新队列', async () => {
    const dialog = await openQueue()
    const before = mockRequest.mock.calls.filter(([p]) => String(p) === '/api/server/admin/wasm-apps/releases/pending').length
    fireEvent.click(await within(dialog).findByTestId('pending-queue-approve-share-note-1.4.0'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/share-note/releases/1.4.0/approve',
        { method: 'POST' },
      )
    })
    expect(await within(dialog).findByTestId('pending-queue-feedback')).toHaveTextContent('已通过 share-note v1.4.0')
    await waitFor(() => {
      const after = mockRequest.mock.calls.filter(([p]) => String(p) === '/api/server/admin/wasm-apps/releases/pending').length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('内联拒绝理由必填：空理由提交按钮禁用且不发请求；填理由后 POST body 带 reason', async () => {
    const dialog = await openQueue()
    fireEvent.click(await within(dialog).findByTestId('pending-queue-reject-share-note-1.4.0'))
    const submit = within(dialog).getByTestId('pending-queue-reject-submit-share-note-1.4.0')
    expect(submit).toBeDisabled()
    // 说明驳回影响面（A8：版本号永久占用）
    expect(dialog).toHaveTextContent('版本号将永久占用')

    fireEvent.click(submit)
    expect(mockRequest).not.toHaveBeenCalledWith(
      '/api/server/admin/wasm-apps/share-note/releases/1.4.0/reject',
      expect.anything(),
    )

    fireEvent.change(within(dialog).getByTestId('pending-queue-reason-share-note-1.4.0'), {
      target: { value: '数据范围超出用途所需' },
    })
    fireEvent.click(submit)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/wasm-apps/share-note/releases/1.4.0/reject',
        { method: 'POST', body: JSON.stringify({ reason: '数据范围超出用途所需' }) },
      )
    })
  })

  it('空清单给空态；响应缺 releases 给「读取失败」——两句话必须不同', async () => {
    pendingQueueMode = 'empty'
    const dialog = await openQueue()
    expect(await within(dialog).findByTestId('pending-queue-empty')).toHaveTextContent('没有待审版本')
    expect(within(dialog).queryByTestId('pending-queue-error')).toBeNull()
    // 关闭后换成形状漂移
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => { expect(screen.queryByTestId('pending-queue-dialog')).toBeNull() })

    pendingQueueMode = 'drift'
    fireEvent.click(screen.getByTestId('org-pending-count'))
    const dialog2 = await screen.findByTestId('pending-queue-dialog')
    expect(await within(dialog2).findByTestId('pending-queue-error')).toHaveTextContent('读取待审队列失败')
    expect(within(dialog2).queryByTestId('pending-queue-empty')).toBeNull()
  })

  it('刷新按钮重新拉取队列', async () => {
    const dialog = await openQueue()
    const before = mockRequest.mock.calls.filter(([p]) => String(p) === '/api/server/admin/wasm-apps/releases/pending').length
    fireEvent.click(within(dialog).getByTestId('pending-queue-refresh'))
    await waitFor(() => {
      const after = mockRequest.mock.calls.filter(([p]) => String(p) === '/api/server/admin/wasm-apps/releases/pending').length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('只读账号：清单可见，通过/拒绝禁用（服务端才是护栏）', async () => {
    setCurrentAdmin({ role: 'user', permissions: ['capability:read'] })
    const dialog = await openQueue()
    const approve = await within(dialog).findByTestId('pending-queue-approve-share-note-1.4.0')
    expect(approve).toBeDisabled()
    expect(within(dialog).getByTestId('pending-queue-reject-share-note-1.4.0')).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// 分页参数（C-13 前端半边）
// ---------------------------------------------------------------------------

describe('应用中心 · 管理列表分页参数（C-13 前端配合）', () => {
  it('列表请求带 limit/offset；翻页把新 offset 带进查询串', async () => {
    pageTruncated = true
    await renderList()
    const first = listCalls()[0]!
    expect(String(first[0])).toContain('limit=20')
    expect(String(first[0])).toContain('offset=0')

    fireEvent.click(screen.getByTestId('app-next-page'))
    await waitFor(() => {
      const calls = listCalls()
      expect(String(calls[calls.length - 1]![0])).toContain('offset=20')
      expect(String(calls[calls.length - 1]![0])).toContain('limit=20')
    })
  })
})

// ---------------------------------------------------------------------------
// 导出（C-02）
// ---------------------------------------------------------------------------

describe('应用中心 · 导出三种形态（C-02）', () => {
  const fetchMock = vi.fn()
  let saved: string[] = []

  beforeEach(() => {
    saved = []
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      const filename = String(url).includes('assets=1')
        ? 'share-note-export-assets.zip'
        : String(url).includes('database=1')
          ? 'share-note-export-db.zip'
          : 'share-note-export.json'
      const type = filename.endsWith('.zip') ? 'application/zip' : 'application/json'
      return new Response(new Blob(['payload'], { type }), {
        status: 200,
        headers: { 'content-type': type, 'content-disposition': `attachment; filename="${filename}"` },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const urlAny = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void }
    if (typeof urlAny.createObjectURL !== 'function') urlAny.createObjectURL = () => 'blob:mock'
    if (typeof urlAny.revokeObjectURL !== 'function') urlAny.revokeObjectURL = () => {}
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download)
    })
  })

  it('三种形态打到契约查询串，文件名来自 Content-Disposition', async () => {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '导出' }))
    const dialog = await screen.findByTestId('export-dialog')

    fireEvent.click(within(dialog).getByTestId('export-json'))
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/api/server/admin/wasm-apps/share-note/export', expect.anything()) })
    await waitFor(() => { expect(saved).toContain('share-note-export.json') })
    // 弹窗内回显（弹窗不自动关闭，方便连导第二种形态）
    expect(await within(dialog).findByTestId('export-done')).toHaveTextContent('share-note-export.json')

    await waitFor(() => { expect(within(dialog).getByTestId('export-database')).not.toBeDisabled() })
    fireEvent.click(within(dialog).getByTestId('export-database'))
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/api/server/admin/wasm-apps/share-note/export?database=1', expect.anything()) })
    await waitFor(() => { expect(saved).toContain('share-note-export-db.zip') })

    await waitFor(() => { expect(within(dialog).getByTestId('export-assets')).not.toBeDisabled() })
    fireEvent.click(within(dialog).getByTestId('export-assets'))
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/api/server/admin/wasm-apps/share-note/export?database=1&assets=1', expect.anything()) })
    await waitFor(() => { expect(saved).toContain('share-note-export-assets.zip') })
    // 页面级 flash 回执说明审计已记录
    expect(await screen.findByTestId('apps-flash')).toHaveTextContent('wasm_app_export')
  })

  it('已清除应用的「含数据/含资源」导出被禁用并说明原因（数据已清除，不可恢复）', async () => {
    await renderList()
    await filterDeleted()
    fireEvent.click(within(rowOf('purged-app')).getByRole('button', { name: '导出' }))
    const dialog = await screen.findByTestId('export-dialog')
    expect(within(dialog).getByTestId('export-json')).not.toBeDisabled()
    expect(within(dialog).getByTestId('export-database')).toBeDisabled()
    expect(within(dialog).getByTestId('export-assets')).toBeDisabled()
    expect(dialog).toHaveTextContent('数据已清除，不可恢复')
  })

  it('导出被拒（410 APP_PURGED）⇒ 原地显示真实原因，不产生下载', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ error: { code: 'APP_PURGED', message: '应用数据已清除', hints: [] } }),
      { status: 410, headers: { 'content-type': 'application/json' } },
    ))
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '导出' }))
    const dialog = await screen.findByTestId('export-dialog')
    fireEvent.click(within(dialog).getByTestId('export-json'))
    const err = await within(dialog).findByTestId('export-error')
    expect(err).toHaveTextContent('数据已清除，不可恢复')
    expect(saved).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 纯函数（把「日期/过滤/解析」的算法钉在用例里，而不是只钉文案）
// ---------------------------------------------------------------------------

describe('生命周期契约的纯函数口径', () => {
  it('保留期：只认正数；缺省/脏值一律 null（不推算日期）', () => {
    expect(retentionDaysOf({ retirement_snapshot_retention_days: 90 })).toBe(90)
    expect(retentionDaysOf({ retention_days: '90' })).toBe(90)
    expect(retentionDaysOf({ retention_days: 0 })).toBeNull()
    expect(retentionDaysOf({ retention_days: 'abc' })).toBeNull()
    expect(retentionDaysOf({})).toBeNull()
    expect(retentionDaysOf(null)).toBeNull()
  })

  it('清理日期：服务端 purge_after 优先；没有则按保留期推算并标记 projected', () => {
    const now = new Date('2026-10-22T00:00:00Z')
    const server = purgePlan({ purge_after: '2027-01-20T00:00:00Z' }, 90, now)
    expect(server).toEqual({ at: '2027-01-20T00:00:00Z', source: 'server', days: 90 })
    const projected = purgePlan({}, 90, now)
    expect(projected?.source).toBe('projected')
    expect(projected?.at).toBe('2027-01-20T00:00:00.000Z')
    expect(purgePlan({}, null, now)).toBeNull()
  })

  it('生命周期块恒有五个键（设计 §7 一项不少），未下发的字段标 present=false', () => {
    const rows = lifecycleRows({ frozen_at: '2026-10-01T00:00:00Z' })
    expect(rows.map((r) => r.key)).toEqual(['frozen_at', 'deleted_at', 'purge_after', 'snapshot_at', 'purged_at', 'data_cleaned_at'])
    expect(rows[0]!.present).toBe(true)
    expect(rows[1]!.present).toBe(false)
    expect(rows[1]!.value).toBe('—')
  })

  it('部署候选：只保留 approved，最新 = id 最大的 approved，当前版本标 current', () => {
    const candidates = deployCandidates(RELEASES_MIX, '1.3.0')
    expect(candidates.map((c) => c.version)).toEqual(['1.3.0', '1.1.0'])
    expect(candidates[0]!.latest).toBe(true)
    expect(candidates[0]!.current).toBe(true)
    expect(candidates[1]!.current).toBe(false)
    expect(candidates[1]!.latest).toBe(false)
  })

  it('待审队列信封：后端真实键 pending 与设计表述键 releases 都认；只有 [] 才是「没有待审」', async () => {
    const { parsePendingQueue } = await import('./apps-lifecycle')
    const actual = parsePendingQueue({ total: 1, pending: [{ app_id: 'a', version: '1.0.1', publisher: 'x', age_seconds: 30 }] })
    expect(actual.ok).toBe(true)
    if (actual.ok) {
      expect(actual.value.total).toBe(1)
      expect(actual.value.rows[0]!.appId).toBe('a')
    }
    const design = parsePendingQueue({ pending_count: 1, releases: [{ app_id: 'b', version: '2.0.0' }] })
    expect(design.ok).toBe(true)
    if (design.ok) expect(design.value.total).toBe(1)
    expect(parsePendingQueue({ total: 0, pending: [] })).toEqual({ ok: true, value: { rows: [], total: 0, truncated: false } })
    expect(parsePendingQueue({ total: 0 }).ok).toBe(false)
  })

  it('部署响应归一：后端把 version/kind 放在 deployment 段，回执仍然说「回滚」', async () => {
    const { normalizeDeployResult } = await import('./apps-lifecycle')
    const result = normalizeDeployResult({
      app: { app_id: 'share-note', current_version: '1.1.0', current_deployment_id: 43 },
      deployment: { id: 43, version: '1.1.0', kind: 'rollback', actor: 'admin', actor_role: 'admin_session', created_at: '2026-10-22T00:00:00Z' },
      changed: true,
    }, { app_id: 'share-note', version: '1.1.0', current_version: '1.3.0' })
    expect(result.kind).toBe('rollback')
    expect(result.current_version).toBe('1.1.0')
    expect(result.deployment?.actor_role).toBe('admin_session')
  })

  it('部署历史解析：缺 deployments 是「读取失败」；current 缺省时按版本与 id 推导唯一一条', () => {
    expect(parseDeployments({ app_id: 'x' })).toEqual({ ok: false, reason: expect.stringContaining('deployments') })
    const parsed = parseDeployments({
      current_version: '1.1.0',
      deployments: [
        { id: 7, version: '1.1.0', kind: 'rollback', actor: 'a', actor_role: 'owner', created_at: '' },
        { id: 6, version: '1.1.0', kind: 'legacy', actor: '', actor_role: 'legacy', created_at: '' },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.rows.map((r) => r.id)).toEqual([7, 6])
    expect(parsed.value.rows.filter((r) => r.current).map((r) => r.id)).toEqual([7])
  })

  it('错误码 → 真实指引：APP_PURGED 说明不可恢复；404 去掉「联系平台管理员」并给恢复入口', () => {
    const purged = lifecycleErrorText(new ApiError(410, 'APP_PURGED', '应用数据已清除'), '失败')
    expect(purged).toContain('数据已清除，不可恢复')
    const notFound = lifecycleErrorText(
      new ApiError(404, 'NOT_FOUND', '已删除的应用不能再修改;如需恢复请联系平台管理员'),
      '失败',
    )
    expect(notFound).not.toContain('联系平台管理员')
    expect(notFound).toContain(DELETED_RECOVERY_GUIDE)
    const deployable = lifecycleErrorText(new ApiError(409, 'RELEASE_NOT_DEPLOYABLE', 'x'), '失败')
    expect(deployable).toContain('approved')
  })

  it('导出文件名解析：filename= 与 filename*=RFC5987 都认，缺失时回落 app_id', async () => {
    const { filenameFrom } = await import('./app-export')
    expect(filenameFrom('attachment; filename="a-b.zip"', 'app', 'database', 'application/zip')).toBe('a-b.zip')
    expect(filenameFrom("attachment; filename*=UTF-8''%E5%AF%BC%E5%87%BA.zip", 'app', 'database', 'application/zip')).toBe('导出.zip')
    expect(filenameFrom(null, 'share-note', 'json', 'application/json')).toBe('share-note-export.json')
  })

  it('downloadAppExport 在非 2xx 时抛出带 code/hints 的 ApiError（页面据此说清原因）', async () => {
    await expect(downloadAppExport('share-note', 'database', {
      fetchImpl: async () => new Response(
        JSON.stringify({ error: { code: 'APP_PURGED', message: '应用数据已清除', hints: ['控制面 JSON 仍可导出'] } }),
        { status: 410, headers: { 'content-type': 'application/json' } },
      ),
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
      save: () => { throw new Error('不应该保存文件') },
    })).rejects.toMatchObject({ code: 'APP_PURGED', status: 410, hints: ['控制面 JSON 仍可导出'] })
  })
})

// ---------------------------------------------------------------------------
// 反证 F-9：DELETE 回执必须按**真实信封**说快照事实
// ---------------------------------------------------------------------------

describe('应用中心 · 删除回执的真实信封（反证 F-9）', () => {
  /** 包一层默认 mock：只替换这一次 DELETE 的响应。 */
  function mockDelete(out: unknown) {
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path) === '/api/server/admin/wasm-apps/share-note' && (init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        return out
      }
      return original(path, init)
    })
  }

  async function deleteShareNote() {
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '删除' }))
    await screen.findByTestId('delete-confirm-dialog')
    fireEvent.click(screen.getByTestId('delete-confirm'))
    return screen.findByTestId('apps-flash')
  }

  it('真实信封（app.snapshot_at + snapshot{path,has_database}）⇒ 回执说「已生成」并给出路径与应用库信息', async () => {
    mockDelete({
      app: {
        app_id: 'share-note', deleted: true,
        deleted_at: '2026-10-22T00:00:00Z', frozen_at: '2026-10-22T00:00:00Z',
        purge_after: '2027-01-20T00:00:00Z', snapshot_at: '2026-10-22T00:00:05Z', purged_at: null,
      },
      retention_days: 90,
      snapshot: { path: '<data_root>/apps/share-note/snapshots/2026-10-22T00-00-05Z', has_database: true },
    })
    const flashMsg = await deleteShareNote()
    expect(flashMsg).toHaveTextContent('只读快照已生成')
    // 时刻来自 **app.snapshot_at**（真实信封里 snapshot 段没有 at）
    expect(flashMsg).toHaveTextContent(new Date('2026-10-22T00:00:05Z').toLocaleString('zh-CN', { hour12: false }))
    // 路径与 has_database 如实渲染（不是编的"快照成功"）
    expect(flashMsg).toHaveTextContent('snapshots/2026-10-22T00-00-05Z')
    expect(flashMsg).toHaveTextContent('含应用库 app.db：是')
  })

  it('没有 app.snapshot_at 时**不得**声称快照已生成（变异 B：删掉该回退必红）', async () => {
    mockDelete({
      app: {
        app_id: 'share-note', deleted: true,
        deleted_at: '2026-10-22T00:00:00Z', frozen_at: '2026-10-22T00:00:00Z',
        purge_after: '2027-01-20T00:00:00Z', purged_at: null,
      },
      retention_days: 90,
      // snapshot 段只有 path/has_database（真实形态），没有 ok/at
      snapshot: { path: '<data_root>/apps/share-note/snapshots/x', has_database: false },
    })
    const flashMsg = await deleteShareNote()
    expect(flashMsg).not.toHaveTextContent('只读快照已生成')
    expect(flashMsg).toHaveTextContent('服务端未回传快照时刻')
    expect(flashMsg).toHaveTextContent('含应用库 app.db：否')
    // 清理日期仍按 retention_days 推算（服务端没给 purge_after 时）
    expect(flashMsg).toHaveTextContent('清理日期')
  })
})

// ---------------------------------------------------------------------------
// 反证 F-8：待审队列行不渲染服务端从不下发的字段
// ---------------------------------------------------------------------------

describe('应用中心 · 待审队列的字段面（反证 F-8）', () => {
  it('行上只渲染服务端真有的键；夹具里多给的 changelog/size/id 不会被渲染或被解析成契约', async () => {
    const { parsePendingQueue } = await import('./apps-lifecycle')
    // 夹具（服务端形状）里根本没有 changelog，这里再显式塞一次来证明"多给也不认"。
    const parsed = parsePendingQueue({
      total: 1,
      pending: [{
        app_id: 'a', version: '1.0.1', publisher: 'x', age_seconds: 30,
        changelog: '服务端不会下发的变更说明', size: 1024, id: 7, description: '服务端不会下发的描述',
      }],
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(Object.keys(parsed.value.rows[0]!).sort()).toEqual([
        'ageSeconds', 'appId', 'createdAt', 'currentVersion', 'publisher', 'title', 'version',
      ])
    }

    await renderList()
    fireEvent.click(screen.getByTestId('org-pending-count'))
    const dialog = await screen.findByTestId('pending-queue-dialog')
    const row = await within(dialog).findByTestId('pending-queue-row-share-note-1.4.0')
    expect(row).toHaveTextContent('v1.4.0')
    expect(row).toHaveTextContent('alice')
    // 生产环境永不出现的东西（旧实现读它、旧夹具喂它）
    expect(row.textContent ?? '').not.toContain('变更说明')
  })
})

// ---------------------------------------------------------------------------
// 反证 F-1：页头徽标与队列 total 同源，分叉与截断都要说出来
// ---------------------------------------------------------------------------

describe('应用中心 · 待审数的两个真源（反证 F-1）', () => {
  it('徽标数字 == 队列 total（服务端同源计数）；两者一致时不出现分叉告警', async () => {
    await renderList()
    const badge = screen.getByTestId('org-pending-count')
    expect(badge).toHaveTextContent('待审 2')
    fireEvent.click(badge)
    const dialog = await screen.findByTestId('pending-queue-dialog')
    // 标题里的数字与徽标一致（都是服务端的全量计数，不是本页行数）
    expect(await within(dialog).findByText('待审队列(2)')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('pending-queue-divergence')).toBeNull()
  })

  it('两个端点数字分叉 ⇒ 明说分叉（不静默挑一个当真），并给出两个数字', async () => {
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      const out = await original(path, init)
      const raw = String(path)
      if (raw.startsWith('/api/server/admin/wasm-apps?')) return { ...(out as object), pending_count: 5 }
      if (raw === '/api/server/admin/wasm-apps/releases/pending') return { ...(out as object), total: 2 }
      return out
    })
    await renderList()
    expect(screen.getByTestId('org-pending-count')).toHaveTextContent('待审 5')
    fireEvent.click(screen.getByTestId('org-pending-count'))
    const dialog = await screen.findByTestId('pending-queue-dialog')
    const warn = await within(dialog).findByTestId('pending-queue-divergence')
    expect(warn).toHaveTextContent('待审 5')
    expect(warn).toHaveTextContent('（2）')
  })

  it('服务端把队列截断（total > 本页行数）⇒ 明确说"只列出前 N 行"', async () => {
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path) === '/api/server/admin/wasm-apps/releases/pending') {
        return { total: 2, pending: [{ app_id: 'share-note', title: '共享便签', version: '1.4.0', age_seconds: 10, current_version: '1.3.0' }] }
      }
      return original(path, init)
    })
    await renderList()
    fireEvent.click(screen.getByTestId('org-pending-count'))
    const dialog = await screen.findByTestId('pending-queue-dialog')
    const note = await within(dialog).findByTestId('pending-queue-truncated')
    expect(note).toHaveTextContent('全组织共 2 个待审版本')
  })
})

// ---------------------------------------------------------------------------
// 反证 F-12：部署选择器排除"字节已释放"的 approved 版本
// ---------------------------------------------------------------------------

describe('应用中心 · 部署选择器排除字节已释放版本（反证 F-12）', () => {
  /** 覆盖 approved 版本清单（其余路由沿用默认 mock）。 */
  function mockApproved(rows: unknown[]) {
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      const raw = String(path)
      if (raw.includes('/releases?status=approved')) {
        return { app_id: 'share-note', status: 'approved', current_version: '1.3.0', releases: rows, pending_count: 0 }
      }
      return original(path, init)
    })
  }

  it('size=0 的 approved（字节已释放）不进选择器，但在「不可部署」清单里带原因与下一步', async () => {
    mockApproved([
      { id: 30, version: '1.3.0', status: 'approved', publisher: 'alice', size: 4096 },
      { id: 20, version: '1.1.0', status: 'approved', publisher: 'alice', size: 0 },
    ])
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '部署' }))
    const dialog = await screen.findByTestId('deploy-dialog')
    expect(await within(dialog).findByTestId('deploy-option-1.3.0')).toBeInTheDocument()
    // 字节已释放的版本**不可选**
    expect(within(dialog).queryByTestId('deploy-option-1.1.0')).toBeNull()
    // 但也不静默消失：列出来并给出可执行的下一步
    const blocked = within(dialog).getByTestId('deploy-blocked-1.1.0')
    expect(blocked).toHaveTextContent('v1.1.0')
    expect(blocked).toHaveTextContent('让作者发布更高版本号')
    expect(within(dialog).getByTestId('deploy-blocked')).toHaveTextContent('409 RELEASE_BYTES_RELEASED')
  })

  it('服务端下发 bytes_released=true 时同样排除（键优先于 size 推断）', async () => {
    mockApproved([
      { id: 30, version: '1.3.0', status: 'approved', size: 4096, bytes_released: false },
      { id: 21, version: '1.2.0', status: 'approved', size: 4096, bytes_released: true },
    ])
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '部署' }))
    const dialog = await screen.findByTestId('deploy-dialog')
    expect(await within(dialog).findByTestId('deploy-option-1.3.0')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('deploy-option-1.2.0')).toBeNull()
    expect(within(dialog).getByTestId('deploy-blocked-1.2.0')).toBeInTheDocument()
  })

  it('体积字段缺失 ⇒ 保守处理：仍列进选择器（不剥夺选项），错误文案可操作', async () => {
    mockApproved([
      { id: 30, version: '1.3.0', status: 'approved' },
      { id: 20, version: '1.1.0', status: 'approved' },
    ])
    await renderList()
    fireEvent.click(within(rowOf('share-note')).getByRole('button', { name: '部署' }))
    const dialog = await screen.findByTestId('deploy-dialog')
    expect(await within(dialog).findByTestId('deploy-option-1.1.0')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('deploy-blocked')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 反证 F-3 / F-4：已删除行的只读详情 + 「后台任务」措辞的防御映射
// ---------------------------------------------------------------------------

describe('应用中心 · 已删除行的只读详情与旧文案防御（反证 F-3/F-4）', () => {
  it('服务端放行只读详情 ⇒ 已删除行打开详情不出现版本清单错误', async () => {
    await renderList()
    await filterDeleted()
    fireEvent.click(within(rowOf('gone-app')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('pending-block')
    expect(within(dialog).queryByTestId('pending-error')).toBeNull()
    expect(within(dialog).queryByTestId('rejected-error')).toBeNull()
  })

  it('旧版服务端仍 404 ⇒ 说明"这是服务端未放行只读详情，不影响恢复/导出"，而不是甩「已退役」', async () => {
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      const raw = String(path)
      if (raw.startsWith('/api/server/admin/wasm-apps/gone-app/releases')) {
        throw new ApiError(404, 'NOT_FOUND', '应用已退役（已删除）')
      }
      return original(path, init)
    })
    await renderList()
    await filterDeleted()
    fireEvent.click(within(rowOf('gone-app')).getByRole('button', { name: '详情' }))
    const dialog = await screen.findByRole('dialog')
    const err = await within(dialog).findByTestId('pending-error')
    expect(err).toHaveTextContent('旧版本服务端未放行')
    expect(err).toHaveTextContent('「恢复」与「导出」')
    // 抽屉里的只读块仍然要在（不是整块坏掉）
    expect(within(dialog).getByTestId('lifecycle-block')).toBeInTheDocument()
    expect(within(dialog).getByTestId('detail-export')).toBeInTheDocument()
  })

  it('服务端 hint 里残留「后台任务」⇒ 渲染前被换成本轮的真实执行者（设计 §7 的书面口径）', async () => {
    const { lifecycleErrorText, sanitizeDeprecatedCopy } = await import('./apps-lifecycle')
    const text = lifecycleErrorText(
      new ApiError(404, 'NOT_FOUND', '已删除的应用不能再处置；R37 的"真删"由后台任务执行'),
      '删除失败',
    )
    expect(text).not.toContain('后台任务')
    expect(text).toContain('退役真删作业（wasm_retirement 调度器）')
    // 幂等：已经是新措辞的文本不再二次替换
    expect(sanitizeDeprecatedCopy(text)).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// 反证 F-2：审核开关回执（服务端 note 与 N 都是语义的一部分）
// ---------------------------------------------------------------------------

describe('审核开关回执与关闭提示（反证 F-2）', () => {
  it('关闭方向：服务端 note 原样透传（权威语义，含 N 与"作者可撤回"）', async () => {
    const { reviewSwitchReceipt } = await import('./apps-lifecycle')
    const note = '审核开关已关闭；现有 3 个待审版本将失去意义（作者可撤回，管理面可逐个通过/拒绝）'
    const text = reviewSwitchReceipt({ review_required: false, changed: true, pending_releases: 3, note }, false)
    expect(text).toContain('已关闭更新审批')
    expect(text).toContain('现有 3 个待审版本将失去意义')
    expect(text).toContain('作者可撤回')
  })

  it('关闭方向：服务端没给 note 时自己拼出 N 与两条真实出路（作者撤回 / 管理面逐个处置）', async () => {
    const { reviewSwitchReceipt, reviewCloseWarning } = await import('./apps-lifecycle')
    const text = reviewSwitchReceipt({ review_required: false, pending_releases: 4 }, false)
    expect(text).toContain('现有 4 个待审版本')
    expect(text).toContain('作者撤回')
    expect(text).toContain('逐个通过/拒绝')
    // 服务端一个数字都没给 ⇒ 不编 0（"没有积压"是另一个事实）
    expect(reviewCloseWarning(null)).toContain('服务端未回传现存待审数')
    expect(reviewCloseWarning(null)).not.toContain('0 个')
    expect(reviewCloseWarning(0)).toContain('没有待审版本积压')
  })

  it('开启方向：有积压时说清"现存 N 仍要逐个处置"，没积压时不多话', async () => {
    const { reviewSwitchReceipt } = await import('./apps-lifecycle')
    expect(reviewSwitchReceipt({ review_required: true, pending_releases: 2 }, true)).toContain('现存 2 个待审版本')
    expect(reviewSwitchReceipt({ review_required: true, pending_releases: 0 }, true)).not.toContain('现存 0')
  })
})

// ---------------------------------------------------------------------------
// 清理积压待审版本（设计 §5.7 的清理动作 / C-08）
// ---------------------------------------------------------------------------

describe('应用中心 · 清理积压待审版本（purge-stale）', () => {
  it('必须先确认：确认框写清三条代价与前置条件，取消则一个写请求都不发', async () => {
    await renderList()
    fireEvent.click(screen.getByTestId('org-pending-count'))
    const dialog = await screen.findByTestId('pending-queue-dialog')
    fireEvent.click(await within(dialog).findByTestId('pending-queue-purge-open'))
    const confirm = await screen.findByTestId('pending-queue-purge-dialog')
    expect(confirm).toHaveTextContent('审核开关必须')
    expect(confirm).toHaveTextContent('409')
    expect(confirm).toHaveTextContent('版本号')
    expect(confirm).toHaveTextContent('永久占用')
    expect(confirm).toHaveTextContent('不可逆')

    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    const writes = mockRequest.mock.calls.filter(([, init]) => {
      const m = (init as RequestInit | undefined)?.method
      return m !== undefined && m !== 'GET' && m !== 'HEAD'
    })
    expect(writes).toEqual([])
  })

  it('确认后 POST 到契约路径，回执带服务端 purged 数并刷新队列', async () => {
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path) === '/api/server/admin/wasm-apps/releases/purge-stale') {
        return { purged: 2, changed: true, status: 'withdrawn', reason: '审核关闭后清理', review_required: false, version_occupied: true }
      }
      return original(path, init)
    })
    await renderList()
    fireEvent.click(screen.getByTestId('org-pending-count'))
    const dialog = await screen.findByTestId('pending-queue-dialog')
    const before = mockRequest.mock.calls.filter(([p]) => String(p) === '/api/server/admin/wasm-apps/releases/pending').length
    fireEvent.click(await within(dialog).findByTestId('pending-queue-purge-open'))
    fireEvent.click(await screen.findByTestId('pending-queue-purge-confirm'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/wasm-apps/releases/purge-stale', { method: 'POST' })
    })
    const feedback = await within(dialog).findByTestId('pending-queue-feedback')
    expect(feedback).toHaveTextContent('已清理 2 个待审版本')
    expect(feedback).toHaveTextContent('wasm_release_purge_stale')
    expect(feedback).toHaveTextContent('版本号仍永久占用')
    // 清理后重取队列（数字以服务端为准，不本地减）
    await waitFor(() => {
      const after = mockRequest.mock.calls.filter(([p]) => String(p) === '/api/server/admin/wasm-apps/releases/pending').length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('审核开关仍开启（409）⇒ 服务端原因渲染在确认框里，不谎报清理成功', async () => {
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path) === '/api/server/admin/wasm-apps/releases/purge-stale') {
        throw new ApiError(409, 'VALIDATION', '审核开关仍开启：待审版本仍可审批，不能批量清理', undefined, [
          '先 PUT /wasm-apps/review {"required":false} 关闭审核，再执行本端点',
        ])
      }
      return original(path, init)
    })
    await renderList()
    fireEvent.click(screen.getByTestId('org-pending-count'))
    const dialog = await screen.findByTestId('pending-queue-dialog')
    fireEvent.click(await within(dialog).findByTestId('pending-queue-purge-open'))
    fireEvent.click(await screen.findByTestId('pending-queue-purge-confirm'))
    const err = await screen.findByTestId('pending-queue-purge-error')
    expect(err).toHaveTextContent('审核开关仍开启')
    expect(err).toHaveTextContent('required')
    // 确认框仍然开着（失败不等于完成），队列反馈里也没有"已清理"
    expect(screen.getByTestId('pending-queue-purge-dialog')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('pending-queue-feedback')).toBeNull()
  })

  it('回执纯函数：purged=0 说"没有可清理"，缺数字时不编 0', async () => {
    const { purgeStaleReceipt } = await import('./apps-lifecycle')
    expect(purgeStaleReceipt({ purged: 0 })).toContain('没有可清理')
    expect(purgeStaleReceipt({ purged: 3 })).toContain('已清理 3 个')
    expect(purgeStaleReceipt({})).toContain('未回报清理数量')
    expect(purgeStaleReceipt({})).not.toContain('已清理 0')
  })
})

describe('两阶段真删：清理完成与否必须分开说（反证 R2-P1-1）', () => {
  it('purged_at 已置但 data_cleaned_at 为空 ⇒ 明确说清理仍在重试，而不是"都已删除"', async () => {
    const { purgeNotice, PURGED_NOTICE, PURGED_CLEANUP_PENDING_NOTICE } = await import('./apps-lifecycle')
    expect(purgeNotice({ purged_at: '2026-10-23T00:00:00Z' })).toBe(PURGED_CLEANUP_PENDING_NOTICE)
    expect(purgeNotice({ purged_at: '2026-10-23T00:00:00Z', data_cleaned_at: '2026-10-23T00:00:05Z' })).toBe(PURGED_NOTICE)
    expect(PURGED_CLEANUP_PENDING_NOTICE).toContain('清理尚未确认完成')
  })
})
