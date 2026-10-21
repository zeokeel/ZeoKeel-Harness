/**
 * P6（2026-10-22）：安装器载荷检查的判据。
 *
 * 真实环境里由 Linux/Windows CI 对一个真 Setup.exe 跑 7z 解包；这里用注入的
 * 解包结果覆盖判定逻辑本身（存在/为空/缺文件/无主程序），避免"CI 一红才发现"。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  findPayloadArchive,
  REQUIRED_PAYLOAD_FILES,
  resolveSevenZip,
  verifyInstallerPayload,
} from '../scripts/verify-win-installer-payload.mjs'

const INSTALLER = '/tmp/ZeoKeel-Harness-2.9.0-x64-Setup.exe'
const PAYLOAD_ARCHIVE = '$PLUGINSDIR/app-64.zip'
const GOOD_PAYLOAD = [
  'resources/LICENSE',
  'resources/THIRD_PARTY_NOTICES.md',
  'ZeoKeel Harness.exe',
]

/** A fake extractor: installer → payload archive, archive → payload files. */
function extractor(payloadFiles = GOOD_PAYLOAD): (zip: string, archive: string) => Promise<string[]> {
  return vi.fn(async (_zip: string, archive: string) => (
    archive === INSTALLER ? [PAYLOAD_ARCHIVE, 'other.bin'] : payloadFiles
  ))
}

describe('载荷归档定位', () => {
  it('匹配 app-64.zip / app-64.7z / app-x64.zip（任意目录）', () => {
    expect(findPayloadArchive(['a/b/app-64.zip'])).toBe('a/b/app-64.zip')
    expect(findPayloadArchive(['$PLUGINSDIR/app-64.7z'])).toBe('$PLUGINSDIR/app-64.7z')
    expect(findPayloadArchive(['$PLUGINSDIR/app-x64.zip'])).toBe('$PLUGINSDIR/app-x64.zip')
    expect(findPayloadArchive(['$PLUGINSDIR/app-32.zip', 'app-64.zip.bak'])).toBeUndefined()
  })

  it('默认 7z 命令可被 SEVEN_ZIP 覆盖；覆盖路径不存在时明确报错', () => {
    expect(resolveSevenZip({ PATH: '/usr/bin' }, () => false)).toBe('7z')
    expect(resolveSevenZip({ SEVEN_ZIP: '/opt/7z' }, path => path === '/opt/7z')).toBe('/opt/7z')
    expect(() => resolveSevenZip({ SEVEN_ZIP: '/missing/7z' }, () => false)).toThrow(/SEVEN_ZIP/u)
  })
})

describe('安装器载荷内容', () => {
  it('两份许可证声明与应用主程序都在时通过', async () => {
    const result = await verifyInstallerPayload(INSTALLER, {
      sevenZip: '7z',
      staging: '/tmp/fake-staging',
      extract: extractor(),
      size: () => 1024,
      cleanup: () => {},
    })
    expect(result.payloadArchive).toBe(PAYLOAD_ARCHIVE)
    expect(result.files).toEqual(REQUIRED_PAYLOAD_FILES)
  })

  it('缺少任一声明时失败并点名缺失文件', async () => {
    await expect(verifyInstallerPayload(INSTALLER, {
      sevenZip: '7z',
      staging: '/tmp/fake-staging',
      extract: extractor(['resources/LICENSE', 'ZeoKeel Harness.exe']),
      size: () => 1024,
      cleanup: () => {},
    })).rejects.toThrow(/missing resources\/THIRD_PARTY_NOTICES\.md/u)
  })

  it('声明文件为空时失败', async () => {
    await expect(verifyInstallerPayload(INSTALLER, {
      sevenZip: '7z',
      staging: '/tmp/fake-staging',
      extract: extractor(),
      size: (path: string) => (path.endsWith('LICENSE') ? 0 : 1024),
      cleanup: () => {},
    })).rejects.toThrow(/empty resources\/LICENSE/u)
  })

  it('没有载荷归档或没有应用主程序时失败', async () => {
    await expect(verifyInstallerPayload(INSTALLER, {
      sevenZip: '7z',
      staging: '/tmp/fake-staging',
      extract: vi.fn(async (_zip: string, archive: string) => (
        archive === INSTALLER ? ['uninstaller.bin'] : []
      )),
      size: () => 1024,
      cleanup: () => {},
    })).rejects.toThrow(/payload archive .* not found/u)

    await expect(verifyInstallerPayload(INSTALLER, {
      sevenZip: '7z',
      staging: '/tmp/fake-staging',
      extract: extractor(['resources/LICENSE', 'resources/THIRD_PARTY_NOTICES.md']),
      size: () => 1024,
      cleanup: () => {},
    })).rejects.toThrow(/application executable/u)
  })

  it('无论成功失败都清理暂存目录', async () => {
    const cleanup = vi.fn()
    await verifyInstallerPayload(INSTALLER, {
      sevenZip: '7z',
      staging: '/tmp/fake-staging',
      extract: extractor(),
      size: () => 1024,
      cleanup,
    })
    expect(cleanup).toHaveBeenCalledOnce()

    const cleanupAfterFailure = vi.fn()
    await expect(verifyInstallerPayload(INSTALLER, {
      sevenZip: '7z',
      staging: '/tmp/fake-staging',
      extract: extractor(['resources/LICENSE']),
      size: () => 1024,
      cleanup: cleanupAfterFailure,
    })).rejects.toThrow()
    expect(cleanupAfterFailure).toHaveBeenCalledOnce()
  })
})
