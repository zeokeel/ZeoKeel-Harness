/**
 * WASM 应用「限流」的管理台契约（设计 `docs/decisions/2026-10-22-wasm-per-app-limits.md`
 * §2.1 模型 / §2.3 API / §2.5 管理台 / §2.6 测试判据）。
 *
 * ## 这一层解决的是什么问题
 *
 * 全局只有一套旋钮（`settings.wasm.limits`）：某个应用异常时管理员只能整体冻结，没有
 * "单独限流/降额"这一档。per-app 覆盖把**四轴**（`app_running` / `app_queue` /
 * `user_per_app_running` / `user_per_app_queued`）做成按应用可空的值 ——
 * **NULL = 继承全局**，非空 = 该应用的显式覆盖；生效值 = 全局复制后套用非空覆盖，
 * 再复用同一份 `applimits.Validate()`。
 *
 * 本文件只做纯函数（不碰 DOM、不发请求），页面拿它把契约里的一句话变成可测的行为：
 *
 *   - 路径只在这里拼（`GET/PUT /api/server/admin/wasm-apps/:app_id/limits`）；
 *   - 响应的**形状校验**（缺 `global`/`effective` ⇒ 解析失败，让页面说「读取失败」，
 *     绝不当成「没有覆盖 / 全部继承全局」—— 那是把「读不到」说成「没有」）；
 *   - 请求体构造：空 = 继承 ⇒ `null`（**顶层 null = 清空全部覆盖**，与全局控制台的
 *     `PUT /wasm-apps/limits {limits:null}` 同语义）；只覆盖一部分时逐轴写
 *     `number | null`（null = 这一轴恢复继承）；
 *   - 保存前的 `effective` 预览与 `exceeds_global` 判定（见下）；
 *   - 错误码 → 可执行的指引（`VALIDATION` 点名哪个轴、404 的两种含义）。
 *
 * ## `exceeds_global` 的两种来源（必须分开说）
 *
 * 契约 §2.3 的响应带 `exceeds_global`（**已保存状态**的服务端判定），而管理台要在
 * **保存之前**就把「这次保存会让该应用比其他应用多占槽位」说出来 —— 那一刻服务端还没
 * 见过新值。因此：
 *
 *   - `view.exceedsGlobal` = 服务端判定（有了就采信，逐轴布尔）；
 *   - `previewExceeds()` = 页面按 `生效值 > 全局值` 推导**待保存**的越界轴，保存前用来决定
 *     是否弹二次确认。
 *
 * 两句话在界面上分开渲染（"当前已保存的覆盖超过全局" vs "这次保存后该应用会超过全局"），
 * 不合并成一句 —— 合并会让"我刚改的值越界了吗"这个问题的答案取决于上一次保存。
 *
 * ## 后端契约（2026-10-22 已由服务端 `api/admin_limits_app.go` 落地；形状按 §2.1/§2.3）
 *
 * | 端点 | 方法 | 前端读的字段 |
 * | --- | --- | --- |
 * | `/wasm-apps/:app_id/limits` | GET | `app_id`；`global{四轴}`；`override{四轴 → number/null}`；`effective{四轴}`；`exceeds_global{四轴 → bool}`（或顶层布尔） |
 * | `/wasm-apps/:app_id/limits` | PUT | body `{四轴: number|null}` 或 `null`（清空）；响应 = 同一视图 + `changed` |
 *
 * 四条假设（后端若选择别的形态，只需改本文件）：
 *   ① `exceeds_global` 逐轴对象优先；顶层布尔（§2.1 的 "exceeds_global: true"）也认，
 *      此时逐轴明细由页面按 `effective > global` 推导（`exceedsFromServer=false`）；
 *   ② `override` 里缺键与 `null` 同义（= 继承）；
 *   ③ PUT 的 `null` 顶层与「四轴全 null 的对象」同义（§2.3：null/空对象 = 清空覆盖）；
 *   ④ 已删除/已清除应用：写面 404（不泄露存在性）⇒ 管理台对这两种行**不渲染写入口**，
 *      也不发请求（见 `limitsWriteGate`）。
 */
import { errorField, errorHints, errorText } from '../../lib/api-error'
import {
  appPath,
  isDeleted,
  isPurged,
  WASM_APPS_PATH,
  type AppLifecycleFields,
  type ParseResult,
} from './apps-lifecycle'

