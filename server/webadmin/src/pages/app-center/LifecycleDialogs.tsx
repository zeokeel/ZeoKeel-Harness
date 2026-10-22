/**
 * 应用生命周期动作的三个对话框（设计 §7；审计 C-02/C-03/C-04/C-11）：
 *
 *   - `DeployDialog`  —— 部署/回滚：版本选择器**只列 approved**，标「当前/最新」，当前版本不可选；
 *   - `DeleteDialog`  —— 删除：确认框按 §5.5 的真实语义写（删除前必须快照、保留期、
 *                        purge_after 具体日期、保留期内可恢复）；
 *   - `ExportDialog`  —— 导出：JSON / 含数据 / 含资源（走 app-export.ts 的 blob 下载）。
 *
 * 三个对话框都**只负责自己那一次写动作**；成功/失败各自原地可见（弹窗被 80% 遮罩压住，
 * 页面级红字在弹窗里读不到 —— 这是 R1-uxw-1 已修过的形态，新对话框沿用）。成功后通过
 * `onDone` 把服务端回执交回页面，由页面统一回填行、刷新列表、打 flash 回执。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../api'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { RefreshCw } from 'lucide-react'
import { downloadAppExport } from './app-export'
import {
  blockedDeployCandidates,
  deleteConfirmCopy,
  deletePath,
  DEPLOY_SELECTOR_HINT,
  deployCandidates,
  deploymentsPath,
  EXPORT_OPTIONS,
  exportCaveats,
  fmtSize,
  isDeleted,
  isPurged,
  lifecycleErrorText,
  normalizeDeployResult,
  parseReleaseRows,
  releaseListPath,
  type DeployResult,
  type AppLifecycleFields,
  type DeployCandidate,
  type DeleteResultView,
  type ExportKind,
  type ReleaseRow,
} from './apps-lifecycle'

/** 动作对象（列表行或抽屉行都满足这个形状）。 */
export interface LifecycleTarget extends AppLifecycleFields {
  app_id: string
  title?: string
  current_version?: string
  enabled?: boolean
  owner?: string
}

function targetName(target: LifecycleTarget | null): string {
  if (target === null) return ''
  return target.title !== undefined && target.title !== '' ? target.title : target.app_id
}

// ---------------------------------------------------------------------------
// 部署 / 回滚
// ---------------------------------------------------------------------------

export interface DeployDialogProps {
  target: LifecycleTarget | null
  open: boolean
  onClose: () => void
  canWrite: boolean
  onDone: (result: DeployResult) => void
}

/**
 * 部署/回滚（设计 §3.3 / §7）。
 *
 * 版本来源是**该应用的 approved 版本清单**（`GET …/releases?status=approved`，服务端
 * `adminReleases` 早已支持该取值）；前端再用 `deployCandidates` 过一遍 —— 任一端漂移时
 * 「选择器里出现不可部署版本」都不会发生（用例直接咬这条）。
 */
