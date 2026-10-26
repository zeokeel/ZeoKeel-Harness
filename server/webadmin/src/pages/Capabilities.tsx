import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { EmptyState } from '../components/empty-state'
import { PageHeader } from '../components/page-header'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Textarea } from '../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Download, FileText, RefreshCw, Share2, ShieldCheck, Sparkles, UserCog } from 'lucide-react'
import { GrantDialog } from '../components/grant-dialog'
import { ArchivePreviewDialog, ArchivePreviewData } from '../components/archive-preview-dialog'
import { TransferOwnerDialog } from '../components/transfer-owner-dialog'
import {
  delistConfirmText, displayNameOf, formatCount, SERVER_TIME_TITLE, serverTimeText,
  SOURCE_LABEL, STATUS_LABEL,
} from '../lib/capability-display'
import { hasPermission, PERM_CAP_READ, PERM_CAP_WRITE } from '../lib/rbac'

/**
 * 能力中心·统一审批(决策 2026-08-25 Phase 3,2026-09 恢复):共享技能与
 * 共享 Agent 的审核队列归并到一个列表(类型徽章区分 + 类型筛选),
 * approve/reject/delete 与授权仍走各自原域端点(base_path 由服务端逐行
 * 下发,均为 /api/server/admin 前缀),质量标记(官方/精选)经各域 /quality
 * 端点设置。不复制审核逻辑,仅组合与状态编排。
 */

interface ApprovalRow {
  kind: 'skill' | 'agent'
  name: string
  version: string
  display_name: string
  description: string
  author: string
  /** 归属人(apps.owner,2026-09-02 归属权)——与 author(本行上传者)可不同。 */
  owner?: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  quality: '' | 'featured'
  downloads: number
  calls?: number
  created_at: string
  base_path: string
  /** 授权基路径(name-only,授权是资源级,同名多版本共享);非 base_path。 */
  grants_base: string
  preview_path: string
  /**
   * **历史字段**（F-51，2026-10-26）：迁移 0053 后一个 `(kind, app_id)` 只能属于
   * 一个渠道，「市场/组织同名冲突」结构上不再可能，服务端恒下发 false。字段保留
   * 只为不破坏旧响应契约；UI 不再渲染「名称冲突」徽章（渲染出来也永远不出现）。
   */
  conflict?: boolean
  /** 官方属性（0059，App 级）：服务端 `ApprovalRow.official` 已下发，接上蓝标/归属语义。 */
  official?: boolean
  /** 上下架状态（App 级，2026-09-15；智能体行 2026-09-17 起同样下发）。 */
  enabled?: boolean
  /**
   * 来源渠道（2026-10-23，服务端 `GET /capabilities/approvals` 新增下发）。
   *
   *   - `market`：市场直上架内容的新版本 —— 归属人员在客户端上传后**恒为 pending**，
   *     此前该队列只读 org 渠道 ⇒ 市场待审版本没有任何审核面，已上架内容永远停在
   *     首版（「已上架技能无法更新」的第三处根因）。
   *   - `org`：组织共享库（员工上传、审批通过）的行，行为完全保持原样。
   *
   * **缺省按 org 处理**（见 {@link channelOf}）：旧服务端不下发该字段时队列里本来
   * 只有 org 行，"缺省 org" 等价于按既有行为渲染；反过来缺省成 market 会把整张表
   * 裁掉删除/上下架/授权入口（管理员突然失去一半动作面）。
   */
  channel?: 'market' | 'org'
}

type ApprovalChannel = NonNullable<ApprovalRow['channel']>

/** 行的来源渠道（缺省 = org，理由见 {@link ApprovalRow.channel}）。 */
function channelOf(row: { channel?: ApprovalChannel }): ApprovalChannel {
  return row.channel === 'market' ? 'market' : 'org'
}

interface Dept {
  id: number
  parent_id: number
  name: string
}

