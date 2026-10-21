/**
 * P1（2026-10-21）：安全模式标记的读写语义。
 *
 * 标记是"一次性"恢复的唯一持久面，因此它必须：
 *  - 写入私有目录（0600 文件 / 0700 目录）并原子落盘；
 *  - 读取**绝不抛错**（坏标记不能变成新的致命原因）；
 *  - 清除失败不阻断已成功的启动。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginSafeModeBoot,
  clearSafeModeMarker,
  finishSafeModeBoot,
  readSafeModeBundles,
  safeModeMarkerPath,
  writeSafeModeMarker,
} from '../src/desktop-safe-mode.ts'

const roots: string[] = []

function sandbox(): { root: string, markerPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'safe-mode-'))
  roots.push(root)
  return { root, markerPath: safeModeMarkerPath(root) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('安全模式标记', () => {
  it('路径固定在 <userData>/plugin-management/safe-mode.json', () => {
    expect(safeModeMarkerPath('/data/userData')).toBe('/data/userData/plugin-management/safe-mode.json')
  })

  it('写入后可读回：去重排序、私有权限、JSON 有 version/createdAt', async () => {
    const { markerPath } = sandbox()
    await writeSafeModeMarker(markerPath, ['@b/x', '@a/y', '@b/x'], new Date('2026-10-21T12:00:00.000Z'))
    expect([...readSafeModeBundles(markerPath).bundles]).toEqual(['@a/y', '@b/x'])
    expect(readSafeModeBundles(markerPath).problem).toBeUndefined()
    expect(statSync(markerPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(markerPath, '..')).mode & 0o777).toBe(0o700)

    const persisted = JSON.parse(readFileSync(markerPath, 'utf8')) as { version: number, createdAt: string }
    expect(persisted.version).toBe(1)
    expect(persisted.createdAt).toBe('2026-10-21T12:00:00.000Z')
  })

  it('没有标记时返回空集，不报错', () => {
    const { markerPath } = sandbox()
    expect(readSafeModeBundles(markerPath)).toEqual({ bundles: new Set() })
  })

  it('坏标记只报告问题，绝不抛错（坏恢复标记不能变成新的致命原因）', async () => {
    const { markerPath } = sandbox()
    mkdirSync(join(markerPath, '..'), { recursive: true })

    writeFileSync(markerPath, '{ not json')
    expect(readSafeModeBundles(markerPath).problem).toContain('unreadable')

    writeFileSync(markerPath, '[]')
    expect(readSafeModeBundles(markerPath).problem).toContain('not an object')

    writeFileSync(markerPath, '{"version":99,"bundles":[]}')
    expect(readSafeModeBundles(markerPath).problem).toContain('version')

    writeFileSync(markerPath, '{"version":1,"bundles":[1]}')
    expect(readSafeModeBundles(markerPath).problem).toContain('invalid')
  })

  it('写入拒绝空集合与超长集合；清除幂等且不抛错', async () => {
    const { markerPath } = sandbox()
    await expect(writeSafeModeMarker(markerPath, [])).rejects.toThrow(/at least one/u)
    await expect(writeSafeModeMarker(markerPath, Array.from({ length: 513 }, (_, index) => `@x/p${String(index)}`)))
      .rejects.toThrow(/too large/u)

    expect(clearSafeModeMarker(markerPath)).toBe(false)
    await writeSafeModeMarker(markerPath, ['@acme/plugin'])
    expect(clearSafeModeMarker(markerPath)).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
    expect(clearSafeModeMarker(markerPath)).toBe(false)
  })
})


describe('启动期的一次性生命周期', () => {
  it('begin 读标记；坏标记只记一条日志、返回空集（不阻断启动）', async () => {
    const { markerPath } = sandbox()
    mkdirSync(join(markerPath, '..'), { recursive: true })
    writeFileSync(markerPath, '{ bad')
    const log = vi.fn()
    expect([...beginSafeModeBoot(markerPath, log)]).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignored'))
  })

  it('finish 只在本次真的消费了标记时清除；没有标记时是 no-op', async () => {
    const { markerPath } = sandbox()
    await writeSafeModeMarker(markerPath, ['@acme/plugin'])
    const log = vi.fn()
    expect(finishSafeModeBoot(markerPath, new Set(), log)).toBe(false)
    expect(existsSync(markerPath)).toBe(true)
    expect(finishSafeModeBoot(markerPath, new Set(['@acme/plugin']), log)).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('left safe mode'))
  })
})

describe('私有目录与标记的形态守卫', () => {
  it('plugin-management 是符号链接时拒绝写入（与 plugin state 同口径）', async () => {
    const { root } = sandbox()
    const outside = join(root, 'outside')
    const parent = join(root, 'userData')
    mkdirSync(outside, { recursive: true })
    mkdirSync(parent, { recursive: true })
    symlinkSync(outside, join(parent, 'plugin-management'))
    await expect(writeSafeModeMarker(join(parent, 'plugin-management', 'safe-mode.json'), ['@acme/plugin']))
      .rejects.toThrow(/real directory/u)
    expect(existsSync(join(outside, 'safe-mode.json'))).toBe(false)
  })

  it('标记本身是符号链接时拒绝写入（不穿透覆盖链接目标）', async () => {
    const { root, markerPath } = sandbox()
    mkdirSync(join(markerPath, '..'), { recursive: true })
    const target = join(root, 'target.json')
    writeFileSync(target, 'do not touch')
    symlinkSync(target, markerPath)
    await expect(writeSafeModeMarker(markerPath, ['@acme/plugin'])).rejects.toThrow(/regular file/u)
  })

  it('已存在的 0755 目录被收紧到 0700', async () => {
    const { markerPath } = sandbox()
    const directory = join(markerPath, '..')
    mkdirSync(directory, { recursive: true, mode: 0o755 })
    chmodSync(directory, 0o755)
    await writeSafeModeMarker(markerPath, ['@acme/plugin'])
    expect(statSync(directory).mode & 0o777).toBe(0o700)
  })
})


describe('读取侧的形态守卫与自愈', () => {
  it('标记是目录/超长文件时只报告问题，不被当成标记（也不阻塞读取）', async () => {
    const { markerPath } = sandbox()
    mkdirSync(markerPath, { recursive: true })
    expect(readSafeModeBundles(markerPath).problem).toContain('not a regular file')

    rmSync(markerPath, { recursive: true, force: true })
    writeFileSync(markerPath, `{"version":1,"bundles":[],"pad":"${'x'.repeat(64 * 1024)}"}`)
    expect(readSafeModeBundles(markerPath).problem).toContain('too large')
  })

  it('begin 遇到坏标记会删掉它（不能永久留在磁盘上，R2-10）', () => {
    const { markerPath } = sandbox()
    mkdirSync(join(markerPath, '..'), { recursive: true })
    writeFileSync(markerPath, '{ bad')
    const log = vi.fn()
    expect([...beginSafeModeBoot(markerPath, log)]).toEqual([])
    expect(existsSync(markerPath)).toBe(false)
  })
})


describe('读侧边界（R2-1/R3-7）', () => {
  it('未知版本的标记只报告、不被删除（可能是更新版本写的）', () => {
    const { markerPath } = sandbox()
    mkdirSync(join(markerPath, '..'), { recursive: true })
    writeFileSync(markerPath, '{"version":99,"bundles":[]}')
    const log = vi.fn()
    expect([...beginSafeModeBoot(markerPath, log)]).toEqual([])
    expect(existsSync(markerPath)).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ignored'))
  })

  it('指向 FIFO 的标记不会被读取（启动不被永久阻塞）', async () => {
    const { markerPath } = sandbox()
    mkdirSync(join(markerPath, '..'), { recursive: true })
    const { execFileSync } = await import('node:child_process')
    try {
      execFileSync('mkfifo', [markerPath])
    } catch {
      return // 平台没有 mkfifo：跳过（CI 上 Linux 有）
    }
    expect(readSafeModeBundles(markerPath).problem).toContain('not a regular file')
  })

  it('读侧遇到符号链接只报告、不跟随（不读链接目标）', () => {
    const { root, markerPath } = sandbox()
    mkdirSync(join(markerPath, '..'), { recursive: true })
    const target = join(root, 'outside.json')
    writeFileSync(target, '{"version":1,"bundles":["@acme/plugin"]}')
    symlinkSync(target, markerPath)
    expect(readSafeModeBundles(markerPath).problem).toContain('not a regular file')
  })
})
