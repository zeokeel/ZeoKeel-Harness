/**
 * 跨应用待审队列（设计 §5.7 / §7；审计 C-07「页头『待审 N』不可点、没有跨应用清单」）。
 *
 * ## 为什么是独立对话框而不是「按状态筛应用再逐个点开」
 *
 * 审核积压是**时间敏感**的处置动作：此前管理员看到页头「待审 12」，只能先 `status=pending`
 * 筛应用、再逐个开详情抽屉、再逐个通过/拒绝（C-07 实测：`Apps.tsx` 的页头徽标没有任何
 * onClick，服务端已查全量待审却只用来数数）。这里把「谁在等我、等的是哪一版、我可以当场
 * 通过或拒绝」放在同一屏：一次网络请求、内联处置、处置完自动刷新。
 *
 * ## 数据与处置的端点（设计 §6.2）
 *
 *   - `GET  /api/server/admin/wasm-apps/releases/pending`  —— 跨应用清单；
 *   - `POST /api/server/admin/wasm-apps/:app_id/releases/:version/approve`
 *   - `POST /api/server/admin/wasm-apps/:app_id/releases/:version/reject`（理由必填 ≤200）
 *
 * 后两条沿用现有审核出口（不做本地伪造）。拒绝必须带理由：服务端 400，且理由进审计链、
 * 回给作者 —— 表单侧前置拦一次，别发注定 400 的请求。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../api'
import { Button } from '../../components/ui/button'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Check, RefreshCw, X } from 'lucide-react'
import {
  appPath,
  fmtTime,
  lifecycleErrorText,
  parsePendingQueue,
  PENDING_QUEUE_PATH,
  pendingAgeText,
  purgeStaleConfirmCopy,
  purgeStaleReceipt,
  PURGE_STALE_PATH,
  queueTruncationNote,
  REJECT_IMPACT_NOTE,
  type PendingQueueRow,
  type PendingQueueView,
  type PurgeStaleResponse,
} from './apps-lifecycle'

const MAX_REASON = 200

interface RejectState {
  appId: string
  version: string
  reason: string
  error: string
}

export interface PendingQueueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  canWrite: boolean
  /**
   * 页头徽标上的「待审 N」（列表响应 `pending_count`）。
   *
   * 反证 F-1：徽标与队列 `total` 来自**两个**服务端查询（列表的 pending_count /
   * 队列端点的 total），历史上会分叉（应用在 pending 期间被删除 ⇒ 徽标永不清零而
   * 队列里看不到）。服务端已统一判据，但前端仍要把"两个数字不一致"这件事**显式说出来**，
   * 而不是同屏摆两个互相矛盾的数。
   */
  badgeTotal?: number | null
  /** 处置成功后的回调（页面据此刷新列表与页头积压数）。 */
  onChanged: () => void
}

/**
 * 待审清单（跨应用）。`rows` 来自服务端；读失败与「没有待审」是两句不同的话。
 */
