/**
 * P1（2026-10-21 反证审查 D 的 K8）：迁移垫片的**内容合同**。
 *
 * `package.json` 里只写 `include: "scripts/installer-shim.nsh"` 不等于垫片可用：
 * 把 `!macro customInit` 注释掉、读错注册表键、忘了 Quit，全套测试都保持绿。
 * 这里把"用户从 2.8.x 全局安装升级时必须被拦住"这条策略钉在文件内容上。
 *
 * 真正的行为验证（旧 per-machine 布局下 `/S` 安装必须停下）需要 Windows 主机，
 * 属于发布验收的残余边界（见 README 的兼容说明）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const shimPath = fileURLToPath(new URL('scripts/installer-shim.nsh', packageRoot))
const shim = readFileSync(shimPath, 'utf8')
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  build?: { nsis?: { include?: unknown, oneClick?: unknown, perMachine?: unknown } }
}

describe('安装器迁移垫片（scripts/installer-shim.nsh）', () => {
  it('文件存在，且被 nsis.include 真正引用（one-click + per-user 组合）', () => {
    expect(existsSync(shimPath)).toBe(true)
    expect(manifest.build?.nsis?.include).toBe('scripts/installer-shim.nsh')
    expect(manifest.build?.nsis?.oneClick).toBe(true)
    expect(manifest.build?.nsis?.perMachine).toBe(false)
  })

  it('customInit 同时读当前与改名前的 GUID（HKLM + HKCU）', () => {
    expect(shim).toContain('!macro customInit')
    // 当前产品 per-machine
    expect(shim).toContain('ReadRegStr $1 HKLM "Software\\${APP_GUID}" "InstallLocation"')
    // 改名前的 PicoAide（真实存量版本用的 appId 派生 GUID）
    expect(shim).toContain('!define ZK_LEGACY_APP_GUID "85820364-4c28-594e-b046-8896b3669248"')
    expect(shim).toContain('ReadRegStr $1 HKLM "Software\\${ZK_LEGACY_APP_GUID}" "InstallLocation"')
    expect(shim).toContain('ReadRegStr $1 HKCU "Software\\${ZK_LEGACY_APP_GUID}" "InstallLocation"')
    // 没有命中时必须继续安装，而不是无条件中止。
    expect(shim).toContain('Goto zk_no_legacy_install')
  })

  it('命中后写诊断 + 非零退出码；静默模式不弹框也不阻塞', () => {
    expect(shim).toContain('zeokeel-harness-legacy-install.txt')
    expect(shim).toContain('FileWrite')
    // 静默更新必须直接走 abort 标签，否则 NSIS 会弹框并永久挂住无人值守更新。
    expect(shim).toContain('IfSilent zk_legacy_abort')
    expect(shim).toContain('SetErrorLevel 2')
    // 诊断先写、再决定是否弹框、最后 Quit。
    const fileWrite = shim.indexOf('FileWrite')
    const silentBranch = shim.indexOf('IfSilent zk_legacy_abort')
    const dialog = shim.indexOf('MessageBox MB_ICONEXCLAMATION|MB_OK')
    const quit = shim.indexOf('Quit')
    expect(silentBranch).toBeGreaterThan(fileWrite)
    expect(dialog).toBeGreaterThan(silentBranch)
    expect(quit).toBeGreaterThan(dialog)
    expect(shim).toContain('Uninstall it first')
  })
})
