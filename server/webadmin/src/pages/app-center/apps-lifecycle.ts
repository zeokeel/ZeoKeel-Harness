/**
 * WASM 应用「生命周期动作面」的管理台契约（设计 `docs/planning/2026-10-22-wasm-lifecycle-redesign.md`
 * §6 API 契约 / §6.2 管理面端点 / §7 Webadmin 契约）。
 *
 * ## 这一层解决的是什么问题
 *
 * 审计 C-01/C-02/C-03/C-04 的共同形态是「承诺与实现分叉」：冻结确认框承诺「到期由后台任务
 * 真删」而后台任务不存在；导出/删除/恢复/回滚在管理面**一个入口都没有**；「已删除」筛选
 * 存在但没有动作可用；错误提示让人「联系平台管理员」而管理员自己也没有那个能力。
 *
 * 本文件把「契约里的端点、契约里的字段、以及每句话到底承诺了什么」收敛成**一份可被用例
 * 直接咬住的实现**（纯函数，不碰 DOM、不发请求）：
 *
 *   - 端点路径只在这里拼（页面不得再散落字符串，端点改名会一次性改到这里）；
 *   - 服务端响应的**形状校验**（缺字段 ⇒ 返回解析失败，让页面说「读取失败」，
 *     绝不当成「没有部署历史 / 没有待审版本」—— 那是把「读不到」说成「没有」，F6 的形态）；
 *   - 生命周期块的行（frozen_at / deleted_at / purge_after / snapshot_at / purged_at）；
 *   - 冻结 / 删除确认框的文案：**按设计 §5.4/§5.5 的真实语义**写，含快照前置条件与
 *     `purge_after` 的具体日期；不再有「后台任务」这类没有执行者的措辞；
 *   - 错误码 → 真实可执行的指引（`APP_PURGED` / `APP_DELETED` / `RELEASE_NOT_DEPLOYABLE`…），
 *     并把服务端 404 里「如需恢复请联系平台管理员」这种误导替换成本页真实存在的恢复入口。
 *
 * ## 后端契约假设（后端泳道 L 尚未合入时按设计 §6 写；不一致处在交付说明里列出）
 *
 * | 端点 | 方法 | 前端读的字段 |
 * | --- | --- | --- |
 * | `/wasm-apps/releases/pending` | GET | `pending[]`：`app_id` `title` `version` `publisher` `age_seconds`/`created_at` `current_version`；顶层 `total`（全量计数） |
 * | `/wasm-apps/:app_id/deployments` | GET | `deployments[]`：`id` `version` `kind` `actor` `actor_role` `message` `created_at` `current`；顶层 `current_version` |
 * | `/wasm-apps/:app_id/deployments` | POST | body `{version, message?}`；响应 `changed` `kind` `version` `current_version` `deployment` |
 * | `/wasm-apps/review` | PUT | body `{required}`；响应 `review_required` `changed` `pending_releases` `note` |
 * | `/wasm-apps/:app_id/restore` | POST | 响应 `app`：`deleted` `deleted_at` `frozen_at` `purge_after` `enabled` |
 * | `/wasm-apps/:app_id` | DELETE | 响应 `app`：`deleted_at` `frozen_at` `purge_after` `snapshot_at` `snapshot_error` `purged_at`；顶层 `retention_days` `snapshot{path,has_database}`（**没有** ok/at） |
 * | `/wasm-apps/:app_id/export` | GET | 查询串 `database=1` / `database=1&assets=1`；`application/zip` 或 JSON 控制面 |
 * | `/wasm-apps`（列表） | GET | 行上额外读 `purge_after` `snapshot_at` `snapshot_error` `purged_at`；顶层读 `retirement_snapshot_retention_days` / `retention_days` |
 * | `/wasm-apps/:app_id/schema` | GET | `schema{tables[{name,rows,columns[{name,type,not_null,pk}]}],initialized,table_count,size_bytes,max_bytes,usage_percent}`（C-05 数据面） |
 * | `/wasm-apps/:app_id/rows` | GET | `?table&limit&offset&unmask=1`；`rows{columns[{name,type,sensitive}],rows[[]],total_rows,has_more,returned,unmasked,masked_columns,truncated_values,value_max_bytes}` |
 *
 * 字段缺失时前端**不推测**：保留期天数缺 ⇒ 确认框明说「清理日期由服务端在冻结时登记」，
 * 不编一个自己算的日期出来（那正是 C-01 的假承诺形态）。
 */
import { ApiError, ADMIN_API } from '../../api'
import { errorText, errorHints } from '../../lib/api-error'

// ---------------------------------------------------------------------------
// 端点（设计 §6.2；管理面 cookie 会话 + RBAC，路径前缀只在此处拼）
// ---------------------------------------------------------------------------

/** 应用集合根（列表 GET 也用它）。 */
export const WASM_APPS_PATH = `${ADMIN_API}/wasm-apps`

/** 跨应用待审清单（设计 §5.7 / §6.2；静态段必须在 `/:app_id` 之前注册）。 */
export const PENDING_QUEUE_PATH = `${WASM_APPS_PATH}/releases/pending`

/**
 * 关闭审核后批量清理积压待审版本（设计 §5.7 的「清理动作」；审计 C-08）。
 *
 * 服务端 2026-10-22 落地（`wasmapp/api/admin_retirement.go` 的 adminPurgeStaleReleases）：
 * `POST …/wasm-apps/releases/purge-stale`（capability:write，无 body）。语义与**作者撤回**
 * 逐字一致：`pending → withdrawn`、`archive=NULL/size=0`、reason 固定、版本号永久占用；
 * **审核开关仍开启时 409**（否则等于把"还能被批准的版本"批量清掉）；幂等。
 */
export const PURGE_STALE_PATH = `${WASM_APPS_PATH}/releases/purge-stale`

/** `POST …/releases/purge-stale` 的响应（服务端 `adminPurgeStaleReleases`）。 */
export interface PurgeStaleResponse {
  /** 本次被清理（pending → withdrawn）的版本数。 */
  purged?: number
  changed?: boolean
  status?: string
  reason?: string
  review_required?: boolean
  /** 版本号仍永久占用（`true` = 作者重发必须升版本号）。 */
  version_occupied?: boolean
  note?: string
}

/**
 * 清理积压的确认框文案（设计 §5.7：这是**有代价**的批量动作，必须显式确认）。
 *
 * 三条代价逐条写清：① 这批版本再也不可能被通过（= 作者撤回同款终态）；
 * ② 制品字节立刻释放；③ 版本号永久占用。再加一条**前置条件**：审核开关必须先关
 * （否则服务端 409 —— 这不是页面的猜测，是端点的 fail-closed 判据）。
 */
export function purgeStaleConfirmCopy(): ConfirmCopy {
  return {
    title: '清理积压待审版本',
    intro: '把当前**全部**待审版本一次性置为「已撤回」（withdrawn）：与作者自己撤回同一语义。',
    bullets: [
      '前置条件：审核开关必须**已关闭**。开关仍开启时服务端返回 409（这批版本当时仍可能被通过，不能批量清掉）。',
      '语义 = 作者撤回：状态置为 withdrawn、制品字节释放（不再计入配额）、审核列清空。',
      '版本号**永久占用**：被清理的版本不能复用，作者重发必须升一个更高的版本号。',
      '原子性与幂等：一次事务处理整批；重复调用第二次 purged=0 且不写审计。',
    ],
    irreversible: '清理是**不可逆**的：这批版本不会再出现在待审队列里（审计链保留动作与计数）。',
  }
}