export function PendingQueueDialog({ open, onOpenChange, canWrite, badgeTotal = null, onChanged }: PendingQueueDialogProps) {
  const [view, setView] = useState<PendingQueueView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState('')
  const [reject, setReject] = useState<RejectState | null>(null)
  /** 清理积压（purge-stale）的确认框与原地错误（设计 §5.7 的清理动作）。 */
  const [purgePrompt, setPurgePrompt] = useState(false)
  const [purgeError, setPurgeError] = useState('')
  const [purging, setPurging] = useState(false)
  /** 请求序号：连点刷新/关闭重开时只认最后一次响应。 */
  const seq = useRef(0)

  const load = useCallback(async () => {
    const current = ++seq.current
    setLoading(true)
    setError('')
    try {
      const raw = await request<unknown>(PENDING_QUEUE_PATH)
      if (current !== seq.current) return
      const parsed = parsePendingQueue(raw)
      if (!parsed.ok) {
        setView(null)
        setError(`读取待审队列失败：${parsed.reason}`)
        return
      }
      setView(parsed.value)
    } catch (err: unknown) {
      if (current !== seq.current) return
      setView(null)
      setError(lifecycleErrorText(err, '读取待审队列失败'))
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setFeedback('')
    setReject(null)
    void load()
  }, [open, load])

  const review = async (row: PendingQueueRow, approve: boolean, reason = '') => {
    if (!canWrite || busy !== '') return
    const key = `${row.appId}:${row.version}:${approve ? 'approve' : 'reject'}`
    setBusy(key)
    setFeedback('')
    try {
      const suffix = approve ? 'approve' : 'reject'
      const init: RequestInit = { method: 'POST' }
      if (!approve) init.body = JSON.stringify({ reason })
      await request(`${appPath(row.appId)}/releases/${encodeURIComponent(row.version)}/${suffix}`, init)
      setFeedback(`已${approve ? '通过' : '拒绝'} ${row.appId} v${row.version}`)
      setReject(null)
      await load()
      onChanged()
    } catch (err: unknown) {
      const text = lifecycleErrorText(err, approve ? '审核通过失败' : '审核拒绝失败')
      if (approve) {
        setFeedback(text)
      } else {
        setReject((prev) => (prev !== null && prev.appId === row.appId && prev.version === row.version
          ? { ...prev, error: text }
          : prev))
      }
    } finally {
      setBusy('')
    }
  }

  /** 拒绝提交：理由必填（trim 后非空），且长度上限与服务端一致。 */
  const submitReject = async (row: PendingQueueRow) => {
    const state = reject
    if (state === null || state.appId !== row.appId || state.version !== row.version) return
    const reason = state.reason.trim()
    if (reason === '') {
      setReject({ ...state, error: '请填写拒绝理由：作者只能凭这段文字知道要改什么' })
      return
    }
    if (reason.length > MAX_REASON) {
      setReject({ ...state, error: `拒绝理由最多 ${MAX_REASON} 字` })
      return
    }
    await review(row, false, reason)
  }

  /**
   * 清理积压待审版本（`POST …/releases/purge-stale`）。
   *
   * 这是**批量且有代价**的动作 ⇒ 必须显式确认（确认框由 `purgeStaleConfirmCopy` 生成）。
   * 服务端在审核开关仍开启时 fail-closed 409，错误原样渲染在这个弹窗里（不吞）。
   * 成功/失败都不乐观更新：清理后重取队列，数字以服务端为准。
   */
  const purgeStale = async () => {
    if (!canWrite || purging) return
    setPurging(true)
    setPurgeError('')
    try {
      const out = await request<PurgeStaleResponse>(PURGE_STALE_PATH, { method: 'POST' })
      setPurgePrompt(false)
      setFeedback(purgeStaleReceipt(out))
      await load()
      onChanged()
    } catch (err: unknown) {
      setPurgeError(lifecycleErrorText(err, '清理积压待审版本失败'))
    } finally {
      setPurging(false)
    }
  }

  const rows = view?.rows ?? []
  const total = view?.total ?? rows.length
  const truncationNote = view === null ? '' : queueTruncationNote(view)
  /** 清理积压的确认文案（纯函数，文案与语义只在 apps-lifecycle 里写一次）。 */
  const purgeCopy = purgeStaleConfirmCopy()
  /** 徽标 N 与队列 total 分叉（服务端已统一判据；前端把不一致说出来而不是静默取其一）。 */
  const diverges = typeof badgeTotal === 'number' && badgeTotal >= 0 && view !== null && badgeTotal !== total
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="pending-queue-dialog">
        <DialogHeader>
          <DialogTitle>待审队列({total})</DialogTitle>
          <DialogDescription>
            跨应用汇总的待审版本：通过后该版本成为可交付版本（仅当它比当前部署版本新时立即上线；比当前旧则只标记通过、不降级）。拒绝必须填理由（写入审计并回给作者；版本号永久占用）。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            数据源:<span className="font-mono">GET {PENDING_QUEUE_PATH}</span>
          </p>
          <div className="flex items-center gap-1">
            {canWrite && (
              <Button
                variant="outline"
                size="sm"
                data-testid="pending-queue-purge-open"
                title="把当前全部待审版本置为「已撤回」（设计 §5.7 的清理动作；需要先关闭审核开关）"
                onClick={() => { setPurgeError(''); setPurgePrompt(true) }}
              >
                清理积压（标记撤回）
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              data-testid="pending-queue-refresh"
              disabled={loading}
              onClick={() => { void load() }}
              aria-label="刷新待审队列"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {feedback !== '' && (
          <p data-testid="pending-queue-feedback" role="status" aria-live="polite" className="rounded-md border border-border bg-muted px-2 py-1.5 text-sm">
            {feedback}
          </p>
        )}
        {error !== '' && (
          <p data-testid="pending-queue-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
            {error}
          </p>
        )}
        {error === '' && loading && view === null && (
          <p className="text-sm text-muted-foreground">读取中…</p>
        )}
        {error === '' && view !== null && rows.length === 0 && (
          <p data-testid="pending-queue-empty" className="text-sm text-muted-foreground">
            没有待审版本。组织开启「更新审批」后，员工发布的新版本会出现在这里。
          </p>
        )}
        {rows.length > 0 && (
          <ul className="space-y-2" data-testid="pending-queue-list">
            {rows.map((row) => {
              const key = `${row.appId}:${row.version}`
              const rejecting = reject !== null && reject.appId === row.appId && reject.version === row.version
              const age = pendingAgeText(row)
              return (
                <li key={key} className="space-y-1 rounded-md border p-2" data-testid={`pending-queue-row-${row.appId}-${row.version}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="text-sm font-medium">
                        {row.title !== '' ? row.title : row.appId}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{row.appId}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">v{row.version}</span>
                        {' · 提交人 '}{row.publisher || '—'}
                        {age !== '' ? ` · ${age}` : row.createdAt !== '' ? ` · ${fmtTime(row.createdAt)}` : ''}
                        {' · 当前生效版本 '}
                        <span className="font-mono">{row.currentVersion !== '' ? `v${row.currentVersion}` : '—'}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        data-testid={`pending-queue-approve-${row.appId}-${row.version}`}
                        disabled={!canWrite || busy !== ''}
                        title={canWrite ? '通过:该版本上线' : '没有 capability:write 权限'}
                        onClick={() => { void review(row, true) }}
                      >
                        <Check className="mr-1 h-4 w-4" />通过
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        data-testid={`pending-queue-reject-${row.appId}-${row.version}`}
                        disabled={!canWrite || busy !== ''}
                        title={canWrite ? '拒绝:必须填理由（版本号永久占用）' : '没有 capability:write 权限'}
                        onClick={() => { setReject({ appId: row.appId, version: row.version, reason: '', error: '' }) }}
                      >
                        <X className="mr-1 h-4 w-4" />拒绝
                      </Button>
                    </div>
                  </div>
                  {rejecting && (
                    <div className="space-y-1 border-t pt-1">
                      <p className="text-xs text-muted-foreground">{REJECT_IMPACT_NOTE}</p>
                      <Label htmlFor={`pending-queue-reason-${row.appId}-${row.version}`} className="text-xs text-muted-foreground">
                        拒绝理由(必填,将写入审计并回给作者)
                      </Label>
                      <Textarea
                        id={`pending-queue-reason-${row.appId}-${row.version}`}
                        aria-label={`拒绝理由 ${row.appId} v${row.version}`}
                        data-testid={`pending-queue-reason-${row.appId}-${row.version}`}
                        maxLength={MAX_REASON}
                        value={reject.reason}
                        placeholder="如:申请的数据范围超出该用途所需"
                        onChange={(e) => { setReject({ ...reject, reason: e.target.value, error: '' }) }}
                      />
                      <p className="text-xs text-muted-foreground">{reject.reason.length}/{MAX_REASON}</p>
                      {reject.error !== '' && (
                        <p data-testid={`pending-queue-reject-error-${row.appId}-${row.version}`} role="alert" aria-live="assertive" className="text-sm text-destructive">
                          {reject.error}
                        </p>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => { setReject(null) }}>取消</Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          data-testid={`pending-queue-reject-submit-${row.appId}-${row.version}`}
                          disabled={busy !== '' || reject.reason.trim() === '' || reject.reason.length > MAX_REASON}
                          onClick={() => { void submitReject(row) }}
                        >
                          确认拒绝
                        </Button>
                      </div>
                    </div>
                  )}
                  {!canWrite && (
                    <p className="text-xs text-muted-foreground">
                      没有 capability:write 权限:通过/拒绝按钮已禁用(服务端同样会拒绝写请求)
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {truncationNote !== '' && (
          <p data-testid="pending-queue-truncated" className="text-xs text-muted-foreground">
            {truncationNote}
          </p>
        )}
        {diverges && (
          <p data-testid="pending-queue-divergence" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            页头徽标「待审 {badgeTotal}」与本队列 total（{total}）不一致：两者来自服务端的两个查询
            （列表 pending_count / 队列端点 total）。请刷新页面重试；仍不一致说明服务端口径漂移，
            请把这两个数字一起报给运维 —— 本页不会替你挑一个当真。
          </p>
        )}
        {rows.length > 0 && (
          <p className="text-xs text-muted-foreground">
            被拒版本号<b>永久占用</b>:作者必须升一个更高的版本号重发（设计 §3.2）。积压版本不会自动转正。
          </p>
        )}
        {/* 清理积压（设计 §5.7 的清理动作 / C-08）：批量、不可逆、有前置条件 ⇒ 二次确认。 */}
        <Dialog open={purgePrompt} onOpenChange={(next) => { if (!next) setPurgePrompt(false) }}>
          <DialogContent data-testid="pending-queue-purge-dialog" className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{purgeCopy.title}</DialogTitle>
              <DialogDescription>{purgeCopy.intro}</DialogDescription>
            </DialogHeader>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {purgeCopy.bullets.map((b) => <li key={b}>{b}</li>)}
            </ul>
            <p className="text-sm text-destructive" data-testid="pending-queue-purge-irreversible">
              {purgeCopy.irreversible}
            </p>
            {purgeError !== '' && (
              <p data-testid="pending-queue-purge-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
                {purgeError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setPurgePrompt(false) }}>取消</Button>
              <Button
                variant="destructive"
                data-testid="pending-queue-purge-confirm"
                disabled={purging || busy !== ''}
                onClick={() => { void purgeStale() }}
              >
                确认清理（标记撤回）
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => { onOpenChange(false) }}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 供页面复用的徽标文案（页头「待审 N」与队列标题同源，避免两处数字口径分叉）。 */
export function pendingBadgeText(total: number): string {
  return `待审 ${total}`
}

/** 便于用例/页面复用的行 key（与列表 key 同形）。 */
export function pendingRowKey(row: PendingQueueRow): string {
  return `${row.appId}:${row.version}`
}

// PendingQueueView 类型在此重新导出，页面只从组件模块取它即可。
export type { PendingQueueView }
