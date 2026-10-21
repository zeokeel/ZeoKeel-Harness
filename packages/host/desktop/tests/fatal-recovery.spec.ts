/**
 * P1（2026-10-21，反证审查后重写）：致命启动失败的**恢复出口**。
 *
 * 2026-10-21 的四路反证（安全 / 状态 / 测试 / 打包）打穿了第一版设计：
 * 「安全模式」把安装面自有的 17 个 bundle（含 `@zeokeel/dsh-enterprise`）当成第三方
 * 写进持久禁用集合，下一次组合必抛 "missing the @zeokeel/dsh-enterprise bundle
 * layer" —— 一键把客户端变成永久起不来，而桌面组合里根本没有"重新启用"入口。
 *
 * 现在的语义（本文件钉住的判据）：
 *  1. 安全模式只写**一次性标记**（component: desktop-safe-mode.ts），启动成功即清；
 *  2. 只筛「可变 且 不属于安装面」的 bundle —— 安装面层被筛掉必然启动环；
 *  3. 先写标记、再搬补丁：标记写失败时补丁原样不动（不留半成品）；
 *  4. 两个用户补丁（profile 与 `$DSH_HOME`）都要备份：home 补丁同样会抛死；
 *  5. 「备份补丁」无事可做时必须报错，绝不"成功重启"骗用户。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupProfilePatch,
  desktopProfileDirectory,
  enterFatalSafeMode,
  homePatchPath,
  performFatalRecovery,
  profilePatchPath,
  readProfileBundleNames,
  safeModeCandidates,
  type FatalRecoveryTargets,
} from '../src/fatal-recovery.ts'
import { readSafeModeBundles } from '../src/desktop-safe-mode.ts'
import { desktopInstallationBundle, effectiveDisabledBundles, ensureDesktopProfile } from '../src/profile.ts'

const roots: string[] = []

/** Launcher-owned carrier layer: filtering it guarantees a boot loop. */
const CARRIER = '@zeokeel/dsh-enterprise'
/** Bundled feature module: installation-owned as well. */
const FEATURE = '@zeokeel/dsh-browser'
/** Immutable upstream layer. */
const IMMUTABLE = '@deepseek-ai/dsh-desktop-app'
/** Third-party bundle a user installed (the only safe-mode target). */
const THIRD_PARTY = '@acme/third-party-bundle'
/** Second third-party bundle, to prove sorting/dedup. */
const THIRD_PARTY_B = '@acme/another-bundle'

/** Isolated home + plugin-management directory. */
function sandbox(): FatalRecoveryTargets {
  const root = mkdtempSync(join(tmpdir(), 'fatal-recovery-'))
  roots.push(root)
  const homeDir = join(root, 'home')
  mkdirSync(homeDir, { recursive: true })
  return {
    homeDir,
    profileName: 'desktop',
    safeModePath: join(root, 'userData', 'plugin-management', 'safe-mode.json'),
  }
}

