/**
 * `/api/server/admin/wasm-apps/runtime` 的**队列 + 调度器**只读切片
 * （生产化评审「管理员视角」P1：可观测性之「哪个应用在拖垮平台」）。
 *
 * ## 为什么需要这一层
 *
 * 服务端 2026-10-22 给 `/admin/runtime` 加了 `queue`（全局水位 + 429 计数 + 按应用前 N 水位）、
 * `schedulers`（含 `wasm_retirement` 真删作业）与 `app_limits.override_count`。
 * 但 webadmin 此前只在「限制项」页读了编译队列/执行槽/磁盘那一小段 —— 于是
 * "现在有几个应用在排队、谁被 429 拒了、退役作业跑没跑"在管理端仍然没有出口。
 *
 * 本文件把这三段收成纯函数（解析 + 降级文案），页面只做渲染：
 *
 *   - **缺字段 ≠ 0**：运行时读不到（装配没注入）与服务端如实回报 0 是两件事。前者一律
 *     归一成 `null` 并让界面写「服务端未下发（不是 0）」；
 *   - `schedulers` 缺失 ≠ 没有调度器（后者是空数组）；
 *   - `top_apps` 缺失 ≠ 没有排队（前者是没下发按应用水位）。
 *
 * 只解析本面板要用的键（queue / schedulers / app_limits）；`compile`/`disk`/`ready`
 * 那一段的可视化归「限制项」页（`Limits.tsx`），不在这里复制第二份。
 */
import { WASM_APPS_PATH, type ParseResult } from './apps-lifecycle'

/** `GET /api/server/admin/wasm-apps/runtime`（与 Limits.tsx 打的是同一个端点）。 */
export const WASM_RUNTIME_PATH = `${WASM_APPS_PATH}/runtime`

/** 单个应用的队列水位（服务端 `queue.AppWatermark` 的 json tag 逐字对齐）。 */
export interface QueueAppWatermark {
  appId: string
  running: number
  waiting: number
  /** 该应用累计被 429 拒绝的次数（含队列满与墙钟）。 */
  rejected: number
}

/** 执行队列的全局水位（服务端 `AdminRuntime` 的 `queue` 段）。 */
export interface RuntimeQueueView {
  /** 在跑实例数；`null` = 服务端未下发该字段（不是 0）。 */
  globalRunning: number | null
  waiting: number | null
  /** 被 429 拒绝：队列满 / 端到端墙钟。 */
  rejectedQueueFull: number | null
  rejectedWallClock: number | null
  /** 按应用水位前 N；`null` = 服务端未下发这一段（不是"没有排队"）。 */
  topApps: QueueAppWatermark[] | null
}

/** 后台调度器快照（服务端 `SchedulerStatusView` 的 json tag 逐字对齐）。 */
export interface RuntimeSchedulerView {
  name: string
  tickSeconds: number | null
  /** `null` = 未下发（不是"没启动"）。 */
  started: boolean | null
  lastRunAt: string | null
  /** 最近一次错误（空串 = 无错误，由服务端省略该键）。 */
  lastError: string
}

/** 运行时摘要：三段都是可缺省的（缺 = 未下发，界面要如实说）。 */
export interface RuntimeSummary {
  queue: RuntimeQueueView | null
  schedulers: RuntimeSchedulerView[] | null
  /** 服务端在册的 per-app 覆盖数（`app_limits.override_count`）；`null` = 未下发。 */
  overrideCount: number | null
}

/** 非负整数读数；其他形态（缺失/`null`/字符串/负数）一律 `null`（不编造 0）。 */
function readCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
}

