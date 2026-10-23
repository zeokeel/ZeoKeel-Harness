/**
 * TS7 编译器口径（2026-10-23）：**每个 workspace 包在 yarn 脚本里跑到的 `tsc` 都必须是
 * TypeScript 7 原生编译器**；需要 TS6 编译器 API 的包另挂 `typescript6` 别名。
 *
 * ## 为什么这条需要判据
 *
 * TS7 只当 **CLI** 用：`typescript@7` 的 `exports["."]` 只剩 `{version, versionMajorMinor}`
 * （编译器 API 挪到 `typescript/unstable/*`，且**没有**"从源码文本解析成 AST"的入口 ——
 * `createSourceFile` 是工厂建节点，`createProgram` 根本不在面内）。而本仓有 10 个守卫 spec
 * 用 `ts.createSourceFile` / `forEachChild` / `createProgram` + `CompilerHost` 那套 TS6 API。
 * 两者共存的形态是：
 *
 *   · 每个包 `typescript: 7.0.2` —— yarn 脚本里的 `tsc` 解析到 7；
 *   · 有 API 消费者的包再挂 `typescript6: npm:typescript@6.0.3`，spec 从它 import。
 *
 * **关键且隐式的一点**：同一个包里"名为 `typescript` 的依赖"和别名都提供名为 `tsc` 的 bin 时，
 * yarn 的脚本 shim 选出的是 **dependency 名为 `typescript` 的那一个**（2026-10-23 用独立
 * yarn 工程实测：`typescript@6 + typescript7@npm:7.0.2` ⇒ 脚本里 `tsc --version` = 6.0.3；
 * `typescript@7 + typescript6@npm:6.0.3` ⇒ 7.0.2）。这条约定**不写在任何 manifest 里**，
 * 一旦有人把 6 写回 `typescript`、或把别名改个名，编译会**静默**退回 TS6（慢 6–15×）而
 * 门禁照样全绿 —— 所以它必须有判据。
 *
 * ## 判据面（四条，都从事实派生，不抄字面量）
 *
 * 1. 每个声明 `typescript` 的 workspace 包：manifest 值必须是 **7.x**；
 * 2. 实装漂移：该包 `node_modules/typescript/package.json` 的版本必须等于 manifest 声明；
 * 3. 编译器 API 的双向对拍：`tests/**\/*.spec.ts` 里 import `'typescript6'` 的包**必须**声明
 *    该别名（且是 6.x）；声明了却没有消费者 ⇒ 红（死别名）；反过来，**不许**有 spec 再
 *    import 裸 `'typescript'`（TS7 的 JS 包只剩版本号，跑起来必炸，`ts.createSourceFile`
 *    之类的成员根本不存在）；
 * 4. **行为判据**（抽样，覆盖三个有 API 消费者的包 + 一个纯 7 包）：在包内实跑
 *    `yarn exec tsc --version`，必须是 7.x —— 这条才是"脚本里真的用 7"的直接证据，
 *    前面三条只证明 manifest/node_modules 的形态。
 *
 * 变异方向：把任一包的 `typescript` 改回 `6.0.3` ⇒ 1/2/4 红；把别名的 import 改回
 * `'typescript'` ⇒ 3 红；把别名删掉 ⇒ 3（消费者侧）红。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DESKTOP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..', '..')

/** 期望的编译器主版本（TS7 原生；`typescript` 包的 bin 仍是 `tsc`，CLI 面不变）。 */
const NATIVE_TYPESCRIPT_MAJOR = '7'
/** 只给测试期编译器 API 用的 TS6 别名依赖名。 */
const LEGACY_API_DEPENDENCY = 'typescript6'

interface WorkspaceManifest {
  /** 包目录（仓内绝对路径）。 */
  readonly directory: string
  /** `package.json` 的 `name`。 */
  readonly name: string
  /** devDependencies ∪ dependencies。 */
  readonly dependencies: Record<string, string>
}