/** Write the profile manifest that lists direct bundles. */
function writeManifest(targets: FatalRecoveryTargets, bundles: readonly string[]): void {
  const directory = desktopProfileDirectory(targets)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: 'desktop', dsh: { profile: { bundles } } }, undefined, 2)}\n`)
}

/** Write a user patch at the given path. */
function writePatch(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

/** Marker contents as a sorted list. */
function markerBundles(targets: FatalRecoveryTargets): string[] {
  return [...readSafeModeBundles(targets.safeModePath).bundles].sort()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('恢复路径与备份', () => {
  it('profile 目录固定在 <home>/profiles/<name>，两个补丁分别是 profile 内与 home 根', () => {
    const targets = sandbox()
    expect(desktopProfileDirectory(targets)).toBe(join(targets.homeDir, 'profiles', 'desktop'))
    expect(profilePatchPath(targets)).toBe(join(targets.homeDir, 'profiles', 'desktop', 'cordis.patch.yml'))
    expect(homePatchPath(targets)).toBe(join(targets.homeDir, 'cordis.patch.yml'))
  })

  it('没有补丁时备份返回 undefined（不创建文件），重名时追加序号且不覆盖', () => {
    const targets = sandbox()
    expect(backupProfilePatch(profilePatchPath(targets))).toBeUndefined()

    const patch = profilePatchPath(targets)
    writePatch(patch, 'first\n')
    const first = backupProfilePatch(patch, new Date('2026-10-21T12:00:00.000Z'))
    expect(first).toBe(`${patch}.bak-2026-10-21T12-00-00-000Z`)
    expect(readFileSync(first as string, 'utf8')).toBe('first\n')

    writePatch(patch, 'second\n')
    const second = backupProfilePatch(patch, new Date('2026-10-21T12:00:00.000Z'))
    expect(second).not.toBe(first)
    expect(readFileSync(second as string, 'utf8')).toBe('second\n')
    expect(readFileSync(first as string, 'utf8')).toBe('first\n')
  })

  it('清单只读 dsh.profile.bundles；缺失返回空数组，类型错误报错', () => {
    const targets = sandbox()
    writeManifest(targets, [CARRIER, THIRD_PARTY])
    expect(readProfileBundleNames(desktopProfileDirectory(targets))).toEqual([CARRIER, THIRD_PARTY])

    writeFileSync(join(desktopProfileDirectory(targets), 'package.json'), '{"name":"desktop"}\n')
    expect(readProfileBundleNames(desktopProfileDirectory(targets))).toEqual([])

    writeFileSync(join(desktopProfileDirectory(targets), 'package.json'), '{"dsh":{"profile":{"bundles":"nope"}}}\n')
    expect(() => readProfileBundleNames(desktopProfileDirectory(targets))).toThrow(/dsh\.profile\.bundles/u)
  })

  it('安全模式候选只包含三方包：安装面层与 immutable 层一律排除（2026-10-21 P0 回归）', () => {
    expect(safeModeCandidates([CARRIER, FEATURE, IMMUTABLE, THIRD_PARTY, THIRD_PARTY_B, THIRD_PARTY]))
      .toEqual([THIRD_PARTY_B, THIRD_PARTY])
    // 真实调用方：安装面层名单来自 profile.ts（渠道裁剪与否都在集合里）。
    expect(safeModeCandidates([CARRIER])).toEqual([])
  })
})

describe('真实 profile 数据面（2026-10-21 P0 回归）', () => {
  it('真实清单里安装面 bundle 存在，且安全模式候选与它们永久无交集', () => {
    const targets = sandbox()
    ensureDesktopProfile(targets.homeDir)
    const bundles = readProfileBundleNames(desktopProfileDirectory(targets))
    // 真实 profile 至少包含十条自有层之一；没有它这个回归测试就失去意义。
    expect(bundles).toContain(CARRIER)
    const installation = bundles.filter(name => desktopInstallationBundle(name))
    expect(installation).toContain(CARRIER)
    const candidates = safeModeCandidates(bundles)
    for (const name of candidates) {
      expect(installation, `${name} 属于安装面，安全模式不得禁用`).not.toContain(name)
    }
  })

  it('组合消费侧的并集过滤：安全模式集合里的安装面层会被剔除', () => {
    const persistent = new Set(['@acme/old-disabled', IMMUTABLE])
    const safeMode = new Set([CARRIER, FEATURE, IMMUTABLE, THIRD_PARTY])
    // 两侧都过滤：persistent 里的 immutable 层同样不得生效（R3-4）。
    expect([...effectiveDisabledBundles(persistent, safeMode)].sort())
      .toEqual(['@acme/old-disabled', THIRD_PARTY])
  })
})

describe('安全模式（一次性标记）', () => {
  it('只写标记：不动两个用户补丁（安全模式不替用户改设置），也不写插件持久状态', async () => {
    const targets = sandbox()
    writeManifest(targets, [CARRIER, FEATURE, IMMUTABLE, THIRD_PARTY, THIRD_PARTY_B])
    writePatch(profilePatchPath(targets), '- insert: []\n')
    writePatch(homePatchPath(targets), '- insert: []\n')

    const report = await enterFatalSafeMode(targets, new Date('2026-10-21T12:00:00.000Z'))
    expect(report.disabledBundles).toEqual([THIRD_PARTY_B, THIRD_PARTY])
    expect(report.backupPath).toBeUndefined()
    expect(report.homeBackupPath).toBeUndefined()
    // 用户的设置补丁（含 home 补丁）必须原地不动（反证审查 A 的 R2-5）。
    expect(readFileSync(profilePatchPath(targets), 'utf8')).toBe('- insert: []\n')
    expect(readFileSync(homePatchPath(targets), 'utf8')).toBe('- insert: []\n')
    expect(markerBundles(targets)).toEqual([THIRD_PARTY_B, THIRD_PARTY])

    // 插件持久状态（plugin-management/state.json）不该被安全模式碰过。
    const statePath = join(targets.safeModePath, '..', 'state.json')
    expect(existsSync(statePath)).toBe(false)
    // 标记文件是私有的（0600），目录 0700 —— 与 plugin state 同一档。
    expect(statSync(targets.safeModePath).mode & 0o777).toBe(0o600)
    expect(statSync(join(targets.safeModePath, '..')).mode & 0o777).toBe(0o700)
  })

  it('标记写失败时直接报错：不产生任何半成品（补丁本来就只在另一个出口搬）', async () => {
    const targets = sandbox()
    writeManifest(targets, [CARRIER, THIRD_PARTY])
    writePatch(profilePatchPath(targets), '- insert: []\n')
    // 让 plugin-management 的父路径是一个普通文件 ⇒ 建目录/写标记必失败。
    mkdirSync(join(targets.safeModePath, '..', '..'), { recursive: true })
    writeFileSync(join(targets.safeModePath, '..'), 'not a directory')

    await expect(enterFatalSafeMode(targets)).rejects.toThrow()
    expect(existsSync(profilePatchPath(targets))).toBe(true)
    expect(readFileSync(profilePatchPath(targets), 'utf8')).toBe('- insert: []\n')
  })

  it('清单坏掉时不动任何文件并如实报告（performFatalRecovery 抛错⇒调用方非零退出）', async () => {
    const targets = sandbox()
    mkdirSync(desktopProfileDirectory(targets), { recursive: true })
    writeFileSync(join(desktopProfileDirectory(targets), 'package.json'), '{ not json')
    writePatch(profilePatchPath(targets), '- insert: []\n')

    const report = await enterFatalSafeMode(targets)
    expect(report.manifestError).toContain('JSON')
    expect(existsSync(profilePatchPath(targets))).toBe(true)
    expect(existsSync(targets.safeModePath)).toBe(false)

    await expect(performFatalRecovery('safe-mode', targets)).rejects.toThrow(/cannot read the profile manifest/u)
  })

  it('没有三方包时退化为备份用户补丁（安全模式不能是死胡同，R2-4）', async () => {
    const targets = sandbox()
    writeManifest(targets, [CARRIER, FEATURE, IMMUTABLE])
    writePatch(profilePatchPath(targets), '- insert: []\n')

    const report = await performFatalRecovery('safe-mode', targets)
    expect(report.disabledBundles).toEqual([])
    expect(report.degradedToPatchBackup).toBe(true)
    expect(report.backupPath).toBeDefined()
    expect(existsSync(targets.safeModePath)).toBe(false)
    expect(existsSync(profilePatchPath(targets))).toBe(false)

    // 既无三方包、也没有任何补丁可搬时才算失败（并且绝不假成功）。
    const empty = sandbox()
    writeManifest(empty, [CARRIER])
    mkdirSync(desktopProfileDirectory(empty), { recursive: true })
    await expect(performFatalRecovery('safe-mode', empty)).rejects.toThrow(/nothing to back up/u)
  })

  it('重复进入幂等：补丁已搬走时只重写标记，不报错', async () => {
    const targets = sandbox()
    writeManifest(targets, [CARRIER, THIRD_PARTY])
    writePatch(profilePatchPath(targets), '- insert: []\n')

    const first = await enterFatalSafeMode(targets)
    const second = await enterFatalSafeMode(targets)
    expect(first.disabledBundles).toEqual([THIRD_PARTY])
    expect(second.disabledBundles).toEqual([THIRD_PARTY])
    expect(first.backupPath).toBeUndefined()
    expect(markerBundles(targets)).toEqual([THIRD_PARTY])
  })
})

describe('备份补丁动作', () => {
  it('两个补丁都备份；都没有时报错（绝不"成功重启"骗用户）', async () => {
    const targets = sandbox()
    writePatch(profilePatchPath(targets), '- insert: []\n')
    writePatch(homePatchPath(targets), '- insert: []\n')
    const report = await performFatalRecovery('backup-patch', targets)
    expect(report.backupPath).toBeDefined()
    expect(report.homeBackupPath).toBeDefined()
    expect(existsSync(profilePatchPath(targets))).toBe(false)
    expect(existsSync(homePatchPath(targets))).toBe(false)

    const empty = sandbox()
    mkdirSync(desktopProfileDirectory(empty), { recursive: true })
    await expect(performFatalRecovery('backup-patch', empty)).rejects.toThrow(/nothing to back up/u)
  })
})


describe('补丁形态与备份名额', () => {
  it('补丁是目录或符号链接时拒绝"备份"（避免假装搬走了设置）', async () => {
    const targets = sandbox()
    mkdirSync(profilePatchPath(targets), { recursive: true })
    expect(() => backupProfilePatch(profilePatchPath(targets))).toThrow(/not a patch file/u)

    const second = sandbox()
    mkdirSync(desktopProfileDirectory(second), { recursive: true })
    writeFileSync(join(desktopProfileDirectory(second), 'real.yml'), '- insert: []\n')
    symlinkSync(join(desktopProfileDirectory(second), 'real.yml'), profilePatchPath(second))
    // 符号链接可以被整体搬走（链接目标原地不动）：拒绝它会让两个恢复出口都死胡同（R3-5）。
    const backup = backupProfilePatch(profilePatchPath(second))
    expect(backup).toBeDefined()
    expect(existsSync(profilePatchPath(second))).toBe(false)
    expect(existsSync(join(desktopProfileDirectory(second), 'real.yml'))).toBe(true)
  })

  it('100 个备份名耗尽时明确报错，不无限循环', () => {
    const targets = sandbox()
    writePatch(profilePatchPath(targets), '- insert: []\n')
    const now = new Date('2026-10-21T12:00:00.000Z')
    const stamp = '2026-10-21T12-00-00-000Z'
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${String(attempt)}`
      writeFileSync(`${profilePatchPath(targets)}.bak-${stamp}${suffix}`, 'occupied')
    }
    expect(() => backupProfilePatch(profilePatchPath(targets), now)).toThrow(/no free backup name/u)
    // 原补丁仍在（失败不产生半成品）。
    expect(existsSync(profilePatchPath(targets))).toBe(true)
  })

  it('performFatalRecovery 的 safe-mode 成功路径返回报告（含备份与禁用清单）', async () => {
    const targets = sandbox()
    writeManifest(targets, [CARRIER, THIRD_PARTY])
    writePatch(profilePatchPath(targets), '- insert: []\n')
    const report = await performFatalRecovery('safe-mode', targets, new Date('2026-10-21T12:00:00.000Z'))
    expect(report.disabledBundles).toEqual([THIRD_PARTY])
    expect(report.backupPath).toBeUndefined()
    expect(markerBundles(targets)).toEqual([THIRD_PARTY])
  })
})


