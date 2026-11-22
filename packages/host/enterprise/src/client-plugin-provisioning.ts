/**
 * 全局客户端插件安装（2026-11，契约：服务端 bootstrap `plugins` 字段与 `/api/client/v2/plugins/:id/:version/bundle`）。
 *
 * 管理员在 webadmin 上传一个 DSH bundle `.tgz`，服务端通过已认证的 bootstrap 把
 * 同一条清单下发给**所有员工**；桌面客户端在 `sync(session)` 写完设置之后调用本模块，
 * 用已有的 `pluginManager` 安装，重启后生效。
 *
 * 这一版的信任边界只有 **TLS + 管理员 RBAC + tarball sha256**：没有签名、没有状态
 * 上报、没有按人分配、也没有强制禁用。所有失败都只记日志并留待下次登录重试 ——
 * 安装插件失败**绝不能**把模型/bootstrap 设置同步一起拖垮。
 *
 * 安全要点：
 *  - 只接受相对下载地址；`session.serverURL + url` 保证会话 Bearer 只发给当前服务端。
 *  - 下载落到 `os.tmpdir()` 下的独立临时目录，复核 size / sha256，并解析 tar 校验
 *    `package.json` 的 name/version；安装结束后无论成败都删除临时目录。
 *  - tar 只允许普通文件与目录。符号链接/硬链接/越界路径（绝对路径、`..`、反斜杠）
 *    一律拒绝 —— pnpm 会真正解包这个 tarball，客户端不能把这类输入交给它。
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from './server-connector/config.ts'
import type { ClientPluginItem } from './server-connector/bootstrap.ts'

/**
 * `pluginManager` 在本模块用到的**最小结构面**。
 *
 * 企业包不依赖 `@deepseek-ai/dsh-plugin-manager`（web/headless 组合里根本没有这个
 * 服务），所以刻意只声明两个方法；字段名与上游 `BundleInfo` / `ChangeResult`
 * 对齐（`name` = package.json name，`application === 'restart-required'`）。
 */
export interface PluginBundleInfo {
  name: string
  version?: string
  /** 已声明为该 profile 依赖；缺省按 true 处理，只有明确 false 才算未安装。 */
  installed?: boolean
}

export interface PluginManagerLike {
  listBundles(): Promise<readonly PluginBundleInfo[]>
  installBundle(
    spec: string,
    options?: { enabled?: boolean },
  ): Promise<{ application?: string; error?: { code?: string; diagnostic?: string } }>
}

/** `desktopRuntime.notify` 的结构面（形状见 desktop/src/runtime.ts 的 DesktopNotification）。 */
export interface DesktopRuntimeLike {
  notify?(notification: { title: string; body: string; sessionId?: string }): void
}

/**
 * I/O 接缝：默认走真实 fetch/fs；测试注入内存实现，避免真网络与真磁盘。
 */
export interface ClientPluginProvisioningIo {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  mkdtemp: (prefix: string) => Promise<string>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  readFile: (path: string) => Promise<Uint8Array>
  rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>
  tmpdir: () => string
}

const DEFAULT_IO: ClientPluginProvisioningIo = {
  fetch: (url, init) => globalThis.fetch(url, init),
  mkdtemp: prefix => mkdtemp(prefix),
  writeFile: (path, data) => writeFile(path, data),
  readFile: path => readFile(path),
  rm: (path, options) => rm(path, options),
  tmpdir: () => tmpdir(),
}

/** 与服务端上传上限一致（24 MiB）；下载超出直接拒绝，避免把整盘塞进内存。 */
const MAX_BUNDLE_BYTES = 24 * 1024 * 1024
/** gzip 解压上限：压缩炸弹在 zlib 层就被截断。 */
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_TAR_ENTRIES = 20_000
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024
const MAX_PAX_RECORDS = 1_000
const TAR_BLOCK_BYTES = 512
/** 单个 tarball 的下载/安装不设无限等待；超时走失败日志，下次登录重试。 */
const DOWNLOAD_TIMEOUT_MS = 120_000

