/**
 * 「限流覆盖（N）」总览对话框（生产化评审 · 管理员视角的已知缺口）。
 *
 * ## 为什么需要它
 *
 * per-app 限流覆盖此前**只能逐个应用翻详情抽屉**（`AppLimitsSection.tsx`）：管理员既
 * 发现不了"哪些应用被单独限流/降额"，也审查不了"已删应用是不是还留着残留覆盖"。
 * 服务端 2026-10-22 补了两条只读出口（决策 §2.3 的例外清单 + `/admin/runtime`
 * 的队列/调度器读数），本对话框把它们变成可操作的同一屏：
 *
 *   - **全部覆盖**（`GET /wasm-apps/limit-overrides`）：app_id/标题、四轴 override、
 *     四轴 effective、是否高于全局、更新时间/人；
 *   - **逐行恢复默认**（`DELETE /wasm-apps/:app_id/limits` = 清空覆盖）→ 成功**回读**
 *     服务端清单（不乐观更新）；
 *   - **运行时水位**（`GET /wasm-apps/runtime` 的 `queue` / `schedulers` 只读摘要）：
 *     "哪个应用在拖垮平台"（top_apps 前 N）与 `wasm_retirement` 真删作业跑没跑。
 *
 * ## 五条实现纪律
 *
 *   1. **读不到 ≠ 没有**：清单缺 `items`、运行时缺 `queue`、调度器缺 `schedulers` 都是
 *      "未下发"，界面必须明说（把它们渲染成空表/0 会让管理员得出相反结论）。
 *   2. **失败不乐观更新**：DELETE 失败时这一行**一个字都不动**，只把服务端信封原样摆出来。
 *   3. **已删除/已清除的应用**：覆盖行按设计保留（0087 无外键、purge 不删覆盖行）⇒ 必须
 *      列出来并标出来源；但写面一律 404（不泄露存在性），因此这两类行**不渲染可点的
 *      「恢复默认」**—— 渲染出来必然 404，管理员只会得到"点了没反应"。
 *   4. **标题与生命周期状态来自应用目录**（`GET /wasm-apps?include_deleted=1&limit=…`）：
 *      覆盖端点只给 app_id。目录读失败时**降级但不说谎**："应用状态未知"，而不是当作
 *      "应用存在"或"应用已删"。
 *   5. **复用 shadcn/ui + 既有契约**：路径/类型/错误归一都在 `app-limits.ts` 与
 *      `app-runtime.ts`，本文件只做组合与状态编排。
 *
 * 变异自证（删实现即红的用例见 `LimitOverridesDialog.test.tsx`）：
 *   · 去掉 `parseAppLimitOverrides` 的 `items` 数组校验 ⇒ 错误态用例红（会渲染成空态）；
 *   · 恢复默认不 GET 回读、直接从本地 state 删行 ⇒ 「成功后回读」用例红；
 *   · 失败后本地删行 ⇒ 「失败不乐观更新」用例红；
 *   · 已删除行照旧渲染可点按钮 ⇒ 「已删除应用不发出 DELETE」用例红；
 *   · 运行时缺 `queue` 时渲染 0 ⇒ 「未下发」用例红。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { errorText } from '../../lib/api-error'
import { fmtTime, WASM_APPS_PATH } from './apps-lifecycle'
import {
  appLimitsPath,
  effectiveSummary,
  LIMIT_OVERRIDES_PATH,
  limitOverridesErrorText,
  limitsErrorText,
  overrideAxisRows,
  overrideResetReceipt,
  overrideRowLabel,
  parseAppLimitOverrides,
  type AppLimitOverrideRow,
  type AppLimitOverridesView,
} from './app-limits'
import {
  parseRuntimeSummary,
  queueSentence,
  RETIREMENT_SCHEDULER,
  schedulerSentence,
  WASM_RUNTIME_PATH,
  type RuntimeSummary,
} from './app-runtime'
import { RefreshCw, RotateCcw } from 'lucide-react'

/**
 * 应用目录一次取多少行。
 *
 * 服务端单页上限是 `adminListMaxLimit = 1000`；这里取同一个数。为什么需要目录：
 * 覆盖行只有 app_id，而"标题 + 是否已删除/已清除"只在应用列表里（且必须带
 * `include_deleted=1`，否则已删应用整行消失 ⇒ 残留覆盖看起来像"应用还在"）。
 * 目录被截断时超出的行**如实标成"状态未知"**（见 rowLifecycleNotice）。
 */
