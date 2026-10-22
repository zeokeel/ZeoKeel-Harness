/**
 * 详情抽屉的「限流」块（设计 `docs/decisions/2026-10-22-wasm-per-app-limits.md` §2.5）。
 *
 * ## 这一块解决的是什么问题
 *
 * 全局只有一套旋钮（`settings.wasm.limits`）：某个应用异常时，管理员只能整体冻结，没有
 * "单独限流/降额"这一档。per-app 覆盖给四个轴（`app_running` / `app_queue` /
 * `user_per_app_running` / `user_per_app_queued`）加一层**可空**的值：
 * 空 = 继承全局，非空 = 该应用的显式覆盖。
 *
 * ## 五条实现纪律（每一条都被 `AppLimitsSection.test.tsx` 咬住）
 *
 *   1. **占位符 = 全局默认值**：四行输入留空时，占位符必须显示该轴当前的全局值，
 *      否则"空 = 继承"就变成了"空 = 我不知道"。
 *   2. **保存前展示 effective**：每一行都显示"保存后的生效值"，并有一行汇总 ——
 *      管理员在点保存之前就该知道这次改动会变成什么。
 *   3. **`exceeds_global` 要二次确认**：§2.1 允许高于全局（显式动作），但绝不允许
 *      "悄悄发生" —— 每次提交前按待保存的生效值判定，一旦有轴超过全局就弹确认框，
 *      取消则**一个请求都不发**。
 *   4. **失败不乐观更新 / 成功回读**：PUT 失败时把服务端信封原样渲染，输入框与
 *      "已保存的覆盖"一个字都不动；PUT 成功后再 GET 一次，界面以**服务端回读的视图**
 *      为准（PUT 的响应可能只是 `{changed}`，拿它拼界面就是乐观更新）。
 *   5. **已删除 / 已清除的应用没有写入口**（§2.3：写面 404 不泄露存在性）：这两种行
 *      连 GET 都不发 —— 渲染一个必然 404 的入口，管理员只会得到"点了没反应"。
 *
 * 「恢复默认」是一次**立刻生效的写动作**（`PUT null` = 清空全部覆盖），与全局限制项页的
 * 「恢复默认/档位」同口径（那一页也是立即 PUT，而不是只清表单）；失败同样原样报错。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../api'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { errorText } from '../../lib/api-error'
import { RefreshCw, RotateCcw, Save } from 'lucide-react'
import { isMissingEndpoint, type AppLifecycleFields, type ParseResult } from './apps-lifecycle'
import {
  anyExceeds,
  APP_LIMIT_KEYS,
  APP_LIMIT_META,
  appLimitsPath,
  draftFromView,
  effectiveSummary,
  emptyLimitsDraft,
  exceededKeys,
  exceedsWarningText,
  limitsDraftDirty,
  limitsErrorText,
  limitsHasOverride,
  limitsReceipt,
  limitsWriteGate,
  overrideSummary,
  parseAppLimitsView,
  parseLimitsDraft,
  previewEffective,
  previewExceeds,
  type AppLimitDraft,
  type AppLimitKey,
  type AppLimitValues,
  type AppLimitsRequestBody,
  type AppLimitsView,
} from './app-limits'

export interface AppLimitsSectionProps {
  appId: string
  /** 详情行的生命周期字段（已删除/已清除 ⇒ 不渲染写入口，见 `limitsWriteGate`）。 */
  app: AppLifecycleFields | null | undefined
  canRead: boolean
  canWrite: boolean
  /** 每次递增即重新读取（冻结/恢复等动作之后由父组件 bump）。 */
  reloadToken?: number
}

/** 保存前的确认上下文（`effective` 是**待保存**的生效值，不是服务端已有值）。 */
interface ConfirmState {
  body: AppLimitsRequestBody
  effective: AppLimitValues
}

