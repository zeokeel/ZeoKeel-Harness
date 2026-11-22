/**
 * 全局客户端插件安装（2026-11）的定向用例。
 *
 * 所有 I/O 都是假的：fetch 返回内存里的 tarball 字节，fs 接缝落在内存 Map 上，
 * pluginManager 是 vi.fn()。这样既没有网络也没有真实 pnpm/磁盘依赖，用例可重复。
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  syncClientPlugins,
  type ClientPluginProvisioningIo,
  type PluginManagerLike,
} from '../src/client-plugin-provisioning.ts'
import type { Session } from '../src/server-connector/config.ts'
import type { ClientPluginItem } from '../src/server-connector/bootstrap.ts'

const SESSION: Session = {
  serverURL: 'https://gateway.example',
  username: 'tester',
  token: 'tok-1',
}

const PACKAGE_NAME = '@example/dsh-global-plugin'
const VERSION = '1.0.0'
const BUNDLE_URL = '/api/client/v2/plugins/example-dsh-global-plugin/1.0.0/bundle'

interface TarEntry {
  name: string
  data: Uint8Array
  /** tar typeflag; 缺省 '0' = 普通文件。 */
  type?: string
}

/** 写一个 ASCII 字段（超长截断），并补 NUL。 */
function writeAscii(header: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = new TextEncoder().encode(text)
  header.set(bytes.subarray(0, length), offset)
}

/** 最小的 ustar header（足够让本模块的校验器接受）。 */
function tarHeader(name: string, size: number, type: string): Uint8Array {
  const header = new Uint8Array(512)
  writeAscii(header, 0, 100, name)
  writeAscii(header, 100, 8, '0000644\0')
  writeAscii(header, 108, 8, '0000000\0')
  writeAscii(header, 116, 8, '0000000\0')
  writeAscii(header, 124, 12, `${size.toString(8).padStart(11, '0')}\0`)
  writeAscii(header, 136, 12, '00000000000\0')
  // checksum 先占 8 个空格，最后再回填。
  writeAscii(header, 148, 8, '        ')
  writeAscii(header, 156, 1, type)
  writeAscii(header, 257, 6, 'ustar\0')
  writeAscii(header, 263, 2, '00')
  let sum = 0
  for (const byte of header) sum += byte
  writeAscii(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function tarEntry(entry: TarEntry): Uint8Array {
  const header = tarHeader(entry.name, entry.data.byteLength, entry.type ?? '0')
  const padded = Math.ceil(entry.data.byteLength / 512) * 512
  const out = new Uint8Array(512 + padded)
  out.set(header, 0)
  out.set(entry.data, 512)
  return out
}

function makeTarball(entries: readonly TarEntry[]): Uint8Array {
  const parts = entries.map(tarEntry)
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0) + 1024
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  // 末尾 1024 字节保持 0（tar 结束标记）。
  return out
}

/** 一个能通过客户端校验的 `.tgz`。 */
function bundleBytes(name = PACKAGE_NAME, version = VERSION): Uint8Array {
  const packageJson = JSON.stringify({
    name,
    version,
    description: 'fixture',
    dsh: { bundle: { patch: [] } },
  })
  const tar = makeTarball([
    { name: 'package/package.json', data: new TextEncoder().encode(packageJson) },
    { name: 'package/lib/index.js', data: new TextEncoder().encode('export {}\n') },
  ])
  return new Uint8Array(gzipSync(tar))
}

function itemFor(bytes: Uint8Array, overrides: Partial<ClientPluginItem> = {}): ClientPluginItem {
  return {
    id: 'example-dsh-global-plugin',
    package_name: PACKAGE_NAME,
    version: VERSION,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    url: BUNDLE_URL,
    ...overrides,
  }
}

interface FakeIo {
  io: ClientPluginProvisioningIo
  fetchMock: ReturnType<typeof vi.fn>
  writes: Map<string, Uint8Array>
  removed: string[]
}

function fakeIo(bytes: Uint8Array): FakeIo {
  const writes = new Map<string, Uint8Array>()
  const removed: string[] = []
  const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }))
  const io: ClientPluginProvisioningIo = {
    fetch: fetchMock as unknown as ClientPluginProvisioningIo['fetch'],
    tmpdir: () => '/tmp',
    mkdtemp: async prefix => `${prefix}test`,
    writeFile: async (path, data) => { writes.set(path, data) },
    readFile: async (path) => {
      const data = writes.get(path)
      if (data === undefined) throw new Error(`missing fake file ${path}`)
      return data
    },
    rm: async (path) => { removed.push(path) },
  }
  return { io, fetchMock, writes, removed }
}

