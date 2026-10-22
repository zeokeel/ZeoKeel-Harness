/**
 * per-app 限流覆盖 · 契约层用例（契约 `docs/decisions/2026-10-22-wasm-per-app-limits.md`
 * §2.1 模型 / §2.3 API / §2.5 管理台 / §2.6 判据 7）。
 *
 * 这一组咬的是**行为**（路径、请求体形态、形状漂移的处理、错误归一），不是"文件里有某个字符串"：
 *
 *   - 路径只在契约层拼：`GET/PUT /api/server/admin/wasm-apps/:app_id/limits`，app_id 必须转义；
 *   - `override` 缺键与 `null` 同义（= 继承）；`global`/`effective` 缺任何一个轴 ⇒ **解析失败**
 *     （绝不拿 global 冒充 effective，也绝不把"读不到"渲染成"全部继承"）；
 *   - 请求体：四轴全空 ⇒ **顶层 `null`**（清空全部覆盖）；部分覆盖 ⇒ 四轴都写进对象，
 *     未填的轴写 `null`（显式"恢复继承"）；
 *   - `exceeds_global` 三种形态（逐轴对象 / 顶层布尔 / 缺失）都要能读，并且分开说
 *     "这是服务端判定"还是"页面按 生效值 > 全局值 推导"；
 *   - 范围与序关系**不在前端判**（`applimits.Validate` 是唯一判据），前端只判格式；
 *   - 已删除 / 已清除的应用没有写入口（服务端 404，不泄露存在性）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api'
import {
  anyExceeds,
  APP_LIMIT_KEYS,
  appLimitsPath,
  draftFromView,
  effectiveSummary,
  exceededKeys,
  exceedsWarningText,
  limitsDraftDirty,
  limitsErrorText,
  limitsHasOverride,
  limitsReceipt,
  limitsWriteGate,
  limitFieldLabel,
  overrideSummary,
  parseAppLimitsView,
  parseLimitsDraft,
  previewEffective,
  previewExceeds,
  type AppLimitValues,
} from './app-limits'

/** 全局四值：取服务端默认口径（`user_per_app_running` 2026-10-22 起默认 2）。 */
const GLOBAL: AppLimitValues = {
  app_running: 4,
  app_queue: 32,
  user_per_app_running: 2,
  user_per_app_queued: 4,
}

const APP_ID = 'share-note'

/** 一份服务端真实形态的视图（契约 §2.3）：该应用把 `app_running` 覆盖成 6（> 全局 4）。 */
function rawView(overrides: Record<string, unknown> = {}) {
  return {
    app_id: APP_ID,
    global: GLOBAL,
    override: { app_running: 6, app_queue: null, user_per_app_running: null, user_per_app_queued: null },
    effective: { app_running: 6, app_queue: 32, user_per_app_running: 2, user_per_app_queued: 4 },
    exceeds_global: { app_running: true, app_queue: false, user_per_app_running: false, user_per_app_queued: false },
    ...overrides,
  }
}

describe('端点路径（契约 §2.3）', () => {
  it('GET/PUT 都打 /wasm-apps/:app_id/limits，app_id 走 encodeURIComponent', () => {
    expect(appLimitsPath(APP_ID)).toBe('/api/server/admin/wasm-apps/share-note/limits')
    // 应用 id 里可能有 `/` 或空格（历史数据的 app_id 是自由文本）⇒ 必须转义，
    // 否则 `/limits` 会被服务端当成 app_id 的一部分（打到另一个端点/404）。
    expect(appLimitsPath('a b/c')).toBe('/api/server/admin/wasm-apps/a%20b%2Fc/limits')
  })
})

