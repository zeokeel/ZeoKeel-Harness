import { useCallback, useEffect, useState } from 'react'
import { Package, RefreshCw, Trash2, Upload } from 'lucide-react'

import { request, ADMIN_API } from '../api'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Skeleton } from '../components/ui/skeleton'
import { Switch } from '../components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { hasPermission, PERM_PLUGIN_WRITE } from '../lib/rbac'
import { useFlash } from '../lib/use-flash'

/**
 * 全局客户端插件分发页（2026-11-22）。
 *
 * 契约：服务端 `/api/server/admin/plugins` + bootstrap `plugins` 字段（0091）。管理员上传一个 DSH bundle
 * `.tgz`，服务端把包体落库并随已认证的 bootstrap 下发给**全部员工**；客户端用既有的
 * `pluginManager` 安装，重启客户端后生效。本切面**没有**按人/部门分配、状态合规、
 * 强制停用、版本历史与签名 —— 只有「一份包，全员生效」。
 *
 * 三条与契约一一对应的硬约束：
 *   ① 上传体是**浏览器内 base64**（`{"bundle_base64","id?"}`），不是 multipart ——
 *      服务端按 JSON 解析并在同一次请求里解码/校验 tar；
 *   ② 列表接口**永不返回 content**，所以页面只展示元数据；`sha256` 只显示前 12 位
 *      （完整值挂 title），它是客户端校验下载包的唯一指纹；
 *   ③ 读权限 `plugin:read` 能看列表；上传/启停/删除都按 `plugin:write`
 *      收敛（体验层；服务端 RequirePermission 才是护栏，缺权限会拿到 403）。
 *
 * 为什么列表读失败要清空旧行：行内的启停/删除都是对**某一版包**的写动作，刷新失败时
 * 保留旧快照会让管理员对着过期数据点下去（与 Connectors/GatewayFiles 同口径）。
 */

interface PluginRow {
  id: string
  package_name: string
  display_name: string
  description: string
  version: string
  sha256: string
  size: number
  enabled: boolean
  updated_by: string
  updated_at: string
}

interface PluginListResponse {
  plugins: PluginRow[]
}

interface PluginUploadResponse {
  plugin: PluginRow
}

/** 与服务端校验一致的上限（超过时前端先拦，避免白传一份 24 MiB 的 base64）。 */
const MAX_BUNDLE_BYTES = 24 * 1024 * 1024

/** 字节 → 人类可读（插件包在 MiB 量级，一位小数足够）。 */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** sha256 只显示前 12 位（完整值挂 title，核对时鼠标悬停可读全）。 */
function shortSha(sha: string): string {
  return typeof sha === 'string' && sha.length > 12 ? `${sha.slice(0, 12)}…` : (sha || '—')
}

/** 时间展示：无效值原样给出，避免把服务端的时间戳静默吞成「—」。 */
function fmtTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

/** 统一错误文案（ApiError 继承 Error，这里只需要 message；其它类型给中文兜底）。 */
function errMessage(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message
  return '操作失败，请稍后重试'
}

/**
 * 浏览器内读文件为 base64（契约要求 JSON 提交，**不**走 multipart）。
 *
 * 分块 `String.fromCharCode` 而不是一次性展开整个 Uint8Array：24 MiB 的包一次性
 * 展开会超出引擎的函数实参上限（抛 RangeError），分块后与文件大小无关。
 * @param file - 用户选择的 `.tgz` 文件。
 * @returns 标准 base64（不含 data URL 前缀）。
 */
