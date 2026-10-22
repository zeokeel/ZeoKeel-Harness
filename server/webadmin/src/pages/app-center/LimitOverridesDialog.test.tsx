/**
 * 「限流覆盖（N）」总览对话框的行为级用例
 * （决策 `docs/decisions/2026-10-22-wasm-per-app-limits.md` §2.5；生产化评审管理员视角）。
 *
 * 咬的是**行为**（发了什么请求、成败后界面以谁为准、已删应用会不会被误当成可写），
 * 不是"页面上出现过某个字符串"：
 *
 *   1. 清单加载：override/effective/是否高于全局/更新时间与人都来自服务端视图；
 *   2. 逐行恢复默认：发 `DELETE /wasm-apps/:app_id/limits`，成功后**回读**清单
 *      （行消失是服务端回读的结果，不是本地乐观删除）；
 *   3. 失败**不乐观更新**：行与覆盖摘要一个字都不动，服务端信封原样显示；
 *   4. 空态 / 错误态 / 形状漂移（缺 `items`）三句不同的话；
 *   5. 已删除 / 已清除应用：行仍在（覆盖行保留）但**不发出**注定 404 的 DELETE；
 *   6. 应用目录读失败 ⇒ "状态未知"，**不是**"应用存在"也不是"应用已删除"；
 *   7. 运行时水位：`queue` / `schedulers` 摘要可见（含 wasm_retirement），
 *      缺 `queue` 时说"未下发"，而不是渲染 0。
 *
 * 变异自证（删实现 ⇒ 红）：
 *   · 成功后不重新 GET、直接从本地 state 过滤掉该行 ⇒ 第 2 条红（清单 GET 次数不增）；
 *   · 失败后本地删行 ⇒ 第 3 条红（行不在 + 覆盖摘要被抹）；
 *   · 去掉 `parseAppLimitOverrides` 的 items 校验 ⇒ 第 4 条的形状漂移用例红（渲染成空态）；
 *   · 已删除行照旧允许点「恢复默认」⇒ 第 5 条红（DELETE 被发出）；
 *   · 目录读失败时当作"应用存在"⇒ 第 6 条红（没有"状态未知"文案）；
 *   · 缺 queue 时渲染 0 ⇒ 第 7 条红（"未下发"文案不见）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError, request } from '../../api'
import { LimitOverridesDialog } from './LimitOverridesDialog'
import { appLimitsPath, LIMIT_OVERRIDES_PATH, type AppLimitKey, type AppLimitValues } from './app-limits'
import { WASM_APPS_PATH } from './apps-lifecycle'
import { WASM_RUNTIME_PATH } from './app-runtime'

const mockRequest = vi.mocked(request)

/** 全局四值（服务端默认口径：`user_per_app_running` 2026-10-22 起是 2）。 */
const GLOBAL: AppLimitValues = {
  app_running: 4,
  app_queue: 32,
  user_per_app_running: 2,
  user_per_app_queued: 4,
}

type AxisOverride = Record<AppLimitKey, number | null>

interface RowSpec {
  appId: string
  override: Partial<AxisOverride>
  updatedAt?: string
  updatedBy?: string
}

interface DirectoryApp {
  app_id: string
  title: string
  deleted_at?: string | null
  purged_at?: string | null
}

const AXES: AppLimitKey[] = ['app_running', 'app_queue', 'user_per_app_running', 'user_per_app_queued']

function allNull(): AxisOverride {
  const out = {} as AxisOverride
  for (const key of AXES) out[key] = null
  return out
}

let rows: RowSpec[]
let directory: DirectoryApp[]
let directoryTruncated: boolean
let overridesMode: 'ok' | 'fail' | 'drift'
let directoryMode: 'ok' | 'fail'
let deleteMode: 'ok' | 'fail'
let runtime: unknown
let deletes: string[]
let overridesGets: number
let directoryGets: number

const DELETE_FAIL = new ApiError(
  404,
  'NOT_FOUND',
  '请求的资源不存在',
)

const RUNTIME_OK = {
  runtime: {
    queue: {
      global_running: 2,
      waiting: 5,
      apps: 1,
      tracked_apps: 2,
      rejected_queue_full: 11,
      rejected_wall_clock: 3,
      top_apps: [
        { app_id: 'capped', running: 1, waiting: 4, rejected: 9 },
        { app_id: 'plain', running: 1, waiting: 1, rejected: 2 },
      ],
    },
    schedulers: [
      { name: 'wasm_retirement', tick_seconds: 60, started: true, runs: 3, errors: 1, last_error: '清理失败：样例错误' },
      { name: 'wasm_opens_retention', tick_seconds: 300, started: false },
    ],
    app_limits: { override_count: 2 },
  },
}