// ---------------------------------------------------------------------------
// 四轴（顺序即渲染顺序；与 Limits.tsx 的 FIELDS 同序、同标签口径）
// ---------------------------------------------------------------------------

export const APP_LIMIT_KEYS = [
  'app_running',
  'app_queue',
  'user_per_app_running',
  'user_per_app_queued',
] as const

export type AppLimitKey = (typeof APP_LIMIT_KEYS)[number]

/** 四轴的完整取值（`global` / `effective`）。 */
export type AppLimitValues = Record<AppLimitKey, number>

/** 覆盖（`null` = 该轴继承全局）。 */
export type AppLimitOverride = Record<AppLimitKey, number | null>

/** 逐轴布尔（`exceeds_global` 的归一形态）。 */
export type AppLimitFlags = Record<AppLimitKey, boolean>

/** 表单草稿：**空串 = 继承全局**（不是 0，也不是"保持原值"）。 */
export type AppLimitDraft = Record<AppLimitKey, string>

/** 每轴的标签与语义（措辞与全局限制项页一致，避免同一个旋钮两套说法）。 */
export const APP_LIMIT_META: Record<AppLimitKey, { label: string; hint: string }> = {
  app_running: {
    label: '单应用并发',
    hint: '同一应用最多 N 个请求同时在跑（读并发；写仍串行）；超限进队列。调大不增加内存上界（实例池乘数是全局并发）',
  },
  app_queue: {
    label: '单应用队列长度',
    hint: '超过并发后允许排队的请求数，再多的直接 429',
  },
  user_per_app_running: {
    label: '单用户单应用并发',
    hint: '单个用户在同一应用内同时能占用的实例数；必须 ≤ 本应用的「单应用并发」',
  },
  user_per_app_queued: {
    label: '单用户单应用排队',
    hint: '一个用户在同一应用队列里的占位上限；必须 ≤ 本应用的「单应用队列长度」',
  },
}

/** `GET/PUT/DELETE /api/server/admin/wasm-apps/:app_id/limits`（§2.3 管理面，cookie 会话 + RBAC）。 */
export function appLimitsPath(appId: string): string {
  return `${appPath(appId)}/limits`
}

/**
 * `GET /api/server/admin/wasm-apps/limit-overrides` —— **全部**应用级限流覆盖的总览。
 *
 * 为什么需要它（生产化评审「管理员视角」的已知缺口）：单应用 GET 只能逐个应用翻，
 * "哪些应用被单独限流/降额、有没有已删应用的残留覆盖"是排查平台公平性的第一入口。
 * 服务端 2026-10-22 落地（`wasmapp/api/admin_limits_app.go` 的 `AdminAppLimitsList`）：
 * 只读、`capability:read`、**不分页**（覆盖是例外配置），响应 `{global, items, total}`。
 *
 * 静态段 `/limit-overrides` 不会被 `/:app_id` 吞掉（gin 静态优先），与 `/limits`（全局
 * 四轴）也是两层语义：那条是**设置**，这条是**例外清单**。
 */
export const LIMIT_OVERRIDES_PATH = `${WASM_APPS_PATH}/limit-overrides`

// ---------------------------------------------------------------------------
// 响应视图
// ---------------------------------------------------------------------------

export interface AppLimitsView {
  appId: string
  /** 全局四值（输入框的占位符 = 这里的值）。 */
  global: AppLimitValues
  /** 该应用的覆盖（`null` = 继承）。 */
  override: AppLimitOverride
  /** 生效值（服务端算好的：全局复制后套用非空覆盖，再过同一个 Validate）。 */
  effective: AppLimitValues
  /** **当前已保存状态**的逐轴越界判定（服务端有就采信，没有则按 effective > global 推导）。 */
  exceedsGlobal: AppLimitFlags
  /** 是否有任一轴超过全局（服务端给顶层布尔时也能读出来）。 */
  exceedsAny: boolean
  /** 逐轴判定是否来自服务端（false = 页面推导，界面上要说清依据）。 */
  exceedsFromServer: boolean
  /** PUT 的 `changed`（GET 恒为 null；缺失不编造）。 */
  changed: boolean | null
}

/** 一个轴的值是否是「合法数字」：正整数（0 不是合法值——四轴的下界都是 1）。 */
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 1
}

