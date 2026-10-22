/**
 * 应用窗口故障 → 宿主上报契约的映射（U-03，2026-10-22 评审）。
 *
 * 为什么这个纯函数需要独立判据：`main.ts` 只在真 Electron 里执行，内联的映射在任何
 * 离线门禁下都测不到 —— 而"崩溃事件丢了 app_id"正是这次 P1 的另一半（链路通了但
 * 后台仍不知道是哪个应用）。
 *
 * 变异验证：
 *  · 删掉 `appId`/`windowKind` 字段 ⇒ 第一条红；
 *  · 把 `did-fail-load` 映射成 `render-process-gone` ⇒ 第二条红（后台会把一次网络
 *    失败当成渲染进程崩溃聚合）；
 *  · 丢掉 `url` ⇒ 第三条红。
 */
import { describe, expect, it } from 'vitest'
import { toRendererErrorReport } from '../src/app-window-error-report.ts'

describe('toRendererErrorReport（U-03）', () => {
  it('render-process-gone 保留 reason/exitCode，并带 app_id 与 windowKind', () => {
    expect(toRendererErrorReport({
      type: 'render-process-gone',
      appId: 'demo',
      windowKind: 'app',
      reason: 'oom',
      exitCode: 5,
      url: 'probe-app://demo/notes',
    })).toEqual({
      type: 'render-process-gone',
      reason: 'oom',
      exitCode: 5,
      appId: 'demo',
      windowKind: 'app',
      url: 'probe-app://demo/notes',
    })
  })

  it('did-fail-load / unresponsive 折叠成 error（IPC 的 type 白名单不接受新值）', () => {
    const failed = toRendererErrorReport({
      type: 'did-fail-load',
      appId: 'demo',
      windowKind: 'app',
      reason: '-105: NAME_NOT_RESOLVED',
      url: 'probe-app://demo/',
    })
    expect(failed).toMatchObject({
      type: 'error',
      message: 'application window did-fail-load: -105: NAME_NOT_RESOLVED',
      appId: 'demo',
      windowKind: 'app',
      url: 'probe-app://demo/',
    })
    expect(toRendererErrorReport({
      type: 'unresponsive',
      appId: 'notes',
      windowKind: 'app',
      reason: 'unresponsive',
    })).toMatchObject({
      type: 'error',
      message: 'application window unresponsive: unresponsive',
      appId: 'notes',
      windowKind: 'app',
    })
  })

  it('exitCode 缺失回落 0；URL 缺失不写空字段', () => {
    const report = toRendererErrorReport({
      type: 'render-process-gone',
      appId: 'demo',
      windowKind: 'app',
      reason: 'crashed',
    })
    expect(report).toEqual({
      type: 'render-process-gone',
      reason: 'crashed',
      exitCode: 0,
      appId: 'demo',
      windowKind: 'app',
    })
    expect('url' in report).toBe(false)
  })
})