function viewOf() {
  const items = rows.map((row) => {
    const override = { ...allNull(), ...row.override }
    const effective = {} as AppLimitValues
    const exceeds: Record<string, boolean> = {}
    for (const key of AXES) {
      effective[key] = override[key] ?? GLOBAL[key]
      exceeds[key] = effective[key] > GLOBAL[key]
    }
    return {
      app_id: row.appId,
      global: GLOBAL,
      override,
      effective,
      exceeds_global: exceeds,
      updated_at: row.updatedAt ?? '2026-10-22T03:00:00Z',
      updated_by: row.updatedBy ?? 'admin',
    }
  })
  return { global: GLOBAL, items, total: items.length }
}

/** 目录查询串由实现拼（`include_deleted=1` 是这一屏的关键，用例单独断言）。 */
function isDirectoryPath(path: string): boolean {
  return path.startsWith(`${WASM_APPS_PATH}?`)
}

beforeEach(() => {
  rows = [
    { appId: 'capped', override: { app_running: 1, user_per_app_running: 1 }, updatedBy: 'alice' },
    { appId: 'hot', override: { app_running: 8 }, updatedBy: 'bob' },
  ]
  directory = [
    { app_id: 'capped', title: '共享便签' },
    { app_id: 'hot', title: '热点应用' },
  ]
  directoryTruncated = false
  overridesMode = 'ok'
  directoryMode = 'ok'
  deleteMode = 'ok'
  runtime = RUNTIME_OK
  deletes = []
  overridesGets = 0
  directoryGets = 0
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const p = String(path)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (p === LIMIT_OVERRIDES_PATH) {
      overridesGets += 1
      if (overridesMode === 'fail') throw new ApiError(500, 'INTERNAL', '读取应用级限流覆盖失败')
      // 形状漂移：没有 items 数组（页面必须说"读不到"，不能说"没有任何覆盖"）。
      if (overridesMode === 'drift') return { global: GLOBAL, total: 1 }
      return viewOf()
    }
    if (isDirectoryPath(p)) {
      directoryGets += 1
      expect(p).toContain('include_deleted=1')
      if (directoryMode === 'fail') throw new ApiError(500, 'INTERNAL', '查询失败')
      return { apps: directory, truncated: directoryTruncated, total: directory.length, limit: 1000, offset: 0 }
    }
    if (p === WASM_RUNTIME_PATH) return runtime
    const matched = p.match(/^\/api\/server\/admin\/wasm-apps\/([^/]+)\/limits$/)
    if (matched && method === 'DELETE') {
      const appId = decodeURIComponent(matched[1])
      expect(p).toBe(appLimitsPath(appId))
      deletes.push(appId)
      if (deleteMode === 'fail') throw DELETE_FAIL
      // 服务端清空：覆盖行消失（下一份清单里不再有该应用）。
      rows = rows.filter((row) => row.appId !== appId)
      return { app_id: appId, changed: true }
    }
    throw new Error(`unexpected request ${method} ${p}`)
  })
})

function openDialog(props: Partial<{ canRead: boolean; canWrite: boolean; onChanged: () => void }> = {}) {
  const onChanged = props.onChanged ?? vi.fn()
  render(
    <LimitOverridesDialog
      open
      onOpenChange={() => {}}
      canRead={props.canRead ?? true}
      canWrite={props.canWrite ?? true}
      onChanged={onChanged}
    />,
  )
  return { onChanged }
}

describe('清单加载（override / effective / 是否高于全局 / 更新人与时间）', () => {
  it('展示两行覆盖：override 与 effective 分列，高于全局的行被标出', async () => {
    openDialog()
    await screen.findByTestId('limit-overrides-row-capped')
    expect(screen.getByTestId('limit-overrides-row-hot')).toBeInTheDocument()

    // 降额行：app_running 有覆盖（1）、app_queue 继承，生效值 = 覆盖 ?? 全局。
    expect(screen.getByTestId('limit-overrides-axis-capped-app_running').textContent).toContain('生效 1')
    expect(screen.getByTestId('limit-overrides-axis-capped-app_queue').textContent).toContain('继承')
    // hot 把 app_running 放宽到 8 > 全局 4：必须有「高于全局」标记，且该轴用行内提示。
    expect(screen.getByTestId('limit-overrides-exceeds-hot').textContent).toContain('高于全局')
    expect(screen.getByTestId('limit-overrides-axis-hot-app_running').textContent).toContain('生效')
    expect(screen.queryByTestId('limit-overrides-exceeds-capped')).toBeNull()

    // 标题来自应用目录（覆盖端点只给 app_id）；更新人来自覆盖行。
    expect(screen.getByTestId('limit-overrides-row-capped').textContent).toContain('共享便签')
    expect(screen.getByTestId('limit-overrides-meta-capped').textContent).toContain('alice')
  })

  it('全局基线随清单一起展示（继承值的来源必须看得见）', async () => {
    openDialog()
    const global = await screen.findByTestId('limit-overrides-global')
    expect(global.textContent).toContain('app_running=4')
    expect(global.textContent).toContain('user_per_app_running=2')
  })
})