/** 清理积压的回执（数字来自服务端 purged；缺失时不编一个 0）。 */
export function purgeStaleReceipt(out: PurgeStaleResponse | null | undefined): string {
  const purged = typeof out?.purged === 'number' && Number.isFinite(out.purged) ? out.purged : null
  const tail = '被清理的版本号仍永久占用（作者重发需升版本号）；本次动作写入审计 wasm_release_purge_stale。'
  if (purged === null) return `清理请求已提交：服务端未回报清理数量，请刷新队列核对。${tail}`
  if (purged <= 0) return `没有可清理的待审版本（服务端 purged=0，幂等返回）。`
  return `已清理 ${purged} 个待审版本（pending → withdrawn，字节已释放）。${tail}`
}

export function appPath(appId: string): string {
  return `${WASM_APPS_PATH}/${encodeURIComponent(appId)}`
}

/** 版本清单（`status=pending|approved|rejected|all`，服务端 api/admin.go 的 adminReleases）。 */
export function releaseListPath(appId: string, status: string): string {
  return `${appPath(appId)}/releases?status=${encodeURIComponent(status)}`
}

/** 部署历史（GET）/ 部署与回滚（POST）。 */
export function deploymentsPath(appId: string): string {
  return `${appPath(appId)}/deployments`
}

/** 恢复软删（`purged_at` 非空 ⇒ 服务端 410 `APP_PURGED`）。 */
export function restorePath(appId: string): string {
  return `${appPath(appId)}/restore`
}

/** 删除（软删 + 快照 + 保留期）。 */
export function deletePath(appId: string): string {
  return appPath(appId)
}

// ---------------------------------------------------------------------------
// 生命周期字段（设计 §4 的 apps 新列 / §7 的「生命周期」块）
// ---------------------------------------------------------------------------

/**
 * 应用行上的生命周期时间线。
 *
 * 全部**可选**：后端泳道 L 未合入时，管理列表不下发这些列 —— 此时界面显示「—」并明说
 * 「服务端未下发」，而不是把「没下发」渲染成「从未冻结/删除」（那是另一种假陈述）。
 */
export interface AppLifecycleFields {
  frozen_at?: string | null
  deleted_at?: string | null
  purge_after?: string | null
  snapshot_at?: string | null
  snapshot_error?: string | null
  purged_at?: string | null
  /** 两阶段真删的第二阶段：数据目录真的被删掉的时刻（迁移 0088）。
   *  purged_at 已置但本字段为空 = 已不可恢复、但盘上可能仍有残留，调度器在重试。 */
  data_cleaned_at?: string | null
}