describe('响应解析（形状漂移不得读成「全部继承全局」）', () => {
  it('正常视图：四轴 global/override/effective + 逐轴 exceeds_global', () => {
    const parsed = parseAppLimitsView(rawView())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.appId).toBe(APP_ID)
    expect(parsed.value.global).toEqual(GLOBAL)
    expect(parsed.value.override).toEqual({
      app_running: 6,
      app_queue: null,
      user_per_app_running: null,
      user_per_app_queued: null,
    })
    expect(parsed.value.effective).toEqual({
      app_running: 6,
      app_queue: 32,
      user_per_app_running: 2,
      user_per_app_queued: 4,
    })
    expect(parsed.value.exceedsGlobal.app_running).toBe(true)
    expect(parsed.value.exceedsGlobal.app_queue).toBe(false)
    expect(parsed.value.exceedsAny).toBe(true)
    expect(parsed.value.exceedsFromServer).toBe(true)
    // GET 没有 changed；PUT 才有 —— 缺失时是 null，不编造 true。
    expect(parsed.value.changed).toBeNull()
  })

  it('PUT 的 {视图 + changed:false} 能读出 changed=false（幂等回执要能说「没有变更」）', () => {
    const parsed = parseAppLimitsView(rawView({ changed: false }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.changed).toBe(false)
  })

  it('override 缺键 ⇒ 该轴 = null（继承），不是 0 也不是缺失', () => {
    const parsed = parseAppLimitsView(rawView({ override: { app_running: 3 } }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.override.app_queue).toBeNull()
    expect(parsed.value.override.user_per_app_running).toBeNull()
    expect(parsed.value.override.user_per_app_queued).toBeNull()
  })

  it('覆盖用 0 作继承哨兵（后端 AppOverride 的真实序列化）⇒ 归一成 null', () => {
    // `wasmapp/applimits.AppOverride` 是四个 int + `0 = 继承全局`，JSON 里四个键恒存在：
    // 若把 0 当成"覆盖值 0"，界面会显示 app_running=0（一个永远不合法的并发值）。
    const parsed = parseAppLimitsView(
      rawView({
        override: { app_running: 0, app_queue: 0, user_per_app_running: 0, user_per_app_queued: 0 },
        effective: GLOBAL,
        exceeds_global: { app_running: false, app_queue: false, user_per_app_running: false, user_per_app_queued: false },
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.override).toEqual({
      app_running: null,
      app_queue: null,
      user_per_app_running: null,
      user_per_app_queued: null,
    })
    expect(limitsHasOverride(parsed.value)).toBe(false)
  })

  it('缺 global / 缺 effective / 非对象 ⇒ 解析失败，且理由指向服务端接口', () => {
    for (const raw of [
      {},
      { app_id: APP_ID, global: GLOBAL }, // 没有 effective
      { app_id: APP_ID, global: GLOBAL, effective: { app_running: 6 } }, // effective 不完整
      { app_id: APP_ID, global: { app_running: 4 }, effective: GLOBAL }, // global 不完整
      null,
      'ok',
    ]) {
      const parsed = parseAppLimitsView(raw)
      expect(parsed.ok, `${JSON.stringify(raw)} 必须解析失败`).toBe(false)
      if (parsed.ok) continue
      expect(parsed.reason).toMatch(/服务端接口/)
    }
  })

  it('exceeds_global 是顶层布尔时：只回答「有没有越界」，逐轴明细由页面推导（并标明来源）', () => {
    const parsed = parseAppLimitsView(rawView({ exceeds_global: true }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.exceedsAny).toBe(true)
    expect(parsed.value.exceedsFromServer).toBe(false)
    // 推导口径 = 生效值 > 全局值：app_running 6 > 4。
    expect(parsed.value.exceedsGlobal.app_running).toBe(true)
    expect(parsed.value.exceedsGlobal.app_queue).toBe(false)
  })

  it('exceeds_global 缺失时按 effective > global 推导（不当成「没有越界」）', () => {
    const raw = rawView()
    delete (raw as Record<string, unknown>).exceeds_global
    const parsed = parseAppLimitsView(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.exceedsFromServer).toBe(false)
    expect(parsed.value.exceedsGlobal.app_running).toBe(true)
  })
})

describe('请求体（空 = 继承；null = 清空全部覆盖）', () => {
  it('四轴全空 ⇒ 顶层 null（不是空对象、不是四个 0）', () => {
    const out = parseLimitsDraft({
      app_running: '',
      app_queue: '  ',
      user_per_app_running: '',
      user_per_app_queued: '',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.body).toBeNull()
    expect(out.allInherit).toBe(true)
    expect(JSON.stringify(out.body)).toBe('null')
  })

  it('部分覆盖 ⇒ 四轴都写进对象，未填的轴写 null（显式「恢复继承」）', () => {
    const out = parseLimitsDraft({
      app_running: '6',
      app_queue: '',
      user_per_app_running: '3',
      user_per_app_queued: '',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.body).toEqual({
      app_running: 6,
      app_queue: null,
      user_per_app_running: 3,
      user_per_app_queued: null,
    })
    expect(JSON.stringify(out.body)).toBe(
      '{"app_running":6,"app_queue":null,"user_per_app_running":3,"user_per_app_queued":null}',
    )
  })

  it('格式不合法（0 / 负数 / 小数 / 字面量）⇒ 拒发并把字段点名（范围与序关系留给服务端）', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '4x']) {
      const out = parseLimitsDraft({
        app_running: bad,
        app_queue: '',
        user_per_app_running: '',
        user_per_app_queued: '',
      })
      expect(out.ok, `${bad} 必须被前端拒发`).toBe(false)
      if (out.ok) continue
      expect(out.invalid).toEqual(['app_running'])
      expect(out.reason).toContain('app_running')
      expect(out.reason).toContain('单应用并发')
    }
  })

  it('序关系**不在**前端判（user_per_app_running 3 > app_running 2 仍照发，由 applimits.Validate 拒）', () => {
    const out = parseLimitsDraft({
      app_running: '2',
      app_queue: '',
      user_per_app_running: '3',
      user_per_app_queued: '',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.body).toEqual({
      app_running: 2,
      app_queue: null,
      user_per_app_running: 3,
      user_per_app_queued: null,
    })
  })
})

describe('保存前的预览（effective / exceeds_global）', () => {
  it('生效值 = 覆盖 ?? 全局（空串继承、非法串不编造数字）', () => {
    const effective = previewEffective(GLOBAL, {
      app_running: '6',
      app_queue: '',
      user_per_app_running: '0',
      user_per_app_queued: '7',
    })
    expect(effective).toEqual({
      app_running: 6,
      app_queue: 32, // 空 ⇒ 继承
      user_per_app_running: 2, // 非法 ⇒ 按继承预览（真正提交会被 parseLimitsDraft 拒）
      user_per_app_queued: 7,
    })
  })

  it('越界判定逐轴（生效值 > 全局值），并给出可读的确认文案', () => {
    const effective = previewEffective(GLOBAL, {
      app_running: '6',
      app_queue: '',
      user_per_app_running: '2',
      user_per_app_queued: '9',
    })
    const flags = previewExceeds(GLOBAL, effective)
    expect(exceededKeys(flags)).toEqual(['app_running', 'user_per_app_queued'])
    expect(anyExceeds(flags)).toBe(true)
    const text = exceedsWarningText(GLOBAL, effective)
    expect(text).toContain('占用更多槽位')
    expect(text).toContain('单应用并发：全局 4 → 该应用 6')
    expect(text).toContain('单用户单应用排队：全局 4 → 该应用 9')
  })

  it('全部不超过全局 ⇒ 没有越界轴（不该弹确认框）', () => {
    const effective = previewEffective(GLOBAL, {
      app_running: '4',
      app_queue: '',
      user_per_app_running: '',
      user_per_app_queued: '',
    })
    expect(anyExceeds(previewExceeds(GLOBAL, effective))).toBe(false)
  })
})

describe('草稿与已保存视图的比较', () => {
  const parsed = parseAppLimitsView(rawView())
  if (!parsed.ok) throw new Error('fixture 必须可解析')
  const view = parsed.value

  it('draftFromView：覆盖有值 ⇒ 数字串，null ⇒ 空串（占位符才是全局默认）', () => {
    expect(draftFromView(view)).toEqual({
      app_running: '6',
      app_queue: '',
      user_per_app_running: '',
      user_per_app_queued: '',
    })
  })

  it('dirty / hasOverride / 摘要', () => {
    const saved = draftFromView(view)
    expect(limitsDraftDirty(view, saved)).toBe(false)
    expect(limitsDraftDirty(view, { ...saved, app_running: '7' })).toBe(true)
    // 尾随空格的输入不算改动（trim 后比较）。
    expect(limitsDraftDirty(view, { ...saved, app_running: '6 ' })).toBe(false)
    expect(limitsHasOverride(view)).toBe(true)
    expect(overrideSummary(view)).toBe(
      'app_running=6、app_queue=继承、user_per_app_running=继承、user_per_app_queued=继承',
    )
    expect(effectiveSummary(view.effective)).toBe(
      'app_running=6、app_queue=32、user_per_app_running=2、user_per_app_queued=4',
    )
  })

  it('没有任何覆盖时 hasOverride=false（「恢复默认」该禁用）', () => {
    const empty = parseAppLimitsView(
      rawView({ override: {}, effective: GLOBAL, exceeds_global: {} }),
    )
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(limitsHasOverride(empty.value)).toBe(false)
  })
})

describe('写入口闸门（已删除 / 已清除 / 无写权限）', () => {
  it('已清除（purged）：不可读也不可写（服务端 410/404，连 GET 都不该发）', () => {
    const gate = limitsWriteGate(
      { deleted_at: '2026-10-01T00:00:00Z', purged_at: '2026-12-01T00:00:00Z' },
      true,
    )
    expect(gate.writable).toBe(false)
    expect(gate.readable).toBe(false)
    expect(gate.reason).toContain('已清除')
  })

  it('已删除（保留期内）：不可读也不可写，且指出恢复入口', () => {
    const gate = limitsWriteGate({ deleted_at: '2026-10-01T00:00:00Z' }, true)
    expect(gate.writable).toBe(false)
    expect(gate.readable).toBe(false)
    expect(gate.reason).toContain('已删除')
    expect(gate.reason).toContain('恢复')
  })

  it('无 capability:write：可读、不可写（禁用原因必须是可见文本）', () => {
    const gate = limitsWriteGate({ deleted_at: null }, false)
    expect(gate.writable).toBe(false)
    expect(gate.readable).toBe(true)
    expect(gate.reason).toContain('capability:write')
  })

  it('正常在架 + 有写权限：可读可写，没有多余文案', () => {
    const gate = limitsWriteGate({ frozen_at: '2026-10-01T00:00:00Z' }, true)
    expect(gate).toEqual({ writable: true, readable: true, reason: '' })
  })
})

describe('错误归一（服务端信封原样保留 + 下一步点哪里）', () => {
  it('VALIDATION：保留 message / 字段 / hints，并点名 applimits.Validate 的序关系', () => {
    const err = new ApiError(
      422,
      'VALIDATION',
      '单用户单应用并发不能大于单应用并发',
      undefined,
      ['全局 app_running=4，本次提交 user_per_app_running=5'],
      { field: 'user_per_app_running' },
    )
    const text = limitsErrorText(err, '保存限流失败')
    expect(text).toContain('单用户单应用并发不能大于单应用并发')
    expect(text).toContain('字段 user_per_app_running')
    expect(text).toContain('全局 app_running=4，本次提交 user_per_app_running=5')
    expect(text).toContain('applimits.Validate')
    // 字段名要说人话（同一个旋钮两套说法会让管理员对不上审计/设计文档）。
    expect(limitFieldLabel('user_per_app_running')).toBe('user_per_app_running（单用户单应用并发）')
  })

  it('404 说清两种含义（端点未就绪 / 应用不存在或已删除），不只报一种', () => {
    const text = limitsErrorText(new ApiError(404, 'NOT_FOUND', '请求的资源不存在'), '保存限流失败')
    expect(text).toContain('尚未提供')
    expect(text).toContain('已删除')
  })

  it('403 指向 capability:write；未知错误原样透传', () => {
    expect(limitsErrorText(new ApiError(403, 'FORBIDDEN', '没有权限'), 'x')).toContain('capability:write')
    expect(limitsErrorText(new ApiError(500, 'INTERNAL', '上游炸了'), 'x')).toBe('上游炸了')
  })
})

describe('回执（写清改了什么 + 审计动作名）', () => {
  const parsed = parseAppLimitsView(rawView())
  if (!parsed.ok) throw new Error('fixture 必须可解析')

  it('保存回执：覆盖明细 + 生效值 + 即时生效 + 审计动作', () => {
    const text = limitsReceipt(parsed.value, 'save')
    expect(text).toContain('app_running=6')
    expect(text).toContain('app_queue=32')
    expect(text).toContain('wasm_app_limits_change')
    expect(text).toContain('新准入')
  })

  it('恢复默认回执：说清四轴全部继承（不是"保存成功"一句了事）', () => {
    const text = limitsReceipt(parsed.value, 'reset')
    expect(text).toContain('全部继承全局')
    expect(text).toContain('wasm_app_limits_change')
  })

  it('changed:false ⇒ 明说「没有变更」（幂等 PUT 不写审计）', () => {
    const same = parseAppLimitsView(rawView({ changed: false }))
    expect(same.ok).toBe(true)
    if (!same.ok) return
    const text = limitsReceipt(same.value, 'save')
    expect(text).toContain('没有变更')
    expect(text).toContain('未写审计')
  })
})

describe('四轴常量（顺序 = 渲染顺序 = 请求体键序）', () => {
  it('恰好四个键且顺序固定', () => {
    expect(APP_LIMIT_KEYS).toEqual([
      'app_running',
      'app_queue',
      'user_per_app_running',
      'user_per_app_queued',
    ])
  })
})
