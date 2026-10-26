/**
 * 能力中心管理面共用的展示变量（D 系列 P3 收口，2026-10-26）。
 *
 * 为什么单独成文件：同一行在技能/智能体/审批三个页面都要显示，之前每个页面
 * 各写一份 `display_name || name`、`v{version}`、数字格式化与时间格式化，
 * 文案和回退链一旦漂移就会出现"同一行三个页面三种写法"。这里只做纯展示，
 * 不参与任何权限/寻址判断（`name` 才是寻址键）。
 */

/** 展示名回退链：display_name → title（兼容智能体旧字段）→ name。 */
export function displayNameOf(row: { display_name?: string; title?: string; name: string }): string {
  return row.display_name?.trim() || row.title?.trim() || row.name
}

/**
 * 版本显示：没有版本时统一文案。此前技能页写「—」、智能体页写「尚未发布版本」、
 * 审批页直接空，同一状态三种表达。
 */
export function versionText(version: string | undefined): string {
  const value = version?.trim() ?? ''
  return value === '' ? '尚未发布' : `v${value}`
}

/** 下载/调用计数：千分位，避免 12345 与 12,345 混排。 */
export function formatCount(value: number | undefined): string {
  return (value ?? 0).toLocaleString('zh-CN')
}

/**
 * 审批行的上传时间。
 *
 * 服务端下发 `2006-01-02 15:04:05`（服务器本地时间，不带时区）；这里原样解析后
 * 用 zh-CN 展示，并在 `SERVER_TIME_TITLE` 里明确"无时区标记"，不假装是浏览器时区。
 */
export function serverTimeText(value: string): string {
  if (value.trim() === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 时间列的悬停说明：接口未带时区，避免管理员误读成本机时间。 */
export const SERVER_TIME_TITLE = '服务器本地时间（接口未带时区标记）'


/**
 * 版本比较：按点分数字段比较，非数字段回退字符串比较。
 *
 * 只用于管理端“同名多版本只显示最新一张卡”的展示去重，不参与服务端版本校验；
 * 真正的版本递增/永久占位判据在 appstore.Publish。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.trim().split(/[.+-]/)
  const pb = b.trim().split(/[.+-]/)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? ''
    const y = pb[i] ?? ''
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny
      continue
    }
    const byText = x.localeCompare(y)
    if (byText !== 0) return byText
  }
  return 0
}

/**
 * 同名多版本去重：只保留版本最高的那一行（P1 F-06）。
 *
 * 审批队列 `status=approved` 是**每版本一行**；管理端技能/智能体页把它当目录行
 * 直接 push 会渲染出多张同名卡（预览/上传指向旧版）。展示层按 name 去重，
 * 保留版本最高的一行；操作仍然走服务端按 name 寻址的端点。
 */
export function dedupeLatestByName<T extends { name: string; version: string }>(rows: readonly T[]): T[] {
  const latest = new Map<string, T>()
  for (const row of rows) {
    const previous = latest.get(row.name)
    if (previous === undefined || compareVersions(row.version, previous.version) > 0) {
      latest.set(row.name, row)
    }
  }
  return [...latest.values()]
}