/** 判断「有值」：null / undefined / 空串 一律视为未设置（服务端两种形态都出现过）。 */
function hasTime(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

export function isFrozen(app: AppLifecycleFields | null | undefined): boolean {
  return hasTime(app?.frozen_at)
}

export function isDeleted(app: AppLifecycleFields | null | undefined): boolean {
  return hasTime(app?.deleted_at)
}

export function isPurged(app: AppLifecycleFields | null | undefined): boolean {
  return hasTime(app?.purged_at)
}

/** 已清除的不可逆说明（设计 §3.1：purged 之后数据面一律 410，只剩控制面元数据）。 */
export const PURGED_NOTICE =
  '数据已清除，不可恢复：制品、应用库、资源与快照都已删除（设计 §3.1）。' +
  '只剩控制面元数据与部署历史（审计用）；「导出」仅控制面 JSON 仍可用，含数据/含资源的导出会返回 410 APP_PURGED。'

/** purged_at 已置、但数据目录尚未确认清理完（data_cleaned_at 为空）时的如实说明。 */
export const PURGED_CLEANUP_PENDING_NOTICE =
  '数据已进入不可恢复状态（purged_at 已置），但**数据目录清理尚未确认完成**（data_cleaned_at 为空）：' +
  '调度器会继续重试删除并写审计；恢复/含数据导出仍会返回 410 APP_PURGED。' +
  '若长时间不变，请检查服务端日志里的 wasm_retirement 错误与数据根权限/磁盘。'

/** 已清除应用的提示文案：清理完成与否必须分开说（不能只看 purged_at 就宣称"都已删除"）。 */
export function purgeNotice(app: AppLifecycleFields | null | undefined): string {
  return isPurged(app) && !hasTime(app?.data_cleaned_at) ? PURGED_CLEANUP_PENDING_NOTICE : PURGED_NOTICE
}

/** 生命周期块的键（顺序即渲染顺序，与设计 §7 逐项一致）。 */
export const LIFECYCLE_KEYS = ['frozen_at', 'deleted_at', 'purge_after', 'snapshot_at', 'purged_at', 'data_cleaned_at'] as const

export type LifecycleKey = (typeof LIFECYCLE_KEYS)[number]

export interface LifecycleRow {
  key: LifecycleKey
  label: string
  /** 渲染值；未设置时是 '—'（不是空串：空串会让表格看起来少了一列）。 */
  value: string
  /** 该字段的语义说明（title/说明文案），让「—」也能被读懂。 */
  note: string
  /** 服务端下发过这个字段吗（未下发 ⇒ 页面可明说「服务端未下发」）。 */
  present: boolean
}

const LIFECYCLE_META: Record<LifecycleKey, { label: string; note: string }> = {
  frozen_at: { label: '冻结时间', note: '冻结 = 立即停服（交付面一律 404）+ 只读快照；解冻不自动上架' },
  deleted_at: { label: '删除时间', note: '软删的时刻；保留期内可「恢复」（恢复后不自动上架）' },
  purge_after: { label: '清理日期', note: '保留期结束时刻：仅当快照已生成时，调度器才会在这一天之后真删数据（不可恢复）' },
  snapshot_at: { label: '快照时间', note: '只读快照（export.json + app.db 的 VACUUM INTO）生成时刻；**快照不存在时不会清理数据**' },
  purged_at: { label: '清除时间', note: '进入不可恢复终态的时刻（恢复/含数据导出一律 410）；数据目录是否已删干净看下一行' },
  data_cleaned_at: { label: '数据清理时间', note: '数据目录**真的删除**的时刻；为空 = 清理仍在重试（磁盘/权限问题，调度器会继续尝试）' },
}

/**
 * 生命周期块的行（设计 §7 要求的五个时间点，一个不少）。
 *
 * `present=false` 表示该字段**服务端没下发**（不是「从未发生」）—— 页面据此可以把五个
 * 「—」读成「后端还没下发这些列」，而不是「这个应用从没被冻结过」。
 */
export function lifecycleRows(app: AppLifecycleFields | null | undefined): LifecycleRow[] {
  return LIFECYCLE_KEYS.map((key) => {
    const raw = app?.[key]
    const present = raw !== undefined
    return {
      key,
      label: LIFECYCLE_META[key].label,
      value: hasTime(raw) ? fmtTime(raw as string) : '—',
      note: LIFECYCLE_META[key].note,
      present,
    }
  })
}

/** 五个字段一个都没下发 = 后端还没提供生命周期列（页面要说出来，不能装作「一切正常」）。 */
export function lifecycleUnavailable(app: AppLifecycleFields | null | undefined): boolean {
  return !LIFECYCLE_KEYS.some((key) => app?.[key] !== undefined)
}

// ---------------------------------------------------------------------------
// 格式化（列表与抽屉共用；此前是 Apps.tsx 里的本地实现，抽出来给新块复用）
// ---------------------------------------------------------------------------

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

/** 制品体积:MiB 保留一位小数;0/未知回落 '—'(不显示"0 B"这种假精确)。 */
export function fmtSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

// ---------------------------------------------------------------------------
// 保留期与 purge_after（C-01 的核心：日期必须是真日期，不是"到期会自动删"）
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 从响应里读退役保留期天数（`retirement_snapshot_retention_days` 是 limits 表里的真名，
 * `retention_days` 是冻结/删除响应里的短名 —— 两个都认）。
 *
 * 返回 null = 服务端没下发 ⇒ 页面**不推算**清理日期（宁可不显示，也不编一个日期）。
 */
export function retentionDaysOf(
  source: { retirement_snapshot_retention_days?: unknown; retention_days?: unknown } | null | undefined,
): number | null {
  for (const raw of [source?.retirement_snapshot_retention_days, source?.retention_days]) {
    const n = typeof raw === 'string' ? Number(raw) : raw
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return null
}

export interface PurgePlan {
  /** ISO 时刻。 */
  at: string
  /** `server` = 服务端登记的 purge_after；`projected` = 按保留期推算（页面必须标「预计」）。 */
  source: 'server' | 'projected'
  days: number | null
}

/**
 * 清理日期：优先用服务端登记的 `purge_after`；没有则按保留期**推算**并标记为「预计」。
 *
 * 为什么允许推算：冻结确认框是**动作发生之前**的确认框，那一刻服务端还没写下 purge_after，
 * 但管理员必须看到「这个动作会在哪一天变成不可恢复的清理」。推算值一律带「预计」前缀 +
 * 依据（冻结时刻 + 保留期 N 天），冻结完成后由服务端回传的 purge_after 接管。
 */
export function purgePlan(
  app: AppLifecycleFields | null | undefined,
  retentionDays: number | null,
  now: Date = new Date(),
): PurgePlan | null {
  if (hasTime(app?.purge_after)) {
    return { at: app!.purge_after as string, source: 'server', days: retentionDays }
  }
  if (retentionDays === null || retentionDays <= 0) return null
  return { at: new Date(now.getTime() + retentionDays * DAY_MS).toISOString(), source: 'projected', days: retentionDays }
}

/** 清理日期的一句话（服务端日期 vs 预计日期，两种口径分开说）。 */
export function purgeSentence(plan: PurgePlan | null): string {
  if (plan === null) {
    return '清理日期：服务端尚未下发保留期天数，本页**不推算** —— 冻结/删除后由服务端登记 purge_after，页面会显示准确日期。'
  }
  if (plan.source === 'server') {
    return `清理日期（服务端登记的 purge_after）：${fmtTime(plan.at)}`
  }
  return (
    `预计清理日期：${fmtTime(plan.at)}（= 当前时刻 + 保留期 ${plan.days} 天；` +
    '冻结/删除完成后以服务端登记的 purge_after 为准）'
  )
}

// ---------------------------------------------------------------------------
// 冻结 / 删除 / 恢复：确认框文案与回执（真实语义，§5.4 / §5.5）
// ---------------------------------------------------------------------------

export interface ConfirmCopy {
  title: string
  intro: string
  /** 逐条代价/语义（渲染成 ul）。第一条恒为「立即停服」。 */
  bullets: string[]
  /** 底部的不可逆声明（没有可逆性风险时为空串）。 */
  irreversible: string
}

export interface ConfirmContext {
  retentionDays: number | null
  now?: Date
}

/** 冻结确认框（设计 §5.4）：快照是否已生成、清理日期具体到时刻。 */
export function freezeConfirmCopy(app: AppLifecycleFields | null | undefined, ctx: ConfirmContext): ConfirmCopy {
  const plan = purgePlan(app, ctx.retentionDays, ctx.now)
  const snapshotLine = hasTime(app?.snapshot_at)
    ? `只读快照：该应用已有快照（${fmtTime(app!.snapshot_at as string)}），解冻前不会重复生成；清理**只会在快照存在时**执行。`
    : '只读快照：冻结时**立即**生成 export.json 与 app.db 的 VACUUM INTO 快照；' +
      '快照生成失败不阻断冻结，但调度器会重试，且**快照生成前不会删除任何数据**。'
  return {
    title: '冻结应用',
    intro: '冻结是平台级处置动作：它同时停止服务、进入只读快照与保留期，影响该应用的全部使用者。',
    bullets: [
      '立即停服：所有访问一律 404（与上下架状态无关），员工端当场不可用。',
      snapshotLine,
      `${purgeSentence(plan)}；保留期结束后**先检查快照是否存在**，只有快照已生成才会真删应用库/资源/快照。`,
      '如何解冻：本页「解冻」按钮即可恢复；解冻后需要重新上架才会对员工可见（不会自动上架）。',
    ],
    irreversible: '保留期结束、快照存在且调度器执行真删之后**不可恢复**（元数据与部署历史留作审计）。',
  }
}

/** 删除确认框（设计 §5.5）：删除前必须快照（快照失败 = 删除失败）；保留期内可恢复。 */
export function deleteConfirmCopy(app: AppLifecycleFields | null | undefined, ctx: ConfirmContext): ConfirmCopy {
  const plan = purgePlan(app, ctx.retentionDays, ctx.now)
  return {
    title: '删除应用',
    intro: '删除是软删：先冻结并生成只读快照，再进入保留期；保留期内可恢复，到期且快照存在时才真删数据。',
    bullets: [
      '立即停服：删除同时冻结该应用，所有访问一律 404，员工端当场不可用。',
      '删除前必须生成只读快照（export.json + app.db 的 VACUUM INTO）：' +
        '**快照生成失败 = 删除失败**，不会留下「已删除但没有快照」的状态。',
      `${purgeSentence(plan)}；保留期内可在本页把状态筛选切到「已删除」后点「恢复」（恢复后不自动上架）。`,
      '制品字节在软删时立即释放（不再计入配额）；版本元数据行与部署历史永久保留（审计用）。',
    ],
    irreversible: '到期真删之后**不可恢复**：应用库、资源与快照都会被删除，只剩元数据。',
  }
}

/** 恢复回执（设计 §5.5：清 deleted_at/frozen_at、enabled=0、不自动上架）。 */
export function restoreReceipt(app: { enabled?: boolean } | null | undefined): string {
  const enabled = app?.enabled === true
  return (
    '已恢复：删除与冻结状态已清除，保留期取消（不会再有到期清理）；' +
    (enabled
      ? '服务端返回该应用仍在架 —— 请核对，恢复动作本身不会自动上架。'
      : '应用保持下架（恢复不自动上架），需要在应用行点「上架」才对员工恢复服务。')
  )
}

/**
 * 生命周期动作的响应（冻结 / 删除）。
 *
 * 形状以**后端真实实现**为准（`wasmapp/api/lifecycle_actions.go`），并保留设计文档里可能
 * 出现的嵌套形态作为兼容：
 *   - 冻结：`{app:{…, purge_after, snapshot_at?, snapshot_ok, snapshot_error?}, note}`
 *     —— 快照结果在 **app 段**（`snapshot_ok`/`snapshot_error`），没有顶层 retention_days；
 *   - 删除：`{app:{…, purge_after, snapshot_at}, retention_days, snapshot:{path,has_database}, note}`
 *     —— 顶层 retention_days 有，snapshot 段**没有** ok/at（时间在 app.snapshot_at）。
 */
export interface LifecycleActionResult {
  app?: (AppLifecycleFields & { enabled?: boolean; snapshot_ok?: boolean; snapshot_path?: string }) | null
  retention_days?: unknown
  snapshot?: { ok?: boolean; at?: string; error?: string; path?: string; has_database?: boolean } | null
  note?: string
  changed?: boolean
}

export type DeleteResultView = LifecycleActionResult

/**
 * 快照结果的统一读取（两处形态归一，页面对"快照成功/失败/未知"只判一次）。
 *
 * 反证 F-9：删除响应的 `snapshot` 段**只有** `path`/`has_database`，快照时刻在
 * `app.snapshot_at`（`lifecycle_actions.go` 的 deleteWasmApp）。旧夹具却给了
 * `snapshot:{ok,at}` —— 于是"删掉 `app.snapshot_at` 回退"也能全绿，而生产回执会退化成
 * 「服务端未回传快照状态」。这里把四种来源**分开**读出来，夹具必须用真实形状。
 */
export function snapshotOutcome(result: LifecycleActionResult | null | undefined): {
  ok: boolean | null
  at: string | null
  error: string
  /** 快照目录/文件路径（删除响应的 `snapshot.path`；没有就是空串）。 */
  path: string
  /** 快照里是否含 `app.db`（删除响应的 `snapshot.has_database`；没下发就是 null）。 */
  hasDatabase: boolean | null
} {
  const app = result?.app ?? {}
  const ok =
    typeof result?.snapshot?.ok === 'boolean'
      ? result.snapshot.ok
      : typeof app.snapshot_ok === 'boolean'
        ? app.snapshot_ok
        : null
  const at = result?.snapshot?.at ?? app.snapshot_at ?? null
  const error = result?.snapshot?.error ?? app.snapshot_error ?? ''
  return {
    ok,
    at: at !== null && at !== '' ? at : null,
    error,
    path: typeof result?.snapshot?.path === 'string' ? result.snapshot.path : '',
    hasDatabase: typeof result?.snapshot?.has_database === 'boolean' ? result.snapshot.has_database : null,
  }
}

/** 快照结果的一句话（删除/冻结回执共用；`ok/at/hasDatabase` 三种事实分开说）。 */
export function snapshotSentence(
  snap: ReturnType<typeof snapshotOutcome>,
  direction: 'freeze' | 'delete',
): string {
  const extra = [
    snap.path !== '' ? `路径 ${snap.path}` : '',
    snap.hasDatabase === null ? '' : `含应用库 app.db：${snap.hasDatabase ? '是' : '否'}`,
  ].filter((s) => s !== '').join('；')
  const suffix = extra === '' ? '' : `（${extra}）`
  if (snap.at !== null) return `只读快照已生成（${fmtTime(snap.at)}）${suffix}`
  const failed = snap.ok === false || snap.error !== ''
  if (direction === 'delete') {
    return failed
      ? `只读快照**未生成**（${snap.error || '服务端未给原因'}）${suffix} —— 服务端会在快照生成前跳过清理，请先核对快照状态`
      : `只读快照：服务端未回传快照时刻（响应里没有 app.snapshot_at）${suffix}，请以详情抽屉「生命周期」块的快照时间为准（快照不存在时不会清理数据）`
  }
  return failed
    ? `只读快照生成失败（${snap.error || '服务端未给原因'}），系统会重试；**快照生成前不会清理任何数据**${suffix}`
    : `只读快照正在生成（服务端未回传结果）；**快照生成前不会清理任何数据**${suffix}`
}

/**
 * 删除回执（真实语义）：快照是否真的生成了（否则不该说"删了"）、清理日期是哪一个时刻。
 *
 * 设计 §5.5：快照失败 = 删除失败（fail-closed）⇒ 200 回来时快照应当已存在；但**仍按响应
 * 如实说**（服务端若将来改成异步快照，回执不能替它撒谎）。
 */
export function deleteReceipt(result: DeleteResultView | null | undefined): string {
  const app = result?.app ?? {}
  const retention = retentionDaysOf({ retention_days: result?.retention_days })
  const plan = purgePlan(app, retention)
  const snapshotText = snapshotSentence(snapshotOutcome(result), 'delete')
  return (
    `已删除：${snapshotText}；${purgeSentence(plan)}。` +
    '保留期内可在本页「已删除」筛选里点「恢复」（恢复后不自动上架）。'
  )
}

/** 冻结回执（真实语义，替代此前的「已冻结:该应用立即停止服务」一句了事）。 */
export function freezeReceipt(result: LifecycleActionResult | null | undefined): string {
  const app = result?.app ?? {}
  const retention = retentionDaysOf({ retention_days: result?.retention_days })
  const plan = purgePlan(app, retention)
  const snapshotText = snapshotSentence(snapshotOutcome(result), 'freeze')
  return `已冻结：该应用立即停止服务；${snapshotText}；${purgeSentence(plan)}`
}

// ---------------------------------------------------------------------------
// 错误码 → 真实可执行的指引
// ---------------------------------------------------------------------------

/**
 * 已删除/已清除应用的真实恢复路径（替代服务端 404 里的「如需恢复请联系平台管理员」）。
 *
 * 服务端文案（`wasmapp/api/release.go` 的「如需恢复请联系平台管理员」）写在一个**管理员就是
 * 平台管理员**的页面上，且那时全仓没有 restore —— 审计 C-04 点名的误导。后端文案属泳道 L，
 * 管理台这一侧必须在渲染前把它换成**本页真实存在的入口**，否则管理员照着提示去找一个
 * 不存在的联系对象。
 */
export const DELETED_RECOVERY_GUIDE =
  '已删除的应用可在本页把「状态筛选」切到「已删除」后在列表里找到，并点「恢复」（恢复后不自动上架）；数据清除之后不可恢复。'

/** 服务端 404 文案里那句误导（逐字来自 release.go）。 */
const MISLEADING_RECOVERY_SENTENCE = /[；;，,]?\s*如需恢复请联系平台管理员[。.]?/g

/**
 * 旧服务端文案里的「后台任务」措辞（设计 §7 点名禁止）⇒ 现行的真实执行者。
 *
 * 反证 F-4：服务端 hint 已经改过（`loadAdminApp` 现在写的是"未过保留期前可在本页
 * 「已删除」筛选里恢复"），但**在途版本**或其它写点仍可能吐出这句话，而管理台把
 * hints 原样拼进界面 ⇒ 文案会漂回 R37 的形态。这一层是**防御映射**：不管服务端哪一版，
 * 界面上出现的都必须是"谁在执行"这件事。
 */
const LEGACY_BACKGROUND_JOB = /由后台任务执行|后台任务/g
const BACKGROUND_JOB_REPLACEMENT = '由退役真删作业（wasm_retirement 调度器）执行'

/** 把已废弃的文案措辞换成本轮的真实语义（幂等；无命中时原样返回）。 */
export function sanitizeDeprecatedCopy(text: string): string {
  return text.replace(LEGACY_BACKGROUND_JOB, BACKGROUND_JOB_REPLACEMENT)
}

/**
 * 版本清单（`/releases?status=pending|rejected`）读取失败时的文案。
 *
 * 反证 F-3：已删除/已清除行的只读详情曾经**必然**出现两条红字 —— 该端点走
 * `adminApp`（`allowDeleted=false`）⇒ 404「应用已退役（已删除）」。服务端已改成
 * 只读放行（`loadAdminApp(..., true)`），但对**尚未升级**的服务端，前端仍要给出
 * 正确的解读：这不是"抽屉坏了"，恢复/导出走的是应用自身端点，不受影响。
 */
export function releaseListErrorText(err: unknown, appDeleted: boolean, what: string): string {
  if (appDeleted && isMissingEndpoint(err)) {
    return (
      `${what}：服务端对这一行返回 404 —— 旧版本服务端未放行「已删除应用的版本清单」（反证 F-3 的修复是把它改成只读放行）。` +
      '这不影响本抽屉的「恢复」与「导出」：两者直接打应用端点，不依赖版本清单。'
    )
  }
  return lifecycleErrorText(err, what)
}

/**
 * 把一次生命周期动作的错误渲染成**可执行**的文本。
 *
 * 与 `errorText` 的分工：`errorText` 负责「message + 字段 + hints」；这里只补一条
 * 「这个错误码在管理台下一步该点哪里」。未知错误码原样透传（不吞服务端信息）。
 */
export function lifecycleErrorText(err: unknown, fallback: string): string {
  const base = sanitizeDeprecatedCopy(errorText(err, fallback))
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? ((err as { code: string }).code) : ''
  const status = typeof (err as { status?: unknown } | null)?.status === 'number' ? (err as { status: number }).status : 0
  switch (code) {
    case 'APP_PURGED':
      return `${base} —— ${PURGED_NOTICE}`
    case 'APP_DELETED':
      return `${base}；${DELETED_RECOVERY_GUIDE}`
    case 'RELEASE_NOT_DEPLOYABLE':
      return `${base}；只有状态为 approved 的版本可以部署（待审 pending / 被拒 rejected / 已撤回 withdrawn 一律不可部署）。`
    case 'RELEASE_BYTES_RELEASED':
      return `${base}；该版本的制品字节已释放（软删或拒绝时释放），不可再部署 —— 请部署另一个 approved 版本。`
    case 'APP_FROZEN':
      return `${base}；应用已冻结（交付面一律 404）：先解冻，再执行该动作。`
    case 'RELEASE_NOT_PENDING':
      return `${base}；只有待审（pending）版本可以撤回，已被审核的版本不能撤回。`
    default:
      break
  }
  if (status === 404) {
    // 反证 F-10：这里曾有一个 `if (/已删除|已退役|不存在|NOT_FOUND/) … else …` 的**同义死分支**
    // （两个分支返回同一个字符串）—— 看着像"有区分口径"，实际没有任何区分。现在只有一条
    // 路径：404 一律给"下一步点哪里"（服务端 message/hint 原文保留在 base 里）。
    const stripped = base.replace(MISLEADING_RECOVERY_SENTENCE, '').trim()
    const cleaned = stripped === '' ? fallback : stripped
    return `${cleaned}；${DELETED_RECOVERY_GUIDE}`
  }
  return base
}

/** 错误里的 hints（导出/删除这类动作的失败提示要保留服务端建议）。 */
export function lifecycleErrorHints(err: unknown): string[] {
  return errorHints(err)
}

// ---------------------------------------------------------------------------
// 部署 / 回滚（设计 §3.3 / §5.1 / §6.2）
// ---------------------------------------------------------------------------

/** 版本行（`GET …/releases?status=approved`；服务端 DTO 见 api/admin.go 的 adminReleases）。 */
export interface ReleaseRow {
  id: number
  version: string
  status: string
  publisher?: string
  /**
   * 制品体积（字节）。**缺失保持 `undefined`**（反证 F-12：旧实现把缺字段折成 0，
   * 于是"服务端没下发体积"与"体积真的是 0（字节已释放）"在部署选择器里无法区分）。
   */
  size?: number
  changelog?: string
  created_at?: string
  current?: boolean
  /**
   * 服务端是否已判定该版本的制品字节已释放（`RELEASE_BYTES_RELEASED`）。
   *
   * 现状：后端**尚未**下发这个键（`adminReleases` 只给 `size`）⇒ 前端退化为按
   * `size <= 0` 推断（见 `releaseBytesReleased`）。后端一旦下发，本键优先、推断作废。
   */
  bytes_released?: boolean
}

export interface DeployCandidate {
  version: string
  releaseId: number
  /** 就是线上当前版本（选择器里**不可选**：服务端会返回 changed:false）。 */
  current: boolean
  /** 最新的 approved 版本（部署它 = kind `publish`；部署更旧的是 `rollback`）。 */
  latest: boolean
  /** 制品字节是否已释放（true ⇒ 部署必吃 409 `RELEASE_BYTES_RELEASED`）。 */
  bytesReleased: boolean
  /** 服务端下发的体积（未下发 = null，**不是 0**）。 */
  size: number | null
}

/**
 * 解析版本清单（`GET …/releases?status=…` 的响应）。
 *
 * 形状不对 ⇒ `ok:false`：部署选择器不能把「读不到版本清单」渲染成「没有可部署的版本」
 * （前者是接口/权限问题，后者是业务状态 —— 两句话必须分开，见 F6 的口径）。
 */
export function parseReleaseRows(raw: unknown): ParseResult<ReleaseRow[]> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: '响应不是对象（这不是「没有可部署版本」，请核对服务端接口）' }
  }
  const list = (raw as Record<string, unknown>).releases
  if (!Array.isArray(list)) {
    return { ok: false, reason: '响应里没有 releases 数组（这不是「没有可部署版本」，请核对服务端接口）' }
  }
  const rows: ReleaseRow[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'number' ? row.id : Number(row.id)
    const version = typeof row.version === 'string' ? row.version : ''
    if (!Number.isFinite(id) || version === '') continue
    const size = typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : undefined
    rows.push({
      id,
      version,
      status: typeof row.status === 'string' ? row.status : '',
      publisher: typeof row.publisher === 'string' ? row.publisher : '',
      // **不**把"未下发"折成 0（反证 F-12）：0 在本文件里的语义是"字节已释放"。
      ...(size !== undefined ? { size } : {}),
      changelog: typeof row.changelog === 'string' ? row.changelog : '',
      created_at: typeof row.created_at === 'string' ? row.created_at : '',
      current: typeof row.current === 'boolean' ? row.current : false,
      ...(typeof row.bytes_released === 'boolean' ? { bytes_released: row.bytes_released } : {}),
    })
  }
  return { ok: true, value: rows }
}

