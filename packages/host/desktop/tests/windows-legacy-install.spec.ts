/**
 * P2（2026-10-21 打包反证）：改名前的 PicoAide 安装检测。
 *
 * 已发布的 2.8.x 用的 appId 与当前不同 ⇒ NSIS GUID 不同 ⇒ 安装器自己的 legacy
 * 检测面看不到它们。应用在交接安装包**之前**查一次注册表，就能弹原生框并且不退出
 * （安装器静默模式只能 exit 2，用户什么都看不到）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  findLegacyWindowsInstall,
  LEGACY_WINDOWS_APP_GUID,
  parseRegQueryInstallLocation,
} from '../src/windows-legacy-install.ts'

const HKLM = `HKLM\\Software\\${LEGACY_WINDOWS_APP_GUID}`
const HKCU = `HKCU\\Software\\${LEGACY_WINDOWS_APP_GUID}`
const REG_OUTPUT = `\r\nHKEY_LOCAL_MACHINE\\Software\\${LEGACY_WINDOWS_APP_GUID}\r\n    InstallLocation    REG_SZ    C:\\Program Files\\PicoAide Harness\r\n\r\n`

describe('注册表输出解析', () => {
  it('提取 InstallLocation 的值（含空格路径）', () => {
    expect(parseRegQueryInstallLocation(REG_OUTPUT)).toBe('C:\\Program Files\\PicoAide Harness')
  })

  it('空值/缺失时返回 undefined', () => {
    expect(parseRegQueryInstallLocation('')).toBeUndefined()
    expect(parseRegQueryInstallLocation('    InstallLocation    REG_SZ    \r\n')).toBeUndefined()
    expect(parseRegQueryInstallLocation('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined()
  })
})

describe('改名前安装检测', () => {
  it('HKLM 命中时返回注册表路径与安装目录', async () => {
    const run = vi.fn(async () => REG_OUTPUT)
    await expect(findLegacyWindowsInstall(run, 'C:\\Windows')).resolves.toEqual({
      registryPath: HKLM,
      installLocation: 'C:\\Program Files\\PicoAide Harness',
    })
    expect(run).toHaveBeenCalledWith('C:\\Windows\\System32\\reg.exe', ['query', HKLM, '/v', 'InstallLocation'])
  })

  it('HKLM 未命中时检查 HKCU（旧的按用户安装）', async () => {
    const run = vi.fn(async (file: string, args: readonly string[]) => {
      void file
      if (args[1] === HKLM) throw new Error('not found')
      return REG_OUTPUT.replace('HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER')
    })
    await expect(findLegacyWindowsInstall(run, 'C:\\Windows')).resolves.toMatchObject({ registryPath: HKCU })
  })

  it('两个键都不存在/都报错时返回 undefined（不是致命错误）', async () => {
    const run = vi.fn(async () => { throw new Error('reg.exe missing') })
    await expect(findLegacyWindowsInstall(run, 'C:\\Windows')).resolves.toBeUndefined()
  })
})