async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const chunk = 0x2000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export default function Plugins() {
  const [rows, setRows] = useState<PluginRow[]>([])
  const [loading, setLoading] = useState(true)
  /** 列表**读取**失败：与动作失败分开，避免一次写失败就把整张表撤掉。 */
  const [loadError, setLoadError] = useState('')
  /** 动作失败（启停/删除）。 */
  const [error, setError] = useState('')
  const [notice, flash] = useFlash(3000)
  /** 互斥标识：`upload` / `<id>-enabled` / `<id>-del`；非空时相关按钮禁用。 */
  const [busy, setBusy] = useState('')

  const [uploadOpen, setUploadOpen] = useState(false)
  const [bundleFile, setBundleFile] = useState<File | null>(null)
  const [bundleId, setBundleId] = useState('')
  const [formError, setFormError] = useState('')
  const [uploading, setUploading] = useState(false)

  const [confirmDel, setConfirmDel] = useState<PluginRow | null>(null)

  const canWrite = hasPermission(PERM_PLUGIN_WRITE)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const data = await request<PluginListResponse>(`${ADMIN_API}/plugins`)
      setRows(data.plugins ?? [])
    } catch (err) {
      // 失败即清空：行内动作不得作用在过期快照上（见文件头注释）。
      setRows([])
      setLoadError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const openUpload = () => {
    setUploadOpen(true)
    setBundleFile(null)
    setBundleId('')
    setFormError('')
  }

  const upload = async () => {
    if (uploading) return
    setFormError('')
    if (bundleFile === null) {
      setFormError('请选择 .tgz 插件包')
      return
    }
    if (!bundleFile.name.toLowerCase().endsWith('.tgz')) {
      setFormError('插件包必须是 .tgz 文件')
      return
    }
    if (bundleFile.size > MAX_BUNDLE_BYTES) {
      setFormError(`插件包超过上限（${humanSize(MAX_BUNDLE_BYTES)}）`)
      return
    }
    setUploading(true)
    setError('')
    try {
      const bundle_base64 = await fileToBase64(bundleFile)
      // id 可选：留空时由服务端按 package.json 的包名派生（契约里的 slug 规则）。
      const payload: { bundle_base64: string; id?: string } = { bundle_base64 }
      const id = bundleId.trim()
      if (id !== '') payload.id = id
      const data = await request<PluginUploadResponse>(`${ADMIN_API}/plugins`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setUploadOpen(false)
      setBundleFile(null)
      setBundleId('')
      flash(`已上传插件「${data.plugin?.display_name || id || '插件'}」`)
      await load()
    } catch (err) {
      // 失败留在对话框里（已填的 id 不丢），并把服务端原因（409/400 等）原样给出。
      setFormError(errMessage(err))
    } finally {
      setUploading(false)
    }
  }

  const toggleEnabled = async (row: PluginRow, enabled: boolean) => {
    if (busy !== '') return
    setBusy(`${row.id}-enabled`)
    setError('')
    try {
      await request(`${ADMIN_API}/plugins/${encodeURIComponent(row.id)}/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      })
      flash(enabled ? `已启用插件「${row.display_name}」` : `已停用插件「${row.display_name}」`)
      await load()
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy('')
    }
  }

  const remove = async (row: PluginRow) => {
    if (busy !== '') return
    setBusy(`${row.id}-del`)
    setError('')
    try {
      await request(`${ADMIN_API}/plugins/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      setConfirmDel(null)
      flash(`已删除插件「${row.display_name}」`)
      await load()
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="插件"
        desc="全局客户端插件分发：上传 DSH 插件包后，所有员工登录时自动同步并安装，重启客户端生效"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => { void load() }} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> 刷新
            </Button>
            {canWrite && (
              <Button size="sm" onClick={openUpload}>
                <Upload className="h-4 w-4" /> 上传插件
              </Button>
            )}
          </>
        }
      />

      {(loadError || error) && <p className="text-sm text-destructive">{loadError || error}</p>}
      {notice !== '' && <p role="status" className="text-sm text-green-700">{notice}</p>}

      {loading ? (
        <div className="space-y-2" data-testid="plugins-loading" aria-label="加载中">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      ) : loadError ? (
        <EmptyState
          icon={<Package className="h-6 w-6" />}
          title="插件列表未读取成功"
          desc="读取失败时不渲染任何行（行内启停/删除都会作用在过期快照上）；请点右上角「刷新」重试"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Package className="h-6 w-6" />}
          title="暂无客户端插件"
          desc={canWrite ? '上传第一个 .tgz 插件包后，所有员工登录客户端时自动同步' : '管理员尚未上传任何插件包'}
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>编号</TableHead>
                <TableHead>包名</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>SHA256</TableHead>
                <TableHead>大小</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>更新</TableHead>
                {canWrite && <TableHead className="text-right">操作</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-testid={`plugin-row-${row.id}`}>
                  <TableCell className="font-mono text-sm">{row.id}</TableCell>
                  <TableCell className="font-mono text-xs">{row.package_name}</TableCell>
                  <TableCell className="whitespace-nowrap font-medium" title={row.description}>
                    {row.display_name}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{row.version}</TableCell>
                  <TableCell className="font-mono text-xs" title={row.sha256}>{shortSha(row.sha256)}</TableCell>
                  <TableCell className="whitespace-nowrap">{humanSize(row.size)}</TableCell>
                  <TableCell>
                    {canWrite ? (
                      <Switch
                        checked={row.enabled}
                        disabled={busy !== ''}
                        onCheckedChange={(v) => { void toggleEnabled(row, v) }}
                        aria-label={`启用 ${row.display_name}`}
                      />
                    ) : (
                      <Badge variant={row.enabled ? 'success' : 'outline'}>{row.enabled ? '已启用' : '已禁用'}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <div>{row.updated_by || '—'}</div>
                    <div className="text-xs">{fmtTime(row.updated_at)}</div>
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        title="删除"
                        aria-label={`删除 ${row.display_name}`}
                        disabled={busy !== ''}
                        onClick={() => setConfirmDel(row)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 上传：浏览器内读成 base64 后以 JSON 提交（无 multipart）。 */}
      <Dialog open={uploadOpen} onOpenChange={(open) => { if (!open && !uploading) setUploadOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上传插件包</DialogTitle>
            <DialogDescription>
              选择 DSH bundle <code>.tgz</code>（含 package.json 与 dsh.bundle.patch）。上传后对所有员工生效；
              以同 id 上传新包时必须使用新版本号（服务端校验，否则 409）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="plugin-bundle">插件包（.tgz）</Label>
            <Input
              id="plugin-bundle"
              type="file"
              accept=".tgz,application/gzip"
              disabled={uploading}
              onChange={(e) => {
                setBundleFile(e.target.files?.[0] ?? null)
                setFormError('')
              }}
            />
            <p className="text-xs text-muted-foreground">包体上限 {humanSize(MAX_BUNDLE_BYTES)}；脚本钩子（preinstall 等）会被服务端拒绝。</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="plugin-id">插件编号（可选）</Label>
            <Input
              id="plugin-id"
              placeholder="留空由服务端按包名生成，如 demo-plugin"
              value={bundleId}
              disabled={uploading}
              onChange={(e) => setBundleId(e.target.value)}
            />
          </div>
          {formError !== '' && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={uploading}>取消</Button>
            <Button disabled={uploading} onClick={() => { void upload() }}>
              {uploading ? '上传中…' : '上传'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除必须二次确认：一份包被删后，所有客户端下次同步都会失去它。 */}
      <Dialog open={confirmDel !== null} onOpenChange={(open) => { if (!open) setConfirmDel(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确定删除插件「{confirmDel?.display_name}」吗？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            删除后该插件不再随 bootstrap 下发；已安装的客户端不会自动卸载，但下次登录不再同步更新。
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirmDel(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={busy !== ''}
              onClick={() => { if (confirmDel !== null) void remove(confirmDel) }}
            >
              {busy === `${confirmDel?.id ?? ''}-del` ? '删除中…' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