const DIRECTORY_LIMIT = 1000

/** top_apps 在摘要里展示前几条（服务端给前 20）。 */
const TOP_APPS_SHOWN = 5

/** 应用目录里我们需要的三项（其余字段与覆盖总览无关）。 */
interface AppDirectoryEntry {
  title: string
  deletedAt: string | null
  purgedAt: string | null
}

type DirectoryState = 'idle' | 'loading' | 'ok' | 'error'

interface DirectoryParseOk {
  ok: true
  entries: Record<string, AppDirectoryEntry>
  truncated: boolean
}
type DirectoryParse = DirectoryParseOk | { ok: false; reason: string }

function readTime(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 解析应用目录（列表响应 `{apps, truncated, …}`）。
 *
 * 只读三项：`title` / `deleted_at` / `purged_at`。缺 `apps` 数组 ⇒ 失败（页面说
 * "应用状态未知"），绝不按"没有应用"处理。
 */
function parseDirectory(raw: unknown): DirectoryParse {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: '响应不是对象' }
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.apps)) {
    return { ok: false, reason: '响应里没有 apps 数组（这不是「没有应用」，应用状态未知）' }
  }
  const entries: Record<string, AppDirectoryEntry> = {}
  for (const item of body.apps) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const appId = typeof row.app_id === 'string' ? row.app_id.trim() : ''
    if (appId === '') continue
    entries[appId] = {
      title: typeof row.title === 'string' ? row.title : '',
      deletedAt: readTime(row.deleted_at),
      purgedAt: readTime(row.purged_at),
    }
  }
  return { ok: true, entries, truncated: body.truncated === true }
}

/** 目录查询串：`include_deleted=1` 是这一屏的关键（没有它，残留覆盖的已删应用会整行消失）。 */
function directoryPath(): string {
  return `${WASM_APPS_PATH}?include_deleted=1&limit=${DIRECTORY_LIMIT}&offset=0`
}

export interface LimitOverridesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  canRead: boolean
  canWrite: boolean
  /** 清空覆盖成功后的回调（应用页据此刷新列表徽标与「限流覆盖（N）」）。 */
  onChanged: () => void
}

