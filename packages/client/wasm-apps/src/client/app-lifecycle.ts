/**
 * 作者**生命周期出口**的客户端半边（R1-pm-1）：应用中心面板 → 本机
 * `/api/zeokeel/apps/wasm/:app_id/(publish|unpublish)` / `DELETE :app_id` /
 * `GET :app_id/diagnostics`。
 *
 * 为什么需要它：宿主早已把发布者的全套代理到本机面
 * （`packages/host/enterprise/src/wasm-apps.ts` 的 prefix handler：
 * `POST :app_id/publish|unpublish|freeze`、`GET :app_id/diagnostics|schema|export`、
 * `DELETE :app_id`），而客户端面板此前**只有"发布/发新版"** —— 作者发错内容既不能
 * 下架止损、也不能删除，排障只能靠猜；而作者指南明写"不要用 curl，工具是唯一走得通
 * 的路"，于是这些出口在产品里根本不可达（独立评审 R1-pm-1 / R1-uxc-10）。
 *
 * 本模块只做三件事，全是纯逻辑（可单测、无 React）：
 *  1. 拼本机路由（app_id 一律 `encodeURIComponent`：它不是可信输入）；
 *  2. 发一次请求（**复用** `publish-app.ts` 的 {@link requestJSON}：错误信封的读法
 *     只有一份实现，不在这里抄第二遍）；
 *  3. 把响应解析成**结构化结果** —— 特别是 `app.enabled` / `app.deleted`：
 *     行状态只能由**服务端返回的值**决定，不能拿"我请求的是下架"当成事实
 *     （服务端会幂等返回 `changed:false` 与它自己的当前值；乐观更新等于把
 *     "我点了下架"说成"它已经下架了"）。
 *
 * 只做**作者自服务**那一组：冻结/解冻（2026-09-23 R5-B-7 起）、恢复软删（2026-10-22
 * 生命周期重设计 §5.5，仅协议半边：目录不下发已删行，界面暂不可达）、导出、自省、审批
 * 留给管理端与后续波次（宿主路由有，但员工侧不该在没有产品决策的情况下暴露）。
 *
 * 冻结/解冻为什么进这一组（R5-B-7 的裁决）：服务端**对发布者开着**
 * `POST /api/client/v2/apps/wasm/:app_id/freeze`（`release.go:119-187` 的 `freeze`，
 * 走 `ownedApp` 鉴权），宿主也早已把 body 原样转发（`wasm-apps.ts:1834-1844`）——
 * 缺的只有客户端这一半。而客户端文案一直在承诺"发布者本人可以解冻"：有端点、
 * 有授权、没有可达路径，正是这条 finding。现在两端同源：面板给出冻结/解冻入口，
 * 文案指向面板。
 *
 * @module @zeokeel/dsh-wasm-apps/client/app-lifecycle
 */

import { t } from './locales.ts'
import {
  requestJSON,
  type PublishFailure,
  type RequestDeps,
} from './publish-app.ts'

/** 本机写面里"上下架"的两个后缀（与宿主路由逐字一致）。 */
export const SET_PUBLISHED_SUFFIX = { online: 'publish', offline: 'unpublish' } as const

/**
 * 本机写面里"冻结/解冻"的后缀（与宿主路由逐字一致）。
 *
 * 两个方向**共用同一个端点**：服务端只看 body 里的 `frozen`
 * （`release.go:139-149`：body 缺 `frozen` 时默认冻结），所以这里不发明
 * `unfreeze` 这种路径 —— 多一条自造路由就多一份与服务端不一致的地方。
 */
export const SET_FROZEN_SUFFIX = 'freeze'

/** 本机路由前缀（与 `wasm-apps.ts` 的 `WASM_APPS_PREFIX` 同值；客户端不 import 宿主包）。 */
export const WASM_APPS_LOCAL_PREFIX = '/api/zeokeel/apps/wasm'

/**
 * 一个 app_id 的本机路由（app_id 是路径段，必须 URI 编码）。
 * @param appId - 应用标识（服务端 `registry.NormalizeAppID` 的产物，仍按不可信输入编码）。
 * @param suffix - 可选的子路径（`` `publish` `` / `` `unpublish` `` / `` `diagnostics` ``）。
 * @returns 以 `/` 开头的本机路径。
 */
export function lifecyclePath(appId: string, suffix?: string): string {
  const base = `${WASM_APPS_LOCAL_PREFIX}/${encodeURIComponent(appId)}`
  return suffix === undefined ? base : `${base}/${suffix}`
}

/**
 * 上下架路由（同一 handler，后缀是**权威**判据：服务端 `publishTarget` 先看后缀再看
 * 请求体，见 `server/internal/wasmapp/api/release.go:90-115`）。
 * @param appId - 应用标识。
 * @param enabled - true = 上架（`publish`），false = 下架（`unpublish`）。
 * @returns 本机路径。
 */
export function setPublishedPath(appId: string, enabled: boolean): string {
  return lifecyclePath(appId, enabled ? SET_PUBLISHED_SUFFIX.online : SET_PUBLISHED_SUFFIX.offline)
}

/**
 * 删除路由（服务端软删：标识与版本号永久占位）。
 * @param appId - 应用标识。
 * @returns 本机路径。
 */
export function deletePath(appId: string): string {
  return lifecyclePath(appId)
}

/**
 * 诊断路由（只读）。
 * @param appId - 应用标识。
 * @returns 本机路径。
 */
export function diagnosticsPath(appId: string): string {
  return lifecyclePath(appId, 'diagnostics')
}

/**
 * 自省路由（只读；表结构 + 行数 + 占用）。
 *
 * 为什么客户端此前不消费自省（2026-09-22 起消费）：服务端从 2026-09-19 起就有
 * `GET …/schema`，但客户端只做了 4 个后缀，作者在产品里**看不到表结构** ——
 * 而"作者数据面"（`rows`）必须先知道有哪些表才能查。
 * @param appId - 应用标识。
 * @returns 本机路径。
 */