/** 版本选择器只列 approved 的说明（设计 §7「版本选择器：只列 approved」）。 */
export const DEPLOY_SELECTOR_HINT =
  '版本选择器只列**可部署**的 approved 版本：待审（pending）、被拒（rejected）、已撤回（withdrawn）的版本不可部署；' +
  '字节已释放的 approved 版本（软删/退役后 `size=0`，或服务端下发 `bytes_released=true`）也不列出 —— ' +
  '部署它们必然返回 409 RELEASE_BYTES_RELEASED。' +
  '部署最新 approved = 发布；部署更旧的 approved = 回滚（不重传、不重审，追加一条部署历史）。当前版本不可重复部署（服务端回 changed:false）。'

/**
 * 该版本的制品字节是否已释放（反证 F-12）。
 *
 * 判定顺序（服务端字段优先，其次推断，最后"不知道"）：
 *   ① 服务端下发 `bytes_released`（将来）⇒ 采信它；
 *   ② 否则看 `size`：**显式下发的 0** 视为已释放 —— 拒绝/撤回/软删/退役都会置
 *      `size=0, archive=NULL`（`serverstore.SoftDeleteWasmRelease` /
 *      `SetReleaseStatusForReview` / `SoftDeleteWasmApp`），而任何正常发布过的版本都有字节；
 *   ③ `size` 没下发（`undefined`）⇒ 返回 null（**不知道**，不做任何假设）。
 *
 * 返回 null 的动作：仍列进选择器（保守 = 不剥夺管理员的选项），但回执/错误文案必须
 * 可操作（`lifecycleErrorText` 的 `RELEASE_BYTES_RELEASED` 分支）。
 */