function readQueue(raw: unknown): RuntimeQueueView | null {
  if (raw === null || typeof raw !== 'object') return null
  const q = raw as Record<string, unknown>
  let topApps: QueueAppWatermark[] | null = null
  if (Array.isArray(q.top_apps)) {
    topApps = []
    for (const entry of q.top_apps) {
      if (entry === null || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      const appId = typeof row.app_id === 'string' ? row.app_id.trim() : ''
      if (appId === '') continue
      topApps.push({
        appId,
        running: readCount(row.running) ?? 0,
        waiting: readCount(row.waiting) ?? 0,
        rejected: readCount(row.rejected) ?? 0,
      })
    }
  }
  return {
    globalRunning: readCount(q.global_running),
    waiting: readCount(q.waiting),
    rejectedQueueFull: readCount(q.rejected_queue_full),
    rejectedWallClock: readCount(q.rejected_wall_clock),
    topApps,
  }
}

function readSchedulers(raw: unknown): RuntimeSchedulerView[] | null {
  if (!Array.isArray(raw)) return null
  const out: RuntimeSchedulerView[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const s = entry as Record<string, unknown>
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    if (name === '') continue
    out.push({
      name,
      tickSeconds: readCount(s.tick_seconds),
      started: typeof s.started === 'boolean' ? s.started : null,
      lastRunAt: typeof s.last_run_at === 'string' && s.last_run_at.trim() !== '' ? s.last_run_at : null,
      lastError: typeof s.last_error === 'string' ? s.last_error : '',
    })
  }
  return out
}

/**
 * 解析 `/runtime` 响应（信封 `{runtime:{…}}`）。
 *
 * 形状不对 ⇒ `ok:false`（页面说「读取运行时水位失败」）。**不**把缺 `runtime` 渲染成
 * 一片 0 —— 那正是本次生产化评审要消灭的"停摆与没活干同形"。
 */
export function parseRuntimeSummary(raw: unknown): ParseResult<RuntimeSummary> {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: '响应不是对象（这不是「没有水位」，请核对服务端接口）' }
  }
  const runtime = (raw as Record<string, unknown>).runtime
  if (runtime === null || typeof runtime !== 'object') {
    return { ok: false, reason: '响应里没有 runtime 段（这不是「没有水位」，请核对服务端接口）' }
  }
  const r = runtime as Record<string, unknown>
  const appLimits = r.app_limits
  return {
    ok: true,
    value: {
      queue: readQueue(r.queue),
      schedulers: readSchedulers(r.schedulers),
      overrideCount:
        appLimits !== null && typeof appLimits === 'object'
          ? readCount((appLimits as Record<string, unknown>).override_count)
          : null,
    },
  }
}

/** 退役真删作业的调度器名（冻结/删除承诺的执行者；这里只读展示它跑没跑）。 */
export const RETIREMENT_SCHEDULER = 'wasm_retirement'

/**
 * 调度器的一句话（`开启/未启动` + tick + 最近错误）。
 *
 * "没跑过"（`last_run_at` 缺失）与"跑了但失败"（`last_error` 非空）必须分开说：
 * 两者在运维面上对应完全不同的动作。
 */
export function schedulerSentence(s: RuntimeSchedulerView): string {
  const parts: string[] = []
  if (s.started === null) parts.push('启动状态未下发')
  else parts.push(s.started ? '运行中' : '未启动')
  if (s.tickSeconds !== null) parts.push(`tick ${s.tickSeconds}s`)
  if (s.lastRunAt !== null) parts.push(`最近运行 ${s.lastRunAt}`)
  else parts.push('尚无运行记录')
  if (s.lastError !== '') parts.push(`最近错误：${s.lastError}`)
  return parts.join(' · ')
}

/** 队列那句话（在跑/排队/429）；缺读数时点名"未下发"而不是写 0。 */
export function queueSentence(q: RuntimeQueueView): string {
  const num = (v: number | null) => (v === null ? '未下发' : String(v))
  return (
    `在跑 ${num(q.globalRunning)} · 排队 ${num(q.waiting)} · ` +
    `429（队列满 ${num(q.rejectedQueueFull)} / 墙钟 ${num(q.rejectedWallClock)}）`
  )
}
