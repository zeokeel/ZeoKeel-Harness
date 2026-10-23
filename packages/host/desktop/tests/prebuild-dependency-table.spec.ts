/**
 * `prebuildWorkspaceDeps` 的**构建依赖表必须完整**（2026-10-23 并行化后新增的判据）。
 *
 * ## 为什么需要它
 *
 * `WORKSPACE_PACKAGES[*].deps` 是"谁要等谁的产物"的**唯一真源**：层就是按它算的
 * （同层并行、跨层串行）。表缺一条边在**串行**时代看不出来（列表顺序恰好对），
 * 但并行后会读到依赖包 tsdown `clean: true` 的窗口 ⇒ `TS7016 Could not find a
 * declaration file`。2026-10-23 的真实现场：`account-card` 的 `src/` import 了
 * `@zeokeel/dsh-enterprise/*` 与 `@zeokeel/dsh-panel-surface/client`，而表里只写了
 * `desktop` ⇒ 并行一跑就红（串行时靠列表顺序兜住，没人发现）。
 *
 * ## 判据（四条，都从事实派生）
 *
 * 1. 表能完整解析（含 `workspace: null` 的 desktop 条目）= 15 项、dir 不重复；
 * 2. 按表算层**必须无环**（成环时 `dependencyLayers` 会 fail-loud，这里提前判）；
 * 3. 每个包 `src/**`（`.ts`/`.tsx`）里 import 到的 `@zeokeel/*` 包，都必须出现在它的
 *    `deps` 里（= 构建输入齐全）——**反向不判**：表里可以有多余的边（例如只为测试
 *    或运行期 require 登记的），多一条只是更保守；
 * 4. 被 import 的包必须**真的在表里**（否则并行时永远等不到它）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DESKTOP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..', '..')
const TABLE_TS = join(DESKTOP_ROOT, 'scripts', 'prebuild-workspace-deps.ts')

interface TableEntry {
  readonly workspace: string | null
  readonly dir: string
  readonly deps: readonly string[]
}

/**
 * 从包表源码里解析条目（容忍多行 `deps` 与 `workspace: null`）。
 *
 * **不能按 `{` 切块**：条目的注释里出现 `{` 就会把块切断（enterprise 的
 * `server-connector/{auth,config,electron}` 正是这样，判据自己先红过一次）。
 * 改成按 `workspace:` 锚点切段，段内再解析 dir / deps。
 */
function parseTable(text: string): TableEntry[] {
  const start = text.indexOf('export const WORKSPACE_PACKAGES')
  expect(start, '找不到 WORKSPACE_PACKAGES 表，本判据需随表实现更新').toBeGreaterThanOrEqual(0)
  const body = text.slice(start)
  const anchors = [...body.matchAll(/workspace:\s*(null|'([^']+)')/gu)]
  const entries: TableEntry[] = []
  for (const [index, anchor] of anchors.entries()) {
    const from = anchor.index ?? 0
    const to = anchors[index + 1]?.index ?? body.length
    const segment = body.slice(from, to)
    const dirMatch = /dir:\s*'([^']+)'/u.exec(segment)
    if (dirMatch === null) continue
    const depsMatch = /deps:\s*\[([\s\S]*?)\]/u.exec(segment)
    entries.push({
      workspace: anchor[1] === 'null' ? null : (anchor[2] ?? null),
      dir: dirMatch[1] ?? '',
      deps: depsMatch === null ? [] : [...(depsMatch[1] ?? '').matchAll(/'([^']+)'/gu)].map(match => match[1] ?? ''),
    })
  }
  return entries
}

/** 同 `prebuild-workspace-deps.ts` 的层算法（成环时返回 `null`）。 */
function layersOrNull(entries: readonly TableEntry[]): TableEntry[][] | null {
  const byDir = new Map(entries.map(entry => [entry.dir, entry]))
  const pending = new Map(entries.map(entry => [entry.dir, new Set(entry.deps.filter(dir => byDir.has(dir)))]))
  const layers: TableEntry[][] = []
  while (pending.size > 0) {
    const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([dir]) => dir)
    if (ready.length === 0) return null
    layers.push(ready.map(dir => byDir.get(dir)).filter((entry): entry is TableEntry => entry !== undefined))
    for (const dir of ready) pending.delete(dir)
    for (const deps of pending.values()) for (const dir of ready) deps.delete(dir)
  }
  return layers
}

/** 递归收集 `src/**` 里的 `.ts`/`.tsx` 文件。 */
function srcFiles(packageDir: string): string[] {
  const root = join(packageDir, 'src')
  const found: string[] = []
  const walk = (current: string): void => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(path)
      } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
        found.push(path)
      }
    }
  }
  walk(root)
  return found
}

const TABLE = parseTable(readFileSync(TABLE_TS, 'utf8'))

describe('prebuild 构建依赖表（并行安全的唯一真源）', () => {
  it('表能完整解析：15 个包、dir 不重复、含 desktop 与三个叶子包', () => {
    expect(TABLE.length).toBe(15)
    const dirs = TABLE.map(entry => entry.dir)
    expect(new Set(dirs).size).toBe(dirs.length)
    expect(dirs).toContain('packages/host/desktop')
    expect(TABLE.find(entry => entry.dir === 'packages/host/desktop')?.workspace).toBeNull()
    for (const leaf of ['packages/host/host-locale', 'packages/host/host-home', 'packages/client/panel-surface']) {
      expect(TABLE.find(entry => entry.dir === leaf)?.deps).toEqual([])
    }
  })

  it('按表算层无环（成环时并行会 fail-loud）', () => {
    const layers = layersOrNull(TABLE)
    expect(layers, '构建依赖成环：并行 prebuild 无法排层').not.toBeNull()
    // 层数必须 > 1（单层说明表里一条依赖都没有，判据会空转）。
    expect((layers ?? []).length).toBeGreaterThan(1)
    // 每层都非空且所有包恰好出现一次。
    const flattened = (layers ?? []).flat().map(entry => entry.dir).sort()
    expect(flattened).toEqual(TABLE.map(entry => entry.dir).sort())
  })

  it('每个包 src/ 里 import 的 @zeokeel 包都在它的 deps 里（缺边在并行下才会炸）', () => {
    const dirByPackageName = new Map<string, string>()
    for (const entry of TABLE) {
      const manifestPath = join(REPO_ROOT, entry.dir, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      if (typeof manifest.name === 'string') dirByPackageName.set(manifest.name, entry.dir)
    }

    const offenders: string[] = []
    for (const entry of TABLE) {
      const packageRoot = join(REPO_ROOT, entry.dir)
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: string }
      const self = manifest.name ?? entry.dir
      const imported = new Set<string>()
      for (const file of srcFiles(packageRoot)) {
        const text = readFileSync(file, 'utf8')
        for (const match of text.matchAll(/\bfrom\s+'(@zeokeel\/[a-z0-9-]+)/gu)) {
          const name = match[1] ?? ''
          if (name !== self) imported.add(name)
        }
      }
      for (const name of imported) {
        const depDir = dirByPackageName.get(name)
        if (depDir === undefined) {
          offenders.push(`${entry.dir}: import 了不在包表里的 ${name}`)
          continue
        }
        if (depDir === entry.dir) continue
        if (!entry.deps.includes(depDir)) {
          offenders.push(`${entry.dir}: import 了 ${name}（${depDir}）但 deps 里没有这条边`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
