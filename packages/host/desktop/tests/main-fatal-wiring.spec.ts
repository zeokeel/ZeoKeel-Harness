/**
 * P1/P2（2026-10-21 反证审查 D 的 H1–H11）：`main.ts` 里"安全模式真的接了"的结构判据。
 *
 * 为什么只能这样测：`start()` 依赖 Electron 实体，单测挂不起来；而纯函数（`fatal-exit`、
 * `desktop-safe-mode`、`fatal-recovery`）都已有行为用例。剩下的风险是**胶水**被改坏：
 * 不消费 marker、不把 marker 传给组合、清除点提前、warnings 不打日志 —— 这些在之前的
 * 变异检验里全部保持绿。这里把它们在 `start()` 源码区间内钉成 token + 顺序判据。
 *
 * 这是**结构性**判据，不替代行为测试：`fatal-exit.spec` 管退出语义，
 * `safe-mode-composition.spec` 管组合消费，`desktop-safe-mode.spec` 管 marker 生命周期。
 * 已知代价：纯改名会假红（反证审查 D 的 Q2），所以每个 token 都同时出现在用例名/注释里。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')

/** `start()` 的函数体（到下一个顶层函数为止）。 */
function startBody(): string {
  const start = mainSource.indexOf('async function start(): Promise<void> {')
  expect(start, 'main.ts 必须保留 start()').toBeGreaterThan(-1)
  const end = mainSource.indexOf('\nasync function run(): Promise<void> {', start)
  expect(end, 'main.ts 的 start() 必须能被定位到结尾').toBeGreaterThan(start)
  return mainSource.slice(start, end)
}

describe('main.ts 的安全模式接线（结构判据）', () => {
  it('启动时消费 marker，并把 bundle 集合传给组合（第 6 个实参）', () => {
    const body = startBody()
    expect(body).toContain('beginSafeModeBoot(safeModePath,')
    expect(body).toMatch(/app\.getPath\('userData'\),\s*safeModeBundles,/)
  })

  it('prepared.warnings 逐条写日志（坏 state / 被过滤的持久禁用不能静默）', () => {
    expect(startBody()).toContain('for (const warning of prepared.warnings)')
  })

  it('marker 只在 runtime.mountScheduled() 之后清除（H1/H2）', () => {
    const body = startBody()
    const mounted = body.indexOf('await runtime.mountScheduled()')
    const cleared = body.indexOf('finishSafeModeBoot(safeModePath, safeModeBundles,')
    expect(mounted, '必须存在 mountScheduled 等待点').toBeGreaterThan(-1)
    expect(cleared, '必须调用 finishSafeModeBoot 清除 marker').toBeGreaterThan(-1)
    expect(cleared, '清除 marker 必须晚于 mountScheduled').toBeGreaterThan(mounted)
  })

  it('致命路径把用户选择原样交给 fatal-exit，不硬编码 retry（H7）', () => {
    const catchAt = mainSource.indexOf('electronLogger.errorCause(cause)')
    expect(catchAt).toBeGreaterThan(-1)
    const block = mainSource.slice(catchAt, mainSource.indexOf('\n  }\n', catchAt))
    expect(block).toMatch(/resolveFatalExit\(\s*action,/)
  })
})