export function DeployDialog({ target, open, onClose, canWrite, onDone }: DeployDialogProps) {
  /**
   * 服务端下发的 approved 版本行（原始形态）。
   *
   * 存原始行而不是"已过滤的候选"：反证 F-12 要同时表达两件事 —— 可部署的进选择器、
   * 字节已释放的**不静默消失**（否则"我明明通过了 v1.1.0 为什么选不到"会被当成页面坏了）。
   */
  const [rows, setRows] = useState<ReleaseRow[]>([])
  const [selected, setSelected] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 请求序号：连续打开不同应用时只认最后一次响应（与页面 detailSeq 同形态）。 */
  const seq = useRef(0)
  const appId = target?.app_id ?? ''
  const currentVersion = target?.current_version ?? ''
  /** 可选择（approved 且字节仍在）。 */
  const candidates: DeployCandidate[] = deployCandidates(rows, currentVersion)
  /** approved 但字节已释放：不进选择器，但要如实列出来（附可执行的下一步）。 */
  const blocked: DeployCandidate[] = blockedDeployCandidates(rows, currentVersion)

  const load = useCallback(async () => {
    if (appId === '') return
    const current = ++seq.current
    setLoading(true)
    setError('')
    setSelected('')
    try {
      const raw = await request<unknown>(releaseListPath(appId, 'approved'))
      if (current !== seq.current) return
      const parsed = parseReleaseRows(raw)
      if (!parsed.ok) {
        setRows([])
        setError(`读取可部署版本失败：${parsed.reason}`)
        return
      }
      setRows(parsed.value)
    } catch (err: unknown) {
      if (current !== seq.current) return
      setRows([])
      setError(lifecycleErrorText(err, '读取可部署版本失败'))
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [appId, currentVersion])

  useEffect(() => {
    if (!open) return
    setMessage('')
    setSelected('')
    void load()
  }, [open, load])

  const submit = async () => {
    if (!target || busy || !canWrite) return
    if (selected === '') {
      setError('请选择要部署的版本（当前版本不可重复部署）')
      return
    }
    setBusy(true)
    setError('')
    try {
      const body: { version: string; message?: string } = { version: selected }
      if (message.trim() !== '') body.message = message.trim()
      const out = await request<unknown>(deploymentsPath(target.app_id), {
        method: 'POST',
        body: JSON.stringify(body),
      })
      // 归一真实信封（version/kind 在 `deployment` 段）：否则回滚会被说成「已部署」。
      onDone(normalizeDeployResult(out, {
        app_id: target.app_id,
        version: selected,
        current_version: currentVersion,
      }))
    } catch (err: unknown) {
      setError(lifecycleErrorText(err, '部署失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-xl" data-testid="deploy-dialog">
        <DialogHeader>
          <DialogTitle>部署 / 回滚:{targetName(target)}</DialogTitle>
          <DialogDescription>把某个 approved 版本指为线上版本。部署是一条不可变记录，回滚也一样（不改写历史）。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground" data-testid="deploy-selector-hint">
            {DEPLOY_SELECTOR_HINT}
          </p>
          <p className="text-xs">
            当前线上版本:<span className="font-mono" data-testid="deploy-current-version">{currentVersion || '—'}</span>
          </p>
          {error !== '' && (
            <p data-testid="deploy-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
              {error}
            </p>
          )}
          {loading ? (
            <p className="text-sm text-muted-foreground">读取可部署版本…</p>
          ) : candidates.length === 0 && error === '' ? (
            <p className="text-sm text-muted-foreground" data-testid="deploy-no-candidates">
              没有可部署的 approved 版本。只有通过审核的版本才能部署；待审版本需要先在待审队列里通过。
            </p>
          ) : (
            <ul className="space-y-1" data-testid="deploy-candidates">
              {candidates.map((candidate) => {
                const disabled = candidate.current
                const active = selected === candidate.version
                return (
                  <li key={candidate.version}>
                    <Button
                      type="button"
                      variant={active ? 'default' : 'outline'}
                      size="sm"
                      className="w-full justify-start gap-2"
                      data-testid={`deploy-option-${candidate.version}`}
                      aria-pressed={active}
                      disabled={disabled || busy}
                      title={disabled ? '这已经是当前线上版本（部署它服务端会回 changed:false）' : candidate.latest ? '部署最新 approved 版本（= 发布）' : '部署更旧的 approved 版本（= 回滚）'}
                      onClick={() => { setSelected(candidate.version) }}
                    >
                      <span className="font-mono">v{candidate.version}</span>
                      {candidate.current && <Badge variant="secondary">当前</Badge>}
                      {candidate.latest && <Badge variant="outline">最新</Badge>}
                      {disabled && (
                        <span className="text-xs text-muted-foreground">当前版本不可选</span>
                      )}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          {blocked.length > 0 && (
            <div className="space-y-1 rounded-md border border-dashed p-2" data-testid="deploy-blocked">
              <p className="text-xs text-destructive">
                以下 approved 版本的制品**字节已释放**，因此不在选择器里（部署它们服务端必然返回
                409 RELEASE_BYTES_RELEASED）：
              </p>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {blocked.map((b) => (
                  <li key={b.version} data-testid={`deploy-blocked-${b.version}`}>
                    <span className="font-mono">v{b.version}</span>
                    {b.current && <span> · 当前线上版本</span>}
                    <span>
                      {' · 体积 '}
                      {b.size === null ? '服务端未下发' : fmtSize(b.size)}
                      {' —— 让作者发布更高版本号，或选择其它仍有字节的 approved 版本'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="deploy-message" className="text-xs text-muted-foreground">
              部署备注（可选，写入部署历史）
            </Label>
            <Textarea
              id="deploy-message"
              aria-label="部署备注"
              data-testid="deploy-message"
              maxLength={200}
              value={message}
              placeholder="如:回滚到 1.0.1，1.0.2 的资源接口报错"
              onChange={(e) => { setMessage(e.target.value) }}
            />
            <p className="text-xs text-muted-foreground">{message.length}/200</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            data-testid="deploy-submit"
            disabled={busy || !canWrite || selected === '' || loading}
            title={canWrite ? undefined : '没有 capability:write 权限'}
            onClick={() => { void submit() }}
          >
            确认部署
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 删除（软删 + 快照 + 保留期）
// ---------------------------------------------------------------------------

export interface DeleteDialogProps {
  target: LifecycleTarget | null
  open: boolean
  onClose: () => void
  canWrite: boolean
  /** 保留期天数（服务端未下发时为 null —— 确认框会明说不推算日期）。 */
  retentionDays: number | null
  onDone: (result: DeleteResultView) => void
}

/**
 * 删除确认（设计 §5.5）。
 *
 * 文案的硬要求（审计 C-01 的"销承诺"形态）：说清**快照是删除的前置条件**、保留期结束的
 * **具体时刻**、以及「已清除不可恢复」；不得再出现「后台任务」这类没有执行者的措辞。
 */
export function DeleteDialog({ target, open, onClose, canWrite, retentionDays, onDone }: DeleteDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (open) setError('') }, [open])
  const copy = deleteConfirmCopy(target, { retentionDays })
  const submit = async () => {
    if (!target || busy || !canWrite) return
    setBusy(true)
    setError('')
    try {
      const out = await request<DeleteResultView>(deletePath(target.app_id), { method: 'DELETE' })
      onDone(out ?? {})
    } catch (err: unknown) {
      setError(lifecycleErrorText(err, '删除失败'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-xl" data-testid="delete-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{copy.title}:{targetName(target)}?</DialogTitle>
          <DialogDescription>{copy.intro}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {copy.bullets.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive" data-testid="delete-irreversible">
          {copy.irreversible}
        </p>
        {error !== '' && (
          <p data-testid="delete-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            variant="destructive"
            data-testid="delete-confirm"
            disabled={busy || !canWrite}
            title={canWrite ? undefined : '没有 capability:write 权限'}
            onClick={() => { void submit() }}
          >
            确认删除
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export interface ExportDialogProps {
  target: LifecycleTarget | null
  open: boolean
  onClose: () => void
  canRead: boolean
  onDone: (kind: ExportKind, filename: string) => void
}

/**
 * 导出（设计 §5.6；C-02「管理面无导出」）。
 *
 * 已清除（purged）的应用在这里必须把话说全：控制面 JSON 仍可导出，含数据/含资源会 410 ——
 * 让管理员点之前就知道结果，而不是拿一个 410 猜页面坏了。
 */
export function ExportDialog({ target, open, onClose, canRead, onDone }: ExportDialogProps) {
  const [busy, setBusy] = useState<ExportKind | ''>('')
  const [error, setError] = useState('')
  /** 导出成功后在弹窗内回显文件名（弹窗不自动关闭：管理员常要连导 JSON 与 zip）。 */
  const [done, setDone] = useState('')
  useEffect(() => { if (open) { setError(''); setDone('') } }, [open])
  const caveats = exportCaveats(target)
  const purged = isPurged(target)
  const deleted = isDeleted(target)
  const run = async (kind: ExportKind) => {
    if (!target || busy !== '' || !canRead) return
    setBusy(kind)
    setError('')
    try {
      const result = await downloadAppExport(target.app_id, kind)
      setDone(result.filename)
      onDone(kind, result.filename)
    } catch (err: unknown) {
      setError(lifecycleErrorText(err, '导出失败'))
    } finally {
      setBusy('')
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-w-xl" data-testid="export-dialog">
        <DialogHeader>
          <DialogTitle>导出:{targetName(target)}</DialogTitle>
          <DialogDescription>
            导出是管理员运维动作（审计记 admin_session）。三种形态按设计 §5.6 区分。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {EXPORT_OPTIONS.map((option) => {
            // 已清除 ⇒ 数据面一律 410（设计 §3.1）；按钮仍然渲染但如实禁用并说明原因。
            const blocked = purged && option.kind !== 'json'
            return (
              <div key={option.kind} className="rounded-md border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{option.label}</div>
                    <div className="text-xs text-muted-foreground">{option.desc}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`export-${option.kind}`}
                    disabled={busy !== '' || !canRead || blocked}
                    aria-describedby={blocked ? `export-blocked-${option.kind}` : undefined}
                    title={
                      !canRead
                        ? '没有 capability:read 权限'
                        : blocked
                          ? '已清除：数据已删除，含数据/含资源的导出会返回 410'
                          : undefined
                    }
                    onClick={() => { void run(option.kind) }}
                  >
                    {busy === option.kind ? <RefreshCw className="mr-1 h-4 w-4 animate-spin" /> : null}
                    导出
                  </Button>
                </div>
                {blocked && (
                  <p id={`export-blocked-${option.kind}`} className="mt-1 text-xs text-destructive">
                    已清除（purged）：数据已清除，不可恢复 —— 该形态会返回 410 APP_PURGED。
                  </p>
                )}
              </div>
            )
          })}
          {deleted && !purged && (
            <p className="text-xs text-muted-foreground" data-testid="export-deleted-note">
              该应用已删除（保留期内）：数据仍在，可导出；恢复后在应用行点「上架」才恢复服务。
            </p>
          )}
          {done !== '' && error === '' && (
            <p data-testid="export-done" role="status" aria-live="polite" className="rounded-md border border-border bg-muted px-2 py-1.5 text-sm">
              已导出：<span className="font-mono">{done}</span>（审计已记录 wasm_app_export）
            </p>
          )}
          {error !== '' && (
            <p data-testid="export-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
              {error}
            </p>
          )}
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground" data-testid="export-caveats">
            {caveats.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
