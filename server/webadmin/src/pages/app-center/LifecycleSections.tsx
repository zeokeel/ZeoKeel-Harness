/**
 * 应用详情抽屉的两个新区块（设计 §7「详情抽屉新增部署历史 + 生命周期块」）：
 *
 *   1. `LifecycleBlock`   —— frozen_at / deleted_at / purge_after / snapshot_at / purged_at；
 *   2. `DeploymentsBlock` —— 部署历史（id/version/kind/actor/actor_role/created_at/current）。
 *
 * 两者都**只读**：动作在行内/抽屉的动作按钮与对话框里（`LifecycleDialogs.tsx`）。
 *
 * 两条纪律（与页面其它只读块同口径）：
 *   - 读取失败 / 形状漂移 **不得**渲染成「没有」：`deployments` 缺失 ⇒ 说「读取失败」；
 *     端点 404（后端泳道 L 尚未合入）⇒ 明说「服务端尚未提供该端点」，不装作已支持。
 *   - 生命周期字段一个都没下发（后端还没有这些列）⇒ 明说「服务端未下发」，而不是
 *     五个「—」让人读成「从未冻结/删除/清理」（那是另一种假陈述，C-01 的同族形态）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../api'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { errorText } from '../../lib/api-error'
import { RefreshCw } from 'lucide-react'
import {
  actorRoleLabel,
  deploymentKindLabel,
  deploymentsPath,
  fmtTime,
  isMissingEndpoint,
  isPurged,
  lifecycleRows,
  lifecycleUnavailable,
  parseDeployments,
  PURGED_NOTICE,
  type AppLifecycleFields,
  type DeploymentsView,
} from './apps-lifecycle'

/**
 * 生命周期块（设计 §7）。
 *
 * `app` 直接取列表/动作回填后的行（详情对象按 app_id 从最新列表行解析，避免抽屉里
 * 显示点开那一刻的旧快照 —— 冻结/删除/恢复之后必须立刻看到新时间线）。
 */
export function LifecycleBlock({ app }: { app: (AppLifecycleFields & { app_id?: string }) | null }) {
  if (app === null) return null
  const rows = lifecycleRows(app)
  const unavailable = lifecycleUnavailable(app)
  const purged = isPurged(app)
  return (
    <section className="space-y-2 rounded-md border p-3" data-testid="lifecycle-block">
      <h3 className="text-sm font-semibold">生命周期</h3>
      {purged && (
        <p
          data-testid="lifecycle-purged"
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive"
        >
          {PURGED_NOTICE}
        </p>
      )}
      {unavailable ? (
        <p data-testid="lifecycle-unavailable" className="text-xs text-muted-foreground">
          服务端没有下发生命周期字段（冻结/删除/清理/快照时间）。这不是「从未冻结或删除」——
          请核对管理列表响应是否带上 `purge_after` / `snapshot_at` / `purged_at`（设计 §4/§7）。
        </p>
      ) : (
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-sm">
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <dt className="text-muted-foreground" title={row.note}>{row.label}</dt>
              <dd className="font-mono" data-testid={`lifecycle-${row.key}`}>
                {row.value}
                {row.present ? null : (
                  <span className="ml-2 font-sans text-xs text-muted-foreground">(服务端未下发)</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {typeof app.snapshot_error === 'string' && app.snapshot_error !== '' && (
        <p data-testid="lifecycle-snapshot-error" className="text-xs text-destructive">
          快照生成失败:{app.snapshot_error}（失败会被重试；**快照生成前不会清理数据**）
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        清理只会在「已删除 + 保留期已过 + 快照已生成」三个条件同时成立时发生（设计 §5.5）。
      </p>
    </section>
  )
}

export interface DeploymentsBlockProps {
  appId: string
  canRead: boolean
  /** 每次递增即重新拉取（部署成功后由父组件 bump，抽屉里的历史立刻更新）。 */
  reloadToken?: number
}

/**
 * 部署历史块（设计 §7）。
 *
 * 端点是 `GET /api/server/admin/wasm-apps/:app_id/deployments`（设计 §6.2）。后端泳道 L
 * 未合入时这里是 404 —— 页面明说「服务端尚未提供该端点」，**不**渲染成空历史。
 */
export function DeploymentsBlock({ appId, canRead, reloadToken = 0 }: DeploymentsBlockProps) {
  const [view, setView] = useState<DeploymentsView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  /** 请求序号：抽屉换应用 / 连点刷新时只认最后一次响应（与页面 detailSeq 同形态）。 */
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!canRead || appId === '') return
    const current = ++seq.current
    setLoading(true)
    setError('')
    try {
      const raw = await request<unknown>(deploymentsPath(appId))
      if (current !== seq.current) return
      const parsed = parseDeployments(raw)
      if (!parsed.ok) {
        setView(null)
        setError(`读取部署历史失败：${parsed.reason}`)
        return
      }
      setView(parsed.value)
    } catch (err: unknown) {
      if (current !== seq.current) return
      setView(null)
      setError(
        isMissingEndpoint(err)
          ? `读取部署历史失败：服务端尚未提供该端点（GET ${deploymentsPath(appId)}，设计 §6.2）。${errorText(err, '')}`.trim()
          : errorText(err, '读取部署历史失败'),
      )
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [appId, canRead])

  useEffect(() => {
    setView(null)
    setError('')
    void load()
  }, [load, reloadToken])

  const rows = view?.rows ?? []
  return (
    <section className="space-y-2 rounded-md border p-3" data-testid="deployments-block">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">部署历史({rows.length})</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { void load() }}
          disabled={loading || !canRead}
          data-testid="deployments-refresh"
          aria-label="刷新部署历史"
          title="重新读取部署历史"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        部署是一条不可变记录：谁在什么时候把哪个版本放上线。回滚 = 用旧版本再部署一次（追加记录，不改写历史）。
      </p>
      {error !== '' && (
        <p data-testid="deployments-error" role="alert" aria-live="assertive" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {error === '' && loading && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">读取中…</p>
      )}
      {error === '' && !loading && view !== null && rows.length === 0 && (
        <p data-testid="deployments-empty" className="text-sm text-muted-foreground">
          没有部署记录。该应用还没有被部署过（存量应用会在迁移回填时补一条 legacy 记录）。
        </p>
      )}
      {error === '' && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="deployments-table">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">部署 ID</th>
                <th className="py-1 pr-2">版本</th>
                <th className="py-1 pr-2">类型</th>
                <th className="py-1 pr-2">操作人</th>
                <th className="py-1 pr-2">角色</th>
                <th className="py-1 pr-2">时间</th>
                <th className="py-1">当前</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid={`deployment-row-${row.id}`} className="border-t">
                  <td className="py-1 pr-2 font-mono">{row.id}</td>
                  <td className="py-1 pr-2 font-mono">
                    v{row.version}
                    {row.message !== '' && (
                      <span className="ml-1 font-sans text-muted-foreground" title={row.message}>
                        · {row.message}
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2" data-testid={`deployment-kind-${row.id}`}>{deploymentKindLabel(row.kind)}</td>
                  <td className="py-1 pr-2">{row.actor || '—'}</td>
                  <td className="py-1 pr-2" data-testid={`deployment-role-${row.id}`}>{actorRoleLabel(row.actor_role)}</td>
                  <td className="py-1 pr-2 whitespace-nowrap text-muted-foreground">{fmtTime(row.created_at)}</td>
                  <td className="py-1">
                    {row.current ? (
                      <Badge variant="secondary" data-testid={`deployment-current-${row.id}`}>当前</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
