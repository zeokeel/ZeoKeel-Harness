/**
 * 应用导出下载（设计 §5.6 / §6.2；审计 C-02「管理面无导出」的管理台半边）。
 *
 * ## 为什么不能复用 `api.request`
 *
 * `request` 恒按 JSON 解析（`res.json()`），而导出有两种成功形态：
 *   - 控制面 JSON（默认，`application/json`）；
 *   - `database=1` / `assets=1` 时的 `application/zip` 二进制。
 *
 * 走 `res.json()` 会把 zip 读坏、也拿不到 `Content-Disposition` 里的文件名。但同时**必须**
 * 保留 `request` 的错误语义：wasm 平台的错误信封是
 * `{"error":{code,message,hints,details}}`，导出被拒（`APP_PURGED` / 404 / 权限）时要
 * 抛出同形的 `ApiError`，页面才能用 `lifecycleErrorText` 说清「下一步该点哪里」。
 *
 * ## 为什么用 fetch + Blob 而不是直接 `window.location = url`
 *
 * 直接导航拿不到状态码：410 `APP_PURGED` 会变成浏览器里一段裸 JSON（或被下载成一个坏文件），
 * 管理员看到的是「点了没反应」。用 fetch 先把响应读成 Blob，成功才触发下载，失败就能原地
 * 渲染原因（并且不产生半个损坏文件）。
 */

import { ApiError } from '../../api'
import { exportPath, type ExportKind } from './apps-lifecycle'

export interface DownloadDeps {
  /** 注入点（用例用；缺省用全局 fetch）。 */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  /** 触发下载（缺省 = 造一个 <a download> 并点击）。注入后用例可断言文件名而不碰 DOM 导航。 */
  save?: (file: { href: string; filename: string }) => void
}

export interface DownloadResult {
  filename: string
  contentType: string
  bytes: number
}

function extOf(kind: ExportKind, contentType: string): string {
  if (contentType.includes('zip')) return 'zip'
  if (contentType.includes('json')) return 'json'
  return kind === 'json' ? 'json' : 'zip'
}

/**
 * 从 `Content-Disposition` 取文件名。
 *
 * 两种形态都要认：`filename="x.zip"`（服务端的 `url.PathEscape` 写法）与
 * `filename*=UTF-8''x.zip`（RFC 5987）。都没有就按 app_id + 扩展名兜底 —— 兜底名里
 * 只放 app_id（它是平台内的标识，不含任何客户身份）。
 */
export function filenameFrom(
  disposition: string | null,
  appId: string,
  kind: ExportKind,
  contentType: string,
): string {
  const raw = disposition ?? ''
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(raw)
  if (star !== null) {
    const candidate = safeDecode(star[1]!.trim().replace(/^"|"$/g, ''))
    if (candidate !== '') return candidate
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(raw)
  if (plain !== null) {
    const candidate = safeDecode(plain[1]!.trim())
    if (candidate !== '') return candidate
  }
  return `${appId}-export.${extOf(kind, contentType)}`
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 默认的“保存”：造一个 <a download> 点击（Blob URL 由调用方负责回收）。 */
function defaultSave(file: { href: string; filename: string }): void {
  if (typeof document === 'undefined') return
  const anchor = document.createElement('a')
  anchor.href = file.href
  anchor.download = file.filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * 下载一次导出。
 *
 * @throws {ApiError} 非 2xx（错误信封读全：code/message/hints/details），页面据此渲染原因。
 */
export async function downloadAppExport(
  appId: string,
  kind: ExportKind,
  deps: DownloadDeps = {},
): Promise<DownloadResult> {
  const doFetch = deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init))
  // 注意：GET 不需要 CSRF（服务端只校验写方法的 X-CSRF-Token）；cookie 会话由
  // `credentials: 'same-origin'` 带上（默认值同此，写出来是为了明示）。
  const res = await doFetch(exportPath(appId, kind), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json, application/zip' },
  })
  if (!res.ok) {
    let code = 'INTERNAL'
    let message = `导出失败(${res.status})`
    let hints: string[] = []
    let details: Record<string, unknown> | undefined
    try {
      const body = await res.json()
      if (typeof body?.error?.code === 'string') code = body.error.code
      if (typeof body?.error?.message === 'string') message = body.error.message
      if (Array.isArray(body?.error?.hints)) {
        hints = body.error.hints.filter((h: unknown): h is string => typeof h === 'string' && h !== '')
      }
      if (body?.error?.details !== null && typeof body?.error?.details === 'object') {
        details = body.error.details as Record<string, unknown>
      }
    } catch {
      /* 非 JSON 错误体（反代 HTML 等）保持上面的中文兜底 */
    }
    throw new ApiError(res.status, code, message, undefined, hints, details)
  }
  const contentType = res.headers.get('content-type') ?? ''
  const filename = filenameFrom(res.headers.get('content-disposition'), appId, kind, contentType)
  const blob = await res.blob()
  const create = deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b))
  const revoke = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url))
  const save = deps.save ?? defaultSave
  const href = create(blob)
  try {
    save({ href, filename })
  } finally {
    revoke(href)
  }
  return { filename, contentType, bytes: blob.size }
}