export function LimitOverridesDialog({ open, onOpenChange, canRead, canWrite, onChanged }: LimitOverridesDialogProps) {
  const [view, setView] = useState<AppLimitOverridesView | null>(null)
  const [loading, setLoading] = useState(false)
  /** 清单读取失败（整份不可信）与**动作**失败（清单仍可信，只是那次清空没成功）分开。 */
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  /** 清空成功的回执（常驻到下一次动作/刷新，不自动消失）。 */
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState('')

  const [directory, setDirectory] = useState<Record<string, AppDirectoryEntry> | null>(null)
  const [directoryState, setDirectoryState] = useState<DirectoryState>('idle')
  const [directoryError, setDirectoryError] = useState('')
  const [directoryTruncated, setDirectoryTruncated] = useState(false)

  const [runtime, setRuntime] = useState<RuntimeSummary | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const [runtimeError, setRuntimeError] = useState('')

  /** 请求序号：连点刷新/关闭重开时只认最后一次响应（与 PendingQueueDialog 同形）。 */
  const seq = useRef(0)
  /** 运行时水位有自己的一条在飞链（连点刷新时同样只认最后一次）。 */
  const runtimeSeq = useRef(0)

  const loadDirectory = useCallback(async (current: number) => {
    setDirectoryState('loading')
    setDirectoryError('')
    try {
      const raw = await request<unknown>(directoryPath())
      if (current !== seq.current) return
      const parsed = parseDirectory(raw)
      if (!parsed.ok) {
        setDirectory(null)
        setDirectoryTruncated(false)
        setDirectoryState('error')
        setDirectoryError(`读取应用目录失败：${parsed.reason}`)
        return
      }
      setDirectory(parsed.entries)
      setDirectoryTruncated(parsed.truncated)
      setDirectoryState('ok')
    } catch (err: unknown) {
      if (current !== seq.current) return
      setDirectory(null)
      setDirectoryTruncated(false)
      setDirectoryState('error')
      setDirectoryError(`读取应用目录失败：${errorText(err, '读取应用目录失败')}（覆盖清单本身已读到）`)
    }
  }, [])

  /**
   * 读覆盖清单（GET）。
   *
   * 成功且**有覆盖行**时才去读应用目录（无覆盖是常见情况，没必要拉一次目录页）。
   * 清空成功后也走这里 —— 界面以服务端回读为准（不乐观更新）。
   */
  const load = useCallback(async () => {
    if (!canRead) {
      setLoading(false)
      return
    }
    const current = ++seq.current
    setLoading(true)
    setLoadError('')
    setActionError('')
    setDirectory(null)
    setDirectoryState('idle')
    setDirectoryError('')
    setDirectoryTruncated(false)
    try {
      const raw = await request<unknown>(LIMIT_OVERRIDES_PATH)
      if (current !== seq.current) return
      const parsed = parseAppLimitOverrides(raw)
      if (!parsed.ok) {
        setView(null)
        setLoadError(`读取限流覆盖失败：${parsed.reason}`)
        return
      }
      setView(parsed.value)
      if (parsed.value.items.length > 0) void loadDirectory(current)
    } catch (err: unknown) {
      if (current !== seq.current) return
      setView(null)
      setLoadError(limitOverridesErrorText(err, '读取限流覆盖失败'))
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [canRead, loadDirectory])

  /** 运行时水位（`queue` / `schedulers` / `app_limits.override_count`）的只读摘要。 */
  const loadRuntime = useCallback(async () => {
    if (!canRead) return
    const current = ++runtimeSeq.current
    setRuntimeLoading(true)
    setRuntimeError('')
    try {
      const parsed = parseRuntimeSummary(await request<unknown>(WASM_RUNTIME_PATH))
      if (current !== runtimeSeq.current) return
      if (!parsed.ok) {
        setRuntime(null)
        setRuntimeError(`读取运行时水位失败：${parsed.reason}`)
        return
      }
      setRuntime(parsed.value)
    } catch (err: unknown) {
      if (current !== runtimeSeq.current) return
      setRuntime(null)
      setRuntimeError(errorText(err, '读取运行时水位失败'))
    } finally {
      if (current === runtimeSeq.current) setRuntimeLoading(false)
    }
  }, [canRead])

  useEffect(() => {
    if (!open) return
    setView(null)
    setFlash('')
    setActionError('')
    setRuntime(null)
    setRuntimeError('')
    void load()
    void loadRuntime()
  }, [open, load, loadRuntime])

  /**
   * 清空某应用的覆盖（`DELETE /:app_id/limits`）。
   *
   * 先本地闸门（已删除/已清除/无写权限 ⇒ 不发注定 404/403 的请求），成功后 `load()`
   * 回读服务端清单。失败时**不删行、不改覆盖摘要**，只显示服务端信封。
   */
  const resetOverride = useCallback(
    async (row: AppLimitOverrideRow) => {
      if (!canWrite || busy !== '') return
      const entry = directory?.[row.appId]
      if (entry?.purgedAt || entry?.deletedAt) return
      setBusy(row.appId)
      setActionError('')
      setFlash('')
      try {
        await request(appLimitsPath(row.appId), { method: 'DELETE' })
        setFlash(overrideResetReceipt(overrideRowLabel(row, entry?.title ?? null)))
        await load()
        onChanged()
      } catch (err: unknown) {
        // **不乐观更新**：行与覆盖摘要一个字都不动，只把服务端命中的原因摆出来。
        setActionError(limitsErrorText(err, '恢复默认失败'))
      } finally {
        setBusy('')
      }
    },
    [busy, canWrite, directory, load, onChanged],
  )

  const total = view === null ? null : view.total
  const countMismatch =
    view !== null && view.serverTotal !== null && view.serverTotal !== view.total
  const runtimeCountMismatch =
    view !== null && runtime !== null && runtime.overrideCount !== null && runtime.overrideCount !== view.total

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto" data-testid="limit-overrides-dialog">
        <DialogHeader>
          <DialogTitle>限流覆盖（{total === null ? '—' : total}）</DialogTitle>
          <DialogDescription>
            全部按应用的限流覆盖（全局基线之外的例外）：override = 该应用自己的值，effective =
            全局复制后套用非空覆盖（继承的子轴会随父轴收紧向下钳）。高于全局的行会标出来 ——
            它比别的应用占更多槽位。逐行「恢复默认」清空覆盖（立即按全局值准入）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            读面无分页（覆盖是例外配置）；写动作与详情抽屉的「限流」块同一端点、同一审计（
            <span className="font-mono">wasm_app_limits_change</span>）。
          </p>
          <Button
            variant="ghost"
            size="sm"
            data-testid="limit-overrides-refresh"
            disabled={!canRead || loading}
            aria-label="刷新限流覆盖"
            title="重新读取覆盖清单与应用目录（运行时水位随之刷新）"
            onClick={() => {
              void load()
              void loadRuntime()
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {!canRead ? (
          <p data-testid="limit-overrides-no-permission" className="text-sm text-muted-foreground">
            没有 capability:read 权限：限流覆盖总览不可读（服务端同样会拒绝读请求）。
          </p>
        ) : (
          <>
            {/* ---- 运行时水位（只读摘要；不做成独立页面） ---- */}
            <section className="space-y-1 rounded-md border p-2" data-testid="limit-overrides-runtime">
              <h3 className="text-xs font-semibold">运行时水位（只读）</h3>
              {runtimeError !== '' && (
                <p
                  data-testid="limit-overrides-runtime-error"
                  role="alert"
                  aria-live="assertive"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
                >
                  {runtimeError}
                </p>
              )}
              {runtimeError === '' && runtimeLoading && runtime === null && (
                <p data-testid="limit-overrides-runtime-loading" className="text-xs text-muted-foreground">
                  读取运行时水位…
                </p>
              )}
              {runtime !== null && (
                <>
                  {runtime.queue === null ? (
                    <p data-testid="limit-overrides-queue-missing" className="text-xs text-muted-foreground">
                      执行队列水位：服务端未下发（不是 0 —— 可能装配未注入队列统计）。
                    </p>
                  ) : (
                    <>
                      <p data-testid="limit-overrides-queue" className="text-xs">
                        {queueSentence(runtime.queue)}
                      </p>
                      {runtime.queue.topApps === null ? (
                        <p data-testid="limit-overrides-top-apps-missing" className="text-xs text-muted-foreground">
                          按应用水位：服务端未下发（不是「当前没有应用在排队」）。
                        </p>
                      ) : runtime.queue.topApps.length === 0 ? (
                        <p data-testid="limit-overrides-top-apps-empty" className="text-xs text-muted-foreground">
                          按应用水位：当前没有在跑/排队的应用。
                        </p>
                      ) : (
                        <ul className="space-y-0.5 text-xs" data-testid="limit-overrides-top-apps">
                          {runtime.queue.topApps.slice(0, TOP_APPS_SHOWN).map((row) => (
                            <li key={row.appId} data-testid={`limit-overrides-top-app-${row.appId}`}>
                              <span className="font-mono">{row.appId}</span>
                              ：在跑 <span className="font-mono">{row.running}</span> · 排队{' '}
                              <span className="font-mono">{row.waiting}</span> · 429{' '}
                              <span className="font-mono">{row.rejected}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                  {runtime.schedulers === null ? (
                    <p data-testid="limit-overrides-schedulers-missing" className="text-xs text-muted-foreground">
                      后台调度器：服务端未下发（不是「没有调度器」）。
                    </p>
                  ) : runtime.schedulers.length === 0 ? (
                    <p data-testid="limit-overrides-schedulers-empty" className="text-xs text-muted-foreground">
                      后台调度器：服务端回报 0 个（两阶段真删/保留期回收都不会自动跑）。
                    </p>
                  ) : (
                    <ul className="space-y-0.5 text-xs" data-testid="limit-overrides-schedulers">
                      {runtime.schedulers.map((s) => (
                        <li
                          key={s.name}
                          data-testid={`limit-overrides-scheduler-${s.name}`}
                          className={s.name === RETIREMENT_SCHEDULER ? 'font-medium' : 'text-muted-foreground'}
                        >
                          <span className="font-mono">{s.name}</span>：{schedulerSentence(s)}
                          {s.name === RETIREMENT_SCHEDULER && (
                            <span className="ml-1 text-muted-foreground">
                              （冻结/删除承诺的执行者：它停摆 ⇒ 保留期到点也不会真删）
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {runtimeCountMismatch && runtime !== null && view !== null && (
                    <p data-testid="limit-overrides-count-mismatch" className="text-xs text-destructive">
                      运行时汇报在册覆盖 {runtime.overrideCount} 条，与本清单 {view.total}{' '}
                      条不一致：两次查询之间有人改动或某次下发失败，点刷新核对。
                    </p>
                  )}
                </>
              )}
            </section>

            {/* ---- 覆盖清单 ---- */}
            {loadError !== '' && (
              <div className="space-y-2">
                <p
                  data-testid="limit-overrides-error"
                  role="alert"
                  aria-live="assertive"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive"
                >
                  {loadError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="limit-overrides-retry"
                  onClick={() => { void load() }}
                >
                  <RefreshCw className="mr-1 h-4 w-4" />重试
                </Button>
              </div>
            )}
            {loadError === '' && loading && view === null && (
              <p data-testid="limit-overrides-loading" className="text-sm text-muted-foreground">
                读取限流覆盖…
              </p>
            )}

            {view !== null && (
              <>
                <p className="text-xs text-muted-foreground" data-testid="limit-overrides-global">
                  全局基线（继承值）：{effectiveSummary(view.global)}
                </p>
                {countMismatch && (
                  <p data-testid="limit-overrides-total-mismatch" className="text-xs text-destructive">
                    服务端 total={view.serverTotal} 与清单行数 {view.total} 不一致（形状漂移）：以屏幕上的行为准，请核对服务端。
                  </p>
                )}
                {directoryState === 'loading' && (
                  <p data-testid="limit-overrides-directory-loading" className="text-xs text-muted-foreground">
                    读取应用目录（标题 / 删除与清除状态）…
                  </p>
                )}
                {directoryState === 'error' && directoryError !== '' && (
                  <p data-testid="limit-overrides-directory-error" className="text-xs text-muted-foreground">
                    {directoryError}
                  </p>
                )}
                {directoryState === 'ok' && directoryTruncated && (
                  <p data-testid="limit-overrides-directory-truncated" className="text-xs text-muted-foreground">
                    应用目录超过 {DIRECTORY_LIMIT} 条被截断：不在目录里的行会标成「状态未知」。
                  </p>
                )}

                {view.items.length === 0 ? (
                  <p data-testid="limit-overrides-empty" className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
                    当前没有任何按应用的限流覆盖：所有应用都按上面的全局四轴准入。要按应用降额/放宽，
                    请打开该应用详情抽屉的「限流」块。
                  </p>
                ) : (
                  <ul className="space-y-2" data-testid="limit-overrides-list">
                    {view.items.map((row) => {
                      const entry = directory?.[row.appId] ?? null
                      const purged = entry?.purgedAt !== null && entry?.purgedAt !== undefined
                      const deleted = !purged && entry?.deletedAt !== null && entry?.deletedAt !== undefined
                      const blocked = purged || deleted
                      const label = overrideRowLabel(row, entry?.title ?? null)
                      const disabledReason = purged
                        ? '该应用数据已清除（purged）：覆盖行按设计保留，但写面 404，不可恢复也不可在此清空'
                        : deleted
                          ? '该应用已删除（保留期内）：覆盖行按设计保留（恢复后仍生效），但写面 404 —— 先在应用列表「恢复」'
                          : ''
                      const busyRow = busy === row.appId
                      return (
                        <li
                          key={row.appId}
                          data-testid={`limit-overrides-row-${row.appId}`}
                          className="space-y-1 rounded-md border p-2"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium" title={label}>{label}</div>
                              <div className="truncate font-mono text-xs text-muted-foreground" title={row.appId}>
                                {row.appId}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                              {row.exceedsAny && (
                                <Badge
                                  variant="destructive"
                                  data-testid={`limit-overrides-exceeds-${row.appId}`}
                                  tabIndex={0}
                                  title="该应用的生效值有轴高于全局 —— 它会比其他应用占用更多槽位"
                                >
                                  高于全局
                                </Badge>
                              )}
                              {purged ? (
                                <Badge variant="secondary" data-testid={`limit-overrides-state-${row.appId}`}>
                                  应用已清除
                                </Badge>
                              ) : deleted ? (
                                <Badge variant="secondary" data-testid={`limit-overrides-state-${row.appId}`}>
                                  应用已删除
                                </Badge>
                              ) : null}
                              <Button
                                size="sm"
                                variant="outline"
                                data-testid={`limit-overrides-reset-${row.appId}`}
                                disabled={!canWrite || busy !== '' || blocked}
                                aria-describedby={blocked ? `limit-overrides-lifecycle-${row.appId}` : undefined}
                                title={
                                  !canWrite
                                    ? '没有 capability:write 权限：清空覆盖已禁用（服务端同样会拒绝）'
                                    : blocked
                                      ? disabledReason
                                      : '清空该应用的覆盖：四轴全部恢复继承全局（立即生效，写审计）'
                                }
                                onClick={() => { void resetOverride(row) }}
                              >
                                <RotateCcw className="mr-1 h-4 w-4" />
                                {busyRow ? '提交中…' : '恢复默认'}
                              </Button>
                            </div>
                          </div>

                          <div className="grid gap-1 text-xs sm:grid-cols-2">
                            {overrideAxisRows(row).map((axis) => (
                              <div key={axis.key} data-testid={`limit-overrides-axis-${row.appId}-${axis.key}`}>
                                <span className="text-muted-foreground" title={axis.label}>
                                  {axis.key}：
                                </span>
                                <span className="font-mono">{axis.override === null ? '继承' : axis.override}</span>
                                <span className="text-muted-foreground"> → 生效 </span>
                                <span className={axis.exceeds ? 'font-mono text-destructive' : 'font-mono'}>
                                  {axis.effective}
                                </span>
                                {axis.exceeds && <span className="ml-1 text-destructive">（高于全局）</span>}
                              </div>
                            ))}
                          </div>

                          <p className="text-xs text-muted-foreground" data-testid={`limit-overrides-meta-${row.appId}`}>
                            更新时间 {fmtTime(row.updatedAt)} · 更新人 {row.updatedBy ?? '—'}
                            {row.exceedsFromServer ? '' : '（逐轴越界明细由本页按 生效值 > 全局值 推导）'}
                          </p>

                          {/* 已删除/已清除：覆盖行保留是设计语义（0087 无外键、purge 不删覆盖行），
                              必须显示出来并说明"为什么不能在这里清空"。 */}
                          {blocked && (
                            <p
                              id={`limit-overrides-lifecycle-${row.appId}`}
                              data-testid={`limit-overrides-lifecycle-${row.appId}`}
                              className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs"
                            >
                              {disabledReason}
                              {purged
                                ? '；覆盖行会一直保留（应用已不可用，覆盖不再生效）。'
                                : '；恢复后覆盖仍按原值生效，届时可在这里或详情抽屉清空。'}
                            </p>
                          )}
                          {!blocked && directoryState === 'ok' && entry === null && (
                            <p
                              id={`limit-overrides-lifecycle-${row.appId}`}
                              data-testid={`limit-overrides-lifecycle-${row.appId}`}
                              className="text-xs text-muted-foreground"
                            >
                              {directoryTruncated
                                ? `该应用不在目录前 ${DIRECTORY_LIMIT} 条内（状态未知）：覆盖行仍保留，「恢复默认」若返回 404 说明应用已删除/清除。`
                                : '应用目录里没有这一条（可能已真删/清除）：覆盖行仍保留，「恢复默认」若返回 404 说明应用已不可写。'}
                            </p>
                          )}
                          {directoryState === 'error' && (
                            <p
                              id={`limit-overrides-lifecycle-${row.appId}`}
                              data-testid={`limit-overrides-lifecycle-${row.appId}`}
                              className="text-xs text-muted-foreground"
                            >
                              应用状态未知（目录读取失败，覆盖清单本身已读到）：「恢复默认」若返回 404 说明应用已删除/清除。
                            </p>
                          )}
                          {directoryState === 'loading' && (
                            <p
                              id={`limit-overrides-lifecycle-${row.appId}`}
                              data-testid={`limit-overrides-lifecycle-${row.appId}`}
                              className="text-xs text-muted-foreground"
                            >
                              应用状态读取中…
                            </p>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}

                {actionError !== '' && (
                  <p
                    data-testid="limit-overrides-action-error"
                    role="alert"
                    aria-live="assertive"
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive"
                  >
                    {actionError}
                  </p>
                )}
                {flash !== '' && (
                  <p
                    data-testid="limit-overrides-flash"
                    role="status"
                    aria-live="polite"
                    className="rounded-md border border-border bg-muted px-2 py-1.5 text-sm"
                  >
                    {flash}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