export function releaseBytesReleased(row: ReleaseRow | null | undefined): boolean | null {
  if (row === null || row === undefined) return null
  if (typeof row.bytes_released === 'boolean') return row.bytes_released
  if (typeof row.size === 'number' && Number.isFinite(row.size)) return row.size <= 0
  return null
}

/** 该应用的 approved 版本（按 id 降序；`latest` 以它为真源）。 */
function approvedRows(rows: ReleaseRow[]): ReleaseRow[] {
  return rows
    .filter((r) => r !== null && typeof r === 'object' && r.status === 'approved' && typeof r.version === 'string' && r.version !== '')
    .slice()
    .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
}

function toCandidate(row: ReleaseRow, currentVersion: string, latestId: number | null): DeployCandidate {
  const released = releaseBytesReleased(row)
  return {
    version: row.version,
    releaseId: row.id,
    current: currentVersion !== '' && row.version === currentVersion,
    latest: latestId !== null && row.id === latestId,
    bytesReleased: released === true,
    size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : null,
  }
}

/**
 * 把版本清单折成**可部署**候选：**只保留 approved**，标出「当前」与「最新」，当前版本不可选，
 * 并**排除字节已释放的版本**（反证 F-12：否则选中后必然吃 409，选择器里"列出来的都能部署"
 * 这句承诺就是假的）。
 *
 * 为什么在前端也过滤一遍：设计 §5.1 规定非 approved 一律 409 `RELEASE_NOT_DEPLOYABLE`，
 * 而管理面版本端点的 `status=` 过滤是服务端行为 —— 任一端漂移时，前端这份过滤保证
 * 「选择器里出现不可部署的版本」不会发生（用例直接咬这条）。最新 = id 最大的 approved
 * （含字节已释放的：服务端判定 publish/rollback 用的就是"最大 approved id"，这里必须同口径，
 * 否则回执会把回滚说成发布）。
 */
