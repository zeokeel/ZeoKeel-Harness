#!/usr/bin/env node
/**
 * 根脚本**类型面**的门禁化：把 `yarn typecheck:scripts` 变成第 18 条根守卫。
 *
 * ## 为什么要有它
 *
 * `tsconfig.scripts.json` 用 `allowJs + checkJs` 把根 `scripts/**` 的 `.mjs` 原样纳入
 * TypeScript 检查（不换扩展名、不加构建步骤）。但它此前只是一个**手动命令**：
 * 没人跑就等于没有 —— 门禁里的东西必须是"每次 `yarn check` 都真的跑"的那一份。
 *
 * ## 它做什么
 *
 * 用**当前 node**（`process.execPath`）去跑根 `devDependencies` 里的 `typescript` 原生
 * `tsc -p tsconfig.scripts.json`，把退出码原样带出来：
 *
 *   · `0`  ⇒ 通过（打印一行 OK）；
 *   · `≠0` ⇒ 失败（类型错误 / 配置错误；**不允许**用 `@ts-nocheck` 之类绕过）；
 *   · 读不到 `tsc` 或配置 ⇒ **退出码 2**（fail-closed：判据自身跑不起来不能算通过）。
 *
 * 为什么用 `process.execPath` + `node_modules/typescript/bin/tsc`，而不是 `node_modules/.bin/tsc`：
 * `.bin` 是指向 shell/`.cmd` 垫片的链接（Windows 上要 shell 才能跑），而判据进程必须是
 * **同一个 node**（路径里带空格/引号时也不经过 shell 解析）。
 *
 * ## 边界（认账）
 *
 * - 它判的是**类型**，不是行为：`checkJs` 不做语法降级，也不执行被检查的文件。
 * - 面内只有 `scripts/**`（`scripts/wasm/probes/**` 是 Electron 渲染进程探针，显式排除，
 *   理由见 `tsconfig.scripts.json` 的注释）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const CONFIG = join(ROOT, 'tsconfig.scripts.json')

for (const [label, path] of [['tsc', TSC], ['tsconfig.scripts.json', CONFIG]]) {
  if (existsSync(path)) continue
  console.error(`check-scripts-types: 读不到 ${label}（${path}）—— 判据自身跑不起来，拒绝当作通过`
    + '\n  ⇒ 先 `corepack yarn install`（根 devDependencies 里有 typescript 7.0.2）')
  process.exit(2)
}

const result = spawnSync(process.execPath, [TSC, '-p', CONFIG], { cwd: ROOT, stdio: 'inherit' })
if (result.error !== undefined) {
  console.error(`check-scripts-types: 起不了 tsc —— ${result.error.message}`)
  process.exit(2)
}
if (result.status !== 0) {
  console.error('check-scripts-types: 根脚本的类型面红了 —— 修 `scripts/**` 的类型错误，'
    + '**不要**加 `@ts-nocheck` / `@ts-ignore` 绕过（那会把这条判据变成装饰）')
  process.exit(result.status ?? 1)
}

console.log('check-scripts-types: OK — `scripts/**` 通过 `tsc -p tsconfig.scripts.json`'
  + '（allowJs + checkJs + noUnusedLocals/noUnusedParameters；`scripts/wasm/probes/**` 显式不在面内）')