/** 读四轴完整取值；缺任何一个键就返回 null（**不**用 1 或 0 补齐：那是编造）。 */
function readValues(raw: unknown): AppLimitValues | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const out = {} as AppLimitValues
  for (const key of APP_LIMIT_KEYS) {
    const value = obj[key]
    if (!isPositiveInt(value)) return null
    out[key] = value
  }
  return out
}

/**
 * 读覆盖：缺键 / `null` / **0** ⇒ `null`（= 继承）。
 *
 * `0` 这一形态来自后端真源（`wasmapp/applimits/appoverride.go` 的 `AppOverride`：
 * 四个 `int` 字段 + `0 = 继承全局` 的哨兵，JSON 里四个键**恒存在**）。管理台一律归一成
 * `null`，这样界面上"继承"只有一种表示 —— 输入框留空、占位符显示全局值。
 */
function readOverride(raw: unknown): AppLimitOverride {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = {} as AppLimitOverride
  for (const key of APP_LIMIT_KEYS) {
    const value = obj[key]
    out[key] = isPositiveInt(value) ? value : null
  }
  return out
}

/**
 * 读 `exceeds_global`：对象（逐轴布尔）/ 顶层布尔（§2.1 的 `exceeds_global: true`）/ 缺失。
 *
 * 三种形态分开返回，页面据此决定"这句话是谁说的"（服务端判定 vs 页面推导）。
 */
function readExceeds(
  raw: unknown,
  effective: AppLimitValues,
  global: AppLimitValues,
): { flags: AppLimitFlags; any: boolean; fromServer: boolean } {
  const derived = {} as AppLimitFlags
  let derivedAny = false
  for (const key of APP_LIMIT_KEYS) {
    derived[key] = effective[key] > global[key]
    if (derived[key]) derivedAny = true
  }
  if (raw === true || raw === false) {
    // 顶层布尔只能回答"有没有任何一轴越界"，逐轴明细仍要靠页面推导。
    return { flags: derived, any: raw || derivedAny, fromServer: false }
  }
  if (raw === null || typeof raw !== 'object') {
    return { flags: derived, any: derivedAny, fromServer: false }
  }
  const obj = raw as Record<string, unknown>
  const flags = {} as AppLimitFlags
  let any = false
  let seen = false
  for (const key of APP_LIMIT_KEYS) {
    const value = obj[key]
    if (typeof value === 'boolean') seen = true
    flags[key] = typeof value === 'boolean' ? value : derived[key]
    if (flags[key]) any = true
  }
  return seen ? { flags, any, fromServer: true } : { flags: derived, any: derivedAny, fromServer: false }
}

/**
 * 解析限流响应（GET / PUT 同一个视图，PUT 多一个 `changed`）。
 *
 * 形状不对 ⇒ `ok:false`（页面说「读取限流失败」）。**不得**把缺 `global` 的响应当成
 * 「全部继承全局」—— 占位符会变成空、生效值会变成编造的数字，管理员据此判断"没问题"。
 */
export function parseAppLimitsView(raw: unknown): ParseResult<AppLimitsView> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: '响应不是对象（这不是「全部继承全局」，请核对服务端接口）' }
  }
  const body = raw as Record<string, unknown>
  const global = readValues(body.global)
  if (global === null) {
    return { ok: false, reason: '响应里没有完整的 global 四值（这不是「全部继承全局」，请核对服务端接口）' }
  }
  const effective = readValues(body.effective)
  if (effective === null) {
    return { ok: false, reason: '响应里没有完整的 effective 四值（不能拿 global 冒充生效值；请核对服务端接口）' }
  }
  const override = readOverride(body.override)
  const exceeds = readExceeds(body.exceeds_global, effective, global)
  return {
    ok: true,
    value: {
      appId: typeof body.app_id === 'string' ? body.app_id : '',
      global,
      override,
      effective,
      exceedsGlobal: exceeds.flags,
      exceedsAny: exceeds.any,
      exceedsFromServer: exceeds.fromServer,
      changed: typeof body.changed === 'boolean' ? body.changed : null,
    },
  }
}

// ---------------------------------------------------------------------------
// 表单草稿 ↔ 请求体
// ---------------------------------------------------------------------------

/** 空草稿（四轴全空 = 全部继承全局）。 */
export function emptyLimitsDraft(): AppLimitDraft {
  return { app_running: '', app_queue: '', user_per_app_running: '', user_per_app_queued: '' }
}

