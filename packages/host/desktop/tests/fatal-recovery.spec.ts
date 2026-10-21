/**
 * P1（2026-10-21）：致命启动失败的**恢复出口**。
 *
 * `fatal-boot` 给出的「安全模式」与「备份补丁」两个出口，必须能在 profile 本身
 * 才是故障原因的时候工作 —— 因此它们只做文件操作：不加载 profile、不解析 patch
 * YAML、不依赖 Electron。这里逐条钉住可观察行为：
 *  1. 备份是**移动**（原文件消失、内容留在 `.bak-<时间戳>`），不删除用户数据；
 *  2. 安全模式只禁用**可变**（第三方）bundle，launcher 自有层不动；
 *  3. 插件状态是**合并**写入：其它 profile 的禁用集合逐字保留；
 *  4. profile 清单坏掉时仍然备份补丁，并如实报告，而不是让恢复本身抛错。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupProfilePatch,
  desktopProfileDirectory,
  enterFatalSafeMode,
  profilePatchPath,
  readProfileBundleNames,
  type FatalRecoveryTargets,
} from '../src/fatal-recovery.ts'

const roots: string[] = []

/** Immutable launcher-owned bundle (never disabled by safe mode). */
const CORE = '@deepseek-ai/dsh-desktop-app'
/** Third-party bundle a user installed into the profile. */
const THIRD_PARTY = '@acme/third-party-bundle'

/** Build an isolated home + plugin-state path. */
function sandbox(): FatalRecoveryTargets {
  const root = mkdtempSync(join(tmpdir(), 'fatal-recovery-'))
  roots.push(root)
  const homeDir = join(root, 'home')
  mkdirSync(homeDir, { recursive: true })
  return {
    homeDir,
    profileName: 'desktop',
    statePath: join(root, 'userData', 'plugin-management', 'state.json'),
  }
}

/** Write the profile manifest that lists the profile's direct bundles. */
function writeManifest(targets: FatalRecoveryTargets, bundles: readonly string[]): void {
  const directory = desktopProfileDirectory(targets)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: 'desktop', dsh: { profile: { bundles } } }, undefined, 2)}\n`)
}

/** Write the user-editable patch the recovery is expected to move aside. */
function writePatch(targets: FatalRecoveryTargets, content: string): string {
  const path = profilePatchPath(targets)
  writeFileSync(path, content)
  return path
}

/** Read the persisted disabled sets, keyed by profile name. */
function readState(targets: FatalRecoveryTargets): Record<string, string[]> {
  const parsed = JSON.parse(readFileSync(targets.statePath, 'utf8')) as {
    profiles: { profileName: string, disabledBundles: string[] }[]
  }
  return Object.fromEntries(parsed.profiles.map(profile => [profile.profileName, profile.disabledBundles]))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('恢复路径与备份', () => {
  it('profile 目录固定在 <home>/profiles/<name>，补丁是目录下的 cordis.patch.yml', () => {
    const targets = sandbox()
    expect(desktopProfileDirectory(targets)).toBe(join(targets.homeDir, 'profiles', 'desktop'))
    expect(profilePatchPath(targets)).toBe(join(targets.homeDir, 'profiles', 'desktop', 'cordis.patch.yml'))
  })

  it('没有补丁时不备份（返回 undefined，不创建文件）', () => {
    const targets = sandbox()
    expect(backupProfilePatch(profilePatchPath(targets))).toBeUndefined()
    expect(existsSync(profilePatchPath(targets))).toBe(false)
  })

  it('备份是移动：原路径消失、备份内容逐字保留，二次备份不覆盖第一次', () => {
    const targets = sandbox()
    writeManifest(targets, [CORE])
    const patch = writePatch(targets, '- insert:\n    - id: user-row\n')
    const first = backupProfilePatch(patch, new Date('2026-10-21T12:00:00.000Z'))
    expect(first).toBe(`${patch}.bak-2026-10-21T12-00-00-000Z`)
    expect(existsSync(patch)).toBe(false)
    expect(readFileSync(first as string, 'utf8')).toBe('- insert:\n    - id: user-row\n')
    expect(backupProfilePatch(patch)).toBeUndefined()

    writePatch(targets, '- insert:\n    - id: second\n')
    const second = backupProfilePatch(patch, new Date('2026-10-21T12:00:00.000Z'))
    expect(second).not.toBe(first)
    expect(readFileSync(second as string, 'utf8')).toBe('- insert:\n    - id: second\n')
  })

  it('清单只读 dsh.profile.bundles；缺失返回空数组，类型错误则报错', () => {
    const targets = sandbox()
    writeManifest(targets, [CORE, THIRD_PARTY])
    expect(readProfileBundleNames(desktopProfileDirectory(targets))).toEqual([CORE, THIRD_PARTY])

    writeFileSync(join(desktopProfileDirectory(targets), 'package.json'), '{"name":"desktop"}\n')
    expect(readProfileBundleNames(desktopProfileDirectory(targets))).toEqual([])

    writeFileSync(join(desktopProfileDirectory(targets), 'package.json'), '{"dsh":{"profile":{"bundles":"nope"}}}\n')
    expect(() => readProfileBundleNames(desktopProfileDirectory(targets))).toThrow(/dsh\.profile\.bundles/u)
  })
})

describe('安全模式', () => {
  it('备份补丁 + 只禁用第三方 bundle，且合并其它 profile 的禁用集合', async () => {
    const targets = sandbox()
    writeManifest(targets, [CORE, THIRD_PARTY])
    writePatch(targets, '- insert: []\n')
    // 先写一份"别的 profile 已经禁用了一个包"的状态：合并写不能把它冲掉。
    mkdirSync(join(targets.statePath, '..'), { recursive: true })
    writeFileSync(targets.statePath, `${JSON.stringify({
      version: 1,
      profiles: [{ profileName: 'other', disabledBundles: ['@acme/kept-disabled'] }],
    }, undefined, 2)}\n`)

    const report = await enterFatalSafeMode(targets, new Date('2026-10-21T12:00:00.000Z'))
    expect(report.backupPath).toBe(`${profilePatchPath(targets)}.bak-2026-10-21T12-00-00-000Z`)
    expect(existsSync(profilePatchPath(targets))).toBe(false)
    expect(report.disabledBundles).toEqual([THIRD_PARTY])
    expect(report.manifestError).toBeUndefined()
    expect(readState(targets)).toEqual({
      desktop: [THIRD_PARTY],
      other: ['@acme/kept-disabled'],
    })
  })

  it('重复执行幂等：已禁用的不重复、已备份的不再产生第二个备份', async () => {
    const targets = sandbox()
    writeManifest(targets, [CORE, THIRD_PARTY])
    writePatch(targets, '- insert: []\n')
    await enterFatalSafeMode(targets)
    const second = await enterFatalSafeMode(targets)
    expect(second.backupPath).toBeUndefined()
    expect(readState(targets).desktop).toEqual([THIRD_PARTY])
  })

  it('清单坏掉时仍然备份补丁，并如实报告原因', async () => {
    const targets = sandbox()
    const directory = desktopProfileDirectory(targets)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), '{ not json')
    writePatch(targets, '- insert: []\n')

    const report = await enterFatalSafeMode(targets)
    expect(report.backupPath).toBeDefined()
    expect(existsSync(report.backupPath as string)).toBe(true)
    expect(report.disabledBundles).toEqual([])
    expect(report.manifestError).toContain('JSON')
    // 没有可禁用的 bundle 时不写状态文件（避免把"清单读不到"变成一次空写入）。
    expect(existsSync(targets.statePath)).toBe(false)
  })
})