describe('逐行「恢复默认」= DELETE /:app_id/limits（成功后回读，不乐观更新）', () => {
  it('发 DELETE，成功后再 GET 清单，行按服务端回读结果消失', async () => {
    const { onChanged } = openDialog()
    await screen.findByTestId('limit-overrides-row-capped')
    const getsBefore = overridesGets

    fireEvent.click(screen.getByTestId('limit-overrides-reset-capped'))

    await waitFor(() => expect(deletes).toEqual(['capped']))
    // 回读：服务端的下一份清单里没有 capped ⇒ 行消失；这才是"已清空"的证据。
    await waitFor(() => expect(screen.queryByTestId('limit-overrides-row-capped')).toBeNull())
    expect(overridesGets).toBeGreaterThan(getsBefore)
    expect(screen.getByTestId('limit-overrides-row-hot')).toBeInTheDocument()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.getByTestId('limit-overrides-flash').textContent).toContain('已恢复默认')
    expect(screen.getByTestId('limit-overrides-flash').textContent).toContain('wasm_app_limits_change')
  })

  it('失败不乐观更新：行与覆盖摘要不动，服务端信封原样显示（含 404 的两种含义）', async () => {
    deleteMode = 'fail'
    openDialog()
    await screen.findByTestId('limit-overrides-row-capped')
    const before = screen.getByTestId('limit-overrides-axis-capped-app_running').textContent

    fireEvent.click(screen.getByTestId('limit-overrides-reset-capped'))

    const error = await screen.findByTestId('limit-overrides-action-error')
    expect(error.textContent).toContain('应用不存在或已删除')
    // 行仍在（没有本地删除），覆盖摘要一个字都没变。
    expect(screen.getByTestId('limit-overrides-row-capped')).toBeInTheDocument()
    expect(screen.getByTestId('limit-overrides-axis-capped-app_running').textContent).toBe(before)
    expect(screen.queryByTestId('limit-overrides-flash')).toBeNull()
  })

  it('无 capability:write：按钮禁用且不发 DELETE', async () => {
    openDialog({ canWrite: false })
    await screen.findByTestId('limit-overrides-row-capped')
    const button = screen.getByTestId('limit-overrides-reset-capped')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(deletes).toEqual([])
  })
})

describe('空态 / 错误态 / 形状漂移（三句不同的话）', () => {
  it('没有任何覆盖：明确说「所有应用按全局准入」，且不为此去拉应用目录', async () => {
    rows = []
    openDialog()
    const empty = await screen.findByTestId('limit-overrides-empty')
    expect(empty.textContent).toContain('没有任何按应用的限流覆盖')
    expect(screen.queryByTestId('limit-overrides-list')).toBeNull()
    expect(directoryGets).toBe(0)
  })

  it('清单读取失败：错误可见 + 重试能恢复（不是"没有覆盖"）', async () => {
    overridesMode = 'fail'
    openDialog()
    const error = await screen.findByTestId('limit-overrides-error')
    expect(error.textContent).toContain('读取应用级限流覆盖失败')
    expect(screen.queryByTestId('limit-overrides-empty')).toBeNull()

    overridesMode = 'ok'
    fireEvent.click(screen.getByTestId('limit-overrides-retry'))
    await screen.findByTestId('limit-overrides-row-capped')
    expect(screen.queryByTestId('limit-overrides-error')).toBeNull()
  })

  it('响应缺 items 数组 ⇒ 解析失败（不得渲染成「没有任何覆盖」）', async () => {
    overridesMode = 'drift'
    openDialog()
    const error = await screen.findByTestId('limit-overrides-error')
    expect(error.textContent).toContain('没有覆盖清单数组')
    expect(screen.queryByTestId('limit-overrides-empty')).toBeNull()
  })
})