/** 主版本号（`"7.0.2"` → `"7"`；`"~6.0.3"` → `"6"`；`"npm:typescript@6.0.3"` → `"6"`）。 */
function majorOf(spec: string): string {
  const pinned = /(?:^|\D)(\d+)\.\d+\.\d+/u.exec(spec.replace(/^npm:[^@]*@/u, ''))
  return pinned?.[1] ?? 'unknown'
}

/** 展开 `packages/<group>/<name>/package.json` 的 workspace 包（只认包根，不进子树）。 */
function workspaceManifests(): WorkspaceManifest[] {
  const root = join(REPO_ROOT, 'packages')
  const manifests: WorkspaceManifest[] = []
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of readdirSync(join(root, group.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(root, group.name, entry.name)
      const manifestPath = join(directory, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: unknown
        dependencies?: unknown
        devDependencies?: unknown
      }
      if (typeof manifest.name !== 'string') throw new Error(`${manifestPath} 缺 name`)
      manifests.push({
        directory,
        name: manifest.name,
        dependencies: {
          ...(manifest.devDependencies as Record<string, string> | undefined),
          ...(manifest.dependencies as Record<string, string> | undefined),
        },
      })
    }
  }
  return manifests
}

/** 实装版本（包内 `node_modules/<name>/package.json` 的 `version`；缺失返回 `null`）。 */
function installedVersion(directory: string, dependency: string): string | null {
  const manifestPath = join(directory, 'node_modules', dependency, 'package.json')
  if (!existsSync(manifestPath)) return null
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  return typeof parsed.version === 'string' ? parsed.version : null
}

/** 该包的 `tests/**` 里从 TS6 别名（`typescript6`）import 编译器 API 的 spec。 */
function compilerApiConsumers(directory: string): string[] {
  const testsRoot = join(directory, 'tests')
  if (!existsSync(testsRoot)) return []
  const consumers: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(?:spec|test)\.tsx?$/u.test(entry.name)) continue
      // 判据：从 `typescript6` 入口 import（= 用 TS6 编译器 API）。这里刻意用文本判据
      // 而不是 AST：本 spec 自己也要在 TS7 下类型检查，用 TS6 的编译器 API 去判"谁在用
      // 编译器 API"会把同一份 API 再引进来一遍。
      if (/\bfrom\s+'typescript6'/u.test(readFileSync(path, 'utf8'))) consumers.push(path)
    }
  }
  walk(testsRoot)
  return consumers
}

const MANIFESTS = workspaceManifests()
const WITH_TYPESCRIPT = MANIFESTS.filter(manifest => manifest.dependencies.typescript !== undefined)