export function schemaPath(appId: string): string {
  return lifecyclePath(appId, 'schema')
}

/**
 * 数据浏览路由（只读；服务端 `api/rows.go`）。
 *
 * 参数一律进查询串（不是路径段）：`table` 可能为空/非法 ⇒ 服务端回 400，
 * 客户端不需要在本地复刻表名规则（复刻 = 第二份真源）。
 * @param appId - 应用标识。
 * @param query - 查询参数（table / limit / offset / unmask）。
 * @returns 本机路径（已 URI 编码）。
 */
export function rowsPath(appId: string, query: { table: string, limit?: number, offset?: number, unmask?: boolean }): string {
  const params = new URLSearchParams()
  params.set('table', query.table)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  if (query.unmask === true) params.set('unmask', '1')
  return `${lifecyclePath(appId, 'rows')}?${params.toString()}`
}

/**
 * 形状对不上时的统一失败（绝不假装成功：宁可报错也不要一个错的行状态）。
 *
 * `message` 由调用方从**字典**取（`locales.ts`）：这条消息会进 en 界面，
 * 写死中文就是新增一处 i18n 缺陷（发布块的同类问题是被记录的 R1-uxc-7，不扩散）。
 * @param appId - 本次请求的 app_id（进 details，便于维护者定位）。
 * @param payload - 服务端原始响应体（进 details）。
 * @param message - 已本地化的说明。
 * @returns 结构化失败。
 */
function shapeMismatch(appId: string, payload: unknown, message: string): PublishFailure {
  return {
    ok: false,
    status: 200,
    code: 'UNEXPECTED_RESPONSE',
    message,
    details: { app_id: appId, response: payload },
    hints: [t('appCenter.shapeMismatchHint')],
    transport: false,
  }
}

/** 安全取对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>
}

/** 安全取字符串（非字符串给空串）。 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ---------------------------------------------------------------------------
// 上下架
// ---------------------------------------------------------------------------

/** 上下架的**服务端**结果（`server/internal/wasmapp/api/release.go:69-86`）。 */
export interface SetPublishedSuccess {
  ok: true
  appId: string
  /** **服务端返回的**当前状态（不是请求里的值）。 */
  enabled: boolean
  /** 服务端是否真的改了（状态本来就一致时 `false` —— 幂等，不写审计）。 */
  changed: boolean
}

/**
 * 解析上下架响应：`{app:{app_id,enabled,changed}}`。
 *
 * `app.enabled` **必须**是布尔值：它是行状态的唯一来源。缺席时按形状错误处理
 * —— 回落成"我请求的那个值"就是把乐观更新伪装成服务端结果（本函数的全部意义）。
 *
 * 2026-09-19：响应里**不再有** `entry_url`（冻结契约 §4.5：应用只在客户端内以
 * `zeokeel-app://<app_id>/` 打开，服务端目录/发布/上下架响应一律不下发入口链接）。
 * 客户端也不再读它 —— 服务端多带一个字段时这里是**忽略**，不是回落。
 * @param appId - 本次请求的 app_id（与回显比对，防串行）。
 * @param payload - 响应体。
 * @returns 结构化结果或失败。
 */
export function parseSetPublishedOutcome(appId: string, payload: unknown): SetPublishedSuccess | PublishFailure {
  const app = asRecord(asRecord(payload).app)
  if (typeof app.enabled !== 'boolean') {
    return shapeMismatch(appId, payload, t('appCenter.setPublishedShapeMismatch'))
  }
  const echoed = asString(app.app_id)
  if (echoed !== '' && echoed !== appId) {
    return shapeMismatch(appId, payload, t('appCenter.setPublishedShapeMismatch'))
  }
  return {
    ok: true,
    appId,
    enabled: app.enabled,
    changed: app.changed === true,
  }
}

/**
 * 上架 / 下架一个应用（发布者本人；服务端 `ownedApp` 对非发布者一律 404）。
 * @param appId - 应用标识。
 * @param enabled - true = 上架，false = 下架。
 * @param deps - 可注入的 fetch / 取消信号（测试与 UI 共用同一条实现）。
 * @returns 服务端结果或结构化失败（永不抛）。
 */
