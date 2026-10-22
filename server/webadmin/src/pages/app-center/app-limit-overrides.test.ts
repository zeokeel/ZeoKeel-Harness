/**
 * 覆盖总览的契约层用例（`GET /wasm-apps/limit-overrides`）。
 *
 * 咬的是**行为**（形状漂移怎么处理、0 与 null 怎么归一、错误怎么归一），不是"文件里有
 * 某个字符串"：
 *
 *   - `{global, items:[{app_id, global, override, effective, exceeds_global, updated_at,
 *     updated_by}], total}` 与服务端 `AdminAppLimitsList` 逐字对齐；
 *   - `override` 的 `0`（后端 `AppOverride` 的继承哨兵）/ 缺键 ⇒ `null`；
 *   - 缺 `items`、缺某行的 `effective`、重复 `app_id` ⇒ **整份解析失败**（不能把"读不到"
 *     或"形状漂移"渲染成"只有这些例外"）；
 *   - `total` 与行数不一致 ⇒ 两个数字都保留（界面必须显式说出来）；
 *   - 404 的文案只指向**总览端点**（不是"某个应用不存在"）。
 *
 * 变异自证（删实现 ⇒ 红）：去掉 items 数组校验 ⇒ 第 3 条红；去掉重复 app_id 检查 ⇒
 * 第 5 条红；缺 effective 时用 global 兜底 ⇒ 第 4 条红（会 ok:true）；readOverride 不再
 * 归一 0 ⇒ 第 2 条红。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api'
import {
  APP_LIMIT_KEYS,
  LIMIT_OVERRIDES_PATH,
  limitOverridesErrorText,
  overrideAxisRows,
  overrideResetReceipt,
  parseAppLimitOverrides,
  type AppLimitValues,
} from './app-limits'

const GLOBAL: AppLimitValues = {
  app_running: 4,
  app_queue: 32,
  user_per_app_running: 2,
  user_per_app_queued: 4,
}

/** 服务端真实形态（`adminLimitsList` 的 item = 单应用视图 + updated_at/updated_by）。 */
function rawList(overrides: Record<string, unknown> = {}) {
  return {
    global: GLOBAL,
    items: [
      {
        app_id: 'capped',
        global: GLOBAL,
        // 后端 `AppOverride` 的 JSON 恒有四个键，0 = 继承。
        override: { app_running: 0, app_queue: 1, user_per_app_running: 0, user_per_app_queued: null },
        effective: { app_running: 4, app_queue: 1, user_per_app_running: 2, user_per_app_queued: 4 },
        exceeds_global: { app_running: false, app_queue: false, user_per_app_running: false, user_per_app_queued: false },
        updated_at: '2026-10-22T03:00:00Z',
        updated_by: 'alice',
      },
      {
        app_id: 'hot',
        global: GLOBAL,
        override: { app_running: 8, app_queue: null, user_per_app_running: null, user_per_app_queued: null },
        effective: { app_running: 8, app_queue: 32, user_per_app_running: 2, user_per_app_queued: 4 },
        exceeds_global: { app_running: true, app_queue: false, user_per_app_running: false, user_per_app_queued: false },
        updated_at: '2026-10-22T04:00:00Z',
        updated_by: 'bob',
      },
    ],
    total: 2,
    ...overrides,
  }
}

describe('路径', () => {
  it('总览打静态段 /limit-overrides（不会被 /:app_id 吞掉）', () => {
    expect(LIMIT_OVERRIDES_PATH).toBe('/api/server/admin/wasm-apps/limit-overrides')
  })
})

