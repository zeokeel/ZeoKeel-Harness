/**
 * 应用窗口故障 → 宿主渲染错误上报契约的**适配层**(U-03,2026-10-22 评审)。
 *
 * ## 为什么要这一层
 *
 * 两个包各自持有一份**结构不同**的形状:
 *  - 应用窗口适配器(`@zeokeel/dsh-wasm-apps-host/electron-adapter`)只知道
 *    "哪个应用、哪种故障、什么原因";它不 import Electron / Sentry;
 *  - 桌面宿主的上报契约(`renderer-error-contract.ts`)是 preload/IPC 与 sink(Sentry)
 *    之间的冻结形状,`render-process-gone` 之前只有 `reason`/`exitCode`。
 *
 * 把映射写成一个纯函数(而不是内联在 `main.ts` 的闭包里):`main.ts` 只在真 Electron
 * 里执行,内联进去的映射在**任何离线门禁**下都测不到 —— 这正是本仓记录过多次的
 * "接线正确、现象为零"的形态。判据在 `tests/app-window-error-report.spec.ts`。
 *
 * ## 字段映射(逐条都是判据)
 *
 *  - `render-process-gone` ⇒ 同形载荷(保留 `reason`/`exitCode`),**外加** `appId`/
 *    `windowKind:'app'`/`url` —— 后台才能按应用聚合崩溃。
 *  - `did-fail-load` / `unresponsive` ⇒ 契约里只有 `error` 这一档可承载"一句话故障"
 *    (IPC 侧的 `type` 白名单不接受新值,而这两条是**主进程**产生的、不走 IPC)。
 *    所以把它们折叠成 `{type:'error', message}`;种类写进 message,`appId`/`url` 照带。
 *    不新增 `type` 值是为了让 `normalizeRendererErrorReport` 的不可信边界保持原样。
 *
 * @module dsh-plugin-desktop/app-window-error-report
 */

import type { AppWindowRendererErrorReport } from '@zeokeel/dsh-wasm-apps-host/electron-adapter'
import type { RendererErrorReport } from './renderer-error-contract.ts'

/**
 * 把应用窗口适配器的报告映射成宿主上报契约。
 * @param report - 适配器交出来的事件(已带 app_id 与 windowKind)。
 * @returns 可交给 `reportRendererError` 的载荷。
 */
export function toRendererErrorReport(report: AppWindowRendererErrorReport): RendererErrorReport {
  if (report.type === 'render-process-gone') {
    return {
      type: 'render-process-gone',
      reason: report.reason,
      exitCode: report.exitCode ?? 0,
      appId: report.appId,
      windowKind: 'app',
      ...(report.url === undefined || report.url === '' ? {} : { url: report.url }),
    }
  }
  return {
    type: 'error',
    message: `application window ${report.type}: ${report.reason}`,
    appId: report.appId,
    windowKind: 'app',
    ...(report.url === undefined || report.url === '' ? {} : { url: report.url }),
  }
}
