import { useCallback, useEffect, useMemo, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Skeleton } from '../components/ui/skeleton'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { TransferOwnerDialog } from '../components/transfer-owner-dialog'
import { CapabilityLockPanel } from '../components/capability-lock-panel'
import { GrantDialog } from '../components/grant-dialog'
import { ArchivePreviewDialog, ArchivePreviewData } from '../components/archive-preview-dialog'
import { Download, UserCog, Bot, Upload, Lock } from 'lucide-react'
import { agentRequest, grantsBase, previewFileBase } from '../lib/capability-endpoints'
import {
  dedupeLatestByName, delistConfirmText, displayNameOf as agentDisplayName, formatCount,
  SOURCE_LABEL, versionText,
} from '../lib/capability-display'
import {
  hasPermission, PERM_CAP_READ, PERM_CAP_WRITE, PERM_MARKET_READ, PERM_MARKET_WRITE,
} from '../lib/rbac'

interface AgentRow {
  name: string
  /**
   * 展示名(2026-10-26 D 系列显示修复):服务端 `agentJSON` 下发。回退链
   * apps.title → 展示版本 title → name;卡片主标题与弹窗标题都用它。
   */
  display_name?: string
  /** 兼容旧服务端的别名(服务端已把 display_name 回退结果同步写到该键)。 */
  title?: string
  version?: string
  description?: string
  /** 本行归档的上传者(署名);与 owner(归属人)可不同。 */
  author?: string
  /**
   * 归属人(apps.owner)。**展示与转移预填只用本字段**:
   * 市场行 = 服务端 agentJSON 的 author 键(即 apps.owner,由 capability-endpoints.spec.ts
   * 对拍钉住);组织行 = 审批归并行的 owner 键。
   */
  owner: string
  enabled: boolean
  quality?: string
  downloads?: number
  changelog?: string
  /** 0059: 官方属性(蓝标, 仅管理员可上传)。 */
  official?: boolean
  /** 来源渠道: market(市场直上架) || org(员工上传审批后)。必填 —— 决定命名空间。 */
  channel: 'market' | 'org'
}

/** 市场命名空间列表行 → 行模型(channel=market;归属见 AgentRow.owner 注释)。 */
function toMarketAgent(raw: Omit<AgentRow, 'owner' | 'channel'>): AgentRow {
  return { ...raw, owner: raw.author ?? '', channel: 'market' }
}

/** 请求初始化(不传 body 时不带该键,保持既有调用形态)。 */
function initOf(req: { method: string; body?: string }): RequestInit {
  return req.body === undefined ? { method: req.method } : { method: req.method, body: req.body }
}

/**
 * 组织共享行(员工上传、审批通过)在本页的**能力边界**。
 *
 * 2026-10-23 起组织行**也能「上传新版」**:服务端新增
 * `POST /agent-presets/:name/archive`(管理员代传组织共享智能体的新版本,
 * `AdminPublish` ⇒ 发布即已审核)。修订前这里写「新版本由员工重新上传」
 * 并禁用了入口 —— 与市场技能页同源的那处「已上架内容无法更新」。
 * 仍只有市场命名空间的:元数据编辑(组织内容的描述随员工上传的归档)。
 */
const ORG_LIMITS = {
  hint: '组织共享智能体:内容由员工上传,管理端可预览/授权/上下架/归属,也可代传新版本(发布即已通过审核)。',
  edit: '组织共享智能体的描述随员工上传的归档,管理端不提供元数据编辑',
} as const

/**
 * 已下架的行「上传新版」不给入口(发布内核在下架态拒收新归档,409 `APP_DELISTED`,
 * **没有角色/渠道例外**)。与 `Marketplace.tsx` 同一条口径(同一类"点完才吃 409" 的假入口)。
 */
export const DELISTED_UPLOAD_HINT = '已下架:请先重新上架再上传新版本'