describe('TypeScript 编译器口径（TS7 原生 + TS6 别名）', () => {
  it('扫描面非空：至少覆盖 desktop 与全部声明 typescript 的包', () => {
    expect(MANIFESTS.length).toBeGreaterThan(10)
    expect(WITH_TYPESCRIPT.length).toBe(MANIFESTS.filter(m => 'typescript' in m.dependencies).length)
    expect(MANIFESTS.some(manifest => manifest.name === 'dsh-plugin-desktop')).toBe(true)
  })

  it('每个声明 typescript 的包的 manifest 都是 7.x', () => {
    const offenders = WITH_TYPESCRIPT
      .filter(manifest => majorOf(manifest.dependencies.typescript ?? '') !== NATIVE_TYPESCRIPT_MAJOR)
      .map(manifest => `${manifest.name}: typescript=${manifest.dependencies.typescript}`)
    expect(offenders).toEqual([])
  })

  it('实装版本与 manifest 一致（安装漂移即红）', () => {
    const offenders: string[] = []
    for (const manifest of WITH_TYPESCRIPT) {
      const declared = manifest.dependencies.typescript ?? ''
      const installed = installedVersion(manifest.directory, 'typescript')
      if (installed === null) {
        offenders.push(`${manifest.name}: node_modules/typescript 缺失（先 yarn install）`)
        continue
      }
      const declaredPinned = /(\d+\.\d+\.\d+)/u.exec(declared.replace(/^npm:[^@]*@/u, ''))?.[1]
      if (declaredPinned !== undefined && installed !== declaredPinned) {
        offenders.push(`${manifest.name}: manifest=${declared} 实装=${installed}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('编译器 API 消费者与 typescript6 别名双向对拍（既不许缺别名，也不许死别名）', () => {
    const offenders: string[] = []
    for (const manifest of MANIFESTS) {
      const consumers = compilerApiConsumers(manifest.directory)
      const legacy = manifest.dependencies[LEGACY_API_DEPENDENCY]
      if (consumers.length > 0) {
        if (legacy === undefined) {
          offenders.push(`${manifest.name}: ${consumers.length} 个 spec 用 TS6 编译器 API，但没声明 ${LEGACY_API_DEPENDENCY}`)
          continue
        }
        if (majorOf(legacy) !== '6') {
          offenders.push(`${manifest.name}: ${LEGACY_API_DEPENDENCY}=${legacy} 不是 6.x（编译器 API 只存在于 6.x）`)
          continue
        }
        const installedLegacy = installedVersion(manifest.directory, LEGACY_API_DEPENDENCY)
        if (installedLegacy === null || majorOf(installedLegacy) !== '6') {
          offenders.push(`${manifest.name}: ${LEGACY_API_DEPENDENCY} 未安装或版本不是 6.x（实装=${installedLegacy ?? '缺失'}）`)
        }
        continue
      }
      if (legacy !== undefined) {
        offenders.push(`${manifest.name}: 声明了 ${LEGACY_API_DEPENDENCY} 但没有任何 spec 用它（死别名）`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('没有 spec 再 import 裸 typescript（TS7 的 JS 包只剩版本号，那套 API 已不存在）', () => {
    const offenders: string[] = []
    for (const manifest of MANIFESTS) {
      const testsRoot = join(manifest.directory, 'tests')
      if (!existsSync(testsRoot)) continue
      const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name)
          if (entry.isDirectory()) {
            walk(path)
            continue
          }
          if (!/\.(?:spec|test)\.tsx?$/u.test(entry.name)) continue
          if (/\bfrom\s+'typescript'/u.test(readFileSync(path, 'utf8'))) offenders.push(path)
        }
      }
      walk(testsRoot)
    }
    expect(offenders).toEqual([])
  })

  it('行为判据：包内 yarn 脚本路径上的 tsc 实跑版本是 7.x（抽样，含三个有 API 消费者的包）', () => {
    const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
    const sampled = MANIFESTS.filter(manifest =>
      ['dsh-plugin-desktop', '@zeokeel/dsh-connectors', '@zeokeel/dsh-enterprise', '@zeokeel/dsh-host-locale']
        .includes(manifest.name),
    )
    // 抽样面必须齐：少一个包名说明包被改名/搬走，判据不能悄悄缩小。
    expect(sampled.map(manifest => manifest.name).sort()).toEqual(
      ['@zeokeel/dsh-connectors', '@zeokeel/dsh-enterprise', '@zeokeel/dsh-host-locale', 'dsh-plugin-desktop'].sort(),
    )
    const offenders: string[] = []
    for (const manifest of sampled) {
      // `yarn exec` 与包脚本用同一个 bin shim —— 这是"脚本里真的跑 7"的直接证据。
      const result = spawnSync(corepack, ['yarn', 'exec', 'tsc', '--version'], {
        cwd: manifest.directory,
        encoding: 'utf8',
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      const version = /Version (\d+\.\d+\.\d+)/u.exec(output)?.[1]
      if (result.status !== 0 || version === undefined) {
        offenders.push(`${manifest.name}: yarn exec tsc --version 失败（status=${String(result.status)}）：${output.slice(0, 200)}`)
        continue
      }
      if (version.split('.')[0] !== NATIVE_TYPESCRIPT_MAJOR) {
        offenders.push(`${manifest.name}: 脚本路径上的 tsc 是 ${version}，不是 ${NATIVE_TYPESCRIPT_MAJOR}.x`)
      }
    }
    expect(offenders).toEqual([])
  }, 60_000)
})