export async function setAppPublished(
  appId: string,
  enabled: boolean,
  deps: RequestDeps = {},
): Promise<SetPublishedSuccess | PublishFailure> {
  // 不带 body：服务端以**路径后缀**判定目标（release.go:90-115），body 只在挂载点
  // 不含后缀时才是判据 —— 发一个 `{enabled}` 反而会造出第二条判据。
  const outcome = await requestJSON(setPublishedPath(appId, enabled), { method: 'POST' }, deps)
  if (!outcome.ok) return outcome
  return parseSetPublishedOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 删除（软删）
// ---------------------------------------------------------------------------

/** 删除的**服务端**结果（`server/internal/wasmapp/api/release.go:189-227`）。 */
export interface DeleteSuccess {
  ok: true
  appId: string
  /** 服务端确认已删除（恒为 true；缺席即形状错误）。 */
  deleted: boolean
  /** 数据保留期（天）；服务端没给就是 `undefined`（**不编造** 90）。 */
  retentionDays: number | undefined
  /** 服务端给运维/用户看的说明（含"真删由后台任务执行"这类边界）。 */
  note: string
}

/**
 * 解析删除响应：`{app:{app_id,deleted,...},retention_days?,note?}`。
 *
 * 行只在 `app.deleted === true` 时才允许消失 —— 这是"确认后行消失"那条行为用例的
 * 判据，也是防"点了删除就先抹掉行"的唯一手段。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化结果或失败。
 */
export function parseDeleteOutcome(appId: string, payload: unknown): DeleteSuccess | PublishFailure {
  const root = asRecord(payload)
  const app = asRecord(root.app)
  if (app.deleted !== true) {
    return shapeMismatch(appId, payload, t('appCenter.deleteShapeMismatch'))
  }
  const echoed = asString(app.app_id)
  if (echoed !== '' && echoed !== appId) {
    return shapeMismatch(appId, payload, t('appCenter.deleteShapeMismatch'))
  }
  return {
    ok: true,
    appId,
    deleted: true,
    retentionDays: typeof root.retention_days === 'number' ? root.retention_days : undefined,
    note: asString(root.note),
  }
}

/**
 * 删除一个应用（软删；不可恢复，标识与版本号永久占位）。
 *
 * **危险动作，调用方必须先二次确认**（面板的确认块就是那个闸）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 服务端结果或结构化失败（永不抛）。
 */
export async function deleteApp(appId: string, deps: RequestDeps = {}): Promise<DeleteSuccess | PublishFailure> {
  const outcome = await requestJSON(deletePath(appId), { method: 'DELETE' }, deps)
  if (!outcome.ok) return outcome
  return parseDeleteOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 冻结 / 解冻（R5-B-7）
// ---------------------------------------------------------------------------

/**
 * 冻结路由（发布者本人；服务端 `ownedApp` 对非发布者一律 404）。
 * @param appId - 应用标识。
 * @returns 本机路径。
 */
export function setFrozenPath(appId: string): string {
  return lifecyclePath(appId, SET_FROZEN_SUFFIX)
}

/** 冻结/解冻的**服务端**结果（`release.go:151-186`）。 */
export interface SetFrozenSuccess {
  ok: true
  appId: string
  /** **服务端返回的**当前冻结状态（不是请求里的值）。 */
  frozen: boolean
  /** 服务端是否真的改了（状态本来就一致时 `false` —— 幂等，不写审计）。 */
  changed: boolean
  /**
   * 服务端返回的上架状态。冻结会**顺带下架**（冻结=停止服务），解冻**不会**
   * 自动上架（`release.go:176-186` 的 note 逐字说明这件事）。
   */
  enabled: boolean
  /** 服务端给用户的说明（解冻时是"不会自动上架，请显式 publish"）；没有就是空串。 */
  note: string
}

/**
 * 解析冻结响应：`{app:{app_id,frozen,changed,enabled,note?}}`。
 *
 * `app.frozen` **必须**是布尔值：它是行状态的唯一来源（与
 * {@link parseSetPublishedOutcome} 同一条纪律 —— 回落成"我请求的那个值"就是把
 * 乐观更新伪装成服务端结果）。`app.enabled` 缺席时按 `false` 读：冻结路径上
 * 服务端恒下发它，缺席只能说明契约漂移，此时"已下架"比"还在服务"更保守。
 * @param appId - 本次请求的 app_id（与回显比对，防串行）。
 * @param payload - 响应体。
 * @returns 结构化结果或失败。
 */
export function parseSetFrozenOutcome(appId: string, payload: unknown): SetFrozenSuccess | PublishFailure {
  const app = asRecord(asRecord(payload).app)
  if (typeof app.frozen !== 'boolean') {
    return shapeMismatch(appId, payload, t('appCenter.setFrozenShapeMismatch'))
  }
  const echoed = asString(app.app_id)
  if (echoed !== '' && echoed !== appId) {
    return shapeMismatch(appId, payload, t('appCenter.setFrozenShapeMismatch'))
  }
  return {
    ok: true,
    appId,
    frozen: app.frozen,
    changed: app.changed === true,
    enabled: app.enabled === true,
    note: asString(app.note),
  }
}

/**
 * 冻结 / 解冻一个应用（发布者本人；服务端 `ownedApp` 鉴权）。
 *
 * 两个方向共用同一个端点，body 恒为 `{"frozen":<bool>}`（服务端以 body 为判据，
 * 空 body 等于冻结 —— 显式传 `true` 让"我到底请求了什么"在两端可读）。
 * 面板对**冻结**方向先出确认块（它会让应用立刻停服并顺带下架），解冻不需要确认。
 * @param appId - 应用标识。
 * @param frozen - true = 冻结，false = 解冻。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 服务端结果或结构化失败（永不抛）。
 */
export async function setAppFrozen(
  appId: string,
  frozen: boolean,
  deps: RequestDeps = {},
): Promise<SetFrozenSuccess | PublishFailure> {
  const outcome = await requestJSON(setFrozenPath(appId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frozen }),
  }, deps)
  if (!outcome.ok) return outcome
  return parseSetFrozenOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 恢复软删应用（2026-10-22 生命周期重设计 §5.5；反证审计 R-05）
// ---------------------------------------------------------------------------
//
// ⚠️ **今天没有界面入口，这是刻意的**：作者面的目录（`api/read.go` 的 catalog）
// 用的是 `ListWasmApps(..., WasmAppFilter{})` —— **不含**软删行（`deleted_at IS NULL`），
// 所以"已删除的应用"根本不在客户端列表里，详情页也就没有可依附的行。伪造一个
// 列表里不存在的入口只会变成另一个"点了必然 404"的死按钮。
//
// 本函数交付的是**协议半边**：宿主路由（`wasm-apps.ts` 的 `restore` 分支）与服务端
// `deployments.go` 的 `restoreForApp` 都已就位，补齐客户端调用面之后，"目录什么时候
// 下发已删行"就是一个纯服务端查询条件的决定（再加详情页一个按钮即可），不需要再动
// 客户端协议。单测钉住路径/请求形态/`changed` 判据三条。

/** 恢复软删应用的本机后缀（与宿主 `wasm-apps.ts` 的 `restore` 分支逐字一致）。 */
export const RESTORE_SUFFIX = 'restore'

/**
 * 恢复路由（发布者本人或超管；服务端 `ownedApp(..., allowDeleted=true)`）。
 * @param appId - 应用标识。
 * @returns 本机路径。
 */
export function restorePath(appId: string): string {
  return lifecyclePath(appId, RESTORE_SUFFIX)
}

/** 恢复的服务端结果（`deployments.go` 的 `restoreForApp`）。 */
export interface RestoreSuccess {
  ok: true
  appId: string
  /**
   * 服务端是否**真的**恢复了（幂等分支"没删除过"回 `false`）。
   *
   * 它是宿主"是否清该 app origin 浏览器存储"的同一判据（`wasm-apps.ts` 的
   * `lifecycleActionApplied('restore', …)` 读的就是**顶层** `changed`）：幂等恢复
   * 既没有变化，也不该清掉员工在这个应用里存的数据。
   */
  changed: boolean
  /** 恢复后的上架状态：设计 §5.5 明写**不自动上架**（`enabled:false`）。 */
  enabled: boolean
  /** 服务端给用户的说明（"需要显式 publish 才恢复服务"）。没有就是空串。 */
  note: string
  /** 保留期是否已清（服务端 `retention_cleared`；缺席按 false 读）。 */
  retentionCleared: boolean
  /** 快照目录清理失败的原因（服务端尽力而为；非空说明磁盘侧有残留）。 */
  snapshotCleanupError: string
}

/**
 * 解析恢复响应：`{app:{app_id,deleted,enabled}, changed, note, retention_cleared?, snapshot_cleanup_error?}`。
 *
 * `changed` **必须**是布尔值：它决定"要不要清 localStorage/IndexedDB"，而这是不可逆
 * 的删数据动作 —— 形状漂移时宁可**不清**（返回形状错误，由界面如实报），也不能猜。
 * @param appId - 本次请求的 app_id（与回显比对，防串行）。
 * @param payload - 响应体。
 * @returns 结构化结果或失败。
 */
export function parseRestoreOutcome(appId: string, payload: unknown): RestoreSuccess | PublishFailure {
  const root = asRecord(payload)
  const app = asRecord(root.app)
  if (typeof root.changed !== 'boolean') {
    return shapeMismatch(appId, payload, t('appCenter.restoreShapeMismatch'))
  }
  const echoed = asString(app.app_id)
  if (echoed !== '' && echoed !== appId) {
    return shapeMismatch(appId, payload, t('appCenter.restoreShapeMismatch'))
  }
  // `deleted:true` 出现在"恢复成功"的响应里就是形状矛盾（恢复后不该还是已删除）。
  if (app.deleted === true) {
    return shapeMismatch(appId, payload, t('appCenter.restoreShapeMismatch'))
  }
  return {
    ok: true,
    appId,
    changed: root.changed,
    // 缺席按 `false` 读：恢复**不**自动上架，`false` 是设计里的默认。
    enabled: app.enabled === true,
    note: asString(root.note),
    retentionCleared: root.retention_cleared === true,
    snapshotCleanupError: asString(root.snapshot_cleanup_error),
  }
}

/**
 * 恢复一个软删的应用（发布者本人；服务端 `ownedApp(..., allowDeleted=true)`）。
 *
 * 幂等：没删除过也回 200 + `changed:false`（不写审计）。调用方要**按 `changed`**
 * 决定界面文案与"是否刷新目录"，不能拿"我点了恢复"当事实。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 服务端结果或结构化失败（永不抛）。
 */
export async function restoreApp(appId: string, deps: RequestDeps = {}): Promise<RestoreSuccess | PublishFailure> {
  const outcome = await requestJSON(restorePath(appId), { method: 'POST' }, deps)
  if (!outcome.ok) return outcome
  return parseRestoreOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 部署历史 / 部署（回滚）/ 撤回（2026-10-22 生命周期重设计 §6.1 / §8）
// ---------------------------------------------------------------------------
//
// 后端（L 泳道）与这些端点同批落地；客户端按**契约**先实现并逐条做形状校验：
// 端点还没上线的环境里会拿到 404/`NOT_FOUND` —— 界面如实显示服务端信封，**不**把
// "端点不存在"说成"没有部署历史"（那会把契约未就绪伪装成事实）。

/** 部署历史的本机后缀（与宿主 `wasm-apps.ts` 的 `deployments` 分支逐字一致）。 */
export const DEPLOYMENTS_SUFFIX = 'deployments'

/**
 * 部署历史列表默认条数（设计 §8「最近 N 条 + 当前版本」）。
 *
 * 为什么不拉全量：部署历史**永不删除**（设计 §3.3），一个长期迭代的应用会有上千条；
 * 面板只需要"最近发生了什么 + 当前是哪一条"。服务端支持 `?limit=`（缺省 50，上限由
 * 服务端判），客户端显式传自己需要的条数，不依赖服务端缺省。
 */
export const DEPLOYMENTS_LIMIT = 20

/**
 * 部署历史的只读路由（设计 §6.1：`GET /api/client/v2/apps/wasm/:app_id/deployments`）。
 * @param appId - 应用标识（路径段，必须 URI 编码）。
 * @param limit - 最近条数（缺省 {@link DEPLOYMENTS_LIMIT}；`0`/负数 ⇒ 不带该参数）。
 * @returns 以 `/` 开头的本机路径（限流参数进查询串）。
 */
export function deploymentsPath(appId: string, limit: number = DEPLOYMENTS_LIMIT): string {
  const base = lifecyclePath(appId, DEPLOYMENTS_SUFFIX)
  return limit > 0 ? `${base}?limit=${String(limit)}` : base
}

/**
 * 撤回一个**待审**版本的路由（设计 §6.1：`POST …/releases/:version/withdraw`）。
 * @param appId - 应用标识。
 * @param version - 版本号（路径段，必须 URI 编码：版本号来自不可信输入）。
 * @returns 以 `/` 开头的本机路径。
 */
export function withdrawReleasePath(appId: string, version: string): string {
  return `${lifecyclePath(appId, 'releases')}/${encodeURIComponent(version)}/withdraw`
}

/** 一条部署记录（设计 §4：`wasm_app_deployments` 的一行）。 */
export interface DeploymentRow {
  /** 记录 id（服务端自增；同版本可能有多条历史，展示靠它区分）。 */
  id: number
  /** 版本号。 */
  version: string
  /** `publish` / `review` / `rollback` / `seed` / `legacy`（未知值原样显示）。 */
  kind: string
  /** 操作人（`legacy` 回填为空串）。 */
  actor: string
  /** 角色（owner / super_admin / admin_session / system / seed / legacy）。 */
  actorRole: string
  /** 部署说明（可空）。 */
  message: string
  /** 记录时间（服务端 RFC3339 原文）。 */
  createdAt: string
  /** 是否**当前**生效的那一条（设计 §2：current = 最新一次 deployment 的指针）。 */
  current: boolean
}

/** 部署历史报告（成功）。 */
export interface DeploymentsReport {
  ok: true
  appId: string
  /** 当前生效版本（服务端下发；空串 = 没有当前版本）。 */
  currentVersion: string
  /** 按服务端顺序（新 → 旧），客户端不重排。 */
  deployments: DeploymentRow[]
}

/** 安全取数字（非数字/非有限 ⇒ 0）。 */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 解析部署历史响应：`{app_id?, current_version?, deployments:[{id,version,kind,actor,actor_role,message,created_at,current?}]}`。
 *
 * 纪律（与版本历史同一条）：`deployments` 缺席/非数组 ⇒ **形状错误**，绝不回落成空
 * 清单 —— 把"解析坏了"显示成"还没有部署历史"会让运维以为线上没有部署记录。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化报告或失败。
 */
export function parseDeploymentsOutcome(appId: string, payload: unknown): DeploymentsReport | PublishFailure {
  const root = asRecord(payload)
  const rows = root.deployments
  if (!Array.isArray(rows)) {
    return shapeMismatch(appId, payload, t('appCenter.deploymentsShapeMismatch'))
  }
  // `current` 的两处来源要合流：行上的 `current:true`，或顶层 `current_version` 与行
  // 版本相等（设计 §6.1「含 current 标记」，两种下发形状都容忍）。
  const currentVersion = asString(root.current_version).trim()
  const deployments: DeploymentRow[] = rows
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    .map(row => {
      const version = asString(row.version)
      return {
        id: asNumber(row.id),
        version,
        kind: asString(row.kind),
        actor: asString(row.actor),
        actorRole: asString(row.actor_role),
        message: asString(row.message),
        createdAt: asString(row.created_at),
        current: row.current === true || (currentVersion !== '' && version === currentVersion),
      }
    })
  return { ok: true, appId, currentVersion, deployments }
}

/**
 * 读部署历史（只读；发布者本人或管理员，服务端仍按 ownedApp 鉴权）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 结构化报告或失败（永不抛）。
 */
export async function fetchDeployments(appId: string, deps: RequestDeps = {}): Promise<DeploymentsReport | PublishFailure> {
  const outcome = await requestJSON(deploymentsPath(appId), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseDeploymentsOutcome(appId, outcome.payload)
}

/** 部署/回滚的**服务端**结果（设计 §5.1：`{deployment?, changed, app?}`）。 */
export interface DeploySuccess {
  ok: true
  appId: string
  /** 本次部署的目标版本（服务端原样回显；缺席时用请求值——两者在成功路径上相等）。 */
  version: string
  /** 服务端是否真的改了（目标 == 当前 ⇒ `false`，幂等，不写审计）。 */
  changed: boolean
  /** 服务端给用户的说明（可空）。 */
  note: string
}

/**
 * 解析部署响应：`{deployment:{version,kind,...}, changed, note?}`。
 *
 * `changed` **必须**是布尔值：它是"线上真的换了版本"的唯一凭据（幂等部署回
 * `changed:false`），回落成"我请求的就是事实"等于把乐观更新伪装成服务端结果。
 * @param appId - 本次请求的 app_id。
 * @param requestedVersion - 本次请求的版本（服务端没回显版本时用它）。
 * @param payload - 响应体。
 * @returns 结构化结果或失败。
 */
export function parseDeployOutcome(appId: string, requestedVersion: string, payload: unknown): DeploySuccess | PublishFailure {
  const root = asRecord(payload)
  const deployment = asRecord(root.deployment)
  if (typeof root.changed !== 'boolean') {
    return shapeMismatch(appId, payload, t('appCenter.deployShapeMismatch'))
  }
  const echoed = asString(deployment.version)
  return {
    ok: true,
    appId,
    version: echoed === '' ? requestedVersion : echoed,
    changed: root.changed,
    note: asString(root.note),
  }
}

/**
 * 部署一个 approved 版本（= **回滚**：用旧版本再部署一次，设计 §3.3）。
 *
 * 不重传、不重审：只发 `{version, message?}`。目标版本必须是 approved 且非当前 ——
 * 服务端会再判一次（`RELEASE_NOT_DEPLOYABLE`），客户端不复刻状态机。
 * @param appId - 应用标识。
 * @param version - 目标版本号。
 * @param deps - 可注入的 fetch / 取消信号 / 说明文字。
 * @returns 服务端结果或结构化失败（永不抛）。
 */
export async function deployVersion(
  appId: string,
  version: string,
  deps: RequestDeps & { message?: string } = {},
): Promise<DeploySuccess | PublishFailure> {
  const body: Record<string, unknown> = { version }
  if (deps.message !== undefined && deps.message !== '') body.message = deps.message
  // 部署写入不带 `limit`（那是读面参数）：路径与读面同前缀，但查询串对写面无意义。
  const outcome = await requestJSON(deploymentsPath(appId, 0), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, deps)
  if (!outcome.ok) return outcome
  return parseDeployOutcome(appId, version, outcome.payload)
}

/** 撤回的**服务端**结果（设计 §5.3：`{release:{version,status:'withdrawn'}, ...}`）。 */
export interface WithdrawSuccess {
  ok: true
  appId: string
  version: string
  /** 服务端确认的新状态（恒为 `withdrawn`；缺席即形状错误）。 */
  status: string
  /** 服务端给用户的说明（版本号永久占位这件事由它转述；可空）。 */
  note: string
}

/**
 * 解析撤回响应：`{release:{version,status}, note?}`。
 * @param appId - 本次请求的 app_id。
 * @param requestedVersion - 本次请求的版本。
 * @param payload - 响应体。
 * @returns 结构化结果或失败。
 */
export function parseWithdrawOutcome(appId: string, requestedVersion: string, payload: unknown): WithdrawSuccess | PublishFailure {
  const root = asRecord(payload)
  // 服务端实际形状（`api/deployments.go` 的 `withdrawForApp`）：
  //   `{app_id, version, status:"withdrawn", changed:true, note}`
  // —— 顶层 `status`/`version`，**没有**嵌套的 `release`。同时容忍 `release:{…}`
  // 这种包装形状（管理面/将来收敛时可能统一），两处都读、只认 `withdrawn`。
  const release = asRecord(root.release)
  const status = asString(root.status) !== '' ? asString(root.status) : asString(release.status)
  if (status !== 'withdrawn') {
    return shapeMismatch(appId, payload, t('appCenter.withdrawShapeMismatch'))
  }
  const echoed = asString(root.version) !== '' ? asString(root.version) : asString(release.version)
  return {
    ok: true,
    appId,
    version: echoed === '' ? requestedVersion : echoed,
    status,
    note: asString(root.note),
  }
}

/**
 * 撤回一个**待审**版本（仅 pending 可撤回；设计 §5.3：字节释放但**版本号永久占用**）。
 *
 * 危险动作（不可逆），调用方必须先二次确认。
 * @param appId - 应用标识。
 * @param version - 版本号。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 服务端结果或结构化失败（永不抛）。
 */
export async function withdrawRelease(appId: string, version: string, deps: RequestDeps = {}): Promise<WithdrawSuccess | PublishFailure> {
  const outcome = await requestJSON(withdrawReleasePath(appId, version), { method: 'POST' }, deps)
  if (!outcome.ok) return outcome
  return parseWithdrawOutcome(appId, version, outcome.payload)
}

// ---------------------------------------------------------------------------
// 诊断（只读）
// ---------------------------------------------------------------------------

/** 一条失败记录（服务端 `diag.Failure`；只取面板要显示的字段）。 */
export interface DiagnosticsFailureRow {
  /** 稳定失败码（`reason_code`）—— 排障的第一判据。 */
  reasonCode: string
  /** `error` / `killed` 等。 */
  outcome: string
  /** 发生时间（服务端 RFC3339 原文）。 */
  createdAt: string
  /** guest 退出码（被杀/陷入时非零）。 */
  guestExitCode: number
}

/** 诊断报告（服务端 `api/read.go` 的 `diagnosticsPayload`）。 */
export interface DiagnosticsReport {
  ok: true
  appId: string
  /** 应用当时的上下架状态（服务端回显，不是目录行的缓存）。 */
  enabled: boolean
  frozen: boolean
  deleted: boolean
  /** 时间窗口（分钟）。 */
  windowMinutes: number
  /** 窗口内调用总数与失败数。 */
  total: number
  failed: number
  /** 最近失败（可能为空）。 */
  failures: DiagnosticsFailureRow[]
  /** 可操作建议（服务端按失败码给出 + 逐条 failure 的建议，已去重）。 */
  hints: string[]
}

/**
 * 解析诊断响应：`{diagnostics:{app_id,app_enabled,...,summary:{total,failed},failures[],hints[]}}`。
 *
 * 字段缺席一律回落成"空/0"而不是编造：诊断页显示"0 失败"是**服务端说的**，
 * 不能是客户端自己推的（评审 R1-pm-16 的教训：诊断口径必须与服务端一致）。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化报告或失败。
 */
export function parseDiagnosticsOutcome(appId: string, payload: unknown): DiagnosticsReport | PublishFailure {
  const body = asRecord(asRecord(payload).diagnostics)
  if (asString(body.app_id) === '') {
    return shapeMismatch(appId, payload, t('appCenter.diagnosticsShapeMismatch'))
  }
  const summary = asRecord(body.summary)
  const rawFailures = Array.isArray(body.failures) ? body.failures : []
  return {
    ok: true,
    appId,
    enabled: body.app_enabled === true,
    frozen: body.app_frozen === true,
    deleted: body.app_deleted === true,
    windowMinutes: typeof body.window_minutes === 'number' ? body.window_minutes : 0,
    total: typeof summary.total === 'number' ? summary.total : 0,
    failed: typeof summary.failed === 'number' ? summary.failed : 0,
    failures: rawFailures
      .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
      .map(row => ({
        reasonCode: asString(row.reason_code),
        outcome: asString(row.outcome),
        createdAt: asString(row.created_at),
        guestExitCode: typeof row.guest_exit_code === 'number' ? row.guest_exit_code : 0,
      })),
    hints: Array.isArray(body.hints)
      ? body.hints.filter((hint): hint is string => typeof hint === 'string' && hint !== '')
      : [],
  }
}

/**
 * 读取一个应用的最近失败诊断（只读；发布者本人或管理员）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 结构化报告或失败（永不抛）。
 */
export async function fetchDiagnostics(appId: string, deps: RequestDeps = {}): Promise<DiagnosticsReport | PublishFailure> {
  const outcome = await requestJSON(diagnosticsPath(appId), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseDiagnosticsOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 作者数据面：自省（schema）+ 行浏览（rows）
// ---------------------------------------------------------------------------
//
// 契约真源：`server/internal/wasmapp/api/read.go`（schema）与 `api/rows.go`（rows）。
// 两个解析器都遵循同一条纪律：**形状对不上就报错，不回落成空表** ——
// 把 404 页面解析成"0 行数据"会让作者以为"数据没写进去"，方向完全错。

/** 自省里的一张表。 */
export interface AppSchemaTable {
  /** 表名（`db.define` 用的那个；平台规则：小写字母开头、[a-z0-9_]）。 */
  name: string
  /** 行数（服务端 `SELECT COUNT(*)`）。 */
  rows: number
  /** 列（含平台自动追加的 `_row_id`，与 `db.define` 的视角一致）。 */
  columns: Array<{ name: string, type: string, pk: boolean }>
  /** 表名不符合平台规则（不是 `db.define` 建的）时置位，此时 columns 为空。 */
  skipped: boolean
  /** skipped 的原因（服务端原文）。 */
  skipReason: string
}

/** 自省报告（服务端 `inspectAppDB`）。 */
export interface AppSchemaReport {
  ok: true
  appId: string
  /** 数据根之下的逻辑路径（不暴露宿主目录布局）。 */
  db: string
  sizeBytes: number
  maxBytes: number
  tableCount: number
  usagePercent: number
  tables: AppSchemaTable[]
}

/**
 * 解析自省响应（`{schema:{app_id,...,tables:[...]}}`）。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化报告或失败。
 */
export function parseSchemaOutcome(appId: string, payload: unknown): AppSchemaReport | PublishFailure {
  const body = asRecord(asRecord(payload).schema)
  if (asString(body.app_id) === '') {
    return shapeMismatch(appId, payload, t('appCenter.schemaShapeMismatch'))
  }
  // **数组缺失 = 形状不符 ⇒ 失败**（2026-09-21 独立审计 P2-2）：回落成 `[]` 会把
  // "服务端改了字段名/返回被截断"渲染成"这个应用还没有数据库"，排障方向完全错。
  // 显式的空数组（服务端说"确实没有表"）仍然正常通过。
  if (!Array.isArray(body.tables)) {
    return shapeMismatch(appId, payload, t('appCenter.schemaShapeMismatch'))
  }
  const rawTables = body.tables
  return {
    ok: true,
    appId,
    db: asString(body.db),
    sizeBytes: typeof body.size_bytes === 'number' ? body.size_bytes : 0,
    maxBytes: typeof body.max_bytes === 'number' ? body.max_bytes : 0,
    tableCount: typeof body.table_count === 'number' ? body.table_count : rawTables.length,
    usagePercent: typeof body.usage_percent === 'number' ? body.usage_percent : 0,
    tables: rawTables
      .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
      .map(row => ({
        name: asString(row.name),
        rows: typeof row.rows === 'number' ? row.rows : 0,
        columns: (Array.isArray(row.columns) ? row.columns : [])
          .filter((col): col is Record<string, unknown> => col !== null && typeof col === 'object')
          .map(col => ({
            name: asString(col.name),
            type: asString(col.type),
            pk: col.pk === true,
          })),
        skipped: row.skipped === true,
        skipReason: asString(row.skip_reason),
      })),
  }
}

/** 数据浏览的一列。 */
export interface AppRowsColumn {
  name: string
  type: string
  /** 服务端按列名启发式判定为敏感（默认脱敏；显式 unmask 才给原值）。 */
  sensitive: boolean
}

/** 数据浏览报告（服务端 `rowsPayload`）。 */
export interface AppRowsReport {
  ok: true
  appId: string
  table: string
  columns: AppRowsColumn[]
  /** 行值：字符串/数字/布尔/null（服务端已把 BLOB 归一成字符串）。 */
  rows: Array<Array<string | number | boolean | null>>
  limit: number
  offset: number
  returned: number
  totalRows: number
  hasMore: boolean
  /** 服务端返回上限（行数/字节）被命中 —— 与 hasMore 是两件事。 */
  truncated: boolean
  /** 被按字节截断的值个数。 */
  truncatedValues: number
  unmasked: boolean
  maskedColumns: string[]
  valueMaxBytes: number
}

/**
 * 解析数据浏览响应（`{rows:{app_id,table,columns,rows,...}}`）。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 结构化报告或失败。
 */
export function parseRowsOutcome(appId: string, payload: unknown): AppRowsReport | PublishFailure {
  const body = asRecord(asRecord(payload).rows)
  if (asString(body.app_id) === '' || asString(body.table) === '') {
    return shapeMismatch(appId, payload, t('appCenter.rowsShapeMismatch'))
  }
  // 同理：`rows`/`columns` 缺失或非数组 ⇒ 形状不符（不能画成"这张表还是空的"）。
  if (!Array.isArray(body.rows) || !Array.isArray(body.columns)) {
    return shapeMismatch(appId, payload, t('appCenter.rowsShapeMismatch'))
  }
  const rawCols = body.columns
  const rawRows = body.rows
  return {
    ok: true,
    appId,
    table: asString(body.table),
    columns: rawCols
      .filter((col): col is Record<string, unknown> => col !== null && typeof col === 'object')
      .map(col => ({
        name: asString(col.name),
        type: asString(col.type),
        sensitive: col.sensitive === true,
      })),
    rows: rawRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map(row => row.map(v => (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v)))),
    limit: typeof body.limit === 'number' ? body.limit : 0,
    offset: typeof body.offset === 'number' ? body.offset : 0,
    returned: typeof body.returned === 'number' ? body.returned : rawRows.length,
    totalRows: typeof body.total_rows === 'number' ? body.total_rows : 0,
    hasMore: body.has_more === true,
    truncated: body.truncated === true,
    truncatedValues: typeof body.truncated_values === 'number' ? body.truncated_values : 0,
    unmasked: body.unmasked === true,
    maskedColumns: Array.isArray(body.masked_columns)
      ? body.masked_columns.filter((c): c is string => typeof c === 'string')
      : [],
    valueMaxBytes: typeof body.value_max_bytes === 'number' ? body.value_max_bytes : 0,
  }
}

/**
 * 读取一个应用的表结构（只读；发布者本人）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 结构化报告或失败（永不抛）。
 */
export async function fetchSchema(appId: string, deps: RequestDeps = {}): Promise<AppSchemaReport | PublishFailure> {
  const outcome = await requestJSON(schemaPath(appId), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseSchemaOutcome(appId, outcome.payload)
}

/**
 * 读取一个应用某张表的行（只读；发布者本人；默认脱敏）。
 * @param appId - 应用标识。
 * @param query - table / limit / offset / unmask。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 结构化报告或失败（永不抛）。
 */
export async function fetchRows(
  appId: string,
  query: { table: string, limit?: number, offset?: number, unmask?: boolean },
  deps: RequestDeps = {},
): Promise<AppRowsReport | PublishFailure> {
  const outcome = await requestJSON(rowsPath(appId, query), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseRowsOutcome(appId, outcome.payload)
}

// ---------------------------------------------------------------------------
// 「允许 AI 读取此应用的数据」的授权卡（默认关；2026-09-21 用户拍板）
// ---------------------------------------------------------------------------
//
// 这段是**客户端半边**：面板把它当普通本机路由调用，真正的闸门在宿主工具
// （`wasm_app_rows`，见 `packages/host/enterprise/src/wasm-app-tools.ts`）。
// 授权状态落在宿主私有文件（`$DSH_HOME/wasm-apps-ai-rows-consent.json`），
// 因此**面板必须读宿主**（不能拿渲染层 `localStorage` 当真相）——否则换窗口/重开
// 客户端后面板显示的开关状态与宿主实际闸门会不一致。
//
// 授权**作用域 = 用户名 ⊕ 服务端地址 ⊕ 应用**（R19B-03，2026-09-25）：面板只管
// "当前这个人、连这台服务端、对这个应用"的那一格；换账号 / 换服务端地址都**不继承**
// （落盘 v2，旧记录按未授权）。作用域由宿主侧按每次调用解析，客户端不参与拼键 ——
// 所以这里没有任何 user/server 参数，面板也不需要知道当前是谁。

/**
 * 授权路由的后缀（**跨端契约**：宿主 `wasm-apps.ts` 的 `AI_ROWS_CONSENT_SUFFIX`
 * 是同值的另一份字面量；客户端不 import 宿主包，漂移由 `ai-rows-consent.spec.tsx`
 * 的读源码对拍钉住）。
 */
export const AI_ROWS_CONSENT_SUFFIX = 'ai-rows-consent'

/**
 * 一个应用的 AI 行数据授权路由。
 * @param appId - 应用标识（路径段，必须 URI 编码）。
 * @returns 以 `/` 开头的本机路径。
 */
export function aiRowsConsentPath(appId: string): string {
  return lifecyclePath(appId, AI_ROWS_CONSENT_SUFFIX)
}

/** 授权状态（宿主返回值）。 */
export interface AiRowsConsentState {
  ok: true
  appId: string
  /** true = 允许 AI 读这个应用的数据（仅脱敏列）；false = 默认关。 */
  enabled: boolean
}

/**
 * 解析授权响应（`{app_id, enabled}`）。
 *
 * 形状不符 ⇒ **失败**（不回落成 `false`）：把"宿主方言变了"显示成"未授权"会让用户
 * 反复点开关而不知道为什么没反应（与 rows/schema 的"不回落成空表"同一条纪律）。
 * @param appId - 本次请求的 app_id。
 * @param payload - 响应体。
 * @returns 状态或失败。
 */
export function parseAiRowsConsentOutcome(appId: string, payload: unknown): AiRowsConsentState | PublishFailure {
  const body = asRecord(payload)
  if (asString(body.app_id) !== appId || typeof body.enabled !== 'boolean') {
    return shapeMismatch(appId, payload, t('appCenter.aiRowsShapeMismatch'))
  }
  return { ok: true, appId, enabled: body.enabled }
}

/**
 * 读授权状态（只读；宿主 `GET …/:app_id/ai-rows-consent`）。
 * @param appId - 应用标识。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 状态或失败（永不抛）。
 */
export async function fetchAiRowsConsent(appId: string, deps: RequestDeps = {}): Promise<AiRowsConsentState | PublishFailure> {
  const outcome = await requestJSON(aiRowsConsentPath(appId), { method: 'GET' }, deps)
  if (!outcome.ok) return outcome
  return parseAiRowsConsentOutcome(appId, outcome.payload)
}

/**
 * 写授权状态（宿主 `POST …/:app_id/ai-rows-consent`，带持有性证明）。
 *
 * 只有**显式**调用才会打开闸门：这个函数是"授权卡"的唯一实现，模型面（工具）没有
 * 任何等价入口 —— `wasm_app_rows` 连 `unmask` 参数都没有，更不会替人点这个开关。
 * @param appId - 应用标识。
 * @param enabled - true = 允许，false = 撤销。
 * @param deps - 可注入的 fetch / 取消信号。
 * @returns 宿主**回报的**状态（以宿主为准，不做乐观更新）。
 */
export async function setAiRowsConsent(appId: string, enabled: boolean, deps: RequestDeps = {}): Promise<AiRowsConsentState | PublishFailure> {
  const outcome = await requestJSON(aiRowsConsentPath(appId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }, deps)
  if (!outcome.ok) return outcome
  return parseAiRowsConsentOutcome(appId, outcome.payload)
}