/** 端点表给不出上传入口时的兜底文案。 */
const UPLOAD_UNAVAILABLE = '该来源暂不支持在管理端上传新版本'

/** 该行是否来自组织共享库(渠道决定命名空间)。 */
function isOrg(row: { channel?: 'market' | 'org' }): boolean {
  return row.channel === 'org'
}

/**
 * 市场智能体管理(G4,2026-09-04):与市场技能同构的管理面——
 * 上架(登记→上传归档,preset.yml 包内即真相)/上传新版/预览/授权/归属/上下架。
 * 端点由 `lib/capability-endpoints` 按行 channel 决定(市场 `/agents` ↔
 * 组织 `/agent-presets`);组织行还会并入本页(打「员工上传」徽标)。
 */
export default function Agents() {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [opError, setOpError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  // 上架登记
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createTitle, setCreateTitle] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createErr, setCreateErr] = useState('')
  // 上传版本
  const [uploadAgent, setUploadAgent] = useState<AgentRow | null>(null)
  const [uploadVersion, setUploadVersion] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  // 锁定管理(2026-09-04 从审批页迁入市场页)
  const [lockOpen, setLockOpen] = useState(false)
  // 编辑描述 / 展示名
  const [editAgent, setEditAgent] = useState<AgentRow | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editErr, setEditErr] = useState('')
  // 预览 / 授权 / 归属
  const [preview, setPreview] = useState<ArchivePreviewData | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  /** 预览中的行(决定预览/单文件/归档走哪个命名空间;org 还要版本段)。 */
  const [previewRow, setPreviewRow] = useState<AgentRow | null>(null)
  const [grantAgent, setGrantAgent] = useState<AgentRow | null>(null)
  const [departments, setDepartments] = useState<GrantDept[]>([])
  interface GrantDept { id: number; name: string; parent_id: number }
  const [transferAgent, setTransferAgent] = useState<AgentRow | null>(null)

  /**
   * 权限门(F-48,2026-10-26):与 Marketplace.tsx 同一口径 —— 读分
   * market:read / capability:read,写分 market:write / capability:write,
   * 按**该行实际端点**申报的权限点渲染入口。
   */
  const canMarketRead = hasPermission(PERM_MARKET_READ)
  const canCapRead = hasPermission(PERM_CAP_READ)
  const canMarketWrite = hasPermission(PERM_MARKET_WRITE)
  const canCapWrite = hasPermission(PERM_CAP_WRITE)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      // 市场列表按行 channel 选命名空间(市场命名空间;组织行见 action 分支)。
      const listReq = agentRequest('list', { channel: 'market', name: '' })!
      // F-48:只请求角色真能读的那一侧,不发必然 403 的请求。
      const [d, approvals] = await Promise.all([
        canMarketRead ? request(listReq.url) : Promise.resolve({ agents: [] }),
        canCapRead
          ? request(`${ADMIN_API}/capabilities/approvals?status=approved&type=agent`).catch(() => ({ approvals: [] }))
          : Promise.resolve({ approvals: [] }),
      ])
      const merged: AgentRow[] = (d.agents ?? []).map(toMarketAgent)
      for (const row of dedupeLatestByName((approvals.approvals ?? []) as {
        name: string; version: string; display_name: string; description: string
        author: string; owner?: string; enabled?: boolean; downloads?: number
        official?: boolean; quality?: string
      }[])) {
        // 归属取服务端下发的 owner(apps.owner),**不是** author(本行上传者);
        // 上下架状态透传服务端值,缺省按"未知即未上架"(绝不回落 true)。
        merged.push({
          name: row.name, display_name: row.display_name,
          title: row.display_name || row.name, version: row.version,
          description: row.description, author: row.author, owner: row.owner ?? '',
          enabled: row.enabled === true,
          downloads: row.downloads ?? 0, official: row.official, quality: row.quality, channel: 'org',
        })
      }
      // 排序定案: 官方 → 精选 → score(calls*3+downloads) 降序 → 名称
      const score = (x: AgentRow): number => (x.downloads ?? 0)
      merged.sort((a, b) => {
        if (!!a.official !== !!b.official) return a.official ? -1 : 1
        if (!!(a.quality === 'featured') !== !!(b.quality === 'featured')) return a.quality === 'featured' ? -1 : 1
        if (score(a) !== score(b)) return score(b) - score(a)
        // P3 D-12：按展示名排序（目录名只在展示名相同时兜底）。
        return agentDisplayName(a).localeCompare(agentDisplayName(b), 'zh-CN') || a.name.localeCompare(b.name)
      })
      setAgents(merged)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [canMarketRead, canCapRead])

  useEffect(() => {
    void load()
    request(`${ADMIN_API}/departments`).then((d) => setDepartments(d.departments ?? [])).catch(() => { /* 授权对话框才用 */ })
  }, [load])

  const create = async () => {
    if (busy) return
    setCreateErr('')
    if (!createName.trim()) { setCreateErr('请填写智能体名'); return }
    setBusy('create-agent')
    try {
      // 新建 = 市场命名空间(组织共享智能体由员工上传,没有管理端新建入口)。
      const req = agentRequest('create', { channel: 'market', name: '' })
      if (req === null) { setCreateErr('当前命名空间不支持新建智能体'); return }
      await request(req.url, {
        method: req.method,
        body: JSON.stringify({
          name: createName.trim(),
          title: createTitle.trim(),
          description: createDesc.trim(),
        }),
      })
      setCreateOpen(false)
      setCreateName('')
      setCreateTitle('')
      setCreateDesc('')
      await load()
    } catch (err: any) {
      setCreateErr(err.message)
    } finally {
      setBusy(null)
    }
  }

  const toBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })

  const upload = async () => {
    if (!uploadAgent || uploadBusy) return
    setUploadErr('')
    if (!uploadFile) { setUploadErr('请选择归档包(.zip 或 .tar.gz,含 agent.cordis.yml + preset.yml)'); return }
    // 上传新版**两个渠道都有**(2026-10-23):市场 `/agents/:name/archive`、
    // 组织 `/agent-presets/:name/archive`。已下架时发布内核一律拒收(409)⇒ 事前拦住。
    const req = agentRequest('uploadVersion', uploadAgent)
    if (req === null) { setUploadErr(UPLOAD_UNAVAILABLE); return }
    if (uploadAgent.enabled === false) { setUploadErr(DELISTED_UPLOAD_HINT); return }
    setUploadBusy(true)
    try {
      const archive = await toBase64(uploadFile)
      // 组织行的版本以包内 preset.yml 为准(服务端不接受外部 version 字段);
      // 市场行保留"填了就带上"的既有兼容形态。
      const body: Record<string, string> = { archive }
      if (!isOrg(uploadAgent) && uploadVersion.trim() !== '') body.version = uploadVersion.trim()
      await request(req.url, { method: req.method, body: JSON.stringify(body) })
      setUploadAgent(null)
      setUploadVersion('')
      setUploadFile(null)
      await load()
    } catch (err: any) {
      setUploadErr(err.message)
    } finally {
      setUploadBusy(false)
    }
  }

  const openPreview = async (a: AgentRow) => {
    const req = agentRequest('preview', a)
    if (req === null) { setOpError(`预览失败:${ORG_LIMITS.hint}`); return }
    try {
      const d = await request(req.url)
      setPreview({ files: d.files ?? [], composition: d.composition ?? '', skill_md: d.composition ?? '' })
      setPreviewKey(`${a.name}-${Date.now()}`)
      setPreviewRow(a)
    } catch (err: any) {
      setOpError(`预览失败:${err.message}`)
    }
  }

  /**
   * 上下架按行 channel 选命名空间:
   *   - 市场:`DELETE /agents/:name` (下架) / `POST /agents/:name/enable` (上架);
   *   - 组织:`PUT /agent-presets/:name/enabled` + 体 `{enabled}`。
   */
  const setEnabled = async (a: AgentRow, enabled: boolean) => {
    if (busy) return
    const action = enabled ? 'enable' : 'disable'
    const req = agentRequest(action, a)
    if (req === null) { setOpError(`${enabled ? '上架' : '下架'}失败:该来源不支持此操作`); return }
    // 下架确认(F-21/F-49):与技能页同一份文案 —— 可恢复 ≠ 删除。
    if (!enabled && !window.confirm(delistConfirmText(agentDisplayName(a)))) return
    const key = `${action}-${a.name}`
    setBusy(key)
    setOpError('')
    try {
      await request(req.url, initOf(req))
      await load()
    } catch (err: any) {
      setOpError(`${enabled ? '上架' : '下架'}失败:${err.message}${a.version ? '' : '(可能尚未发布版本)'}`)
    } finally {
      setBusy(null)
    }
  }

  const saveEdit = async () => {
    if (!editAgent || busy) return
    const req = agentRequest('updateMeta', editAgent)
    if (req === null) { setEditErr(ORG_LIMITS.edit); return }
    setEditErr('')
    setBusy('edit-agent')
    try {
      await request(req.url, {
        method: req.method,
        body: JSON.stringify({ title: editTitle.trim(), description: editDesc }),
      })
      setEditAgent(null)
      await load()
    } catch (err: any) {
      setEditErr(err.message)
    } finally {
      setBusy(null)
    }
  }

  /** F-02：释放只有身份、没有版本的智能体空壳名称（服务端守卫同技能）。 */
  const releaseShell = async (a: AgentRow): Promise<void> => {
    if (busy !== null) return
    if (!window.confirm(`释放空壳「${agentDisplayName(a)}」的名称？\n\n该名称下没有任何版本，释放后可重新登记；官方归属或已有版本会被服务端拒绝。`)) return
    setBusy(`release-${a.name}`)
    setOpError('')
    try {
      await request(`${ADMIN_API}/apps/agent/${encodeURIComponent(a.name)}`, { method: 'DELETE' })
      await load()
    } catch (err: any) {
      setOpError(`释放名称失败：${err.message}`)
    } finally {
      setBusy(null)
    }
  }

  /** P3 D-12：管理端搜索按展示名/目录名/描述，与卡片标题口径一致。 */
  const visibleAgents = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('zh-CN')
    if (q === '') return agents
    return agents.filter((a) =>
      agentDisplayName(a).toLocaleLowerCase('zh-CN').includes(q)
      || a.name.toLocaleLowerCase('zh-CN').includes(q)
      || (a.description ?? '').toLocaleLowerCase('zh-CN').includes(q))
  }, [agents, query])

  return (
    <div className="space-y-4">
      <PageHeader
        title="智能体市场"
        desc="官方智能体(蓝标) / 员工上传(审批后);授权制可见、归属约束续传"
        actions={
          <>
            {/* F-48:锁定写面 / 登记分别需要 capability:write / market:write。 */}
            {canCapWrite && (
              <Button size="sm" variant="outline" onClick={() => setLockOpen(true)}>
                <Lock className="h-3.5 w-3.5" /> 锁定管理
              </Button>
            )}
            {canMarketWrite && (
              <Button size="sm" onClick={() => { setCreateOpen(true); setCreateErr(''); setCreateTitle('') }}>
                <Upload className="h-3.5 w-3.5" /> 上架智能体
              </Button>
            )}
          </>
        }
      />
      {opError && <div className="text-sm text-destructive">{opError}</div>}
      <Card>
        <CardHeader>
          <CardTitle>智能体(Agent)</CardTitle>
          <CardDescription>与技能同规则:归档直存数据库、包内 preset.yml 携带版本/描述/作者/分类、发布即已审核</CardDescription>
          <div className="flex justify-end pt-2">
            <Input
              value={query}
              onChange={(e) => { setQuery(e.target.value) }}
              placeholder="搜索展示名 / 目录名 / 描述"
              aria-label="搜索智能体"
              className="h-8 w-56"
            />
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex items-center justify-between rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              <span>智能体加载失败:{error}</span>
              <Button size="sm" variant="outline" onClick={() => void load()}>重试</Button>
            </div>
          ) : loading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleAgents.length === 0 && (
                <div className="col-span-full">
                  <EmptyState title="没有匹配的智能体" desc={`没有展示名/目录名/描述匹配「${query.trim()}」的智能体`} />
                </div>
              )}
              {visibleAgents.map((a) => (
                <div key={a.name} className="group flex flex-col rounded-lg border bg-card p-4 transition-all duration-200 hover:border-[#1E40AF]/40 hover:shadow-md">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[#1E40AF]">
                        <Bot className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        {/* 主标题 = 展示名;目录名只在两者不同时作副标题,避免重复。 */}
                        <div className="truncate text-sm font-semibold" title={a.name}>{agentDisplayName(a)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {versionText(a.version)}
                          {agentDisplayName(a) !== a.name && <span className="ml-1.5 font-mono">{a.name}</span>}
                        </div>
                      </div>
                    </div>
                    <span className="flex items-center gap-1.5">
                      {a.official && <Badge className="bg-[#1E40AF] text-white hover:bg-[#1E40AF]">官方</Badge>}
                      {a.quality === 'featured' && <Badge variant="secondary">精选</Badge>}
                      {a.channel === 'org' && (
                        <Badge variant="outline" title="员工上传、审批通过后进入组织共享库">{SOURCE_LABEL.org}</Badge>
                      )}
                      {a.enabled ? <Badge variant="success">上架</Badge> : <Badge variant="outline">已下架</Badge>}
                    </span>
                  </div>
                  <p className="mt-3 line-clamp-3 flex-1 text-xs leading-relaxed text-slate-500" title={a.description || undefined}>{a.description || '暂无描述'}</p>
                  <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-slate-500" title="归属人:首个成功发布者(apps.owner),只有归属人(及管理员)能更新">
                    <UserCog className="h-3 w-3 shrink-0" /><span className="truncate">归属 {a.official ? '官方' : (a.owner || '未指定')}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
                    {/* 精选徽章已在标题行渲染一次(F-54:同一状态不重复两颗)。 */}
                    <span className="inline-flex items-center gap-1"><Download className="h-3 w-3" />下载 {formatCount(a.downloads)}</span>
                  </div>
                  {/* 组织共享行仍没有 元数据编辑 端点(服务端确实不存在)⇒ 该入口对
                      org 行禁用并说明原因,绝不回落市场命名空间(必然 404)。
                      「上传新版」2026-10-23 起两渠道都有(org 走 /agent-presets/:name/archive)。 */}
                  {isOrg(a) && (
                    <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{ORG_LIMITS.hint}</p>
                  )}
                  <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
                    {(() => {
                      const previewReq = agentRequest('preview', a)
                      const editReq = agentRequest('updateMeta', a)
                      const uploadReq = agentRequest('uploadVersion', a)
                      // 已下架 ⇒ 上传新版必被发布内核拒(无渠道例外);reason 挂外层 span
                      // (禁用按钮不派发鼠标事件,浏览器不显示它自己的 title)。
                      const uploadBlocked = a.enabled === false
                      return (
                        <>
                          {/* F-48:按该行实际端点的权限点渲染入口(缺权限 ⇒ 不出现)。 */}
                          {(isOrg(a) ? canCapRead : canMarketRead) && (
                            <Button
                              variant="outline"
                              disabled={previewReq === null}
                              title={previewReq === null ? ORG_LIMITS.hint : undefined}
                              onClick={() => void openPreview(a)}
                            >预览</Button>
                          )}
                          {canCapWrite && (
                            <span title={uploadBlocked ? DELISTED_UPLOAD_HINT : undefined}>
                              <Button
                                variant="outline"
                                disabled={busy !== null || uploadReq === null || uploadBlocked}
                                title={uploadBlocked ? DELISTED_UPLOAD_HINT : uploadReq === null ? UPLOAD_UNAVAILABLE : undefined}
                                onClick={() => { setUploadAgent(a); setUploadVersion(''); setUploadFile(null); setUploadErr('') }}
                              >上传新版</Button>
                            </span>
                          )}
                          {canCapWrite && (!a.version || a.version === '') && (
                            <Button
                              variant="destructive"
                              disabled={busy !== null}
                              title="该智能体只有身份、没有任何版本；释放名称后可重新登记（有版本时不能释放）"
                              onClick={() => { void releaseShell(a) }}
                            >{busy === `release-${a.name}` ? '释放中…' : '释放名称'}</Button>
                          )}
                          {canMarketWrite && (
                            <Button
                              variant="outline"
                              disabled={editReq === null}
                              title={editReq === null ? ORG_LIMITS.edit : undefined}
                              onClick={() => {
                                setEditAgent(a)
                                setEditDesc(a.description ?? '')
                                // 展示名回填:当前展示名等于目录名时留空,避免把 slug
                                // 当成"人工展示名"提交(空值服务端保持既有展示名)。
                                const current = a.display_name?.trim() || a.title?.trim() || ''
                                setEditTitle(current === a.name ? '' : current)
                                setEditErr('')
                              }}
                            >编辑</Button>
                          )}
                          {canCapWrite && (
                            <Button variant="outline" onClick={() => setTransferAgent(a)} title="转移归属(负责人)">归属</Button>
                          )}
                          {(isOrg(a) ? canCapWrite : canMarketWrite) && (
                            <Button variant="outline" onClick={() => setGrantAgent(a)}>授权</Button>
                          )}
                          {(isOrg(a) ? canCapWrite : canMarketWrite) && (a.enabled
                            ? <Button variant="destructive" disabled={busy !== null} onClick={() => void setEnabled(a, false)}>{busy === `disable-${a.name}` ? '下架中…' : '下架'}</Button>
                            : <Button variant="outline" disabled={busy !== null} onClick={() => void setEnabled(a, true)}>{busy === `enable-${a.name}` ? '上架中…' : '重新上架'}</Button>)}
                        </>
                      )
                    })()}
                  </div>
                </div>
              ))}
              {agents.length === 0 && (
                <div className="col-span-full">
                  <EmptyState
                    icon={<Bot className="h-5 w-5 text-muted-foreground" />}
                    title="暂无智能体"
                    desc={canMarketWrite ? '点击「上架智能体」登记并上传归档包' : '由管理员上架智能体后显示在这里'}
                  />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 上架登记弹窗(先登记,再上传归档;版本来自 preset.yml) */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上架智能体</DialogTitle>
            <DialogDescription>先登记名称与描述,随后上传归档包(agent.cordis.yml + preset.yml;版本/展示名/描述以包内为准)</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="agent-name">名称(唯一,不可修改)</Label>
              <Input id="agent-name" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="如 code-review-bot" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-title">展示名(可选)</Label>
              <Input id="agent-title" value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} placeholder={createName || '留空则显示名称(目录名)'} />
              <p className="text-xs text-muted-foreground">上传归档后以包内 preset.yml 的 title 为准。</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-desc">描述(展示文案)</Label>
              <Textarea id="agent-desc" rows={3} value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} />
            </div>
            {createErr && <div className="text-sm text-destructive">{createErr}</div>}
            <Button className="w-full" disabled={busy !== null} onClick={() => { void create() }}>{busy === 'create-agent' ? '处理中…' : '登记'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 上传版本弹窗 */}
      <Dialog open={!!uploadAgent} onOpenChange={(open) => { if (!open) setUploadAgent(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上传新版 · {uploadAgent ? agentDisplayName(uploadAgent) : ''}</DialogTitle>
            <DialogDescription>
              {uploadAgent?.channel === 'org'
                ? '组织共享智能体:归档包要求顶层 agent.cordis.yml + preset.yml;版本以包内 preset.yml 为准,管理员代传即发布(已通过审核)'
                : '归档包要求顶层 agent.cordis.yml + preset.yml(版本必须高于当前最高版本;版本号以包内 preset.yml 为准,此处可留空)'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>归档包(.zip / .tar.gz)</Label>
              <input type="file" accept=".zip,.tar.gz,.gz" className="block w-full text-sm"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
            </div>
            {/* 组织行的版本来自包内 preset.yml(服务端不接受外部 version 字段)⇒
                不渲染版本输入,免得出现"填了但不生效"的假入口。 */}
            {uploadAgent?.channel === 'org' ? (
              <p className="text-xs text-muted-foreground">版本以包内 preset.yml 为准,此处无需填写;上传即对该智能体的授权用户生效。</p>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="agent-upload-version">版本(可选,与 preset.yml 一致时填写)</Label>
                <Input id="agent-upload-version" value={uploadVersion} onChange={(e) => setUploadVersion(e.target.value)} placeholder="如 1.1.0" />
              </div>
            )}
            {uploadErr && <div className="text-sm text-destructive">{uploadErr}</div>}
            <Button className="w-full" disabled={uploadBusy} onClick={() => { void upload() }}>{uploadBusy ? '发布中…' : '发布'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 编辑展示名/描述弹窗 */}
      <Dialog open={!!editAgent} onOpenChange={(open) => { if (!open) setEditAgent(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑智能体 · {editAgent ? agentDisplayName(editAgent) : ''}</DialogTitle>
            <DialogDescription>仅展示文案;版本/内容以归档包为准,归属经「归属」转移</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="agent-edit-title">展示名</Label>
              <Input id="agent-edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder={editAgent?.name || '留空则显示名称(目录名)'} />
              <p className="text-xs text-muted-foreground">卡片标题;留空保持既有展示名(不会把英文目录名写成展示名)。</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-edit-desc">描述</Label>
              <Textarea id="agent-edit-desc" rows={4} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
            </div>
            {editErr && <div className="text-sm text-destructive">{editErr}</div>}
            <Button className="w-full" disabled={busy !== null} onClick={() => { void saveEdit() }}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>

      <CapabilityLockPanel open={lockOpen} onClose={() => setLockOpen(false)} />
      {preview && (
        <ArchivePreviewDialog
          openKey={previewKey}
          data={preview}
          mainTitle={`${previewRow && isOrg(previewRow) ? '组织共享' : '市场'} · ${previewRow?.name ?? ''}`}
          mainContent={preview.composition ?? ''}
          // 单文件/归档端点按 channel 走:市场是 name 级、组织是 name@version 级。
          fileBase={previewRow ? previewFileBase('agent', previewRow) ?? '' : ''}
          onClose={() => { setPreview(null); setPreviewRow(null) }}
        />
      )}
      {grantAgent && (
        <GrantDialog
          open={!!grantAgent}
          name={grantAgent.name}
          // 授权基路径按行 channel 走:市场 /agents/:name、组织 /agent-presets/:name
          // (组织库的授权是 name-only,同名多版本共享 —— 不带版本段)。
          basePath={grantsBase('agent', grantAgent) ?? ''}
          departments={departments}
          onClose={() => setGrantAgent(null)}
          onSaved={() => { setGrantAgent(null); void load() }}
        />
      )}
      {transferAgent && (
        <TransferOwnerDialog
          open={!!transferAgent}
          kind="agent"
          name={transferAgent.name}
          displayName={transferAgent ? agentDisplayName(transferAgent) : undefined}
          currentOwner={transferAgent.owner}
          onClose={() => setTransferAgent(null)}
          onSaved={() => { setTransferAgent(null); void load() }}
        />
      )}
    </div>
  )
}