/** 由已保存的视图生成草稿（覆盖有值 ⇒ 数字串；`null` ⇒ 空串）。 */
export function draftFromView(view: AppLimitsView): AppLimitDraft {
  const draft = emptyLimitsDraft()
  for (const key of APP_LIMIT_KEYS) {
    const value = view.override[key]
    draft[key] = value === null ? '' : String(value)
  }
  return draft
}

/**
 * 请求体的两种形态（§2.3）：
 *   - `null` —— **清空全部覆盖**（四轴全部恢复继承全局）；
 *   - 对象 —— 逐轴 `number`（显式覆盖）或 `null`（该轴恢复继承）。
 */
export type AppLimitsRequestBody = Record<AppLimitKey, number | null> | null

/** 草稿解析结果：`invalid` 是格式不合法的轴（范围/序关系留给服务端的 `applimits.Validate`）。 */
export type LimitsDraftResult =
  | { ok: true; body: AppLimitsRequestBody; allInherit: boolean }
  | { ok: false; invalid: AppLimitKey[]; reason: string }

/**
 * 草稿 ⇒ 请求体。
 *
 * 纪律（与全局限制项页同口径）：**前端不另写一份判据**。这里只判"格式"（空串以外的
 * 内容必须是正整数），范围（`app_running ≤ max_instances`）与序关系
 * （`user_per_app_running ≤ app_running`）一律交给服务端 `applimits.Validate`，它的
 * `details.field` 由 `limitsErrorText` 原样渲染。否则前端会出现第二套规则，迟早漂移。
 *
 * 四轴全空 ⇒ **顶层 `null`**（清空全部覆盖）。部分覆盖时四轴**都写进对象**（未填的轴写
 * `null`）——这样"这一轴恢复继承"是显式动作，不依赖服务端对"缺键"的解释（假设 ③）。
 */
export function parseLimitsDraft(draft: AppLimitDraft): LimitsDraftResult {
  const values = {} as Record<AppLimitKey, number | null>
  const invalid: AppLimitKey[] = []
  for (const key of APP_LIMIT_KEYS) {
    const raw = (draft[key] ?? '').trim()
    if (raw === '') {
      values[key] = null
      continue
    }
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) {
      invalid.push(key)
      values[key] = null
      continue
    }
    values[key] = n
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      invalid,
      reason:
        `这些字段必须填正整数（或留空表示继承全局）：${invalid
          .map((key) => `${key}（${APP_LIMIT_META[key].label}）`)
          .join('、')}。范围与序关系由服务端校验（applimits.Validate）。`,
    }
  }
  const allInherit = APP_LIMIT_KEYS.every((key) => values[key] === null)
  return { ok: true, body: allInherit ? null : values, allInherit }
}

// ---------------------------------------------------------------------------
// 保存前的预览（effective / exceeds_global）
// ---------------------------------------------------------------------------

/** 保存后的生效值预览：逐轴 `覆盖 ?? 全局`。 */
export function previewEffective(global: AppLimitValues, draft: AppLimitDraft): AppLimitValues {
  const out = {} as AppLimitValues
  for (const key of APP_LIMIT_KEYS) {
    const raw = (draft[key] ?? '').trim()
    const n = raw === '' ? NaN : Number(raw)
    out[key] = Number.isInteger(n) && n >= 1 ? n : global[key]
  }
  return out
}

/** 保存后的越界轴：`生效值 > 全局值`（§2.1 允许高于全局，但要显式提示）。 */
export function previewExceeds(global: AppLimitValues, effective: AppLimitValues): AppLimitFlags {
  const out = {} as AppLimitFlags
  for (const key of APP_LIMIT_KEYS) out[key] = effective[key] > global[key]
  return out
}

export function exceededKeys(flags: AppLimitFlags): AppLimitKey[] {
  return APP_LIMIT_KEYS.filter((key) => flags[key])
}

export function anyExceeds(flags: AppLimitFlags): boolean {
  return APP_LIMIT_KEYS.some((key) => flags[key])
}

/**
 * 越界警告（保存前二次确认框的正文）。
 *
 * 每一轴都写成"全局 X → 该应用 Y"的对比，并说明代价：**该应用会比其他应用占用更多槽位**
 * （同样的全局上界下，它一个应用能吃掉更多并发/队列位置）。§2.1 的取向是允许（管理员显式
 * 动作），但不允许"悄悄发生"——所以必须二次确认。
 */