describe('已删除 / 已清除的应用（覆盖行保留是设计语义）', () => {
  it('已删除：行可见并标出，恢复默认可点被禁用、不发 DELETE', async () => {
    rows = [{ appId: 'gone', override: { app_queue: 1 } }]
    directory = [{ app_id: 'gone', title: '已删除应用', deleted_at: '2026-10-01T00:00:00Z' }]
    openDialog()
    await screen.findByTestId('limit-overrides-row-gone')
    await waitFor(() => expect(screen.getByTestId('limit-overrides-state-gone').textContent).toContain('应用已删除'))
    const notice = screen.getByTestId('limit-overrides-lifecycle-gone')
    expect(notice.textContent).toContain('恢复')
    expect(notice.textContent).toContain('404')
    const button = screen.getByTestId('limit-overrides-reset-gone')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(deletes).toEqual([])
  })

  it('已清除：行可见并说明「不可恢复、也不再需要清空」', async () => {
    rows = [{ appId: 'wiped', override: { app_running: 1 } }]
    directory = [
      { app_id: 'wiped', title: '已清除应用', deleted_at: '2026-10-01T00:00:00Z', purged_at: '2026-10-10T00:00:00Z' },
    ]
    openDialog()
    await screen.findByTestId('limit-overrides-row-wiped')
    await waitFor(() => expect(screen.getByTestId('limit-overrides-state-wiped').textContent).toContain('应用已清除'))
    const notice = screen.getByTestId('limit-overrides-lifecycle-wiped')
    expect(notice.textContent).toContain('不可恢复')
    expect(screen.getByTestId('limit-overrides-reset-wiped')).toBeDisabled()
  })
})

describe('应用目录读失败（降级但不说谎）', () => {
  it('状态未知：行仍可见、仍可尝试清空（服务端 404 会如实报出）', async () => {
    directoryMode = 'fail'
    openDialog()
    await screen.findByTestId('limit-overrides-row-capped')
    await waitFor(() => {
      expect(screen.getByTestId('limit-overrides-lifecycle-capped').textContent).toContain('应用状态未知')
    })
    // 目录失败不等于"应用已删"：按钮仍然可点（真实的 404 由服务端回答）。
    const button = screen.getByTestId('limit-overrides-reset-capped')
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(deletes).toEqual(['capped']))
  })
})

describe('运行时水位（只读摘要；缺读数 ≠ 0）', () => {
  it('queue 的全局水位/429 与 top_apps、schedulers（含 wasm_retirement）都可见', async () => {
    openDialog()
    const queue = await screen.findByTestId('limit-overrides-queue')
    expect(queue.textContent).toContain('在跑 2')
    expect(queue.textContent).toContain('排队 5')
    expect(queue.textContent).toContain('11')
    expect(screen.getByTestId('limit-overrides-top-app-capped').textContent).toContain('排队 4')
    const retirement = screen.getByTestId('limit-overrides-scheduler-wasm_retirement')
    expect(retirement.textContent).toContain('运行中')
    expect(retirement.textContent).toContain('清理失败：样例错误')
    expect(retirement.textContent).toContain('真删')
    expect(screen.getByTestId('limit-overrides-scheduler-wasm_opens_retention').textContent).toContain('未启动')
  })

  it('服务端未下发 queue / schedulers：说"未下发"，不渲染成 0', async () => {
    runtime = { runtime: {} }
    openDialog()
    const missing = await screen.findByTestId('limit-overrides-queue-missing')
    expect(missing.textContent).toContain('未下发')
    expect(missing.textContent).toContain('不是 0')
    expect(screen.getByTestId('limit-overrides-schedulers-missing').textContent).toContain('未下发')
  })

  it('运行时读失败不拖垮覆盖清单：两条错误各自可见', async () => {
    runtime = null // 解析失败（没有 runtime 段）
    openDialog()
    const runtimeError = await screen.findByTestId('limit-overrides-runtime-error')
    expect(runtimeError.textContent).toContain('读取运行时水位失败')
    await screen.findByTestId('limit-overrides-row-capped')
  })
})

describe('无读权限', () => {
  it('一个请求都不发，只说明权限要求', async () => {
    openDialog({ canRead: false })
    expect((await screen.findByTestId('limit-overrides-no-permission')).textContent).toContain('capability:read')
    expect(overridesGets).toBe(0)
    expect(directoryGets).toBe(0)
  })
})