export function AppLimitsSection({ appId, app, canRead, canWrite, reloadToken = 0 }: AppLimitsSectionProps) {
  const gate = limitsWriteGate(app, canWrite)
  const readable = gate.readable && canRead

  const [view, setView] = useState<AppLimitsView | null>(null)
  const [draft, setDraft] = useState<AppLimitDraft>(emptyLimitsDraft)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [invalid, setInvalid] = useState<AppLimitKey[]>([])
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<ConfirmState | null>(null)
  /**
   * 回执用**常驻** state（不是 useFlash 的 3 s 自动消失）：这一条里有"哪个轴被改成什么、
   * 其余继承、审计动作名"，是管理员核对本次动作的唯一凭据 —— 读到一半自己消失的凭据
   * 等于没有。下一次写动作开始时才清空。
   */
  const [flash, setFlash] = useState('')
  /** 请求序号：抽屉换应用/连点刷新时只认最后一次响应（与页面 detailSeq 同形态）。 */
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!readable) {
      setLoading(false)
      return
    }
    const current = ++seq.current
    setLoading(true)
    setLoadError('')
    try {
      const raw = await request<unknown>(appLimitsPath(appId))
      if (current !== seq.current) return
      const parsed = parseAppLimitsView(raw)
      if (!parsed.ok) {
        // 形状漂移不得渲染成"全部继承全局"（那会让四个占位符变成空、生效值变成编造值）。
        setView(null)
        setLoadError(`读取限流失败：${parsed.reason}`)
        return
      }
      setView(parsed.value)
      setDraft(draftFromView(parsed.value))
      setInvalid([])
    } catch (err: unknown) {
      if (current !== seq.current) return
      setView(null)
      setLoadError(
        isMissingEndpoint(err)
          ? `读取限流失败：服务端尚未提供该端点（GET ${appLimitsPath(appId)}，契约 §2.3）。${errorText(err, '')}`.trim()
          : limitsErrorText(err, '读取限流失败'),
      )
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [appId, readable])

  useEffect(() => {
    setView(null)
    setDraft(emptyLimitsDraft())
    setLoadError('')
    setSaveError('')
    setInvalid([])
    setConfirming(null)
    void load()
  }, [load, reloadToken])

  /**
   * 提交一次写动作（保存覆盖 / 清空覆盖），成功后**回读**服务端视图。
   *
   * 回读而不是拿 PUT 响应拼界面：PUT 的信封可能只是 `{changed:true}`（§2.3 只承诺
   * "返回同样的视图 + changed"），用它渲染等于乐观更新 —— 而 §2.5 要求的是
   * "保存成功回读服务端视图（不乐观更新）"。
   */
  const submit = useCallback(
    async (body: AppLimitsRequestBody, action: 'save' | 'reset') => {
      if (!gate.writable || busy) return
      setBusy(true)
      setSaveError('')
      setFlash('')
      try {
        const putRaw = await request<unknown>(appLimitsPath(appId), {
          method: 'PUT',
          body: JSON.stringify(body),
        })
        const putParsed = parseAppLimitsView(putRaw)
        const changedFromPut = putParsed.ok ? putParsed.value.changed : null
        let fresh: ParseResult<AppLimitsView>
        try {
          fresh = parseAppLimitsView(await request<unknown>(appLimitsPath(appId)))
        } catch (err: unknown) {
          // 写已经提交（2xx），只是回读失败：如实说，别拿旧视图冒充新值。
          setLoadError(`保存已提交，但回读服务端视图失败：${limitsErrorText(err, '读取限流失败')}（请点刷新核对最新值）`)
          return
        }
        if (!fresh.ok) {
          setLoadError(`保存已提交，但回读服务端视图失败：${fresh.reason}`)
          return
        }
        const next: AppLimitsView = { ...fresh.value, changed: changedFromPut }
        setView(next)
        setDraft(draftFromView(next))
        setInvalid([])
        setLoadError('')
        setFlash(limitsReceipt(next, action))
      } catch (err: unknown) {
        // **不乐观更新**：失败时 view/draft 一个字都不动，只把服务端信封原样摆出来。
        setSaveError(limitsErrorText(err, action === 'reset' ? '恢复默认失败' : '保存限流失败'))
      } finally {
        setBusy(false)
      }
    },
    [appId, busy, gate.writable],
  )

  const save = () => {
    if (!gate.writable || busy || view === null) return
    const parsed = parseLimitsDraft(draft)
    if (!parsed.ok) {
      setInvalid(parsed.invalid)
      setSaveError(parsed.reason)
      return
    }
    setInvalid([])
    setSaveError('')
    const effective = previewEffective(view.global, draft)
    if (anyExceeds(previewExceeds(view.global, effective))) {
      // §2.1：允许高于全局，但必须先确认"该应用会比其他应用占用更多槽位"。
      setConfirming({ body: parsed.body, effective })
      return
    }
    void submit(parsed.body, 'save')
  }

  const resetAll = () => {
    if (!gate.writable || busy || view === null) return
    // 立即写：`PUT null` = 清空全部覆盖（§2.3）。不是"只清表单"。
    void submit(null, 'reset')
  }

  const effective: AppLimitValues | null = view === null ? null : previewEffective(view.global, draft)
  const pendingExceeds = view === null || effective === null ? null : previewExceeds(view.global, effective)
  const dirty = view === null ? false : limitsDraftDirty(view, draft)

  return (
    <section className="space-y-2 rounded-md border p-3" data-testid="limits-block">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">限流（per-app 覆盖）</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { void load() }}
          disabled={loading || !readable}
          data-testid="app-limits-refresh"
          aria-label="刷新限流覆盖"
          title="重新读取服务端视图"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        四个可空轴：**留空 = 继承全局**，占位符显示该轴当前的全局默认值。生效值 =
        全局复制后套用非空覆盖，再走服务端同一份 `applimits.Validate`。保存即时生效
        （只影响新准入，收紧不会打断已在跑的请求）。
      </p>

      {!readable ? (
        <p data-testid="limits-block-unavailable" className="text-sm text-muted-foreground">
          {gate.readable ? '没有 capability:read 权限：限流覆盖不可读（服务端同样会拒绝读请求）。' : gate.reason}
        </p>
      ) : (
        <>
          {loadError !== '' && (
            <p
              data-testid="app-limits-load-error"
              role="alert"
              aria-live="assertive"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive"
            >
              {loadError}
            </p>
          )}
          {loadError === '' && loading && view === null && (
            <p data-testid="app-limits-loading" className="text-sm text-muted-foreground">读取限流覆盖…</p>
          )}

          {view !== null && effective !== null && (
            <>
              {!gate.writable && (
                <p id="app-limits-readonly" data-testid="app-limits-readonly" className="text-xs text-muted-foreground">
                  {gate.reason}
                </p>
              )}
              <div className="space-y-1.5">
                {APP_LIMIT_KEYS.map((key) => {
                  const meta = APP_LIMIT_META[key]
                  const globalValue = view.global[key]
                  const previewValue = effective[key]
                  const inherited = (draft[key] ?? '').trim() === ''
                  return (
                    <div
                      key={key}
                      className="grid grid-cols-[7.5rem_1fr] items-center gap-2"
                      data-testid={`app-limit-row-${key}`}
                    >
                      <Label htmlFor={`app-limit-${key}`} className="text-xs" title={meta.hint}>
                        {meta.label}
                      </Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          id={`app-limit-${key}`}
                          data-testid={`app-limit-${key}`}
                          aria-label={meta.label}
                          type="number"
                          min={1}
                          inputMode="numeric"
                          className="h-8 w-24"
                          value={draft[key] ?? ''}
                          placeholder={String(globalValue)}
                          disabled={!gate.writable || busy}
                          aria-invalid={invalid.includes(key) ? true : undefined}
                          onChange={(e) => {
                            const next = e.target.value
                            setDraft((prev) => ({ ...prev, [key]: next }))
                          }}
                        />
                        <span className="text-xs text-muted-foreground" data-testid={`app-limit-global-${key}`}>
                          全局 {globalValue}
                        </span>
                        <span className="text-xs" data-testid={`app-limit-effective-${key}`}>
                          {inherited ? `继承（生效 ${previewValue}）` : `生效 ${previewValue}`}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className="text-xs" data-testid="app-limits-effective">
                保存后的生效值：{effectiveSummary(effective)}
                <span className="ml-2 text-muted-foreground" data-testid="app-limits-override-summary">
                  当前覆盖:{overrideSummary(view)}
                </span>
              </p>

              {view.exceedsAny && (
                <p data-testid="app-limits-server-exceeds" className="text-xs text-destructive">
                  服务端判定：当前**已保存**的覆盖里有轴超过全局
                  （{exceededKeys(view.exceedsGlobal).join('、') || '逐轴明细未下发'}）——
                  该应用现在就会比其他应用占用更多槽位。
                  {view.exceedsFromServer ? '' : '（逐轴明细由本页按 生效值 > 全局值 推导）'}
                </p>
              )}

              {pendingExceeds !== null && anyExceeds(pendingExceeds) && (
                <p
                  data-testid="app-limits-exceeds-warning"
                  role="alert"
                  aria-live="polite"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive"
                >
                  {exceedsWarningText(view.global, effective)}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  data-testid="app-limits-save"
                  disabled={!gate.writable || busy || !dirty}
                  aria-describedby={!gate.writable ? 'app-limits-readonly' : undefined}
                  onClick={save}
                >
                  <Save className="mr-1 h-4 w-4" />保存并生效
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="app-limits-reset"
                  disabled={!gate.writable || busy || !limitsHasOverride(view)}
                  aria-describedby={!gate.writable ? 'app-limits-readonly' : undefined}
                  title={limitsHasOverride(view) ? '清空全部覆盖，四轴恢复继承全局' : '当前没有覆盖（四轴全部继承全局）'}
                  onClick={resetAll}
                >
                  <RotateCcw className="mr-1 h-4 w-4" />恢复默认
                </Button>
                {dirty && (
                  <span className="text-xs text-muted-foreground" data-testid="app-limits-dirty">有未保存的改动</span>
                )}
              </div>

              {saveError !== '' && (
                <p
                  data-testid="app-limits-save-error"
                  role="alert"
                  aria-live="assertive"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive"
                >
                  {saveError}
                </p>
              )}
              {flash !== '' && (
                <p
                  data-testid="app-limits-flash"
                  role="status"
                  aria-live="polite"
                  className="rounded-md border border-border bg-muted px-2 py-1.5 text-sm"
                >
                  {flash}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                每次保存/清空都写审计 `wasm_app_limits_change`（detail 含四个覆盖值，null = 恢复继承）。
              </p>
            </>
          )}
        </>
      )}

      {/* 二次确认（§2.1/§2.5）：超过全局的保存必须显式确认，取消则**不发请求**。 */}
      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null) }}>
        <DialogContent data-testid="app-limits-confirm-dialog">
          <DialogHeader>
            <DialogTitle>确认：这个应用会超过全局限流</DialogTitle>
            <DialogDescription>
              允许高于全局（管理员显式动作，绝对上界不变），但该应用会比其他应用占用更多槽位。
            </DialogDescription>
          </DialogHeader>
          {view !== null && confirming !== null && (
            <p className="text-sm text-destructive" data-testid="app-limits-confirm-warning">
              {exceedsWarningText(view.global, confirming.effective)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="app-limits-confirm-cancel" onClick={() => { setConfirming(null) }}>
              取消（不发请求）
            </Button>
            <Button
              variant="destructive"
              data-testid="app-limits-confirm"
              disabled={busy}
              onClick={() => {
                const pending = confirming
                setConfirming(null)
                if (pending !== null) void submit(pending.body, 'save')
              }}
            >
              确认提交
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