describe('重复安全模式失败后的升级（R3-1）', () => {
  it('上一跳安全模式没救回来时：同时备份补丁并标记 escalated', async () => {
    const targets = sandbox()
    writeManifest(targets, [CARRIER, THIRD_PARTY])
    writePatch(profilePatchPath(targets), '- insert: []\n')
    // 第一次：写 marker，成功返回（不改补丁）。
    const first = await performFatalRecovery('safe-mode', targets)
    expect(first.disabledBundles).toEqual([THIRD_PARTY])
    expect(first.escalated).toBeUndefined()
    expect(existsSync(profilePatchPath(targets))).toBe(true)
    // 第二次（标记仍在 ⇒ 上一次启动仍失败）：升级为同时备份补丁。
    const second = await performFatalRecovery('safe-mode', targets)
    expect(second.escalated).toBe(true)
    expect(second.backupPath).toBeDefined()
    expect(existsSync(profilePatchPath(targets))).toBe(false)
    expect(markerBundles(targets)).toEqual([THIRD_PARTY])
  })

  it('上一跳失败且没有任何补丁可备份时明确报错（不再假装成功）', async () => {
    const targets = sandbox()
    writeManifest(targets, [CARRIER, THIRD_PARTY])
    await performFatalRecovery('safe-mode', targets)
    await expect(performFatalRecovery('safe-mode', targets)).rejects.toThrow(/nothing to back up/u)
  })
})