export function exceedsWarningText(global: AppLimitValues, effective: AppLimitValues): string {
  const lines = exceededKeys(previewExceeds(global, effective)).map(
    (key) => `${APP_LIMIT_META[key].label}：全局 ${global[key]} → 该应用 ${effective[key]}`,
  )
  return (
    `该应用会比其他应用占用更多槽位：${lines.join('；')}。` +
    '这仍是允许的（管理员显式动作，绝对上界不变），但它会挤占同一进程里其他应用的并发/队列位置。' +
    '确认后再提交；取消则不发送任何请求。'
  )
}

/** 草稿是否与已保存的覆盖不同（决定「保存」是否可点，以及是否真的会发 PUT）。 */
export function limitsDraftDirty(view: AppLimitsView, draft: AppLimitDraft): boolean {
  const saved = draftFromView(view)
  return APP_LIMIT_KEYS.some((key) => (saved[key] ?? '') !== (draft[key] ?? '').trim())
}

/** 当前是否已存在任何覆盖（决定「恢复默认」是否可点）。 */
export function limitsHasOverride(view: AppLimitsView): boolean {
  return APP_LIMIT_KEYS.some((key) => view.override[key] !== null)
}

/**
 * 覆盖的一句话（`app_running=4、app_queue=继承`）：界面上"到底覆盖了什么"必须一眼可见。
 *
 * 用**服务端字段名**而不是中文标签：这四个名字是审计 detail、服务端校验错误
 * (`details.field`) 与设计文档里共用的那一套 —— 回执里写字段名，管理员才能把它和
 * 审计页/错误信息对上。
 */
export function overrideAxisSummary(override: AppLimitOverride): string {
  return APP_LIMIT_KEYS.map((key) => `${key}=${override[key] === null ? '继承' : String(override[key])}`).join('、')
}

/** 单应用视图的覆盖摘要（总览的每行与详情块的汇总行共用同一实现）。 */
export function overrideSummary(view: { override: AppLimitOverride }): string {
  return overrideAxisSummary(view.override)
}

/** 生效值的一句话（输入行的预览与回执共用）。 */
export function effectiveSummary(effective: AppLimitValues): string {
  return APP_LIMIT_KEYS.map((key) => `${key}=${effective[key]}`).join('、')
}

const AUDIT_ACTION = 'wasm_app_limits_change'

/**
 * 保存/清空的回执（写清三件事：这次改了什么、其余仍继承、审计动作名）。
 *
 * `changed === false` 时必须说"没有变更"（§2.6 判据 5：无变化重复 PUT 不写审计），
 * 不能让管理员以为刚写进去了一条覆盖。
 */
export function limitsReceipt(view: AppLimitsView, action: 'save' | 'reset'): string {
  const audit = `本次动作写入审计 ${AUDIT_ACTION}（detail 含 app_id、四个覆盖值与 actor_role=admin_session）。`
  if (view.changed === false) {
    return `没有变更：服务端回报 changed=false（覆盖与提交值一致，未写审计）。当前覆盖：${overrideSummary(view)}。`
  }
  if (action === 'reset') {
    return (
      '已恢复默认：四个轴全部继承全局（覆盖已清空，立刻按全局值准入；已在跑的请求不会被打断）。' +
      audit
    )
  }
  return (
    `已保存：${overrideSummary(view)}；其余轴继承全局。` +
    `服务端回读的生效值：${effectiveSummary(view.effective)}。保存后即时生效（只影响新准入，收紧不会打断已在跑的请求）。` +
    audit
  )
}

// ---------------------------------------------------------------------------
// 写入口闸门（已删除 / 已清除 / 无写权限）
// ---------------------------------------------------------------------------

export interface LimitsWriteGate {
  /** 是否允许渲染写入口（保存 / 恢复默认）。 */
  writable: boolean
  /** 是否允许读取（已删除/已清除的应用连 GET 也不发：写面 404 不泄露存在性，读面同口径）。 */
  readable: boolean
  /** 不可写/不可读的原因（可见文本，不藏在 title 里）。 */
  reason: string
}

/**
 * 限流块的写入口闸门（与详情抽屉的生命周期动作同口径）。
 *
 * §2.3：应用不存在 / 已删除 ⇒ 404（写面不泄露存在性；已删除应用不能设覆盖）。管理台照此
 * 收敛：已删除（含保留期内）与已清除的应用**不渲染写入口、也不发请求** —— 渲染出来必然
 * 404，管理员只会得到"点了没反应"。恢复（restore）之后重新打开抽屉即可配置。
 */
