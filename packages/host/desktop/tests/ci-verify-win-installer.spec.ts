/**
 * P6（2026-10-22）：CI 安装器门禁脚本的入口判据。
 *
 * 真正的行为检查在 `verify-win-installer-payload/runtime.mjs`（各自有 spec）；
 * 这里只钉"从官方 staging 目录挑出唯一的 Setup 产物"这条入口，防止脚本在空目录上
 * 静默通过或被别的 exe 顶替。
 */
import { describe, expect, it } from 'vitest'
import { findOfficialInstaller, OFFICIAL_STAGING_DIR } from '../scripts/ci-verify-win-installer.mjs'

describe('CI 安装器门禁入口', () => {
  it('默认 staging 目录是 client-assets/official', () => {
    expect(OFFICIAL_STAGING_DIR.replace(/\\/gu, '/')).toBe('client-assets/official')
  })

  it('挑出 *Setup*.exe（忽略其它文件，多个时取排序后的第一个）', () => {
    const found = findOfficialInstaller('client-assets/official', () => [
      'ZeoKeel-Harness-2.9.0-x64-Setup.exe',
      'ZeoKeel-Harness-2.8.3-x64-Setup.exe',
      'notes.txt',
      'portable.zip',
    ])
    expect(found.replace(/\\/gu, '/')).toBe('client-assets/official/ZeoKeel-Harness-2.8.3-x64-Setup.exe')
  })

  it('没有任何 Setup 产物时明确失败（绝不静默通过）', () => {
    expect(() => findOfficialInstaller('client-assets/official', () => ['notes.txt']))
      .toThrow(/no official installer/u)
  })
})