/** 日志失败也绝不能反过来打断安装流程。 */
function log(ctx: Context, level: 'info' | 'warn' | 'error', message: string): void {
  try {
    const logger = ctx.logger as unknown as Record<string, ((message: string) => void) | undefined> | undefined
    logger?.[level]?.(message)
  } catch {
    // 日志实现（测试替身/自定义 exporter）抛错时忽略。
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 把服务端下发的全局插件清单同步到本机。
 *
 * 永不抛出：任何一步失败都只记日志（下次登录重试）。无 `pluginManager`
 * （web/headless）或旧服务端没有 `plugins` 字段时直接 no-op。
 *
 * @param ctx - Host context；`pluginManager` / `desktopRuntime` 都是结构探测。
 * @param session - 当前登录会话（提供 serverURL 与 Bearer token）。
 * @param plugins - bootstrap 的 `plugins`；`undefined`/空数组 = 无事可做。
 * @param overrides - 测试用的 I/O 接缝（生产调用不传）。
 */
export async function syncClientPlugins(
  ctx: Context,
  session: Session,
  plugins: readonly ClientPluginItem[] | undefined,
  overrides: Partial<ClientPluginProvisioningIo> = {},
): Promise<void> {
  try {
    if (!Array.isArray(plugins) || plugins.length === 0) return

    // 结构探测而不是 inject：web/headless 组合没有 pluginManager，不能因此让本插件
    // 进入 waiting/失败状态。
    const manager = (ctx.get?.('pluginManager') as PluginManagerLike | undefined) ?? undefined
    if (manager === undefined || typeof manager.listBundles !== 'function' || typeof manager.installBundle !== 'function') return

    const io: ClientPluginProvisioningIo = { ...DEFAULT_IO, ...overrides }

    let bundles: readonly PluginBundleInfo[]
    try {
      bundles = await manager.listBundles()
    } catch (cause) {
      // 读不到已安装清单时不能猜；整轮放弃，下次登录重试。
      log(ctx, 'error', `client plugins: listBundles failed: ${describe(cause)}`)
      return
    }

    const restartRequired: string[] = []
    for (const item of plugins) {
      if (!isClientPluginItem(item)) {
        log(ctx, 'warn', 'client plugins: ignoring malformed bootstrap entry')
        continue
      }
      if (isInstalled(bundles, item)) {
        log(ctx, 'info', `client plugins: ${item.package_name}@${item.version} already installed; skipping`)
        continue
      }
      try {
        const needsRestart = await provisionOne(ctx, session, item, manager, io)
        if (needsRestart) restartRequired.push(`${item.package_name}@${item.version}`)
      } catch (cause) {
        log(ctx, 'error', `client plugins: ${item.package_name}@${item.version} failed: ${describe(cause)}`)
      }
    }

    if (restartRequired.length > 0) notifyRestartOnce(ctx, restartRequired)
  } catch (cause) {
    // 契约：绝不从 session handler 抛出去。
    log(ctx, 'error', `client plugins: provisioning aborted: ${describe(cause)}`)
  }
}

async function provisionOne(
  ctx: Context,
  session: Session,
  item: ClientPluginItem,
  manager: PluginManagerLike,
  io: ClientPluginProvisioningIo,
): Promise<boolean> {
  const url = bundleURL(session.serverURL, item.url)
  log(ctx, 'info', `client plugins: downloading ${item.package_name}@${item.version}`)

  const response = await io.fetch(url, {
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/gzip',
    },
    // 令牌只发给当前服务端；重定向到别处会把 Bearer 带出去。
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`download ${url} returned HTTP ${response.status}`)

  const downloaded = new Uint8Array(await response.arrayBuffer())
  if (downloaded.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(`download is ${downloaded.byteLength} bytes, over the ${MAX_BUNDLE_BYTES}-byte limit`)
  }

  let workDir: string | undefined
  try {
    workDir = await io.mkdtemp(join(io.tmpdir(), 'dsh-client-plugin-'))
    const file = join(workDir, tempFileName(item))
    await io.writeFile(file, downloaded)
    // 从磁盘读回复核，确保真正交给 pnpm 的是通过校验的那份字节。
    const stored = new Uint8Array(await io.readFile(file))
    verifyTarball(stored, item)

    const identity = readBundleIdentity(stored)
    if (identity.name !== item.package_name || identity.version !== item.version) {
      throw new Error(
        `tarball package ${identity.name}@${identity.version} does not match bootstrap entry ${item.package_name}@${item.version}`,
      )
    }

    const result = await manager.installBundle(file, { enabled: true })
    if (result?.application === 'failed' || result?.application === 'cancelled') {
      // installBundle 以返回值报告失败（而非抛错）时不能记成安装成功。
      const detail = result.error?.diagnostic === undefined ? '' : `: ${result.error.diagnostic}`
      throw new Error(`installBundle reported ${result.error?.code ?? result.application}${detail}`)
    }
    log(ctx, 'info', `client plugins: installed ${item.package_name}@${item.version} (${result?.application ?? 'unknown'})`)
    return result?.application === 'restart-required'
  } finally {
    if (workDir !== undefined) {
      try {
        await io.rm(workDir, { recursive: true, force: true })
      } catch (cause) {
        // 临时文件清理失败不影响安装结果；下次登录会重新下载。
        log(ctx, 'warn', `client plugins: could not remove ${workDir}: ${describe(cause)}`)
      }
    }
  }
}

function isInstalled(bundles: readonly PluginBundleInfo[], item: ClientPluginItem): boolean {
  return bundles.some((bundle) => bundle !== undefined
    && bundle.name === item.package_name
    && bundle.version === item.version
    && bundle.installed !== false)
}

/** 只接受以单个 `/` 开头的相对路径，杜绝把 Bearer 发往任意源。 */
function bundleURL(serverURL: string, relative: string): string {
  if (!relative.startsWith('/') || relative.startsWith('//')) {
    throw new Error(`refusing non-relative bundle URL ${JSON.stringify(relative)}`)
  }
  return `${serverURL.replace(/\/+$/, '')}${relative}`
}

function tempFileName(item: ClientPluginItem): string {
  const slug = (value: string): string => value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'plugin'
  return `${slug(item.package_name)}-${slug(item.version)}.tgz`
}

function verifyTarball(stored: Uint8Array, item: ClientPluginItem): void {
  if (stored.byteLength !== item.size) {
    throw new Error(`size mismatch: expected ${item.size}, got ${stored.byteLength}`)
  }
  const expected = item.sha256.trim().toLowerCase()
  const actual = createHash('sha256').update(stored).digest('hex')
  if (actual !== expected) {
    throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`)
  }
}

interface BundleIdentity {
  name: string
  version: string
}

/**
 * 从 `.tgz` 里读出 `package.json` 的 name/version。
 *
 * 这里**不信任**服务端已经校验过：同一份字节马上会交给 pnpm 解包，客户端必须自己
 * 确认「哈希对得上的 tarball」确实就是清单里那个包。
 */
function readBundleIdentity(tarball: Uint8Array): BundleIdentity {
  let tar: Uint8Array
  try {
    tar = new Uint8Array(gunzipSync(tarball, { maxOutputLength: MAX_UNCOMPRESSED_BYTES }))
  } catch (cause) {
    throw new Error(`not a gzip tarball: ${describe(cause)}`)
  }
  const packageJson = findPackageJson(tar)
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(packageJson))
  } catch (cause) {
    throw new Error(`tarball package.json is not valid JSON: ${describe(cause)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('tarball package.json is not an object')
  const { name, version } = parsed as { name?: unknown; version?: unknown }
  if (typeof name !== 'string' || name.length === 0) throw new Error('tarball package.json has no name')
  if (typeof version !== 'string' || version.length === 0) throw new Error('tarball package.json has no version')
  return { name, version }
}

/**
 * 有界地走一遍 tar，校验每个 entry 的类型与路径，返回根目录 package.json 的字节。
 *
 * 支持 ustar 与 pax（`x`）扩展头；GNU longname（`L`/`K`）与全局头（`g`）一律拒绝 ——
 * 它们不是 npm pack 的产物，支持面越小越安全。
 */
function findPackageJson(tar: Uint8Array): Uint8Array {
  let offset = 0
  let entries = 0
  let packageJson: Uint8Array | undefined
  let paxPath: string | undefined
  let paxLinkpath: string | undefined
  let paxSize: number | undefined

  while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES)
    if (isZeroBlock(header)) break
    entries += 1
    if (entries > MAX_TAR_ENTRIES) throw new Error(`tarball has more than ${MAX_TAR_ENTRIES} entries`)

    verifyTarChecksum(header)
    const headerSize = readTarOctal(header, 124, 12, 'size')
    // pax 覆盖只作用于紧随其后的 entry：先取快照再清空，避免同一份覆盖串到后面的 entry。
    const pendingPath = paxPath
    const pendingLinkpath = paxLinkpath
    const pendingSize = paxSize
    paxPath = undefined
    paxLinkpath = undefined
    paxSize = undefined
    if (pendingLinkpath !== undefined) {
      throw new Error('tarball pax header overrides a link path, which global client plugins do not allow')
    }
    const size = pendingSize ?? headerSize
    const type = String.fromCharCode(header[156] ?? 0)
    const path = normalizeTarPath(pendingPath ?? readTarPath(header))
    if (size > MAX_UNCOMPRESSED_BYTES) throw new Error(`tar entry ${path} is too large`)

    const dataStart = offset + TAR_BLOCK_BYTES
    const dataEnd = dataStart + size
    if (dataEnd > tar.byteLength) throw new Error(`tar entry ${path} exceeds the tarball bytes`)
    const data = tar.subarray(dataStart, dataEnd)

    if (type === 'x') {
      const pax = readPaxRecords(data)
      paxPath = pax.path
      paxLinkpath = pax.linkpath
      paxSize = pax.size
    } else if (type === 'g' || type === 'L' || type === 'K') {
      throw new Error(`tarball entry ${path} uses unsupported tar extension type ${JSON.stringify(type)}`)
    } else if (type === '1' || type === '2') {
      throw new Error(`tarball entry ${path} is a link, which global client plugins do not allow`)
    } else if (type === '3' || type === '4' || type === '6') {
      throw new Error(`tarball entry ${path} is a special file, which global client plugins do not allow`)
    } else if (type !== '0' && type !== '\0' && type !== '5' && type !== '7') {
      throw new Error(`tarball entry ${path} has unsupported type ${JSON.stringify(type)}`)
    } else if (type !== '5') {
      if (path === 'package/package.json' || path === 'package.json') {
        if (packageJson !== undefined) throw new Error('tarball has more than one package.json')
        if (data.byteLength > MAX_PACKAGE_JSON_BYTES) throw new Error('tarball package.json is too large')
        packageJson = data
      }
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
  }

  if (packageJson === undefined) throw new Error('tarball has no root package.json')
  return packageJson
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}

function verifyTarChecksum(header: Uint8Array): void {
  const stored = readTarOctal(header, 148, 8, 'checksum')
  let sum = 0
  for (let index = 0; index < TAR_BLOCK_BYTES; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
  }
  if (sum !== stored) throw new Error(`tar header checksum mismatch: expected ${stored}, computed ${sum}`)
}

/** tar 的数字字段（octal，空格/NUL 填充）；base-256 扩展字段直接拒绝。 */
function readTarOctal(header: Uint8Array, offset: number, length: number, field: string): number {
  let text = ''
  for (let index = offset; index < offset + length; index++) {
    const byte = header[index] ?? 0
    if (byte === 0 || byte === 0x20) continue
    text += String.fromCharCode(byte)
  }
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar header ${field} is not a valid octal number`)
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new Error(`tar header ${field} is out of range`)
  return value
}

function readTarString(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length)
  let end = 0
  while (end < bytes.byteLength && bytes[end] !== 0) end += 1
  // NUL 之后还有非零字节时，不同 tar reader 对字段边界的理解可能不一致 ——
  // 这正是路径校验被绕过的入口，直接拒绝。
  for (let index = end + 1; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0) throw new Error('tar header string field has data after its NUL terminator')
  }
  return new TextDecoder().decode(bytes.subarray(0, end))
}

function readTarPath(header: Uint8Array): string {
  const name = readTarString(header, 0, 100)
  const prefix = readTarString(header, 345, 155)
  return prefix.length > 0 ? `${prefix}/${name}` : name
}

/**
 * 拒绝绝对路径、`..`、反斜杠与 NUL；空段与 `.` 归一化掉。
 */
function normalizeTarPath(raw: string): string {
  if (raw.length === 0) throw new Error('tar entry has an empty path')
  if (raw.includes('\0') || raw.includes('\\')) throw new Error(`tar entry path ${JSON.stringify(raw)} contains an illegal character`)
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error(`tar entry path ${JSON.stringify(raw)} is absolute`)
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new Error(`tar entry path ${JSON.stringify(raw)} escapes the archive root`)
    parts.push(part)
  }
  if (parts.length === 0) throw new Error(`tar entry path ${JSON.stringify(raw)} normalizes to nothing`)
  return parts.join('/')
}

interface PaxRecords {
  path?: string
  linkpath?: string
  size?: number
}

/** pax 扩展头是一串 `<decimal length><space><key>=<value>\n`。 */
function readPaxRecords(data: Uint8Array): PaxRecords {
  const decoder = new TextDecoder()
  const records: PaxRecords = {}
  let offset = 0
  let count = 0
  while (offset < data.byteLength) {
    count += 1
    if (count > MAX_PAX_RECORDS) throw new Error('tarball pax header has too many records')
    let space = offset
    while (space < data.byteLength && data[space] !== 0x20) space += 1
    if (space >= data.byteLength) throw new Error('tarball pax header record has no length separator')
    const lengthText = decoder.decode(data.subarray(offset, space))
    if (!/^\d+$/.test(lengthText)) throw new Error('tarball pax header record has an invalid length')
    const length = Number.parseInt(lengthText, 10)
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.byteLength) {
      throw new Error('tarball pax header record length is out of bounds')
    }
    const record = decoder.decode(data.subarray(space + 1, offset + length))
    const equals = record.indexOf('=')
    if (equals <= 0) throw new Error('tarball pax header record has no key')
    const key = record.slice(0, equals)
    const value = record.endsWith('\n') ? record.slice(0, -1).slice(equals + 1) : record.slice(equals + 1)
    if (key === 'path') records.path = value
    else if (key === 'linkpath') records.linkpath = value
    else if (key === 'size') {
      if (!/^\d+$/.test(value)) throw new Error('tarball pax header size override is invalid')
      const size = Number.parseInt(value, 10)
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('tarball pax header size override is out of range')
      records.size = size
    }
    offset += length
  }
  return records
}

function isClientPluginItem(value: unknown): value is ClientPluginItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string'
    && typeof item.package_name === 'string' && item.package_name.length > 0
    && typeof item.version === 'string' && item.version.length > 0
    && typeof item.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(item.sha256)
    && typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0
    && typeof item.url === 'string' && item.url.startsWith('/')
}

function notifyRestartOnce(ctx: Context, names: readonly string[]): void {
  const body = `已安装客户端插件 ${names.join('、')}，重启客户端后生效。`
  try {
    const runtime = ctx.get?.('desktopRuntime') as DesktopRuntimeLike | undefined
    runtime?.notify?.({ title: '客户端插件已更新', body })
  } catch (cause) {
    log(ctx, 'warn', `client plugins: restart notification failed: ${describe(cause)}`)
  }
  log(ctx, 'info', `client plugins: restart required for ${names.join(', ')}`)
}