export function limitsWriteGate(app: AppLifecycleFields | null | undefined, canWrite: boolean): LimitsWriteGate {
  if (isPurged(app)) {
    return {
      writable: false,
      readable: false,
      reason:
        '该应用数据已清除（purged）：限流覆盖不可读也不可写 —— 已删除/已清除的应用在服务端一律 404（写面不泄露存在性）。',
    }
  }
  if (isDeleted(app)) {
    return {
      writable: false,
      readable: false,
      reason:
        '该应用已删除（保留期内）：不能设置限流覆盖 —— 服务端对已删除应用返回 404（写面不泄露存在性）。' +
        '先在详情抽屉点「恢复」，恢复后即可按应用配置限流。',
    }
  }
  if (!canWrite) {
    return {
      writable: false,
      readable: true,
      reason: '当前账号只读（需要 capability:write）：限流覆盖的值可见，保存与「恢复默认」都已禁用（服务端同样会拒绝写请求）。',
    }
  }
  return { writable: true, readable: true, reason: '' }
}

// ---------------------------------------------------------------------------
// 错误归一
// ---------------------------------------------------------------------------

/** 字段名 → 中文标签（服务端 `details.field` 点名时，界面上说人话）。 */
export function limitFieldLabel(field: string): string {
  if (field in APP_LIMIT_META) return `${field}（${APP_LIMIT_META[field as AppLimitKey].label}）`
  return field
}

/**
 * 把一次限流读写失败渲染成**可执行**的文本（服务端 message + 字段 + hints 原样保留）。
 *
 * 三类要补一句"下一步点哪里"：
 *   - `VALIDATION`（400/422）：判据是 `applimits.Validate` 那一份 —— 序关系
 *     （`user_per_app_running ≤ app_running`、`user_per_app_queued ≤ app_queue`）与绝对上界；
 *   - 404：**两种含义**（端点未就绪 / 应用不存在或已删除），不能只报一种；
 *   - 403：缺 `capability:write`。
 *
 * 其余错误码原样透传（不吞服务端信息）。
 */
export function limitsErrorText(err: unknown, fallback: string): string {
  const base = errorText(err, fallback)
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : ''
  const status = typeof (err as { status?: unknown } | null)?.status === 'number' ? (err as { status: number }).status : 0
  const field = errorField(err)
  if (code === 'VALIDATION' || status === 400 || status === 422) {
    const which = field === '' ? '' : `被拒的字段：${limitFieldLabel(field)}。`
    return (
      `${base} ${which}` +
      '判据只有服务端一份（applimits.Validate）：单用户单应用并发 ≤ 单应用并发、单用户单应用排队 ≤ 单应用队列长度，' +
      '且不得超过绝对上界（全局并发实例数 / 队列上限）；每行输入框的占位符就是全局默认值。'
    ).trim()
  }
  if (status === 403) {
    return `${base}；需要 capability:write 权限才能修改限流覆盖（前端禁用只是体验层，服务端会同样拒绝）。`
  }
  if (status === 404) {
    return (
      `${base}；服务端返回 404，只有两种可能：① 该端点在该部署里尚未提供（不可用；` +
      'GET/PUT /api/server/admin/wasm-apps/:app_id/limits）；② 应用不存在或已删除' +
      '（写面 404 不泄露存在性，已删除应用不能设覆盖）。已删除的行请在详情抽屉点「恢复」后再配置。'
    )
  }
  return base
}

/** 错误里的 hints（读取/保存失败的提示要保留服务端建议）。 */
export function limitsErrorHints(err: unknown): string[] {
  return errorHints(err)
}