export function deployCandidates(rows: ReleaseRow[], currentVersion: string): DeployCandidate[] {
  const approved = approvedRows(rows)
  const latestId = approved.length > 0 ? approved[0]!.id : null
  return approved
    .filter((r) => releaseBytesReleased(r) !== true)
    .map((r) => toCandidate(r, currentVersion, latestId))
}

/**
 * approved 但**不可部署**的版本（字节已释放）。它们不该出现在选择器里，但也不能被静默
 * 藏起来：管理员看到"我明明通过了 v1.1.0，为什么选不到"时会以为是页面坏了。
 */
export function blockedDeployCandidates(rows: ReleaseRow[], currentVersion: string): DeployCandidate[] {
  const approved = approvedRows(rows)
  const latestId = approved.length > 0 ? approved[0]!.id : null
  return approved
    .filter((r) => releaseBytesReleased(r) === true)
    .map((r) => toCandidate(r, currentVersion, latestId))
}

/** 部署历史的行（设计 §7：id/version/kind/actor/actor_role/created_at/current 标记）。 */
export interface DeploymentRow {
  id: number
  version: string
  kind: string
  actor: string
  actor_role: string
  message: string
  created_at: string
  current: boolean
}

export interface DeploymentsView {
  rows: DeploymentRow[]
  currentVersion: string
  currentDeploymentId: number
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * 解析部署历史响应。
 *
 * 形状不对 ⇒ `ok:false`（页面说「读取失败」），**不得**当成「没有部署历史」——
 * 一个不存在的端点（后端未合入时是 404）与「这个应用从没部署过」在管理员眼里是两件事。
 */
export function parseDeployments(raw: unknown): ParseResult<DeploymentsView> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: '响应不是对象（这不是「没有部署历史」，请核对服务端接口）' }
  }
  const body = raw as Record<string, unknown>
  const list = body.deployments
  if (!Array.isArray(list)) {
    return { ok: false, reason: '响应里没有 deployments 数组（这不是「没有部署历史」，请核对服务端接口）' }
  }
  const currentVersion = typeof body.current_version === 'string' ? body.current_version : ''
  const rows: DeploymentRow[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'number' ? row.id : Number(row.id)
    const version = typeof row.version === 'string' ? row.version : ''
    if (!Number.isFinite(id) || version === '') continue
    rows.push({
      id,
      version,
      kind: typeof row.kind === 'string' ? row.kind : '',
      actor: typeof row.actor === 'string' ? row.actor : '',
      actor_role: typeof row.actor_role === 'string' ? row.actor_role : '',
      message: typeof row.message === 'string' ? row.message : '',
      created_at: typeof row.created_at === 'string' ? row.created_at : '',
      current: typeof row.current === 'boolean' ? row.current : false,
    })
  }
  // `current` 缺省时按（版本 == 当前版本，且是该版本里 id 最大的一条）推导 —— 同一个版本
  // 可以被部署多次（回滚再回滚），当前部署只有一条。
  if (rows.length > 0 && !rows.some((r) => r.current) && currentVersion !== '') {
    const sameVersion = rows.filter((r) => r.version === currentVersion).sort((a, b) => b.id - a.id)
    if (sameVersion.length > 0) sameVersion[0]!.current = true
  }
  rows.sort((a, b) => b.id - a.id)
  return {
    ok: true,
    value: {
      rows,
      currentVersion,
      currentDeploymentId: typeof body.current_deployment_id === 'number' ? body.current_deployment_id : 0,
    },
  }
}

export const DEPLOYMENT_KIND_LABELS: Record<string, string> = {
  publish: '发布',
  review: '审批上线',
  rollback: '回滚',
  seed: '内置播种',
  legacy: '迁移回填',
}

export function deploymentKindLabel(kind: string): string {
  return DEPLOYMENT_KIND_LABELS[kind] ?? (kind === '' ? '—' : kind)
}

export const ACTOR_ROLE_LABELS: Record<string, string> = {
  owner: '作者',
  super_admin: '超管兜底',
  admin_session: '管理员会话',
  system: '系统',
  seed: '内置播种',
  legacy: '迁移回填',
}

