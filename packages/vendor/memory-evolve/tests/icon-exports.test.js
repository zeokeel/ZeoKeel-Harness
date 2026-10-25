/**
 * 回归：DSH 0.2.1 的 ui-primitives 移除了带像素后缀的图标导出
 * （IconSearchOutline16 / IconFolderOpen16 …），改名为 …Regular / …Medium。
 * 这些名字在构建期不会被 TypeScript/打包器校验（平台模块是 external），
 * 运行时拿到 undefined 后 React 渲染直接抛错 —— 表现就是「技能管理」白屏。
 *
 * 判据：源码里除 `src/client/ui-icons.ts`（唯一兼容层，旧名只作兜底字符串）外不得
 * 出现旧的像素后缀图标名；产物里必须带现代名，旧名只允许作为 resolveIcon 的兜底参数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OBSOLETE = /\bIcon[A-Za-z0-9]*(?:14|16|20|24)\b/g

/**
 * 唯一允许出现"已移除图标名"的源码位置（跨版本兼容层）。
 *
 * 2026-10-25 合并上游：上游 e6f6b84 引入 `src/client/ui-icons.ts`，用
 * 「新名 → 旧名 → Medium → null」四档解析把旧名当**字符串字面量**兜底；本仓的
 * 生产代码仍直接 import DSH 0.2.1 的 `…Regular` 名（本测试第一版就是为此加的），
 * 该兼容层只被它自己的上游测试（tests/client-icons-compat.test.js）使用。
 * 因此这里按上游自己的规则放行这一个文件：**它是唯一允许触碰旧名的地方**，
 * 其余任何 .ts/.tsx 出现旧名照样判红（本回归的原始目的不变）。
 */
const LEGACY_NAME_ALLOWLIST = new Set([join('src', 'client', 'ui-icons.ts')])

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) yield path
  }
}

test('源码不再引用已移除的像素后缀图标名（兼容层 ui-icons.ts 除外）', () => {
  const offenders = []
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file)
    if (LEGACY_NAME_ALLOWLIST.has(rel)) continue
    const matches = readFileSync(file, 'utf8').match(OBSOLETE)
    if (matches !== null) offenders.push(`${rel}: ${[...new Set(matches)].join(', ')}`)
  }
  assert.deepEqual(offenders, [])
})

test('已提交的 lib/client.js 与源码同构：现代名在、旧名只作兼容层兜底字符串', () => {
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  // 生产 UI 现在统一 import `src/client/ui-icons.ts` 的稳定名（2026-10-25 采用上游
  // 跨版本解析层）⇒ 产物必须带上 0.2.x 的 `…Regular` 导出名。改了 src/client 却没
  // 重建产物时，旧产物里只有 `…16/…14`，这条立刻红（正是本回归最初要抓的形态）。
  for (const modern of [
    'IconSearchOutlineRegular', 'IconWarningOutlineRegular', 'IconChevronDownOutlineRegular', 'IconPlusOutlineRegular',
  ]) {
    assert.ok(bundle.includes(modern), `lib/client.js 必须引用 ${modern}（改了 src/client 必须重建产物）`)
  }
  // 旧名只能作为兼容层 `resolveIcon(modern, legacy)` 的兜底参数出现（esbuild 会保留
  // 成字符串字面量）；出现在任何别的位置都说明有人绕过了唯一兼容层、直接按旧名
  // 取组件 —— 那在 0.2.x 上是 undefined，React 会整块 UI 崩掉。
  const fallback = new Set(
    [...bundle.matchAll(/resolveIcon\(["']([^"']+)["'],\s*["']([^"']+)["']\)/gu)].map((m) => m[2]),
  )
  const leftover = [...new Set(bundle.match(OBSOLETE) ?? [])].filter((name) => !fallback.has(name))
  assert.deepEqual(leftover, [], '产物里的旧图标名必须全部来自 resolveIcon 的兜底参数')
  assert.ok(fallback.size >= 10, `兼容层兜底项应整组出现在产物里（实际 ${fallback.size} 项）`)
})