/**
 * 预览弹层的重挂 key(2026-10-26 D 系列显示修复)。
 *
 * 必须先算 `(display_name || name)` 再拼 `@version`:写成
 * `display_name || name + '@' + version` 时 `+` 的优先级高于 `||`,展示名非空
 * 的行 key 会**丢掉版本段** —— 同一展示名的不同版本预览不再区分,弹层状态
 * (选中文件/滚动位置)会串到另一行。导出为纯函数以便判据直接钉住。
 */
export function previewKeyOf(row: { display_name?: string; name: string; version: string }): string {
  return (row.display_name || row.name) + '@' + row.version
}

/** 状态徽章文案取自 `capability-display.STATUS_LABEL`（与客户端 locales 对齐，F-50）。 */
const STATUS_META: Record<ApprovalRow['status'], { label: string; variant: 'secondary' | 'success' | 'destructive' }> = {
  pending: { label: STATUS_LABEL.pending, variant: 'secondary' },
  approved: { label: STATUS_LABEL.approved, variant: 'success' },
  rejected: { label: STATUS_LABEL.rejected, variant: 'destructive' },
}

const KIND_META: Record<ApprovalRow['kind'], { label: string; icon: typeof Sparkles }> = {
  skill: { label: '技能', icon: Sparkles },
  agent: { label: '智能体', icon: Share2 },
}

/**
 * 「待审 + 应用已下架」这一格为什么不能点（R6-B P2，2026-09-23）。
 *
 * 服务端自第五轮起在下架期间对 approve 一律 409 `APP_DELISTED`
 * （`server/internal/sharedskills/routes.go` 的 `Distribution.Writable()`，agentshare 同闸；
 * 带真 PG 的回归用例 `internal/capabilities/r5b_delist_owner_semantics_test.go` 明确造出
 * "先有 1.1.0 待审、再下架"并断言 409）。而本页此前只在 `status === 'approved'` 的行上
 * 渲染下架徽标，待审行给出的是一个**注定失败**的「通过」按钮，事前没有任何标记。
 *
 * 文案与 `APP_DELISTED` 语义一致，并给出 Admin 在本页可达的处置路径
 * （上下架是 App 级、按 name 生效 ⇒ 在「已通过」页对同名应用的已通过版本「上架」即可解冻）。
 */
export const DELISTED_PENDING_HINT =
  '该应用已下架：下架期间「通过」会被服务端拒绝（409 APP_DELISTED）。请先到「已通过」页对该应用「上架」。'

/**
 * market 行「已下架 + 待审」的同一条事前说明（2026-10-23）。
 *
 * 服务端的下架冻结在**发布内核**里（`serverstore.ReviewPending` 的 `ErrAppDelisted`），
 * 与渠道无关 ⇒ market 待审版本的「通过」同样必然 409。差别只在**处置路径**：
 * 市场行没有本页的上下架入口（上下架在市场页），所以指向「市场」页重新上架。
 */
export const DELISTED_PENDING_MARKET_HINT =
  '该市场应用已下架：下架期间「通过」会被服务端拒绝（409 APP_DELISTED）。请先到「市场」页对该应用「重新上架」。'

/**
 * market 待审行的**影响面说明**（2026-10-23）。
 *
 * 组织行通过 = 该版本对该技能的授权用户可见；市场行通过 = **替换分发版本**，
 * 同样立即对全部授权用户生效（不是只有上传者）。管理员点「通过」之前必须知道
 * 这一下影响的是谁 —— 这是本页对 market 行唯一新加的一行文案。
 */
export const MARKET_PENDING_HINT = (kind: ApprovalRow['kind']): string =>
  `市场${KIND_META[kind].label}待审版本：通过后对该${KIND_META[kind].label}的全部授权用户生效`

/**
 * 锁定管理(决策 2026-09-01 D4):被锁定的技能/智能体只能由管理员发布,
 * 员工在客户端上传时会收到 403 与此处填写的理由。支持对**尚不存在**的
 * 名字预先锁定(占名),防止员工抢占官方命名。
 */

