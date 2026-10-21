/**
 * P1（2026-10-21，反证审查 D 的 C10/N6/N9）：「安全模式真的生效」这条端到端链路。
 *
 * 之前的测试只覆盖了 fatal-recovery 的候选计算与标记读写，**没有任何用例**证明
 * `prepareDesktopProfile` 会消费第 6 个参数、也没有用例覆盖"坏 plugin state 不该
 * 变成致命原因"。这里用真实的 profile（`ensureDesktopProfile`）与一个真实第三
 * 方 bundle（带 patch 行）走完整组合，判据取可观察结果：
 *  - 不带 safe-mode：第三方 bundle 的 patch 行出现在组合里；
 *  - 带 safe-mode：该行消失，但安装面层（carrier）仍在、组合不抛；
 *  - safe-mode 集合里混入安装面层时被过滤（不会把客户端变砖）；
 *  - 坏 state / 持久状态里的安装面包名被降级并写入 warnings。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDesktopProfile, prepareDesktopProfile } from '../src/profile.ts'

interface Manifest {
  readonly path: string
  readonly value: { dsh: { profile: { bundles: string[] } } }
}

const roots: string[] = []
const THIRD_PARTY = '@acme/composition-plugin'
const CARRIER = '@zeokeel/dsh-enterprise'

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'safe-mode-composition-'))
  roots.push(directory)
  return directory
}

function manifest(home: string): Manifest {
  const path = join(ensureDesktopProfile(home), 'package.json')
  return { path, value: JSON.parse(readFileSync(path, 'utf8')) as Manifest['value'] }
}

/**
 * Create a resolvable third-party bundle whose patch marks the settings row.
 *
 * 用「给已有行加 config」而不是「insert 一行 `name: pkg/host`」：后者的
 * `name` 在 `omitUnresolvedOptionalEntries` 里解析不到（bundle 包里没有 `/host`
 * 子路径），会被**静默丢弃**，于是"bundle 生效/被跳过"根本不可观察
 * （2026-10-21 反查：desktop-plugins.spec 的同类断言其实是空转的）。
 */
function installBundle(home: string, packageName: string): void {
  const profileDir = ensureDesktopProfile(home)
  const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: packageName,
    version: '1.2.3',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })}\n`)
  writeFileSync(join(packageDir, 'cordis.patch.yml'), [
    '- id: settings',
    '  config:',
    '    compositionMarker: true',
    '',
  ].join('\n'))
}

function addBundle(home: string, packageName: string): void {
  const found = manifest(home)
  found.value.dsh.profile.bundles.push(packageName)
  writeFileSync(found.path, `${JSON.stringify(found.value, undefined, 2)}\n`)
}

/** Whether the third-party bundle's patch survived into this composition. */
function hasCompositionMarker(prepared: Awaited<ReturnType<typeof prepareDesktopProfile>>): boolean {
  return prepared.patches.some(patch => {
    const config = (patch as { config?: unknown }).config
    return config !== null && typeof config === 'object'
      && (config as { compositionMarker?: unknown }).compositionMarker === true
  })
}

function statePath(rootDir: string): string {
  return join(rootDir, 'userData', 'plugin-management', 'state.json')
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('安全模式在组合层的真实消费', () => {
  it('不带 safe-mode 时第三方 bundle 的 patch 行在组合里', async () => {
    const home = join(root(), 'home')
    ensureDesktopProfile(home)
    installBundle(home, THIRD_PARTY)
    addBundle(home, THIRD_PARTY)
    const prepared = await prepareDesktopProfile(undefined, home, 'linux')
    expect(hasCompositionMarker(prepared)).toBe(true)
    expect(prepared.warnings).toEqual([])
  })

  it('带 safe-mode 时该行被跳过，但安装面 carrier 仍在（组合不抛）', async () => {
    const home = join(root(), 'home')
    ensureDesktopProfile(home)
    installBundle(home, THIRD_PARTY)
    addBundle(home, THIRD_PARTY)
    const prepared = await prepareDesktopProfile(
      undefined, home, 'linux', undefined, undefined, new Set([THIRD_PARTY]),
    )
    expect(hasCompositionMarker(prepared)).toBe(false)
    // carrier 层被跳过会让 prepareDesktopProfile 直接抛错，能走到这里即为判据。
    expect(prepared.profile.layers.some(layer => layer.packageName === CARRIER)).toBe(true)
  })

  it('safe-mode 集合里混入安装面层时被过滤：不会误禁 carrier', async () => {
    const home = join(root(), 'home')
    ensureDesktopProfile(home)
    const prepared = await prepareDesktopProfile(
      undefined, home, 'linux', undefined, undefined, new Set([CARRIER]),
    )
    expect(prepared.profile.layers.some(layer => layer.packageName === CARRIER)).toBe(true)
    expect(prepared.warnings).toEqual([])
  })

  it('坏 plugin state 被降级为 warnings，启动组合继续（N9）', async () => {
    const home = join(root(), 'home')
    ensureDesktopProfile(home)
    const pluginStatePath = statePath(root())
    mkdirSync(join(pluginStatePath, '..'), { recursive: true })
    writeFileSync(pluginStatePath, '{ broken json')
    const prepared = await prepareDesktopProfile(undefined, home, 'linux', pluginStatePath)
    expect(prepared.warnings.join('\n')).toContain('plugin-management state ignored')
  })

  it('持久状态里的安装面包名被过滤并记录（N2：旧版本/插件管理器写坏也不能变砖）', async () => {
    const home = join(root(), 'home')
    ensureDesktopProfile(home)
    installBundle(home, THIRD_PARTY)
    addBundle(home, THIRD_PARTY)
    const pluginStatePath = statePath(root())
    mkdirSync(join(pluginStatePath, '..'), { recursive: true })
    writeFileSync(pluginStatePath, `${JSON.stringify({
      version: 1,
      profiles: [{ profileName: 'desktop', disabledBundles: [CARRIER, THIRD_PARTY] }],
    })}\n`)
    const prepared = await prepareDesktopProfile(undefined, home, 'linux', pluginStatePath)
    // carrier 仍在（若被禁用会直接抛错），三方 bundle 仍被真正禁用。
    expect(prepared.profile.layers.some(layer => layer.packageName === CARRIER)).toBe(true)
    expect(hasCompositionMarker(prepared)).toBe(false)
    expect(prepared.warnings.join('\n')).toContain(`ignoring persisted disable outside the third-party set: ${CARRIER}`)
  })
})
