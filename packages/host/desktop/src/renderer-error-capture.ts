/**
 * Host-side sink for renderer error reports (P0-6 / 决策 D8).
 *
 * 主进程侧的两件事:
 *  1. 从渲染进程经 `RENDERER_ERROR_CHANNEL` 收报告(不可信边界 ⇒ 先归一化);
 *  2. 把归一化后的报告交给**已注册的 sink** —— 具体由哪个模块上报(企业
 *     `error-reporting` 插件 → GlitchTip)不属于 desktop 包的职责,desktop 只
 *     提供通道。没有 sink(未登录/插件未加载/headless)时**静默丢弃**:
 *     错误上报坏掉绝不能影响宿主。
 *
 * 为什么 sink 是模块级而不是每次调用传:IPC 监听在启动期就装好了(早于任何
 * 插件 apply),而插件是登录后才注册 sink 的 —— 两边生命周期不同,必须解耦。
 */

import type { RendererErrorReport } from './renderer-error-contract.ts'
import { normalizeRendererErrorReport, RENDERER_ERROR_CHANNEL } from './renderer-error-contract.ts'

/** 上报落点:由拥有 Sentry 实例的一方注册。 */
export type RendererErrorSink = (report: RendererErrorReport) => void

let sink: RendererErrorSink | undefined

/**
 * 注册上报落点。
 * @param next - 接收归一化报告的落点。
 * @returns 幂等 disposer(仅当自己仍是当前 sink 时才清除)。
 */
export function setRendererErrorSink(next: RendererErrorSink): () => void {
  sink = next
  return () => {
    if (sink === next) sink = undefined
  }
}

/** 当前是否已有落点(测试与诊断用)。 */
export function hasRendererErrorSink(): boolean {
  return sink !== undefined
}

/**
 * 本安装的应用源 scheme(`APP_ORIGIN_SCHEME`,渠道注入;U-03,2026-10-22 评审)。
 *
 * 为什么由 main 在模块作用域登记而不是每个调用点传:上报落点(Sentry)收到的报告只有
 * 结构字段,而"这条错误来自哪个 WASM 应用"只能由 `url` 的 scheme + host 判出来 ——
 * 判据只有一份,放在**唯一**的主进程上报入口(`reportRendererError`)最不容易漏。
 * scheme 是渠道值,不在这里写死。
 */
let appOriginScheme: string | undefined

/**
 * 登记本安装的应用源 scheme(启动期一次;重复登记以最后一次为准)。
 * @param scheme - 不含 `:` 的 scheme(如 `example-app`)。
 */
export function registerRendererErrorAppScheme(scheme: string): void {
  if (typeof scheme !== 'string' || scheme === '') return
  appOriginScheme = scheme.replace(/:+$/u, '')
}

/**
 * 主进程侧补写 `app_id`/`windowKind` 的判据(不可信输入:只用于打 tag)。
 *
 * 形状与宿主包的 `APP_ID_PATTERN`(`^[a-z0-9]+(?:-[a-z0-9]+)*$`,≤63)同口径 —— 两边
 * 发散时,一个合法应用 id 会因为多一个下划线而在后台**静默失去 app_id 标签**。
 */
const APP_ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const APP_ID_MAX_LENGTH = 63

/**
 * 从一条报告里推断它来自哪个应用窗口(U-03)。
 *
 * 只在**已登记应用 scheme** 且 host 形如合法 app_id 时才返回:`url` 来自渲染进程
 * (页面可伪造),所以这里不做任何授权决定,只产出一个**标签**;形状不合法一律当
 * "不是应用窗口"(不补标签,也不改写原报告)。
 * @param report - 归一化后的报告(已限定字段与长度)。
 * @returns app_id;不是应用窗口的 URL ⇒ undefined。
 */
export function appIdFromRendererErrorReport(report: RendererErrorReport): string | undefined {
  if (appOriginScheme === undefined) return undefined
  const url = (report as { url?: unknown }).url
  if (typeof url !== 'string' || url === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${appOriginScheme}:`) return undefined
  const host = parsed.hostname.toLowerCase()
  return host.length <= APP_ID_MAX_LENGTH && APP_ID_SHAPE.test(host) ? host : undefined
}

/**
 * 补写应用窗口标签(幂等:已经有 `windowKind` 的报告原样返回)。
 *
 * `render-process-gone`(应用窗口崩溃由本包写 `appId`)与渲染进程 IPC 报告都走这里,
 * 所以 Sentry 端能用同一个 `zeokeel.app_id` 筛出"某个应用出问题了"。
 * @param report - 归一化后的报告。
 * @returns 可能带 `appId`/`windowKind` 的报告。
 */
export function enrichRendererErrorReport(report: RendererErrorReport): RendererErrorReport {
  if (report.windowKind !== undefined) return report
  if (typeof report.appId === 'string' && report.appId !== '') {
    return { ...report, windowKind: 'app' }
  }
  const appId = appIdFromRendererErrorReport(report)
  if (appId === undefined) return report
  return { ...report, appId, windowKind: 'app' }
}

/**
 * 把一条**已在主进程内**产生的报告交给 sink(如 `render-process-gone`)。
 *
 * 交出去之前补写应用窗口标签(见 {@link enrichRendererErrorReport})。无 sink 时静默
 * 丢弃,绝不抛。
 */
export function reportRendererError(report: RendererErrorReport): boolean {
  const current = sink
  if (current === undefined) return false
  try {
    current(enrichRendererErrorReport(report))
    return true
  } catch {
    // 上报落点自身出错不得影响宿主(它在另一端已经 fail-soft,这里是双保险)。
    return false
  }
}

/** 可注入的最小 IPC 面(便于单测不依赖真实 Electron)。 */
export interface RendererErrorIpc {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown
}

/**
 * 安装渲染进程错误通道的监听(启动期调用一次;幂等)。
 *
 * @param ipc - IPC 宿主(生产传 Electron `ipcMain`,测试注入假实现)。
 * @returns disposer(测试/重启用)。
 */
export function installRendererErrorCapture(ipc: RendererErrorIpc): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    const normalized = normalizeRendererErrorReport(payload)
    // 形状不对 ⇒ 不是我们的 preload 发的,丢弃比猜测安全(不可信边界)。
    if (!normalized.ok) return
    reportRendererError(normalized.report)
  }
  ipc.on(RENDERER_ERROR_CHANNEL, listener)
  return () => {
    ipc.removeListener(RENDERER_ERROR_CHANNEL, listener)
  }
}
