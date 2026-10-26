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
 * 来源徽章文案（F-50，2026-10-26）：与客户端 `capability.sourceOrg/sourceMarket/
 * sourceBuiltin` 逐字对齐。管理端此前把 org 行叫「员工上传」、审批表里叫「组织」，
 * 同一概念两种叫法；客户端用的是「组织」。
 */
export const SOURCE_LABEL = {
  market: '市场',
  org: '组织',
  builtin: '平台内置',
} as const

/**
 * 审核状态文案（F-50）：与客户端 `capability.pending/approved/rejected`
 * （审核中 / 已共享 / 未通过）对齐。**只改展示文案，不改服务端枚举**
 * （DTO 里仍是 pending/approved/rejected）。
 */
export const STATUS_LABEL = {
  pending: '审核中',
  approved: '已共享',
  rejected: '未通过',
} as const

/** 内置技能来源显示：服务端 `source` 是稳定枚举 `builtin`，展示为客户端的「平台内置」。 */
export function builtinSourceLabel(source: string | undefined): string {
  const value = source?.trim() ?? ''
  if (value === '') return ''
  if (value === 'builtin') return SOURCE_LABEL.builtin
  return value
}

/**
 * 下架确认文案（F-21，2026-10-26）：三个管理页共用一份，并与
 * 「删除版本」（不可恢复）/「释放名称」（仅空壳）明确区分 —— 下架只是**停止分发**，
 * 内容和版本都在，随时可以重新上架。
 */
export function delistConfirmText(displayName: string): string {
  return `下架「${displayName}」？\n\n`
    + '下架 = 停止分发（可恢复）：员工目录不可见、不可下载，内容与版本保留；随时可「重新上架」恢复。\n'
    + '下架不是删除：删除版本不可恢复（归档字节释放、版本号永久占位），只有空壳才能「释放名称」。'
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