// ---------------------------------------------------------------------------
// 覆盖总览（`GET /wasm-apps/limit-overrides`）
//
// 生产化评审「管理员视角」的已知缺口：per-app 覆盖此前**只能逐个应用翻详情抽屉**，
// 于是"哪些应用被单独限流/降额""已删应用是否留着残留覆盖"没有可发现面。本段是那份
// 清单的契约层：路径、形状校验、错误归一、每行摘要（纯函数，不碰 DOM）。
//
// 三条纪律（与单应用视图同口径，`AppLimitsView` 怎么处理这里就怎么处理）：
//   ① `global` / `effective` 缺轴 ⇒ 整份**解析失败**（页面说「读取失败」）；
//      `effective` 绝不由前端按 `override ?? global` 现推 —— 服务端的生效规则里
//      继承的子轴会随父轴收紧**向下钳**（决策 §4「套用规则唯一实现」），在管理台重写
//      一遍就是第二份判据，迟早与调度器分叉；
//   ② `override` 的缺键 / `null` / `0`（后端 `AppOverride` 的 0 = 继承哨兵）一律归一成
//      `null`，界面上"继承"只有一种表示；
//   ③ 一条坏行 ⇒ 整份失败，**不跳过**。跳过会让"读到了 N 条、其中一条形状漂移"变成
//      "这张表就是全部例外"的假陈述 —— 管理员据此判断"只有这些应用被限流过"。
// ---------------------------------------------------------------------------

/** 总览里的一行（服务端 `adminLimitsList` 的 item：单应用视图 + app_id/updated_at/updated_by）。 */
export interface AppLimitOverrideRow {
  appId: string
  /** 该行对应的全局四值（服务端逐行下发；缺省时回落总览顶层的 `global`，两处同源）。 */
  global: AppLimitValues
  override: AppLimitOverride
  effective: AppLimitValues
  exceedsGlobal: AppLimitFlags
  exceedsAny: boolean
  /** 逐轴判定是否来自服务端（false = 页面推导，界面上要说清依据）。 */
  exceedsFromServer: boolean
  /** 该覆盖最后一次写入时刻（服务端 `updated_at`）；空/缺失 ⇒ null（不编造）。 */
  updatedAt: string | null
  /** 最后写入者（服务端 `updated_by`）；空/缺失 ⇒ null。 */
  updatedBy: string | null
}

/** 覆盖总览视图（`{global, items, total}`）。 */
export interface AppLimitOverridesView {
  global: AppLimitValues
  items: AppLimitOverrideRow[]
  /**
   * 屏幕上实际渲染的行数（= `items.length`）。
   *
   * 标题里的「限流覆盖（N）」用它 —— 管理员能一行行数出来的数字，才是可核对的数字。
   */
  total: number
  /**
   * 服务端下发的 `total`（契约上恒等于 `len(items)`）。
   *
   * 与 `items.length` 不一致 ⇒ 形状漂移（不是"少显示了几条"这么简单：说明两端对
   * "例外清单"的边界已经有分歧），界面必须显式说出来，**不能**二选一地静默。
   */
  serverTotal: number | null
}

/** 读一个"时间串"：非空字符串采信（`fmtTime` 负责格式化），其余 null。 */
function readTimeString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null
}

/**
 * 解析覆盖总览。
 *
 * 形状不对 ⇒ `ok:false`（页面说「读取限流覆盖失败」）。**不得**把"响应里没有清单数组"
 * 当成"当前没有任何覆盖" —— 前者是读不到，后者是"所有应用都按全局值准入"，两者在
 * 排查公平性时结论完全相反。
 */