export function actorRoleLabel(role: string): string {
  return ACTOR_ROLE_LABELS[role] ?? (role === '' ? '—' : role)
}

/** 部署/回滚的响应（设计 §6.2 POST deployments）。 */
export interface DeployResult {
  app_id: string
  version: string
  kind: string
  changed: boolean
  current_version: string
  deployment?: DeploymentRow
}

/**
 * 归一部署响应（设计 §6.2 的 POST 响应）。
 *
 * 后端真实形状是 `{app:{current_version,…}, deployment:{version,kind,…}, changed}` ——
 * version/kind 挂在 `deployment` 段而**不在**顶层；设计文档只写「部署/回滚」没有钉死信封。
 * 顶层字段存在时优先用顶层（向前兼容），否则从 deployment/app 段取，取不到才回落请求里的
 * 目标版本（此时 kind 未知，回执会说「已部署」而不是猜测「回滚」）。
 */
export function normalizeDeployResult(
  raw: unknown,
  fallback: { app_id: string; version: string; current_version: string },
): DeployResult {
  const body = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const dep = body.deployment !== null && typeof body.deployment === 'object' ? body.deployment : null
  const app = body.app !== null && typeof body.app === 'object' ? body.app : null
  const version =
    (typeof body.version === 'string' && body.version !== '' && body.version) ||
    (dep !== null && typeof dep.version === 'string' && dep.version !== '' ? dep.version : '') ||
    fallback.version
  const kind =
    (typeof body.kind === 'string' && body.kind !== '' && body.kind) ||
    (dep !== null && typeof dep.kind === 'string' ? dep.kind : '')
  const currentVersion =
    (typeof body.current_version === 'string' && body.current_version !== '' && body.current_version) ||
    (app !== null && typeof app.current_version === 'string' && app.current_version !== ''
      ? app.current_version
      : '')
  const changed = typeof body.changed === 'boolean' ? body.changed : true
  const deployment: DeploymentRow | undefined =
    dep === null
      ? undefined
      : {
          id: typeof dep.id === 'number' ? dep.id : 0,
          version,
          kind,
          actor: typeof dep.actor === 'string' ? dep.actor : '',
          actor_role: typeof dep.actor_role === 'string' ? dep.actor_role : '',
          message: typeof dep.message === 'string' ? dep.message : '',
          created_at: typeof dep.created_at === 'string' ? dep.created_at : '',
          current: typeof dep.current === 'boolean' ? dep.current : true,
        }
  return {
    app_id: fallback.app_id,
    version,
    kind,
    changed,
    current_version: currentVersion !== '' ? currentVersion : changed ? version : fallback.current_version,
    deployment,
  }
}

/** 部署回执：kind 决定说「发布」还是「回滚」；changed:false 必须明说「没有变更」。 */
export function deployReceipt(result: DeployResult | null | undefined): string {
  if (result === null || result === undefined) return '部署请求已提交'
  const changed = result.changed !== false
  const kind = deploymentKindLabel(result.kind)
  if (!changed) {
    return `没有变更：v${result.version} 已经是当前线上版本（服务端幂等返回 changed:false，未追加部署历史）。`
  }
  return `已${kind === '回滚' ? '回滚' : '部署'}：线上版本切到 v${result.version}（${kind}），已追加一条部署历史。`
}

// ---------------------------------------------------------------------------
// 待审队列（设计 §5.7 / §6.2 `GET …/releases/pending`；C-07）
// ---------------------------------------------------------------------------

/**
 * 待审队列的一行（**逐键对照**服务端 `pendingReleaseQueueRows` 的真实下发面）。
 *
 * 反证 F-8：这里曾声明并渲染 `id/size/changelog/description` 四个键，而服务端
 * （`wasmapp/api/deployments.go` 的 `pendingReleaseQueueRows`）**从不下发**它们 ——
 * 生产环境那行永远不出现，而夹具给了它们，于是"渲染服务端不存在的字段"被测试钉成了契约。
 * 现在类型只保留服务端真有的键：app_id/title/version/publisher/created_at/age_seconds/
 * current_version。要加体积/变更说明，先让服务端在 `pendingReleaseQueueRows` 里下发
 * （`adminReleases` 已有 `size`/`changelog` 可抄），前端再跟上。
 */
export interface PendingQueueRow {
  appId: string
  /** 应用当前目录标题（可能为空：首版待审时 apps.title 是 app_id 占位）。 */
  title: string
  version: string
  publisher: string
  currentVersion: string
  createdAt: string
  /** 服务端给的年龄（秒）；没有就用 created_at 现算。 */
  ageSeconds: number | null
}

export interface PendingQueueView {
  rows: PendingQueueRow[]
  /** 服务端 `total`（与页头徽标同源的全量计数，**不是**本页行数）。 */
  total: number
  /** 服务端一次最多返回 200 行；`total > rows.length` 就必须在界面上说出来。 */
  truncated: boolean
}

/**
 * 解析跨应用待审清单。
 *
 * 形状不对 ⇒ `ok:false`（页面说「读取失败」）；`pending: []` 才是真「没有待审版本」，
 * 两者在页面上必须是两句不同的话（F6 的口径）。
 *
 * 反证 F-1 的两处修正：`total` 优先取服务端给的**全量计数**（`total` / `pending_count`），
 * 绝不用 `rows.length` 冒充；`truncated` 明确表达"这一屏不是全部"。
 */
export function parsePendingQueue(raw: unknown): ParseResult<PendingQueueView> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: '响应不是对象（这不是「没有待审版本」，请核对服务端接口）' }
  }
  const body = raw as Record<string, unknown>
  // 两个键都认：后端（`wasmapp/api/admin_retirement.go` 的 adminPendingReleases）下发的是
  // `pending`，设计 §5.7 的表述是「跨应用清单」而没有钉死键名；任一键缺失都**不能**被读成
  // 「没有待审」—— 只有 `[]` 才是空。
  const list = Array.isArray(body.pending) ? body.pending : body.releases
  if (!Array.isArray(list)) {
    return { ok: false, reason: '响应里没有 pending/releases 数组（这不是「没有待审版本」，请核对服务端接口）' }
  }
  const rows: PendingQueueRow[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const appId = typeof row.app_id === 'string' ? row.app_id : ''
    const version = typeof row.version === 'string' ? row.version : ''
    if (appId === '' || version === '') continue
    rows.push({
      appId,
      title: typeof row.title === 'string' ? row.title : '',
      version,
      publisher: typeof row.publisher === 'string' ? row.publisher : '',
      currentVersion: typeof row.current_version === 'string' ? row.current_version : '',
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      ageSeconds: typeof row.age_seconds === 'number' && Number.isFinite(row.age_seconds) ? row.age_seconds : null,
    })
  }
  const total =
    typeof body.total === 'number' && Number.isFinite(body.total)
      ? body.total
      : typeof body.pending_count === 'number' && Number.isFinite(body.pending_count)
        ? body.pending_count
        : rows.length
  return { ok: true, value: { rows, total, truncated: total > rows.length } }
}

