#!/usr/bin/env node
/**
 * 开发内循环：`tsdown --watch`（增量重建）+ 应用自动重启。
 *
 * ## 为什么需要它
 *
 * `yarn dev` 是 `yarn run build && node lib/bin.js`：`build` 第一步就 `rm -rf lib`，
 * 然后 brand-prepare + tsdown + 两次 `tsc --emitDeclarationOnly`。**每改一行都付一遍**。
 * 2026-10-23 实测（4 核 / TS7）：整链 2.2s；`tsdown --watch` 的增量重建是 **~300ms**，
 * 差 7 倍。而且 dev 运行期**不需要** `lib/types`（那是给别的包的 tsc 读的），
 * 实测删掉 `lib/types` 后 `node lib/bin.js --version/--help` 完全正常。
 *
 * ## 用法
 *
 *   yarn dev:watch            # 构建 + 启动应用；改 src/ 后自动重建并重启应用
 *   yarn dev:watch --no-app   # 只做构建（想在别处手动跑应用时用）
 *   yarn dev:watch --types    # 同时跑 `tsc --emitDeclarationOnly --watch`（别的包 tsc 要桌面类型时）
 *   yarn dev:watch --no-restart  # 重建但不重启应用（UI 类热路径只想看日志时）
 *
 * ## 边界（写清楚，免得当成 HMR 用）
 *
 * 这是**重建 + 进程重启**，不是 HMR：主进程/客户端 bundle 都是整包换，Electron 没有
 * 模块热替换通道（本仓客户端用的是自研 ModuleLoader，不经过 Vite dev server）。
 * 重建 → 重启的端到端延迟 ≈ 300ms 构建 + Electron 冷启动。
 *
 * 退出：Ctrl-C 会把应用、tsdown、tsc 三个子进程一起收掉（SIGTERM → 5s → SIGKILL）。
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectInvocation } from './direct-invocation.mjs'

const DESKTOP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 重建行的判据（tsdown --watch 的两种完成行）。 */
const REBUILD_LINE = /Build complete in|Rebuilt in/u

/**
 * 这一行是不是"一次重建完成"？（纯函数，便于单独判定/变异）
 * @param line - tsdown 的一行输出。
 * @returns 是否触发重启。
 */
export function isRebuildLine(line) {
  return REBUILD_LINE.test(line)
}

/** 向子进程发退出信号，宽限期后强杀。 */
function terminate(child, label) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolvePromise => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已经退出
      }
    }, 5000)
    child.once('close', () => {
      clearTimeout(timer)
      resolvePromise()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolvePromise()
    }
    void label
  })
}

/** 一次性命令（brand-prepare）。 */
function runOnce(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(' ')} 退出码 ${String(code)}`))))
  })
}

/**
 * 启动 watch 内循环。
 * @param options - `{ app, types, restart }`。
 * @returns 进程退出时 resolve（收到 SIGINT/SIGTERM 时先收子进程）。
 */
export async function runDevWatch(options) {
  const { app, types, restart } = options
  // 品牌素材（build/ 下的图标）是应用启动与托盘图标要用的派生资源；它不随 --watch 重建，
  // 所以这里跑一次（0.5s）。--no-app 也跑：构建产物本身要它。
  await runOnce(process.execPath, [resolve(DESKTOP_ROOT, 'scripts/brand-prepare.mjs')], DESKTOP_ROOT)

  /** @type {import('node:child_process').ChildProcess | null} */
  let appChild = null
  /** @type {import('node:child_process').ChildProcess | null} */
  let tscChild = null
  let stopping = false
  let appStartedOnce = false

  const startApp = () => {
    if (!app || stopping) return
    if (appChild !== null && appChild.exitCode === null) return
    console.log('[dev-watch] 启动应用：node lib/bin.js')
    appChild = spawn(process.execPath, [resolve(DESKTOP_ROOT, 'lib/bin.js')], {
      cwd: DESKTOP_ROOT,
      stdio: 'inherit',
      env: process.env,
    })
    appChild.on('close', code => {
      console.log(`[dev-watch] 应用退出（${String(code)}）`)
      appStartedOnce = true
    })
  }

  const restartApp = () => {
    if (!app) return
    if (appChild === null || appChild.exitCode !== null) {
      startApp()
      return
    }
    if (!restart) return
    const previous = appChild
    console.log('[dev-watch] 重建完成，重启应用')
    terminate(previous, 'app').then(() => startApp())
  }

  // tsdown --watch：只重建 JS（main/preload/bin/client），不产 d.ts。
  const tsdown = spawn(resolve(DESKTOP_ROOT, 'node_modules/.bin/tsdown'), ['--watch'], {
    cwd: DESKTOP_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  let buffer = ''
  let pendingRestart = null
  const onChunk = chunk => {
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!isRebuildLine(line)) continue
      // 首次构建：还没有应用就直接起；之后每次重建：重启应用（250ms 防抖，连续保存只起一次）。
      if (!appStartedOnce && appChild === null) {
        startApp()
        appStartedOnce = true
        continue
      }
      if (pendingRestart !== null) clearTimeout(pendingRestart)
      pendingRestart = setTimeout(() => {
        pendingRestart = null
        restartApp()
      }, 250)
    }
  }
  tsdown.stdout?.on('data', onChunk)
  tsdown.stderr?.on('data', chunk => process.stderr.write(chunk))
  tsdown.on('close', code => {
    if (!stopping) console.error(`[dev-watch] tsdown 退出（${String(code)}）`)
  })

  if (types) {
    const tsc = resolve(DESKTOP_ROOT, 'node_modules/.bin/tsc')
    tscChild = spawn(tsc, ['-p', 'tsconfig.json', '--emitDeclarationOnly', '--watch', '--preserveWatchOutput'], {
      cwd: DESKTOP_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  }

  console.log(
    `[dev-watch] 已启动：tsdown --watch${types ? ' + tsc --watch' : ''}`
    + `${app ? ' + 应用自动重启' : '（--no-app）'}`
    + '；Ctrl-C 退出',
  )

  await new Promise(resolvePromise => {
    const shutdown = async () => {
      if (stopping) return
      stopping = true
      console.log('[dev-watch] 收尾中…')
      await Promise.all([terminate(appChild, 'app'), terminate(tsdown, 'tsdown'), terminate(tscChild, 'tsc')])
      resolvePromise()
    }
    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())
    tsdown.once('close', () => void shutdown())
  })
}

/** CLI 入口。 */
async function main(argv) {
  const options = {
    app: !argv.includes('--no-app'),
    types: argv.includes('--types'),
    restart: !argv.includes('--no-restart'),
  }
  await runDevWatch(options)
}

if (isDirectInvocation(import.meta)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