interface FakeManager {
  manager: PluginManagerLike
  listBundles: ReturnType<typeof vi.fn>
  installBundle: ReturnType<typeof vi.fn>
}

function fakeManager(
  bundles: readonly { name: string; version?: string; installed?: boolean }[] = [],
  application = 'applied',
): FakeManager {
  const listBundles = vi.fn(async () => bundles)
  const installBundle = vi.fn(async () => ({ application }))
  return { manager: { listBundles, installBundle } as PluginManagerLike, listBundles, installBundle }
}

function fakeCtx(services: Record<string, unknown> = {}): {
  ctx: Context
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
} {
  const info = vi.fn()
  const warn = vi.fn()
  const error = vi.fn()
  const ctx = {
    get: (name: string) => services[name],
    logger: { info, warn, error },
  } as unknown as Context
  return { ctx, info, warn, error }
}

describe('global client plugin provisioning', () => {
  it('同版本已安装：不下载、不安装', async () => {
    const bytes = bundleBytes()
    const item = itemFor(bytes)
    const { io, fetchMock, removed } = fakeIo(bytes)
    const { manager, installBundle } = fakeManager([{ name: item.package_name, version: item.version, installed: true }])
    const { ctx, error } = fakeCtx({ pluginManager: manager })

    await syncClientPlugins(ctx, SESSION, [item], io)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(installBundle).not.toHaveBeenCalled()
    expect(removed).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })

  it('未安装：下载并校验后以绝对路径 enabled:true 安装，restart-required 通知一次', async () => {
    const bytes = bundleBytes()
    const item = itemFor(bytes)
    const { io, fetchMock, removed } = fakeIo(bytes)
    const { manager, installBundle } = fakeManager([], 'restart-required')
    const notify = vi.fn()
    const { ctx, error } = fakeCtx({ pluginManager: manager, desktopRuntime: { notify } })

    await syncClientPlugins(ctx, SESSION, [item], io)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://gateway.example${BUNDLE_URL}`)
    expect(init).toMatchObject({
      headers: { Authorization: 'Bearer tok-1' },
      redirect: 'error',
    })

    expect(installBundle).toHaveBeenCalledTimes(1)
    const [spec, options] = installBundle.mock.calls[0] as [string, { enabled?: boolean }]
    expect(spec.startsWith('/tmp/dsh-client-plugin-test/')).toBe(true)
    expect(spec.endsWith('.tgz')).toBe(true)
    expect(options).toEqual({ enabled: true })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.any(String),
      body: expect.stringContaining(`${PACKAGE_NAME}@${VERSION}`),
    }))
    expect(removed).toEqual(['/tmp/dsh-client-plugin-test'])
    expect(error).not.toHaveBeenCalled()
  })

  it('sha256 不匹配：不安装、记错误日志、清理临时目录', async () => {
    const bytes = bundleBytes()
    const item = itemFor(bytes, { sha256: '0'.repeat(64) })
    const { io, removed } = fakeIo(bytes)
    const { manager, installBundle } = fakeManager()
    const { ctx, error } = fakeCtx({ pluginManager: manager })

    await syncClientPlugins(ctx, SESSION, [item], io)

    expect(installBundle).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('sha256 mismatch'))
    expect(removed).toEqual(['/tmp/dsh-client-plugin-test'])
  })

  it('没有 pluginManager（web/headless）：整轮 no-op', async () => {
    const bytes = bundleBytes()
    const item = itemFor(bytes)
    const { io, fetchMock, removed } = fakeIo(bytes)
    const { ctx, error } = fakeCtx()

    await syncClientPlugins(ctx, SESSION, [item], io)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(removed).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })

  it('旧服务端不下发 plugins：连 listBundles 都不调用', async () => {
    const { io, fetchMock } = fakeIo(bundleBytes())
    const { manager, listBundles, installBundle } = fakeManager()
    const { ctx, error } = fakeCtx({ pluginManager: manager })

    await syncClientPlugins(ctx, SESSION, undefined, io)

    expect(listBundles).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(installBundle).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('版本变化：即使同名包已装旧版本，仍然下载并安装新版本', async () => {
    const bytes = bundleBytes(PACKAGE_NAME, '1.1.0')
    const item = itemFor(bytes, { version: '1.1.0', url: '/api/client/v2/plugins/example-dsh-global-plugin/1.1.0/bundle' })
    const { io, fetchMock, removed } = fakeIo(bytes)
    const { manager, installBundle } = fakeManager([{ name: item.package_name, version: '1.0.0', installed: true }])
    const { ctx } = fakeCtx({ pluginManager: manager })

    await syncClientPlugins(ctx, SESSION, [item], io)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(installBundle).toHaveBeenCalledWith(expect.stringMatching(/\.tgz$/), { enabled: true })
    expect(removed).toEqual(['/tmp/dsh-client-plugin-test'])
  })

  it('tarball 内 package.json 的 name/version 与清单不符：拒绝安装', async () => {
    const bytes = bundleBytes('@example/other-plugin', '9.9.9')
    const item = itemFor(bytes)
    const { io, removed } = fakeIo(bytes)
    const { manager, installBundle } = fakeManager()
    const { ctx, error } = fakeCtx({ pluginManager: manager })

    await syncClientPlugins(ctx, SESSION, [item], io)

    expect(installBundle).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('does not match bootstrap entry'))
    expect(removed).toEqual(['/tmp/dsh-client-plugin-test'])
  })

  it('tarball 含符号链接：拒绝安装（不能把链接交给 pnpm 解包）', async () => {
    const tar = makeTarball([
      {
        name: 'package/package.json',
        data: new TextEncoder().encode(JSON.stringify({ name: PACKAGE_NAME, version: VERSION })),
      },
      { name: 'package/evil', data: new Uint8Array(0), type: '2' },
    ])
    const bytes = new Uint8Array(gzipSync(tar))
    const item = itemFor(bytes)
    const { io } = fakeIo(bytes)
    const { manager, installBundle } = fakeManager()
    const { ctx, error } = fakeCtx({ pluginManager: manager })

    await syncClientPlugins(ctx, SESSION, [item], io)

    expect(installBundle).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('is a link'))
  })

  it('tarball 含越界路径：拒绝安装', async () => {
    const tar = makeTarball([
      {
        name: 'package/package.json',
        data: new TextEncoder().encode(JSON.stringify({ name: PACKAGE_NAME, version: VERSION })),
      },
      { name: 'package/../../escape', data: new TextEncoder().encode('x') },
    ])
    const bytes = new Uint8Array(gzipSync(tar))
    const item = itemFor(bytes)
    const { io } = fakeIo(bytes)
    const { manager, installBundle } = fakeManager()
    const { ctx, error } = fakeCtx({ pluginManager: manager })

    await syncClientPlugins(ctx, SESSION, [item], io)

    expect(installBundle).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('escapes the archive root'))
  })

  it('下载失败只记日志，不影响后续条目', async () => {
    const first = bundleBytes('@example/first', '1.0.0')
    const second = bundleBytes('@example/second', '2.0.0')
    const items = [
      itemFor(first, { id: 'first', package_name: '@example/first', version: '1.0.0', url: '/api/client/v2/plugins/first/1.0.0/bundle' }),
      itemFor(second, { id: 'second', package_name: '@example/second', version: '2.0.0', url: '/api/client/v2/plugins/second/2.0.0/bundle' }),
    ]
    const writes = new Map<string, Uint8Array>()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/first/1.0.0/bundle')) return new Response('nope', { status: 500 })
      return new Response(second, { status: 200 })
    })
    const io: ClientPluginProvisioningIo = {
      fetch: fetchMock as unknown as ClientPluginProvisioningIo['fetch'],
      tmpdir: () => '/tmp',
      mkdtemp: async prefix => `${prefix}test`,
      writeFile: async (path, data) => { writes.set(path, data) },
      readFile: async (path) => writes.get(path)!,
      rm: async () => undefined,
    }
    const { manager, installBundle } = fakeManager()
    const { ctx, error } = fakeCtx({ pluginManager: manager })

    await syncClientPlugins(ctx, SESSION, items, io)

    expect(error).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'))
    expect(installBundle).toHaveBeenCalledTimes(1)
    expect(installBundle.mock.calls[0]?.[0]).toContain('example-second-2.0.0.tgz')
  })
})
