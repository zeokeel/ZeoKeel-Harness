/**
 * P1（2026-10-21）：安全模式标记的读写语义。
 *
 * 标记是"一次性"恢复的唯一持久面，因此它必须：
 *  - 写入私有目录（0600 文件 / 0700 目录）并原子落盘；
 *  - 读取**绝不抛错**（坏标记不能变成新的致命原因）；
 *  - 清除失败不阻断已成功的启动。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearSafeModeMarker,
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
