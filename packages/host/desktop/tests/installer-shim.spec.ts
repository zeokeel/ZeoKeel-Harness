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

  it('customInit 读旧的 per-machine 注册表项（与 electron-builder 写入面一致）', () => {
    expect(shim).toContain('!macro customInit')
    expect(shim).toContain('ReadRegStr $0 HKLM "Software\\${APP_GUID}" "InstallLocation"')
    // 没有命中时必须继续安装，而不是无条件中止。
    expect(shim).toMatch(/StrCmp \$0 "" zk_no_legacy_install/)
  })

  it('命中后写诊断、可见提示并退出（绝不静默装出第二份）', () => {
    expect(shim).toContain('zeokeel-harness-legacy-install.txt')
    expect(shim).toContain('FileWrite')
    expect(shim).toContain('MessageBox MB_ICONEXCLAMATION|MB_OK')
    expect(shim).toContain('Quit')
    // Quit 必须在提示之后：顺序反了用户什么都看不到。
    expect(shim.indexOf('Quit')).toBeGreaterThan(shim.indexOf('MessageBox MB_ICONEXCLAMATION|MB_OK'))
  })
})