export function parseAppLimitOverrides(raw: unknown): ParseResult<AppLimitOverridesView> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: '响应不是对象（这不是「没有任何覆盖」，请核对服务端接口）' }
  }
  const body = raw as Record<string, unknown>
  const global = readValues(body.global)
  if (global === null) {
    return { ok: false, reason: '响应里没有完整的 global 四值（这不能当成「没有任何覆盖」，请核对服务端接口）' }
  }
  if (!Array.isArray(body.items)) {
    return {
      ok: false,
      reason: '响应里没有覆盖清单数组 `items`（这不是「没有任何覆盖」，是清单读不到；请核对服务端接口）',
    }
  }
  const items: AppLimitOverrideRow[] = []
  const seen = new Set<string>()
  for (let i = 0; i < body.items.length; i += 1) {
    const rawItem = body.items[i]
    if (rawItem === null || typeof rawItem !== 'object') {
      return { ok: false, reason: `覆盖清单第 ${i + 1} 行不是对象（清单形状漂移，整份不采信）` }
    }
    const item = rawItem as Record<string, unknown>
    const appId = typeof item.app_id === 'string' ? item.app_id.trim() : ''
    if (appId === '') {
      return { ok: false, reason: `覆盖清单第 ${i + 1} 行没有 app_id（清单形状漂移，整份不采信）` }
    }
    if (seen.has(appId)) {
      // 0087 的主键是 app_id ⇒ 重复行只能是形状漂移（或两段数据拼错）。静默去重会让
      // "同一个应用出现两条不同覆盖"这件事被 UI 吞掉。
      return { ok: false, reason: `覆盖清单里 app_id=${appId} 出现重复行（清单形状漂移，整份不采信）` }
    }
    seen.add(appId)
    // 行级 global 缺省时回落顶层 global：两处是同一次请求里同一个服务端值，不是编造。
    const rowGlobal = item.global === undefined ? global : readValues(item.global)
    if (rowGlobal === null) {
      return { ok: false, reason: `覆盖清单第 ${i + 1} 行（app_id=${appId}）的 global 四值不完整（整份不采信）` }
    }
    const effective = readValues(item.effective)
    if (effective === null) {
      return {
        ok: false,
        reason: `覆盖清单第 ${i + 1} 行（app_id=${appId}）没有完整的 effective 四值（不能拿 global 或覆盖现推生效值；整份不采信）`,
      }
    }
    const override = readOverride(item.override)
    const exceeds = readExceeds(item.exceeds_global, effective, rowGlobal)
    items.push({
      appId,
      global: rowGlobal,
      override,
      effective,
      exceedsGlobal: exceeds.flags,
      exceedsAny: exceeds.any,
      exceedsFromServer: exceeds.fromServer,
      updatedAt: readTimeString(item.updated_at),
      updatedBy: readTimeString(item.updated_by),
    })
  }
  return {
    ok: true,
    value: {
      global,
      items,
      total: items.length,
      serverTotal: typeof body.total === 'number' && Number.isFinite(body.total) ? body.total : null,
    },
  }
}

/** 总览每行的四轴明细（渲染顺序 = 请求体键序 = 审计 detail 的字段序）。 */
export interface OverrideAxisRow {
  key: AppLimitKey
  label: string
  /** `null` = 该轴继承全局。 */
  override: number | null
  effective: number
  /** 该轴是否超过全局（= 该应用比其他应用多占槽位的那一轴）。 */
  exceeds: boolean
}

export function overrideAxisRows(row: {
  override: AppLimitOverride
  effective: AppLimitValues
  exceedsGlobal: AppLimitFlags
}): OverrideAxisRow[] {
  return APP_LIMIT_KEYS.map((key) => ({
    key,
    label: APP_LIMIT_META[key].label,
    override: row.override[key],
    effective: row.effective[key],
    exceeds: row.exceedsGlobal[key],
  }))
}

/** 该行的标题（有标题用标题，否则用 app_id —— 应用被真删后标题只剩占位）。 */
export function overrideRowLabel(row: { appId: string }, title: string | null | undefined): string {
  const t = (title ?? '').trim()
  return t === '' ? row.appId : t
}

/**
 * 清空某应用覆盖（`DELETE /wasm-apps/:app_id/limits`）的回执。
 *
 * 与单应用详情块「恢复默认」同语义：立即生效、只影响新准入、审计留痕。
 */
export function overrideResetReceipt(label: string): string {
  return (
    `已恢复默认：${label} 的四轴全部继承全局（覆盖已清空，立即按全局值准入；已在跑的请求不会被打断）。` +
    '本次动作写入审计 wasm_app_limits_change（detail 含 app_id、四个覆盖值 null 与 actor_role=admin_session）。'
  )
}

/**
 * 覆盖总览读失败的可执行文本（与 `limitsErrorText` 分家：这里的 404 只可能意味着
 * **总览端点**未就绪，而不是"某个应用不存在"—— 后者在总览里根本不是错误）。
 */
export function limitOverridesErrorText(err: unknown, fallback: string): string {
  const base = errorText(err, fallback)
  const status = typeof (err as { status?: unknown } | null)?.status === 'number' ? (err as { status: number }).status : 0
  if (status === 403) {
    return `${base}；需要 capability:read 权限才能查看全部应用的限流覆盖（服务端同样会拒绝读请求）。`
  }
  if (status === 404) {
    return (
      `${base}；服务端返回 404：该部署可能尚未提供覆盖总览端点（GET ${LIMIT_OVERRIDES_PATH}）。` +
      '逐个应用的详情抽屉「限流」块不受影响，仍可单独查看与修改。'
    )
  }
  return base
}