/** 队列被服务端截断时的一句话（反证 F-1 的第二处真源分叉：total ≠ 本页行数）。 */
export function queueTruncationNote(view: PendingQueueView): string {
  if (!view.truncated) return ''
  return `服务端一次最多返回 ${view.rows.length} 行；全组织共 ${view.total} 个待审版本，` +
    '其余未在本屏列出（「待审 N」徽标显示的是全量计数，两者数字不同不是缺陷）。'
}


/** 待审年龄：优先用服务端给的秒数，否则按 created_at 现算；都缺 ⇒ ''（不编一个「刚刚」）。 */
export function pendingAgeText(row: PendingQueueRow, now: Date = new Date()): string {
  let seconds = row.ageSeconds
  if (seconds === null && row.createdAt !== '') {
    const created = new Date(row.createdAt).getTime()
    if (!Number.isNaN(created)) seconds = Math.max(0, Math.round((now.getTime() - created) / 1000))
  }
  if (seconds === null || !Number.isFinite(seconds)) return ''
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}

/** 驳回影响面提示（A8：版本号永久占用，重发必须升版本号）。 */
export const REJECT_IMPACT_NOTE =
  '版本号将永久占用（不能复用）：驳回后发布者必须升一个更高的版本号重发；被驳版本的归档字节会被释放。'

// ---------------------------------------------------------------------------
// 更新审批开关（设计 §5.7；反证 F-2）
// ---------------------------------------------------------------------------

/**
 * `PUT /wasm-apps/review` 的响应（**真实信封**，见 `wasmapp/api/admin.go` 的 AdminReview）。
 *
 * 反证 F-2：前端曾把响应窄化成 `{review_required?}`，于是服务端已经给的
 * `pending_releases`（全组织现存待审数）与 `note`（「现有 N 个待审版本将失去意义
 * （作者可撤回，管理面可逐个通过/拒绝）」）被整段丢弃，关闭方向只 flash 一句固定文案。
 * 现在四个键全部读出来：`note` 是服务端权威语义（与设计 §5.3 的 withdraw 对齐），
 * 前端只在它缺失时才自己拼一句**同义**的话。
 */
export interface ReviewSwitchResponse {
  review_required?: boolean
  changed?: boolean
  setting_key?: string
  /** 全组织现存待审版本数（与列表 `pending_count` 同源）。 */
  pending_releases?: number
  /** 服务端给的清理提示（关闭方向且有待审时才下发）。 */
  note?: string
}

/** 从开关响应里读待审数；缺失返回 null（**不**用 0 冒充"没有积压"）。 */
export function pendingFromSwitch(raw: unknown): number | null {
  const n = (raw as { pending_releases?: unknown } | null | undefined)?.pending_releases
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

/**
 * 关闭审批开关时**必须**说清的话（设计 §5.7 原话 + §5.3 的撤回能力）。
 *
 * `pending` 为 null（服务端没下发）时**不编造数字**：只说"现存待审版本不会自动转正"，
 * 并指向待审队列。这是"服务端未下发"与"确实没有积压"必须分开的又一处。
 */
export function reviewCloseWarning(pending: number | null, note: string = ''): string {
  if (note !== '') return `服务端提示：${note}`
  if (pending === null) {
    return '已处于待审状态的版本**不会**自动转正：服务端未回传现存待审数，请在待审队列里核对；' +
      '不再需要的版本可由**作者撤回**（设计 §5.3），或由管理员在队列里逐个通过/拒绝。'
  }
  if (pending <= 0) return '当前没有待审版本积压（服务端回报 0 个）：关闭后新版本发布即生效。'
  return `现有 ${pending} 个待审版本将**失去意义**（它们不会被自动上线）：` +
    '不再需要的可由**作者撤回**（设计 §5.3，作者侧新能力），也可由管理员在待审队列里逐个通过/拒绝。'
}

/**
 * 审核开关的即时回执（含**服务端 note** 与 N）。
 *
 * 两个方向都要说清代价：开启 ⇒ 新版本停在待审（现存积压仍需逐个处置）；
 * 关闭 ⇒ 现存 N 个待审版本将失去意义（作者可撤回 / 管理面可逐个处置）。
 */
export function reviewSwitchReceipt(
  out: ReviewSwitchResponse | null | undefined,
  next: boolean,
  fallbackPending: number | null = null,
): string {
  const pending = pendingFromSwitch(out) ?? fallbackPending
  const note = typeof out?.note === 'string' ? out.note.trim() : ''
  if (next) {
    return pending !== null && pending > 0
      ? `已开启更新审批：新版本需审批后生效；现存 ${pending} 个待审版本仍需逐个通过/拒绝。`
      : '已开启更新审批：新版本需审批后生效（线上继续运行当前生效版本，不会中断使用）。'
  }
  return `已关闭更新审批：新版本发布即生效；${reviewCloseWarning(pending, note)}`
}

// ---------------------------------------------------------------------------
// 导出（设计 §5.6 / §6.2；C-02）
// ---------------------------------------------------------------------------

export type ExportKind = 'json' | 'database' | 'assets'

export interface ExportOption {
  kind: ExportKind
  label: string
  desc: string
  query: string
}

/**
 * 三种导出（设计 §5.6）：控制面 JSON（向后兼容）/ 含应用库的 zip / zip 再加资源目录。
 *
 * `assets=1` 按设计 §5.6 是「zip 内**再**加 assets」⇒ 含资源必然是 zip，于是同时带
 * `database=1`（否则拿不到 zip 容器）。这一点是契约假设，已在交付说明里列出。
 */
export const EXPORT_OPTIONS: ExportOption[] = [
  { kind: 'json', label: '控制面 JSON', desc: '应用元数据 + 版本清单 + 生命周期（不含使用者数据与资源）', query: '' },
  { kind: 'database', label: '含应用数据（zip）', desc: 'export.json + app.db 的只读快照（VACUUM INTO）', query: '?database=1' },
  { kind: 'assets', label: '含数据与资源（zip）', desc: 'export.json + app.db + assets/<release_id>/ 资源目录', query: '?database=1&assets=1' },
]

export function exportPath(appId: string, kind: ExportKind): string {
  const option = EXPORT_OPTIONS.find((o) => o.kind === kind) ?? EXPORT_OPTIONS[0]!
  return `${appPath(appId)}/export${option.query}`
}

/**
 * 导出对话框里的警告：已清除/已删除的应用，**哪些导出还会成功**必须写在按钮旁边，
 * 否则管理员点「含数据」拿到一个 410 会以为是页面坏了。
 */
export function exportCaveats(app: AppLifecycleFields | null | undefined): string[] {
  const notes: string[] = []
  if (isPurged(app)) notes.push(`该应用已清除：${purgeNotice(app)}`)
  else if (isDeleted(app)) notes.push('该应用已删除：保留期内数据仍在（含数据/含资源可导出）；恢复后不会自动上架。')
  notes.push('每次导出都会写审计（wasm_app_export，detail 含 database/assets 与 actor_role，不含行内容）。')
  return notes
}

// ---------------------------------------------------------------------------
// 小工具：把 API 失败折成「不要静默」的读取失败文案
// ---------------------------------------------------------------------------

export function shapeDriftReason(label: string, reason: string): string {
  return `读取${label}失败：${reason}`
}

/** 供页面区分「端点不存在」（后端未合入）与其它失败：404 要明说未就绪。 */
export function isMissingEndpoint(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 404
  return (err as { status?: unknown } | null)?.status === 404
}