export default function Capabilities() {
  const [allRows, setAllRows] = useState<ApprovalRow[]>([])
  // 独立的全状态计数数据(仅 tab 徽章用);allRows 只含当前 status 过滤后的
  // 列表,不能用于跨状态计数(否则其它 tab 的徽章恒为 0,2026-09-01 审计发现)。
  const [countRows, setCountRows] = useState<ApprovalRow[]>([])
  const [tab, setTab] = useState('pending')
  const [typeFilter, setTypeFilter] = useState<'all' | 'skill' | 'agent'>('all')
  const [error, setError] = useState('')
  /**
   * **列表读取**失败（R16A-18，审计 2026-09-25，P3）：必须与 `error`（**动作**失败：
   * 拒绝理由为空 / approve / reject / delete / 上下架的 catch）分开。
   *
   * 合用一个状态时，一次**写**请求失败就会把整张表换成「审批列表未读取成功 /
   * 读取失败时不渲染任何行」—— 而列表读**从未**失败，文案还反过来说"为避免把上一页
   * 的数据当成当前结果"。同族修法（R15C-W-04）在 Departments/Apps/Balance/Audit
   * 已经就位（`loadError`），本页与 Connectors 是漏掉的两处。
   *
   * 渲染口径不变：`loadError` 非空 ⇒ 页面级确定态（不渲染任何行，指回刷新入口）；
   * `error` 非空 ⇒ 只显示横幅，**表格照常渲染**（动作失败不改变"当前数据是这一份"）。
   */
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirm, setConfirm] = useState<ApprovalRow | null>(null)
  const [confirmKind, setConfirmKind] = useState<'approve' | 'reject' | 'delete'>('approve')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<ArchivePreviewData | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [previewRow, setPreviewRow] = useState<ApprovalRow | null>(null)
  const [busy, setBusy] = useState('')
  const [grantName, setGrantName] = useState('')
  const [grantBase, setGrantBase] = useState('')
  const [departments, setDepartments] = useState<Dept[]>([])
  // 归属转移(2026-09-02):管理员可修改技能/智能体负责人。
  const [transferRow, setTransferRow] = useState<ApprovalRow | null>(null)

  /**
   * 权限门(F-48,2026-10-26):审批队列的**读**是 `capability:read`（服务端
   * `/capabilities/approvals` 的申报），**所有处置动作**（通过/拒绝/删除版本/
   * 质量/上下架/归属转移/授权）都是 `capability:write`。只读角色不显示写按钮、
   * 也不发必然 403 的写请求；super_admin 权限集包含两者，行为不变。
   */
  const canRead = hasPermission(PERM_CAP_READ)
  const canWrite = hasPermission(PERM_CAP_WRITE)

  useEffect(() => {
    request(`${ADMIN_API}/departments`)
      .then((data) => { setDepartments(data.departments ?? []) })
      .catch(() => { /* 单用户授权仍可用 */ })
  }, [])
  const loadSeq = useRef(0)

  const load = useCallback(async (status: string, kind: 'all' | 'skill' | 'agent') => {
    const current = ++loadSeq.current
    setLoading(true)
    // 只清"读取失败"；**不清**动作失败的横幅（否则一次自动重拉会把管理员刚看到的
    // "删除失败：xxx"悄悄抹掉，而他们正需要据此重试或换做法）。
    setLoadError('')
    setError('')
    try {
      // status=all 必须显式传(服务端缺省=仅 pending);type 缺省=全部。
      const qs = new URLSearchParams({ status })
      if (kind !== 'all') qs.set('type', kind)
      const data = await request<{ approvals: ApprovalRow[] }>(`${ADMIN_API}/capabilities/approvals?${qs}`)
      if (current !== loadSeq.current) return
      setAllRows(data.approvals ?? [])
    } catch (err: any) {
      if (current !== loadSeq.current) return
      // R15C-W-02（审计 2026-09-25，P2）：失败必须把**行**清掉。此前只 setError，
      // 切 tab 后失败仍渲染上一个 tab 的行，而行内「删除/通过/拒绝/下架」全部可点
      // —— 管理员点「已拒绝」本意是清理已拒绝的版本，屏幕上却是待审版本，删除还会
      // 不可恢复地释放归档字节。与 Apps.tsx「列表读取失败 = 页面级的确定态」同口径。
      setAllRows([])
      setLoadError(err.message)
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [])

  // tab/type 变化都触发重拉(服务端过滤);计数用独立的全状态数据。
  // F-48:没有 capability:read 时不发必然 403 的请求。
  useEffect(() => { if (canRead) void load(tab, typeFilter) }, [canRead, load, tab, typeFilter])

  // tab 徽章计数:status=all 全量(与当前 tab/type 无关——计数反映每种
  // 状态的真实总量;type 筛选时同样按 type 拉全状态)。
  // P2 F-23：动作成功后必须显式刷新；此前 effect 只依赖 typeFilter，表变了而
  // 徽章停在旧值（表空却显示「待审核(1)」）。
  const refreshCounts = useCallback(async (): Promise<void> => {
    const qs = new URLSearchParams({ status: 'all' })
    if (typeFilter !== 'all') qs.set('type', typeFilter)
    try {
      const data = await request<{ approvals: ApprovalRow[] }>(`${ADMIN_API}/capabilities/approvals?${qs}`)
      setCountRows(data.approvals ?? [])
    } catch {
      // 徽章保持上次值，不阻塞列表。
    }
  }, [typeFilter])

  useEffect(() => { if (canRead) void refreshCounts() }, [canRead, refreshCounts])

  const shown = allRows

  const act = async (row: ApprovalRow, kind: 'approve' | 'reject' | 'delete') => {
    if (busy) return
    setBusy(row.name + row.version + kind)
    setError('')
    try {
      const base = row.base_path
      if (kind === 'delete') {
        await request(base, { method: 'DELETE' })
      } else if (kind === 'reject') {
        const trimmed = reason.trim()
        if (trimmed === '') {
          setError('请填写拒绝理由')
          setBusy('')
          return
        }
        await request(`${base}/reject`, { method: 'POST', body: JSON.stringify({ reason: trimmed }) })
      } else {
        await request(`${base}/approve`, { method: 'POST' })
      }
      setConfirm(null)
      setReason('')
      await load(tab, typeFilter)
      await refreshCounts()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  /**
   * 组织共享技能/智能体上下架（技能 2026-09-15，智能体 2026-09-17 SG-4）：
   * apps.enabled 级开关，员工可见性与下载同时受控。两 kind 的服务端端点对称
   * （/shared-skills/:name/enabled 与 /agent-presets/:name/enabled），都挂在
   * 行的 grants_base 下，故这里不需要按 kind 分支。
   */
  const setEnabled = async (row: ApprovalRow, enabled: boolean) => {
    if (busy) return
    // 上下架确认(F-49:三页口径统一):下架 = 停止分发、可恢复,不是删除。
    const name = `${displayNameOf(row)}@${row.version}`
    if (!window.confirm(enabled
      ? `重新上架「${name}」？恢复后该 App 的全部授权用户可见可下载（下架仍可再次执行）。`
      : delistConfirmText(name))) return
    setBusy(row.name + row.version + 'enabled')
    setError('')
    try {
      await request(`${row.grants_base}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) })
      await load(tab, typeFilter)
      await refreshCounts()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const setQuality = async (row: ApprovalRow, quality: '' | 'featured') => {
    if (row.status !== 'approved') return
    setBusy(row.name + row.version + 'quality')
    setError('')
    try {
      await request(`${row.base_path}/quality`, { method: 'PUT', body: JSON.stringify({ quality }) })
      await load(tab, typeFilter)
      await refreshCounts()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const openPreview = async (row: ApprovalRow) => {
    // P2 F-22：拒绝时服务端已清空归档，预览必 404；入口不应出现，这里再兜一层。
    if (row.status === 'rejected') return
    // 预览 key 由 previewKeyOf 一处产出(优先级 bug 的回归判据见该函数注释)。
    setPreviewKey(previewKeyOf(row))
    setPreviewRow(row)
    setPreview(null)
    setError('')
    try {
      const data = await request<ArchivePreviewData>(row.preview_path)
      setPreview(data)
    } catch (err: any) {
      setError(err.message)
      setPreviewKey('')
    }
  }

  // 归属转移(2026-09-02):行按钮只打开公共 TransferOwnerDialog,
  // PUT /apps/:kind/:app_id/owner 与错误展示在弹窗组件内,审计由服务端留痕。
  const counts = {
    all: countRows.length,
    pending: countRows.filter(r => r.status === 'pending').length,
    approved: countRows.filter(r => r.status === 'approved').length,
    rejected: countRows.filter(r => r.status === 'rejected').length,
  }

  // F-48:没有 capability:read 时给确定态（不发请求、不渲染任何操作）。
  if (!canRead) {
    return (
      <EmptyState
        icon={<Share2 className="h-6 w-6" />}
        title="没有审批查看权限"
        desc="需要 capability:read；联系超级管理员授予后再查看审批队列。"
      />
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="审批"
        desc="技能/智能体的新版本统一审批队列（组织共享 + 市场）：通过后按授权可见可安装；上下架/质量/官方归属在市场页或本页对应动作"
      />
      {/* 状态 tab + 类型筛选 */}
      <div className="flex items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {/* F-50:状态文案与客户端 locales 对齐（审核中/已共享/未通过）。 */}
            <TabsTrigger value="pending">{STATUS_LABEL.pending}（{counts.pending}）</TabsTrigger>
            <TabsTrigger value="approved">{STATUS_LABEL.approved}（{counts.approved}）</TabsTrigger>
            <TabsTrigger value="rejected">{STATUS_LABEL.rejected}（{counts.rejected}）</TabsTrigger>
            <TabsTrigger value="all">全部（{counts.all}）</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1">
          {(['all', 'skill', 'agent'] as const).map(t => (
            <Button key={t} size="sm" variant={typeFilter === t ? 'default' : 'outline'} onClick={() => { setTypeFilter(t) }}>
              {t === 'all' ? '全部类型' : KIND_META[t].label}
            </Button>
          ))}
          <Button variant="outline" size="sm" className="ml-1" onClick={() => { void load(tab, typeFilter) }} title="刷新">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* F-24(产品待定):服务端审批队列只并入 market 的**待审**版本,市场已共享/未通过
          的历史版本没有列表端点。这里明确说清去哪看,不让管理员以为「全部」缺了一半。 */}
      <p className="text-xs text-muted-foreground">
        市场渠道只并入待审版本；已共享 / 未通过的市场版本请到「技能 / 智能体」页查看。
      </p>

      {/* 横幅：**读取失败与动作失败都显示原文**（否则读取失败的具体原因只剩
          「…未读取成功」一句，运维拿不到 500 里的细节）。与 Departments.tsx 同口径。 */}
      {(loadError || error) && <p className="text-sm text-destructive">{loadError || error}</p>}

      {loading ? (
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : loadError ? (
        // 失败 ≠ 空态：说清"没读到"，并指回可用的重试入口（右上角刷新 / 切换 tab）。
        // 判据必须是 **loadError**（列表读失败），不是 error（动作失败）——见 state 注释。
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="审批列表未读取成功"
          desc="为避免把上一页的数据当成当前结果，读取失败时不渲染任何行；请点右上角刷新重试" />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Share2 className="h-6 w-6" />} title="暂无待处理能力" desc="员工上传的技能/Agent 将出现在这里" />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>名称 / 标题</TableHead>
                <TableHead>版本</TableHead>
                <TableHead title="上传者（release.publisher）；与归属人可不同">作者（上传者）</TableHead>
                <TableHead title="负责人（apps.owner），决定谁能续传新版本">归属（负责人）</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>质量</TableHead>
                <TableHead>下载/调用</TableHead>
                <TableHead>上传时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(row => {
                const meta = STATUS_META[row.status]
                const kindMeta = KIND_META[row.kind]
                const KindIcon = kindMeta.icon
                // 来源渠道:market 行**恒为 pending**(市场直上架内容的新版本),
                // 且市场命名空间没有 删除/质量/版本级上下架/授权 端点 ⇒ 这些入口
                // 不渲染(渲染出来点下去必然 404);通过/拒绝/预览/下载归档/转移归属
                // 走服务端下发的 base_path,两渠道同形。
                const channel = channelOf(row)
                const isMarket = channel === 'market'
                // 行内**任一**操作在途都要置灰并拦住重复点击。此前漏了 'enabled'
                // （上下架的键，见 setEnabled）⇒ 管理员在"下架"在途时点"重新上架"会被
                // `if (busy) return` 静默吞掉、按钮也不置灰，零反馈（2026-09-17 独立审计）。
                const isBusy = busy === row.name + row.version + 'approve'
                  || busy === row.name + row.version + 'reject'
                  || busy === row.name + row.version + 'delete'
                  || busy === row.name + row.version + 'quality'
                  || busy === row.name + row.version + 'enabled'
                return (
                  <TableRow key={row.kind + ':' + row.name + '@' + row.version}>
                    <TableCell>
                      <Badge variant="outline"><KindIcon className="mr-1 h-3 w-3" />{kindMeta.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" title="市场 = 管理端直上架；组织 = 员工上传、审批通过后进入共享库">
                        {isMarket ? SOURCE_LABEL.market : SOURCE_LABEL.org}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="whitespace-nowrap font-medium">
                        {displayNameOf(row)}
                        {/* F-51:`conflict` 在迁移 0053 之后恒 false(服务端保留字段只为
                            响应兼容),这里不再渲染永远不出现的「名称冲突」徽章。 */}
                      </div>
                      {/* 目录名只在展示名不同时作副标题,避免同一串名称出现两次。 */}
                      {displayNameOf(row) !== row.name && (
                        <div className="text-xs text-muted-foreground">{row.name}</div>
                      )}
                      {/* market 待审行的影响面说明(仅 market):组织行通过 = 该版本对
                          授权用户可见,市场行通过 = **替换分发版本**,同样对全部授权
                          用户生效。 */}
                      {isMarket && row.status === 'pending' && (
                        <div className="mt-1 max-w-[16rem] whitespace-normal text-[11px] leading-relaxed text-muted-foreground" data-role="market-pending-hint">
                          {MARKET_PENDING_HINT(row.kind)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{row.version}</TableCell>
                    <TableCell>{row.author || '—'}</TableCell>
                    <TableCell title="归属人(谁能续传新版本;与作者可不同)">
                      {/* F-51:官方 App 的归属语义是「官方」(owner 恒空),接上蓝标而不是显示 —。 */}
                      {row.official
                        ? <Badge className="bg-[#1E40AF] text-white hover:bg-[#1E40AF]">官方</Badge>
                        : (row.owner || '—')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                      {/* 下架徽标按**服务端字段**（`apps.enabled=false`）渲染，不再只在
                          `status === 'approved'` 的行上：待审版本叠在已下架应用上时，
                          通过必被服务端 409 `APP_DELISTED` 拒（R6-B P2），事前必须有标记。 */}
                      {row.enabled === false && (
                        <Badge variant="destructive" className="ml-1" title="已下架：员工目录不可见且不可下载（数据保留）">已下架</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* F-25:质量标记只有组织命名空间有版本级端点(`PUT …/:version/quality`)。
                          市场渠道服务端**没有** quality 端点 ⇒ 不渲染 Select（不造假入口），
                          只给一句为什么；组织行在无 capability:write 时也只读展示。 */}
                      {row.status === 'approved' && !isMarket ? (
                        canWrite ? (
                          <Select
                            value={row.quality || 'none'}
                            onValueChange={(v) => { void setQuality(row, v === 'none' ? '' : 'featured') }}
                            disabled={isBusy}
                          >
                            <SelectTrigger className="h-7 w-24 text-xs">
                              <SelectValue placeholder="无" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">无</SelectItem>
                              <SelectItem value="featured">精选</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-xs text-muted-foreground">{row.quality === 'featured' ? '精选' : '—'}</span>
                        )
                      ) : (
                        <span
                          className="text-xs text-muted-foreground"
                          title={isMarket ? '市场渠道没有质量设置端点（服务端未提供 /quality），精选由组织行维护' : undefined}
                        >—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      下载 {formatCount(row.downloads)}{row.kind === 'skill' ? ` / 调用 ${formatCount(row.calls)}` : ''}
                    </TableCell>
                    <TableCell className="text-muted-foreground" title={SERVER_TIME_TITLE}>{serverTimeText(row.created_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {row.status !== 'rejected' && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => { void openPreview(row) }} title="查看内容预览">
                              <FileText className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm"
                              onClick={() => { window.open(`${row.base_path}/archive`, '_blank') }}
                              title="下载归档核查" aria-label="下载归档核查">
                              <Download className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {canWrite && (
                          <Button variant="ghost" size="sm" disabled={isBusy}
                            onClick={() => { setTransferRow(row) }}
                            title="转移归属(负责人)" aria-label="转移归属(负责人)">
                            <UserCog className="h-4 w-4" />
                          </Button>
                        )}
                        {/* 以下四个动作**只有组织命名空间有端点**(授权 / 上下架 /
                            质量 / 删除),market 行一律不渲染 —— 渲染出来点下去必然 404。
                            市场行的上下架/删除在市场页(`/skills|agents/:name[/version]`),
                            本页只承担"审"。 */}
                        {canWrite && !isMarket && row.status === 'approved' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setGrantName(row.name); setGrantBase(row.grants_base) }} title="授权" aria-label="授权">
                            <ShieldCheck className="h-4 w-4" />
                          </Button>
                        )}
                        {canWrite && !isMarket && row.status === 'approved' && (
                          row.enabled === false ? (
                            <Button size="sm" variant="outline" disabled={isBusy}
                              onClick={() => { void setEnabled(row, true) }}
                              title="重新上架（员工可见可下载）" aria-label="重新上架">
                              上架
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" disabled={isBusy}
                              onClick={() => { void setEnabled(row, false) }}
                              title="下架（员工不可见、不可下载；数据保留）" aria-label="下架">
                              下架
                            </Button>
                          )
                        )}
                        {canWrite && row.status !== 'approved' && (
                          // 已下架的待审行：「通过」置灰（点下去必然 409 APP_DELISTED），
                          // 说明挂在**外层 span** 上 —— 禁用按钮不派发鼠标事件，浏览器
                          // 不会显示它自己的 title（R6-B P2）。市场行的修复入口在
                          // 「市场」页（本页不渲染上下架），故文案按渠道分支。
                          <span title={row.enabled === false
                            ? (isMarket ? DELISTED_PENDING_MARKET_HINT : DELISTED_PENDING_HINT)
                            : undefined}>
                            <Button size="sm" disabled={isBusy || row.enabled === false}
                              onClick={() => { setConfirm(row); setConfirmKind('approve') }}>通过</Button>
                          </span>
                        )}
                        {/* 拒绝只对待审版本开放(ID-01,审计 2026-09-23):拒绝与
                            「释放归档字节」是同一条 UPDATE,对**已通过且在服务中**
                            的版本执行它会不可恢复地销毁归档(该版本对全员 404、版本号
                            烧毁)。要停服务用「下架」(可逆)。服务端在 DAO 层同样拒绝
                            并回 409 APPROVED_NOT_REJECTABLE,这里只是不让入口出现。
                            市场待审版本**也**必须能拒绝,否则坏版本只能靠通过来清场。 */}
                        {canWrite && row.status === 'pending' && (
                          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setReason(''); setConfirm(row); setConfirmKind('reject') }}>拒绝</Button>
                        )}
                        {/* F-21:按钮文案写明是「删除版本」——与「下架」(可恢复)区分。 */}
                        {canWrite && !isMarket && row.status !== 'approved' && (
                          <Button size="sm" variant="destructive" disabled={isBusy} onClick={() => { setConfirm(row); setConfirmKind('delete') }}>删除版本</Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}


      {/* 内容预览(文件清单可点击查看任意文件内容;主文件按 kind:SKILL.md / agent.cordis.yml) */}
      <ArchivePreviewDialog
        openKey={previewKey}
        data={preview}
        mainTitle={previewRow?.kind === 'agent' ? 'agent.cordis.yml' : 'SKILL.md'}
        mainContent={previewRow?.kind === 'agent' ? (preview?.composition ?? '') : (preview?.skill_md ?? '')}
        fileBase={previewRow ? previewRow.base_path : ''}
        onClose={() => { setPreviewKey('') }}
      />

      {/* 确认弹窗 */}
      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) { setConfirm(null); setReason('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm && confirmKind === 'approve' && `确定通过「${displayNameOf(confirm)}@${confirm.version}」吗？`}
              {confirm && confirmKind === 'reject' && `确定拒绝「${displayNameOf(confirm)}@${confirm.version}」吗？`}
              {confirm && confirmKind === 'delete' && `确定删除版本「${displayNameOf(confirm)}@${confirm.version}」吗？`}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmKind === 'approve' && (confirm && channelOf(confirm) === 'market'
              // market 行的通过 = **替换分发版本**(不是新增一个可见版本),影响面是
              // 该应用的全部授权用户;本页不渲染市场行的上下架/删除(那些在市场页)。
              ? '通过后该版本立即替换市场分发版本，对该应用的全部授权用户生效。'
              : '通过后该版本将按授权可见可安装。')}
            {confirmKind === 'reject' && '拒绝后仅上传者可见；该版本的归档字节会被释放且不可恢复。如需停止服务请改用「下架」（可恢复）。请填写理由，上传者可见。'}
            {confirmKind === 'delete' && '删除版本 = 不可恢复：该版本的记录与归档字节会被移除，版本号永久占位、不能复用。如果只是想停止分发，请改用「下架」（可恢复）。'}
          </p>
          {confirmKind === 'reject' && (
            <Textarea
              value={reason}
              onChange={e => { setReason(e.target.value) }}
              placeholder="拒绝理由(必填,≤500 字,作者可见)"
              maxLength={500}
              rows={3}
              aria-label="拒绝理由"
            />
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { setConfirm(null); setReason('') }}>取消</Button>
            {confirm && (
              <Button
                variant={confirmKind === 'delete' || confirmKind === 'reject' ? 'destructive' : 'default'}
                disabled={busy !== '' || (confirmKind === 'reject' && reason.trim() === '')}
                onClick={() => { void act(confirm, confirmKind) }}
              >
                {busy ? '处理中…' : '确认'}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <GrantDialog
        open={grantName !== ''}
        name={grantName}
        basePath={grantBase}
        departments={departments}
        onClose={() => { setGrantName(''); setGrantBase('') }}
        onSaved={() => { void load(tab, typeFilter) }}
      />

      {/* 归属转移(2026-09-02):管理员把维护权交给其他员工/管理员账号。
          弹窗组件自包含(输入/错误/提交),与市场技能页共用同一实现。 */}
      <TransferOwnerDialog
        open={transferRow !== null}
        kind={transferRow?.kind ?? 'skill'}
        name={transferRow?.name ?? ''}
        displayName={transferRow ? displayNameOf(transferRow) : undefined}
        currentOwner={transferRow?.owner ?? ''}
        onClose={() => { setTransferRow(null) }}
        onSaved={() => { void load(tab, typeFilter) }}
      />
    </div>
  )
}