describe('解析（服务端字段逐字对齐）', () => {
  it('两行的 override / effective / 越界 / 更新时间与人都读出来', () => {
    const parsed = parseAppLimitOverrides(rawList())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.total).toBe(2)
    expect(parsed.value.serverTotal).toBe(2)
    expect(parsed.value.global).toEqual(GLOBAL)
    const [capped, hot] = parsed.value.items
    expect(capped.appId).toBe('capped')
    // 0 与 null 都归一成「继承」——界面上"继承"只有一种表示。
    expect(capped.override.app_running).toBeNull()
    expect(capped.override.user_per_app_queued).toBeNull()
    expect(capped.override.app_queue).toBe(1)
    expect(capped.effective.app_running).toBe(4)
    expect(capped.exceedsAny).toBe(false)
    expect(capped.updatedBy).toBe('alice')
    expect(hot.exceedsAny).toBe(true)
    expect(hot.exceedsGlobal.app_running).toBe(true)
    expect(hot.exceedsFromServer).toBe(true)
    expect(hot.updatedAt).toBe('2026-10-22T04:00:00Z')
  })

  it('行级 global 缺省时回落总览顶层的 global（同一次请求的同一个值）', () => {
    const raw = rawList()
    delete (raw.items[0] as Record<string, unknown>).global
    const parsed = parseAppLimitOverrides(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.items[0].global).toEqual(GLOBAL)
  })

  it('缺 items 数组 ⇒ 解析失败（不是「没有任何覆盖」）', () => {
    const parsed = parseAppLimitOverrides({ global: GLOBAL, total: 0 })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('items')
  })

  it('某行缺 effective ⇒ 整份失败（生效值不许由前端现推）', () => {
    const raw = rawList()
    delete (raw.items[1] as Record<string, unknown>).effective
    const parsed = parseAppLimitOverrides(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('hot')
    expect(parsed.reason).toContain('effective')
  })

  it('重复 app_id ⇒ 整份失败（0087 主键保证唯一，重复只能是形状漂移）', () => {
    const raw = rawList()
    const dup = { ...raw.items[1], app_id: 'capped' }
    raw.items.push(dup)
    const parsed = parseAppLimitOverrides(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toContain('重复')
  })

  it('服务端 total 与行数不一致 ⇒ 两个数字都保留（界面必须说出来）', () => {
    const parsed = parseAppLimitOverrides(rawList({ total: 9 }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.total).toBe(2)
    expect(parsed.value.serverTotal).toBe(9)
  })

  it('非对象响应 ⇒ 解析失败', () => {
    expect(parseAppLimitOverrides(null).ok).toBe(false)
    expect(parseAppLimitOverrides('[]').ok).toBe(false)
  })
})

describe('每行的四轴明细（渲染顺序 = 请求体键序）', () => {
  it('顺序固定、继承显示为 null、越界轴带标记', () => {
    const parsed = parseAppLimitOverrides(rawList())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const rows = overrideAxisRows(parsed.value.items[1])
    expect(rows.map((row) => row.key)).toEqual([...APP_LIMIT_KEYS])
    expect(rows[0]).toMatchObject({ override: 8, effective: 8, exceeds: true })
    expect(rows[1]).toMatchObject({ override: null, effective: 32, exceeds: false })
  })
})

describe('错误归一（404 只指向总览端点）', () => {
  it('404：说明总览端点可能未就绪，并指出单应用入口仍可用', () => {
    const text = limitOverridesErrorText(new ApiError(404, 'NOT_FOUND', '请求的资源不存在'), '读取限流覆盖失败')
    expect(text).toContain(LIMIT_OVERRIDES_PATH)
    expect(text).toContain('详情抽屉')
    // 不能把总览 404 说成"某个应用不存在"（那条判断属于单应用端点）。
    expect(text).not.toContain('已删除应用不能设覆盖')
  })

  it('403：点名 capability:read；其他错误原样透传', () => {
    expect(limitOverridesErrorText(new ApiError(403, 'FORBIDDEN', '无权限'), 'x')).toContain('capability:read')
    expect(limitOverridesErrorText(new ApiError(500, 'INTERNAL', '读取应用级限流覆盖失败'), 'x')).toContain(
      '读取应用级限流覆盖失败',
    )
  })
})

describe('清空覆盖的回执', () => {
  it('写清"四轴全部继承 + 立即生效 + 审计动作"', () => {
    const text = overrideResetReceipt('共享便签')
    expect(text).toContain('共享便签')
    expect(text).toContain('wasm_app_limits_change')
    expect(text).toContain('已在跑的请求不会被打断')
  })
})
