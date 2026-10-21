/**
 * 回归：DSH 0.2.1 的 ui-primitives 移除了带像素后缀的图标导出
 * （IconSearchOutline16 / IconFolderOpen16 …），改名为 …Regular / …Medium。
 * 这些名字在构建期不会被 TypeScript/打包器校验（平台模块是 external），
 * 运行时拿到 undefined 后 React 渲染直接抛错 —— 表现就是「技能管理」白屏。
 *
 * 判据：源码与已提交的 lib/client.js 里都不允许再出现旧的像素后缀图标名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OBSOLETE = /\bIcon[A-Za-z0-9]*(?:14|16|20|24)\b/g

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) yield path
  }
}

test('源码不再引用已移除的像素后缀图标名', () => {
  const offenders = []
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const matches = readFileSync(file, 'utf8').match(OBSOLETE)
    if (matches !== null) offenders.push(`${file}: ${[...new Set(matches)].join(', ')}`)
  }
  assert.deepEqual(offenders, [])
})

test('已提交的 lib/client.js 不再引用已移除的像素后缀图标名', () => {
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  const names = [...new Set(bundle.match(OBSOLETE) ?? [])]
  assert.deepEqual(names, [])
})
