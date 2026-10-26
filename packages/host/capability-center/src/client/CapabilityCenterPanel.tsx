import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Card,
  Chip,
  EmptyState,
  IconTile,
  PANEL_GRID,
  PANEL_SEARCH,
  PANEL_TOOLBAR,
  PanelButton,
  PanelPage,
  SegmentedControl,
  TONE_COLOR,
  icons,
  type PanelTone,
} from '@zeokeel/dsh-panel-surface/client'
import { t, type CapabilityKey } from './locales.ts'
import { compareVersions } from './version-compare.ts'
import { builtinCardsForTab, planBuiltinCards, useBuiltinSkills, type BuiltinCard } from './BuiltinSkillsStrip.tsx'

/**
 * 能力中心（Capability Hub）——技能商城 / 共享技能 / 共享 Agent 的归一入口。
 *
 * ## 信息架构（2026-10-26 现代化重构）
 *
 * 4 个分段：**全部 / 已安装 / 我上传 / 市场**；工具条 = 分段 + 类型 chips +
 * 搜索 + 排序（最近更新 / 名称 / 下载）+ 网格/列表视图 + 结果计数（全部在
 * `PanelPage` 的 toolbar 内）。
 *
 *  - 「已安装」= 磁盘上真的有这一份（`installed` 由磁盘 provenance 判定）；
 *  - 「我上传」= 作者面：服务端 `?source=own` 的行（含 pending/rejected/下架，
 *    **没有本机副本也在**）∪ 本机草稿。这是盘点 F-08 的修法；
 *  - 「市场」= 目录行（市场 + 组织合并，`source !== 'local'`）。
 *
 * 卡片只留：标题（`displayName`，回退 `name`）+ slug 副标题 + 最多两个 Chip +
 * 固定两行描述 + 「版本 · 作者」meta + 一个 primary 动作 + 一个 ghost「详情」。
 * 长状态说明（下架/转交/拒因/审核提示/覆盖后果）**只在详情子视图**里展开——
 * 详情是面板内的整页子视图（`view` 状态），不再是遮住一切的弹层；
 * `CapabilityDetailDialog` 作为兼容导出保留。
 *
 * ## 其它硬约定
 *
 * 复合键：卡片 key 与操作一律用 `{kind}:{name}`——技能名与 preset id 允许同名
 * （如 codeql），归并后必须复合键避免串卡；多个版本经 `mergeItems` 归并成一张卡。
 *
 * ⚠️ 安装端点**不带 `?force=1`**（R2-SK-5）：宿主按 pathname 分发、从不读这个参数，
 * 重装/更新靠安装器的"整树替换"语义；留一个宿主不读的参数面只会让人以为它能强制刷新。
 */

type CapabilityKind = 'skill' | 'agent'
type CapabilitySource = 'market' | 'org' | 'local'
type ItemStatus = 'pending' | 'approved' | 'rejected'

/** 统一视图模型：一个来源一条（同名多版本在服务端/host 已归并为一条，versions 展开）。 */
interface CapabilityItem {
  kind: CapabilityKind
  source: CapabilitySource
  name: string
  displayName: string
  /** 当前展示的版本（来源分区=最高 approved；我的=本地版本/上传版本）。 */
  version: string
  description: string
  author: string
  /** 组织库作者可见的非 approved 状态；undefined = 无上传记录。 */
  status?: ItemStatus | undefined
  reason?: string | undefined
  /** 组织库质量标记（0037）：仅 approved 行有展示语义。 */
  /** 质量(0059 起仅 featured;官方语义移交 official 属性)。 */
  quality?: '' | 'featured' | undefined
  /** 0059 官方:蓝标 + 仅管理员可上传(员工端更新禁用)。 */
  official?: boolean | undefined
  /** 市场排序评分(服务端计算 = calls*3+downloads),客户端直接按此排序。 */
  score?: number | undefined
  downloads?: number | undefined
  calls?: number | undefined
  /** 该名全部 approved 版本（历史版本展开用；不含当前版本则单元素）。 */
  versions: string[]
  /** 已安装（磁盘存在同名目录，且并非本机创作）。 */
  installed: boolean
  /** 已装版本（hasUpdate 比较基准；本地创作时为其版本）。 */
  installedVersion?: string | undefined
  /**
   * 本机那一份的来源（宿主按磁盘上的 provenance 判定，审计 2026-09-23 A2/A3）：
   * `store` = 能力中心装的（更新/卸载直接做）；`local` = 本机自制或来源不明
   * （覆盖/删除前**必须**由用户确认，宿主也会在缺 `?overwrite=1` 时 409 拒绝）。
   */
  installedOrigin?: 'store' | 'local' | undefined
  /**
   * 本机那一份**能不能算作当前账号的**（宿主按服务端「我的」视图下发的归属判据，
   * 第六轮审计 R6-B-1）。
   *
   * 技能库/预设目录是**机器作用域**的（`<DSH_HOME>/skills`，不按账号分目录），
   * 而同机换账号是被支持的操作 ⇒ 磁盘上这一份可能是**别的账号**装的。宿主手里唯一
   * 能证明的事实是：服务端 `?source=own`（author-own 任意状态）里有没有同名同 kind
   * 的行 —— 有 ⇒ 这个名字属于当前账号（`'mine'`）；没有 ⇒ **证明不了**
   * （`'unknown'`：既可能是别人装的，也可能是我装的别人的内容）。
   *
   * 为什么**不发** `'other'`：宿主没有任何事实能证明"这一份是第三方装的"，编一个
   * 出来就是本条 finding 的同一个错（拿未知当已知）。
   *
   * 消费纪律（见 {@link isDelistedItem} 第 3 条）：只有 `'mine'` 才允许走"目录里没有
   * 它 ⇒ 判已下架"的推断，并因此给出**删除本机那一份**的动作；`'unknown'` 一律不判、
   * 不删（判据只回答"能不能从目录更新/上传"，不回答"这份内容还能不能用"）。
   */
  localOwnership?: 'mine' | 'unknown' | undefined
  /** 是否本地创作（「我的」分区用）。 */
  isLocal?: boolean | undefined
  /** 本地创作时是否有上传状态记录（无 = 未上传过）。 */
  uploadStatus?: ItemStatus | undefined
  /** 溯源（D6）：安装来源渠道（market/org）；本地原创时为空。 */
  originChannel?: string | undefined
  /** 溯源：来源应用 ID（即使用户改了目录名也能认出归属）。 */
  originAppId?: string | undefined
  /**
   * 溯源：来源**服务端**——只在"这一份是另一台服务端（另一个部署/租户）装的"时下发
   * （R17B-04）。此时宿主已把它按本机内容处理（更新/删除都要确认），面板只负责把
   * 事实说出来：同名同版本在别的服务端上"已安装"是假象，模型读的是上一租户的内容。
   */
  originServer?: string | undefined
  /** 溯源：安装后内容被本地修改过。 */
  dirty?: boolean | undefined
  /**
   * 本机那一份是库根里的**符号链接**（R17B-01）：运行时照旧加载它，但
   * `packSkill` 有意拒收链接形态（避免把链接目标里的库外文件打进上传包）⇒
   * 这一格不给「上传」按钮，只标"符号链接"。
   */
  originSymlink?: boolean | undefined
  /** 运行时技能名（SKILL.md 的 name）；与 name 不同时需显式提示。 */
  runtimeName?: string | undefined
  /**
   * 是否当前用户归属（2026-09-02 归属权：上传预检据此区分「我的」与「他人」同名）。
   *
   * **三态**（R5-B-2）：`true` = 服务端说归你；`false` = 服务端**明确**说不是你的
   * （归属被转走就是这一档）；`undefined` = 这一行没有下发该字段（本地磁盘行就是
   * 这种情况）—— 未知**不得**被当成"我的"（上传预检仍是 `!== true` 就拦住），
   * 也不得被当成"已转交"（没有事实就不下这个判词）。
   */
  isOwner?: boolean | undefined
  /**
   * 服务端行上的归属人账号（`is_owner === false` 时用来说明"转给谁了"）。
   *
   * ⚠️ **当前员工面契约里没有这个字段**（2026-09-23 核对 `server/internal/capabilities`：
   * `owner` 只在管理端的 `ApprovalRow` 上，员工面的 `CapabilityItem` 只有 `is_owner`）。
   * 保留它是因为"已转交"的**文案**（转给了谁）需要它：服务端一旦在员工面行上补
   * `owner`（json `owner`），客户端不需要再改（{@link isTransferredItem} 的判据仍以
   * `is_owner === false` 为主，本字段只用于显示）。缺省 = 未下发，不编造名字。
   */
  owner?: string | undefined
  /**
   * 服务端在**作者自己的行**上下发的下架标记（`server/internal/capabilities` 的
   * `CapabilityItem.Delisted`，json `delisted`；第五轮审计 R5-B-1 的权威字段）。
   *
   * 语义（服务端泳道的定义）：下架 = **不可分发**，但归属人自己的「我的」分区仍会
   * 返回该行并带 `delisted:true` —— 作者需要看到这个状态，否则管控动作在作者面
   * 没有任何反馈。分发面列出的行恒为 `false`。缺省 = 未下发（不得读成"上架"）。
   */
  delisted?: boolean | undefined
  /**
   * 上架标志（`apps.enabled`）的**兼容**读取口。
   *
   * ⚠️ 当前能力中心的员工面契约用的是 `delisted`（服务端 2026-09-23 定的字段），
   * **没有** `enabled`；这里保留是因为"目录行带 `apps.enabled`"是同一产品另一处
   * （应用中心 `AppCenterItem.enabled`）的既有形态 —— 一旦哪条目录行带它，判据立即
   * 生效，不用再改客户端。缺省是 `undefined` 而不是 `true`：能力中心没有"这一行默认
   * 上架"的知识，把未下发读成"上架"就是拿未知当可用（R5-B-1 的纪律）。
   */
  enabled?: boolean | undefined
  /**
   * 「最近更新」排序用的时间戳（ISO 字符串）。
   *
   * 来源：本机行由宿主按技能/预设目录的 mtime 下发；目录行目前没有该字段（服务端
   * DTO 不带 `updated_at`），`sortItems` 在缺省时按版本号降序兜底 —— 不编造时间。
   */
  updatedAt?: string | undefined
  /** 变更说明（服务端 DTO 目前不下发；`changelog` 有值时详情才渲染那一段）。 */
  changelog?: string | undefined
  /**
   * 面板取数时打的**来源分区标记**（`applySectionRows` 用它替换「上一次 own 分区」
   * 的行；服务端载荷没有这个字段，渲染层也不读它）。
   */
  section?: 'mine' | 'market' | 'own' | undefined
}

/** 面板信息架构的四个分段（2026-10-26 重构：全部 / 已安装 / 我上传 / 市场）。 */
export type SourceTab = 'all' | 'installed' | 'own' | 'market'
/** 类型筛选（全部 / 技能 / 智能体）。 */
export type TypeFilter = 'all' | CapabilityKind
/** 排序键（最近更新 / 名称 / 下载）。 */
export type SortKey = 'updated' | 'name' | 'downloads'
/** 视图模式（网格 / 列表）。 */
export type ViewMode = 'grid' | 'list'


/** 顶部 Tab 条：来源分区 + 类型筛选。 */
/**
 * 类型筛选片（全部 / 技能 / 智能体）。
 *
 * 只给几何：颜色与 `[data-active]` / `:hover` 反馈由共享样式表的 `.zeokeel-chipbtn`
 * 负责 —— 颜色写进行内联样式就再也做不出悬停态（本仓的既定分工）。
 */
const FILTER: React.CSSProperties = {
  padding: '3px 11px',
  fontSize: 12,
  borderRadius: 999,
  margin: 0,
}



/** 网格里的一张能力卡（纵向排布，动作条贴底）。 */
const CARD: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '14px 15px',
  borderRadius: 14,
}

const TITLE_ROW: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }
const NAME: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)', lineHeight: '20px' }
const META: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-caption)', margin: 0, lineHeight: '16px' }
const DESC: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  cursor: 'pointer',
}

/**
 * 卡片里的描述：**固定两行**。
 *
 * 2026-09-20 用户口径：「能力中心里描述超长」—— 原来是三行 + 点击就地展开，展开后
 * 卡片变高、把整行栅格一起撑开，同一行相邻卡片出现大片空白。现在卡片里只留两行，
 * **全文去详情弹层看**（网格高度恒定）。
 */
const DESC_CLAMP: React.CSSProperties = {
  ...DESC,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

// 头像底色：直接用**会随主题翻转**的 alias token。
// 2026-09-16 审计：原先写成 `var(--dsw-static-deepseek-5, var(--dsw-alias-brand-primary))`
// 这种两层写法，外层名字在上游**不存在**（静态色板是 100/400/500 这类三位刻度，
// 没有 `-5`）⇒ 永远落到内层 alias，等于白写一层；直接写内层才是可读的真源，
// 也避免"看着像静态色、实际是主题色"的误导。
const AVATAR_COLORS = [
  'var(--dsw-alias-brand-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-warn-label)',
  'var(--dsw-alias-label-tertiary)',
]

/** 按名称+类型确定头像颜色（稳定；导出供单测）。 */
export function avatarColor(name: string): string {
  if (name === '') return AVATAR_COLORS[0] ?? 'var(--dsw-alias-brand-primary)'
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0]!
}

const NAME_COL: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }
const NAME_WRAP: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }
const CARD_FOOT: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 'auto',
  paddingTop: 10,
  borderTop: '1px solid var(--dsw-alias-border-l1)',
}

/** 自制徽章(紫, 与官方蓝/来源灰区分)。 */
// 自制/本地来源徽章：原先写死紫色 #7C3AED，两主题同值 —— 暗色下面板底
// (bg-layer-2 = rgb(44,44,46)) 上只有 2.45:1（2026-09-16 暗色审计）。
// 上游没有紫色语义 token，改用会翻转的三级文字色，靠文案「自制」区分来源。

/**
 * 单测用：数值感知版本比较 —— 实现已抽到 `version-compare.ts`（内置技能区
 * BuiltinSkillsStrip 也要用它，而 panel 渲染 strip，反向 import 会成环）。
 * 这里 re-export 保持既有调用面不变。
 */
export { compareVersions } from './version-compare.ts'

/** 根据（kind, name）取最高 approved 版本（数值感知）。 */
export function latestApprovedVersionByName(items: readonly CapabilityItem[], kind: CapabilityKind, name: string): string | undefined {
  const versions = items.filter(i => i.kind === kind && i.name === name && i.status === 'approved').map(i => i.version)
  if (versions.length === 0) return undefined
  return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best), versions[0]!)
}

/** 是否应显示「更新到 vX」：approved 最高版本 > 已装版本。 */
export function hasUpdateFor(item: CapabilityItem): boolean {
  if (!item.installed) return false
  const latest = item.versions.length > 0 ? item.versions[item.versions.length - 1] : undefined
  if (latest === undefined || item.installedVersion === undefined) return false
  return compareVersions(latest, item.installedVersion) > 0
}

/**
 * 「哪个分段显示哪些条目」的**唯一实现**。
 *
 * 2026-10-26 信息架构重构后四个分段是 `all / installed / own / market`：
 *  - `market`：目录行（市场 + 组织合并结果，`source !== 'local'`）—— 与旧「市场」一致；
 *  - `installed`：磁盘上真的有这一份（`installed === true`）；
 *  - `own`：**我上传**的内容 —— 归属人自己的目录行（服务端 `?source=own`，含
 *    pending/rejected，**没有本机副本也在**）∪ 本机草稿（`source === 'local'` 且
 *    没有商店溯源）。判据见 {@link isOwnUploadItem}；
 *  - `all`：全部（三个来源的并集，卡片去重交给 `mergeItems`）。
 *
 * **兼容面**：旧调用 `itemsForTab(rows, 'mine')` 仍是 2026-08-25 定案的语义
 * （本机创作 + 已安装的来源条目），既有回归用例逐字不动。新 UI 不再使用 `'mine'`。
 * @param items - 行（可以尚未归并）。
 * @param tab - 分段（含兼容的旧 `'mine'`）。
 * @returns 该分段可见的行（保持输入顺序）。
 */
export function itemsForTab<T extends {
  source?: string | undefined
  installed?: boolean | undefined
  isOwner?: boolean | undefined
  originChannel?: string | undefined
  uploadStatus?: string | undefined
}>(
  items: readonly T[],
  tab: SourceTab | 'mine',
): T[] {
  if (tab === 'market') return items.filter(i => i.source !== 'local')
  if (tab === 'all') return [...items]
  if (tab === 'installed') return items.filter(i => i.installed === true)
  if (tab === 'own') return items.filter(i => isOwnUploadItem(i))
  return items.filter(i => i.source === 'local' || i.installed === true)
}

/**
 * 这一行算不算「我上传」（`own` 分段的判据，**唯一实现**）。
 *
 * 两档来源（2026-10-26 F-08）：
 *  1. **目录里的作者行**：服务端 `?source=own` 下发的行 `is_owner: true` —— 它包含
 *     pending / rejected / 已下架，**不要求本机有副本**。这是"作者看不到自己的待审
 *     行"的修法：旧实现只请求 market/local，own 仅用于匹配本机行的状态；
 *  2. **本机草稿**：`source === 'local'` 且没有商店溯源（不是从目录装进来的）——
 *     用户写好还没上传的那一份；它没有 `is_owner`（服务端还不知道它）。
 *
 * 注意 `installedOrigin === 'store'` 的本机行**不算**我上传（那是从别人那里装来的，
 * 属于「已安装」）。`uploadStatus` 有值的本机行算（作者自己上传过的记录还在）。
 * @param item - 一行（归并前后均可）。
 * @returns 出现在「我上传」分段 ⇒ true。
 */
export function isOwnUploadItem(item: {
  source?: string | undefined
  isOwner?: boolean | undefined
  originChannel?: string | undefined
  uploadStatus?: string | undefined
}): boolean {
  if (item.isOwner === true) return true
  if (item.source !== 'local') return false
  return item.originChannel === undefined || item.uploadStatus !== undefined
}

/**
 * 按分段/类型/搜索排序后的列表（**唯一排序实现**）。
 *
 * `updated`（最近更新）的口径：有 `updatedAt` 的行按时间降序；缺时间戳的行按版本号
 * 降序兜底（服务端 DTO 不带时间，**不编造**）—— 同档再按展示名。`name` / `downloads`
 * 与旧实现保持同一批字段，只是把"来源分区固定排序"换成用户可选排序。
 * @param items - 已过滤的行。
 * @param sort - 排序键。
 * @returns 新数组（不改输入）。
 */
export function sortItems(items: readonly CapabilityItem[], sort: SortKey): CapabilityItem[] {
  const title = (item: CapabilityItem): string => item.displayName !== '' ? item.displayName : item.name
  return [...items].sort((a, b) => {
    if (sort === 'downloads') {
      const byDownloads = (b.downloads ?? 0) - (a.downloads ?? 0)
      if (byDownloads !== 0) return byDownloads
      return title(a).localeCompare(title(b)) || a.name.localeCompare(b.name)
    }
    if (sort === 'name') return title(a).localeCompare(title(b)) || a.name.localeCompare(b.name)
    // updated：时间戳优先，缺省按版本号（"最近更新的版本"是唯一端到端可比的事实）。
    if (a.updatedAt !== undefined || b.updatedAt !== undefined) {
      const at = a.updatedAt ?? ''
      const bt = b.updatedAt ?? ''
      if (at !== bt) return at < bt ? 1 : -1
    }
    const byVersion = compareVersions(b.version, a.version)
    if (byVersion !== 0) return byVersion
    return title(a).localeCompare(title(b)) || a.name.localeCompare(b.name)
  })
}


/** 取数分区：市场（市场+组织合并结果）/ 本机（已装 + 本地创作）/ 我上传（own）。 */
export type SectionKey = 'mine' | 'market' | 'own'

/**
 * 一次分区取数回来后如何并进现有列表（**唯一实现**）。
 *
 * 决策 2026-08-25：「市场」tab 承载 market+org 合并结果 —— 加载 market 时清除
 * 两源旧条目；「我的」只清 local（其余保留：`?source=local` 的载荷里同时带
 * 商店已装行与本机行）。2026-10-26 追加 `own`（我上传）分区：它只清**上一次 own
 * 取数**打上 `section: 'own'` 标记的行，不碰市场/本机行 —— own 行与市场行同名时
 * 由 `mergeItems` 归并，而不是互相覆盖。
 *
 * 抽成纯函数是为了让「多种到达顺序」可被单测直接驱动（独立复审 2026-09-23 N1）：
 * 本包没有 jsdom/渲染测试面，而这条归约是多次并发取数唯一的合流点 —— 它在
 * `setItems` 的 updater 里时，谁也没法在没有 React 的情况下复现各分区先后到达。
 * @param prev - 当前列表。
 * @param key - 回来的那个分区。
 * @param rows - 该分区的行。
 * @returns 合并后的列表。
 */
export function applySectionRows(
  prev: readonly CapabilityItem[],
  key: SectionKey,
  rows: readonly CapabilityItem[],
): CapabilityItem[] {
  if (key === 'own') {
    const tagged = rows.map(row => ({ ...row, section: 'own' as const }))
    return [...prev.filter(i => i.section !== 'own'), ...tagged]
  }
  const drop = key === 'market'
    ? (i: CapabilityItem) => i.source !== 'local' && i.section !== 'own'
    : (i: CapabilityItem) => i.source === 'local'
  return [...prev.filter(i => !drop(i)), ...rows]
}


/** 单测用：按（kind, source）解析安装端点。
 * 市场技能只存在于服务端 skills/marketplace 表,必须走 /api/zeokeel/skills 代理
 * (网关 marketplace /archive);共享技能走 shared-skills 代理(带版本);
 * 智能体走 agent-presets 代理。合并面板时(57aeffecbb)曾把市场技能误路由
 * 到 shared-skills 端点 → 网关 404 → 面板「操作失败:gateway error」。
 *
 * ⚠️ 端点**本身不带 query 参数**（R2-SK-5）：路径由本函数拼，`?overwrite=1` 由
 * {@link withOverwrite} 在"用户已在确认条上确认过"之后加上 —— 宿主**真的读**它
 * （审计 2026-09-23 A2/A3/A15 的两端契约），缺它时拒绝覆盖本机自制内容（409
 * `LOCAL_CONTENT`）。这与历史上的 `?force=1` 不同：那一个谁都没读，是死面。
 */
export function installEndpoint(item: CapabilityItem, version: string): string {
  let base: string
  if (item.kind === 'skill') {
    base = item.source === 'market'
      ? `/api/zeokeel/skills/${encodeURIComponent(item.name)}/install`
      : `/api/zeokeel/shared-skills/${encodeURIComponent(item.name)}/${encodeURIComponent(version)}/install`
  } else {
    base = `/api/zeokeel/agent-presets/${encodeURIComponent(item.name)}/install`
  }
  return base
}

/**
 * 「按版本安装」是否真的能装到指定版本（审计 2026-09-23 A11）。
 *
 * 只有**组织共享技能**的端点把版本写进路径
 * （`/api/zeokeel/shared-skills/:name/:version/install`）。市场技能与智能体的端点
 * 都不带版本（市场归档端点只按"当前 approved 最高版"取），所以对它们渲染
 * 「v1 / v2」按钮是**假入口**：点 v1 装到的还是最新版，界面却按 v1 记账。
 * @param item - 能力中心的一行。
 * @returns 支持按版本安装为 true。
 */
export function versionInstallSupported(item: CapabilityItem): boolean {
  return item.kind === 'skill' && item.source === 'org'
}

/**
 * 覆盖确认的判据（审计 A2/A3/A15 + 第四轮 R4-B-3）。
 *
 * 返回 true 时面板先出确认条、用户点过之后才把 `?overwrite=1` 发给宿主；
 * 宿主侧对同一种情形没有标记就 409 `LOCAL_CONTENT`（两端同一份规则，见
 * auth-gate 的 `/api/zeokeel/skills` 分支注释与安装器的
 * `requiresOverwriteConfirmation`）。
 *
 * 两档成因（**同一份事实的两种读法，不是两套判据**）：
 *  - `installedOrigin !== 'store'`：本机那一份不是能力中心装的（用户自制 /
 *    来源不明）；
 *  - `dirty === true`（R4-B-3）：**商店来源但被本地修改过** —— 磁盘上的内容哈希
 *    与安装时记的 `archiveChecksum` 不一致。它同时是"商店来源"和"里面装着用户的
 *    字节"：旧判据只看来源，于是「更新到 vX」一次单击就把用户加的文件与改过的正文
 *    整树删掉 —— 而卡片上还挂着「已本地修改」徽章（有徽章、无后果提示）。
 *    `dirty` 由宿主按磁盘事实算出（`isInstalledSkillDirty`，与宿主闸门同源）。
 * @param item - 能力中心的一行。
 * @returns 覆盖前需要用户确认。
 */
export function needsOverwriteConfirm(item: CapabilityItem): boolean {
  return item.installed === true && (item.installedOrigin !== 'store' || item.dirty === true)
}

/** 覆盖确认条的措辞档位（三选一，见 {@link overwriteConfirmReason}）。 */
export type OverwriteConfirmReason = 'local' | 'dirty' | 'store'

/**
 * 确认条该说哪一句（**唯一判定**）。
 *
 * 抽成纯函数的理由与 `needsOverwriteConfirm` 相同：措辞决定用户是否知道"按下去会
 * 丢什么"。`dirty` 档（R4-B-3）必须与"用户自制"分开 —— 前者丢的是**你自己改过的
 * 那部分**，后者丢的是**你写的一整份技能**，用户要据此决定按不按。
 * @param item - 能力中心的一行。
 * @returns `local` / `dirty` / `store`。
 */
export function overwriteConfirmReason(item: CapabilityItem): OverwriteConfirmReason {
  if (item.installedOrigin !== 'store') return 'local'
  return item.dirty === true ? 'dirty' : 'store'
}

/** 确认条要显示的那一行状态（{@link PendingInstall} 的最小子集，便于单测）。 */
export interface ConfirmStripInput {
  name: string
  /** 兼容字段：没有 `reason` 的历史调用按它推档（true ⇒ `local`）。 */
  localConflict: boolean
  reason?: OverwriteConfirmReason | undefined
}

/** 确认条的措辞档位（`reason` 优先；缺省按 `localConflict` 推）。 */
function confirmStripReason(input: ConfirmStripInput): OverwriteConfirmReason {
  return input.reason ?? (input.localConflict ? 'local' : 'store')
}

/**
 * 确认条正文（**唯一实现**；三档措辞见 {@link overwriteConfirmReason}）。
 * @param input - 待确认的那一发。
 * @returns 当前界面语言下的提示文案。
 */
export function confirmStripText(input: ConfirmStripInput): string {
  const reason = confirmStripReason(input)
  if (reason === 'local') return t('capability.conflictConfirmLocal', { name: input.name })
  if (reason === 'dirty') return t('capability.conflictConfirmDirty', { name: input.name })
  return t('capability.conflictConfirm', { name: input.name })
}

/**
 * 确认条的按钮文案（与 {@link confirmStripText} 同档）。
 * @param input - 待确认的那一发。
 * @returns 当前界面语言下的按钮标签。
 */
export function confirmStripAction(input: ConfirmStripInput): string {
  const reason = confirmStripReason(input)
  if (reason === 'local') return t('capability.forceInstallLocal')
  if (reason === 'dirty') return t('capability.forceInstallDirty')
  return t('capability.forceInstall')
}

/** 给写面端点加上"用户已确认覆盖/删除本机内容"的显式标记。 */
export function withOverwrite(url: string, overwrite: boolean): string {
  if (!overwrite) return url
  return `${url}${url.includes('?') ? '&' : '?'}overwrite=1`
}

/**
 * 一次**卸载**请求的 URL（唯一拼装入口，与 {@link installRequestUrl} 同档）。
 *
 * 第二半的 `?ownership=unknown`（C2-1）只在归并后的行**证明不了归属**时出现
 * （{@link CapabilityItem.localOwnership} ≠ `'mine'`）——宿主据此**不写**随包技能的
 * 机器级墓碑（`<skills>/.skill-removed/<name>.json`），即"删了还会回来"的安全失败模式。
 *
 * 为什么这个事实必须由面板带过去：归属是聚合面用服务端 `?source=own` 匹配算出来的
 * （技能库是机器作用域的，卸载路由不出网、自己判不出）。与 `?overwrite=1` 同一条既有
 * 模式：面板给"宿主单独判不出的那个事实"，宿主仍是权威（只认字面值 `unknown`）。
 *
 * ⚠️ 它**不改变**"plugin 行是否给卸载"这个 UI 承诺（{@link planCardAction} 的输出逐字
 * 不变，端点串也不变）：只影响"这次删除要不要成为机器级永久偏好"。
 * @param item - 能力中心的一行（归并后的行，`localOwnership` 由 {@link mergeItems} 归一）。
 * @param opts - `overwrite: true` = 用户已在第二段确认里点过。
 * @returns 请求 URL。
 */
export function uninstallRequestUrl(item: CapabilityItem, opts?: { overwrite?: boolean | undefined }): string {
  const base = withOverwrite(uninstallEndpoint(item, item.version), opts?.overwrite === true)
  if (item.localOwnership === 'mine') return base
  // 证明不了归属（含字段缺失 ⇒ `mergeItems` 已归一成 'unknown'）⇒ 带上提示。
  // market/org 行宿主不写墓碑，多带一个参数是惰性的；本机 plugin 行才是它的作用面。
  return `${base}${base.includes('?') ? '&' : '?'}ownership=unknown`
}

/**
 * 这一发安装是否必须先弹确认条（**唯一判定入口**）。
 *
 * 抽成纯函数是为了让"确认条可达"这条契约可被单测打坏（审计 A15：旧实现里
 * 更新按钮硬编码 force，确认条永远是死代码，而纯渲染层没有任何用例能抓到）。
 * @param item - 能力中心的一行。
 * @param opts - 调用方的选项（`overwrite: true` = 用户已在确认条上点过）。
 * @returns 需要先确认。
 */
export function installNeedsConfirm(item: CapabilityItem, opts?: { overwrite?: boolean | undefined }): boolean {
  return opts?.overwrite !== true && needsOverwriteConfirm(item)
}

/**
 * 一次安装请求的 URL（**唯一拼装入口**）。
 *
 * `?overwrite=1` 只在"用户已确认"时出现 —— 宿主缺它就会拒绝覆盖本机自制内容
 * （409 `LOCAL_CONTENT`）。版本取用户点选的那一个，否则取当前展示版本。
 * @param item - 能力中心的一行。
 * @param opts - 调用方的选项（overwrite / 用户点选的版本）。
 * @returns 请求 URL。
 */
export function installRequestUrl(
  item: CapabilityItem,
  opts?: { overwrite?: boolean | undefined, version?: string | undefined },
): string {
  const version = opts?.version ?? item.version
  return withOverwrite(installEndpoint(item, version), opts?.overwrite === true)
}

/**
 * 本机技能库里那一份"来源是随包/平台"的技能，卸载走哪条端点（审计 A6 + 跨泳道契约 S2）。
 *
 *  - `builtin`（平台内置，服务端下发）⇒ `POST /api/zeokeel/skills/builtin/:name/uninstall`
 *    —— 这条路由是本次新增的（此前内置技能只能装不能卸）；
 *  - `plugin`（随客户端内置，如随包插件同步进来的技能）⇒ `POST /api/zeokeel/skills/:name/uninstall`
 *    —— 该端点本就是纯本地删除。
 * @param item - 能力中心的一行。
 * @returns 端点路径；不适用（不是这两种来源）时为 undefined。
 */
export function localRemoveEndpoint(item: CapabilityItem): string | undefined {
  if (item.kind !== 'skill') return undefined
  const name = encodeURIComponent(item.name)
  if (item.originChannel === 'builtin') return `/api/zeokeel/skills/builtin/${name}/uninstall`
  if (item.originChannel === 'plugin') return `/api/zeokeel/skills/${name}/uninstall`
  return undefined
}

/** 卡片页脚那一格该出什么（{@link planCardAction} 的返回值）。 */
export type CardActionPlan =
  | { kind: 'uninstall', endpoint: string, localContent: boolean }
  | { kind: 'update', version: string }
  | { kind: 'install' }
  | { kind: 'upload' }
  | { kind: 'reupload' }
  | { kind: 'review', status: ItemStatus }
  /** 归属已转交（R5-B-2）：这一格没有可达动作，只报状态。 */
  | { kind: 'transferred' }
  /** 已下架且本机没有可卸的那一份（R5-B-1）：同样只报状态。 */
  | { kind: 'delisted' }
  /** 库根里的**符号链接**形态（R17B-01）：运行时会加载，但打包/上传入口有意拒收 ⇒ 不给假按钮。 */
  | { kind: 'linked' }

/**
 * 本机这一份是不是"从目录装进来的那一份"（{@link isDelistedItem} 推断判据的一半）。
 *
 * 只认**目录渠道**（`market` / `org`）：`builtin` / `plugin` 是随包内容，
 * 本来就不在能力中心目录里，把它们算进来会让平台内置技能恒显示「已下架」。
 * 两个字段都是磁盘 provenance 的消费端（auth-gate 的本机行），与安装器/卸载器的
 * `isStoreProvenance` 同源。
 */
function catalogSourcedLocal(item: Pick<CapabilityItem, 'installedOrigin' | 'originChannel'>): boolean {
  return item.installedOrigin === 'store' && (item.originChannel === 'market' || item.originChannel === 'org')
}

/**
 * 这一行当前**不在可用目录中**（下架 / 授权撤回 / 已转走）—— 三条判据，前两条是
 * 服务端下发的事实，第三条是**只在能证明属于当前账号时**才允许的客户端推断：
 *
 *  1. **权威判据（作者面）**：服务端在作者自己的行上下发了 `delisted: true`
 *     （`CapabilityItem.Delisted`，R5-B-1 的服务端泳道新增字段）；
 *  2. **权威判据（目录面）**：服务端在行上下发了 `enabled: false`（下架行不再被
 *     服务端滤掉时就是这一档，客户端无需再改）；
 *  3. **推断判据**：这是一张**归并后 `source === 'local'`** 的本机行，带着目录渠道的
 *     商店溯源（{@link catalogSourcedLocal}），**且宿主能证明它属于当前账号**
 *     （`localOwnership === 'mine'`）。
 *
 * 第 2 条为什么成立：{@link mergeItems} 的权威序是 市场 > 组织 > 本机 —— 只要目录里
 * 还有同名同 kind 的一行，归并结果的 `source` 就**不可能**是 `local`。于是
 * "source === 'local' + 商店溯源"等价于"这份内容是从目录装进来的、而目录里已经没有
 * 它了"（R5-B-1：下架后员工面 market/org/own 三个来源同时为空，只剩磁盘本机行）。
 *
 * ⚠️ **第 3 条为什么必须加归属这一维（第六轮审计 R6-B-1）**：技能库是**机器作用域**
 * 的（`<DSH_HOME>/skills`，不按账号分目录），同机换账号又是被支持的操作。于是"本机有
 * 一份商店内容、当前账号在 own/market 两个视图里都看不到它"这个形状**同时**对应两种
 * 完全不同的处境：
 *   - 它确实是当前账号的内容（作者面 `delisted` 未下发的旧服务端；或授权被撤回），
 *     或
 *   - 它是**另一个账号**在这台机器上装的（当前账号既不是作者、也没有授权）。
 * 只看"目录里没有它"无法区分两者，修复前的版本会把后者也说成"可能已被管理员下架"，
 * 并把页脚换成**删除本机那一份**——一个跨账号的破坏性动作。归属判据由宿主下发
 * （{@link CapabilityItem.localOwnership}，来自服务端 `?source=own` 的匹配结果），
 * 证明不了（`'unknown'`）就**不下判词**：不标已下架、也不给删除类动作。
 *
 * 判据只回答"还能不能从目录更新/上传"，**不**回答"这份内容还能不能用"：磁盘上这一份
 * 照常可用、照常渲染，只是不再出现"上传/更新"这种已达不成的动作。
 * @param item - 能力中心的一行（必须是**归并后**的行，见上）。
 * @returns 明确不在目录中且属于当前账号 ⇒ `true`；其余（含未知）⇒ `false`。
 */
export function isDelistedItem(
  item: Pick<
    CapabilityItem,
    'source' | 'delisted' | 'enabled' | 'installedOrigin' | 'originChannel' | 'localOwnership'
  >,
): boolean {
  if (item.delisted === true) return true
  if (item.enabled === false) return true
  return item.source === 'local' && catalogSourcedLocal(item) && item.localOwnership === 'mine'
}

/**
 * 归属已被转交给别人（R5-B-2）：服务端**明确**说这一行不归当前用户
 * （`is_owner === false`），而本机还留着"我上传过"的记录
 * （{@link CapabilityItem.uploadStatus} 有值）。
 *
 * 为什么必须同时看 `uploadStatus`：任何"别人上传、我装进来"的商店行
 * `is_owner` 同样是 `false`，只看它会把每一份装来的内容都写成「已转交」。
 *
 * **不拿 `author` 兜底**（R5-B-2 的纪律）：`author` 是发布者，归属转移之后它仍然是
 * 旧作者的名字 —— 用本地这份缓存去推归属正是这条 finding 的成因。
 * @param item - 能力中心的一行（归并后的行）。
 * @returns 已转交 ⇒ `true`。
 */
export function isTransferredItem(item: Pick<CapabilityItem, 'isOwner' | 'uploadStatus'>): boolean {
  return item.isOwner === false && item.uploadStatus !== undefined
}

/**
 * 卡片页脚动作的**唯一判定实现**（渲染层只按它 map，不再自己算一遍）。
 *
 * 抽成纯函数的理由（独立复审 2026-09-23 A6/N1）：本包没有 jsdom/渲染测试面，
 * 而这正是 A6 的验收点 ——「同名商店行存在时仍渲染「随客户端内置」徽章 + 卸载按钮」。
 * 埋成 JSX 嵌套三元时，`mergeItems` 吞掉本机行字段造成的"页脚退化成「安装」"
 * 没有任何用例能打坏（审计探针只能逐字复刻这两处分支）。
 *
 * 两条口径（与 {@link localRemoveEndpoint} / `needsOverwriteConfirm` 同源）：
 *  - `source === 'local'`（本机创作，含 builtin/plugin 同步进来的那一份）：
 *    平台/随包内置的技能出「卸载」（审计 A6）；**已转交**（R5-B-2）与**不在目录中**
 *    （R5-B-1/B-3，**且能证明属于当前账号**，R6-B-1）两态各自出状态/卸载，
 *    **绝不出「上传」**；其余按上传状态出上传/等审/重传；
 *  - 商店行：未装出「安装」，有新版出「更新到 vX」（**不传 force**，A15），
 *    **归属人且已装**（且非官方/非下架）出「上传新版」（task-4），否则出「卸载」。
 *
 * task-4 的商店行上传档为什么必须存在：`mergeItems` 的权威序是 市场 > 组织 > 本机，
 * 技能一上架卡片就变成商店行，修前的「上传」只在 `source === 'local'` 命中 ⇒ 作者
 * 上架后再也发不了新版。服务端本轮起作者面会下发 market 渠道的 own 行（含待审），
 * 所以这一档在市场上也看得见待审状态。
 *
 * 删除类动作的**准入条件**（R6-B-1）：本机那一份必须能证明属于当前账号
 * （{@link CapabilityItem.localOwnership} = `'mine'`，或服务端下发了权威的
 * `delisted`/`enabled`）。证明不了的行**一律不出**「卸载」—— 技能库是机器作用域的，
 * 删掉的很可能是同机**另一个账号**装的那一份。
 * @param item - 能力中心的一行（归并后的行）。
 * @returns 页脚动作。
 */
export function planCardAction(item: CapabilityItem): CardActionPlan {
  if (item.source === 'local') {
    const removable = localRemoveEndpoint(item)
    if (removable !== undefined) {
      return { kind: 'uninstall', endpoint: removable, localContent: needsOverwriteConfirm(item) }
    }
    // R5-B-2 先于上传档：归属已经不在自己名下（服务端 `is_owner:false`）时，
    // 「上传 / 重新上传」是**已达不成**的动作（服务端 409 NAME_TAKEN）。这一格
    // 只报状态，不再造假按钮。
    if (isTransferredItem(item)) return { kind: 'transferred' }
    // R5-B-1/B-3：目录里已经没有这一行（下架 / 授权撤回）时，本机这一份**仍然
    // 可用**，但"上传"要么注定失败、要么（下架期间服务端放行上传时）只是让作者
    // 在完全不知情的状态下反复提交。改成**真的可达**的那一个动作：本地卸载
    // （{@link uninstallEndpoint} 对技能走 shared-skills、对智能体走
    // agent-presets —— 两条都是既有端点，零新增接口）。是否为"用户自己的内容"
    // 仍由 needsOverwriteConfirm 决定要不要先确认一次。
    //
    // ⚠️ 这一格**只在能证明本机那一份属于当前账号时**才可能命中（R6-B-1）：
    // `isDelistedItem` 的第 3 条判据要求 `localOwnership === 'mine'`。证明不了
    // （`'unknown'`，例如"同事在这台机器上装的商店技能"）时落到下面的上传档：
    // 那是一个**无副作用**的动作（服务端会以名称占用拒掉），而删除**别人**装在
    // 这台机器上的那一份是有后果的跨账号动作。
    if (isDelistedItem(item)) {
      return {
        kind: 'uninstall',
        endpoint: uninstallEndpoint(item, item.version),
        localContent: needsOverwriteConfirm(item),
      }
    }
    // R17B-01：符号链接形态（运行时加载得到、但打包入口有意拒收）⇒ 只报事实。
    // 位置在"转让/下架/可卸载"三档之后：本机若真有规范落点可卸，卸载仍是可达动作。
    if (item.originSymlink === true) return { kind: 'linked' }
    if (item.uploadStatus === 'rejected') return { kind: 'reupload' }
    if (item.uploadStatus === 'pending') return { kind: 'review', status: 'pending' }
    if (item.uploadStatus === 'approved') return { kind: 'review', status: 'approved' }
    return { kind: 'upload' }
  }
  if (isDelistedItem(item)) {
    // 目录行上的下架（服务端 `enabled:false`）：**不给**「安装」—— 装了也不会与
    // 目录一致，而下架对使用者等价于"不存在"；本机已经有一份时给「卸载」（可达），
    // 否则这一格只报状态（与应用中心「已下架 + 禁用打开」同形态）。
    return item.installed
      ? { kind: 'uninstall', endpoint: uninstallEndpoint(item, item.version), localContent: needsOverwriteConfirm(item) }
      : { kind: 'delisted' }
  }
  if (!item.installed) return { kind: 'install' }
  // task-4：**商店行 + 归属人 + 已安装 ⇒ 上传新版**。
  //
  // 这是"上架后作者再也发不了新版"的修法：`mergeItems` 的权威序是 市场 > 组织 >
  // 本机，技能一上架，卡片就从本机行变成商店行，而修前的「上传」只在
  // `source === 'local'` 命中 ⇒ 作者上架后上传入口消失（`upload()` 里的 `isOwner`
  // 预检成了死代码）。服务端契约（本轮）：非管理员对**任意渠道**的自己归属的 App
  // 发新版本 ⇒ 收下为 pending（market 渠道同样要管理员审核后生效）；非归属人 ⇒
  // 409 NAME_TAKEN。
  //
  // 守卫与顺序（三档**绝不**出上传，不得为了变绿放宽）：
  //  - `isDelistedItem` 在前（上一档）：下架/撤权期间上传注定被服务端拒（409
  //    APP_DELISTED），给按钮只是让作者反复提交；
  //  - `!installed` 在前：没有本机内容时上传没有可打包的东西 ⇒ 仍是「安装」；
  //  - `official === true` 排除：官方内容只有管理员能发版，客户端证明不了这件事，
  //    与「更新」按钮对 official 的置灰口径一致；
  //  - 位置在 `hasUpdateFor` **之前**（见 {@link CardActionPlan} 那一档的取舍）：
  //    「更新到 vX」是**非归属人**的档，归属人的卡片承载"发新版"。
  //  - `isTransferredItem` 只对 local 行生效，这一段不改它（商店行的 `is_owner:false`
  //    本来就被 `isOwner === true` 这一条排除）。
  if (item.isOwner === true && item.official !== true) return { kind: 'upload' }
  if (hasUpdateFor(item)) {
    return { kind: 'update', version: item.versions[item.versions.length - 1] ?? item.version }
  }
  return {
    kind: 'uninstall',
    endpoint: uninstallEndpoint(item, item.version),
    localContent: needsOverwriteConfirm(item),
  }
}

/**
 * 「上传」按钮的文案键（task-4）——**唯一实现**：本机行 = 「上传共享」（既有产品动作，
 * 文案逐字不变）；商店行 = 「上传新版」（同一个 `upload()`，区别只在语义：
 * 前者是首次共享，后者是给已上架的条目发新版本）。
 * @param item - 能力中心的一行（归并后的行）。
 * @returns 文案的字典键。
 */
export function uploadActionLabelKey(item: Pick<CapabilityItem, 'source'>): 'capability.upload' | 'capability.uploadNew' {
  return item.source === 'local' ? 'capability.upload' : 'capability.uploadNew'
}

/**
 * 卡片里那条「市场技能的新版本需管理员审核后生效」是否出现（task-4）。
 *
 * 只对**真的给出「上传新版」的那一格**出现，且只限 market 渠道 + 归属人：
 *  - 组织渠道的新版本由本组织管理员审，不是市场审核 ⇒ 不提示；
 *  - 非归属人 / 官方 / 下架 / 未安装 ⇒ 页脚根本没有上传动作 ⇒ 不提示（否则会出现
 *    "卡片说要审核、页脚却没有上传按钮"的自相矛盾 —— 与 R5-B-1/B-2 同形的假入口）。
 * @param item - 能力中心的一行（归并后的行）。
 * @returns 出现 ⇒ `true`。
 */
export function showsMarketReviewHint(item: CapabilityItem): boolean {
  if (item.source !== 'market' || item.isOwner !== true) return false
  return planCardAction(item).kind === 'upload'
}

/** 「来源」徽章可能用到的字典键（**六选一**，见 {@link capabilitySourceBadgeKey}）。 */
export type CapabilitySourceBadgeKey =
  | 'capability.sourceLocal'
  | 'capability.sourceOrg'
  | 'capability.sourceBuiltin'
  | 'capability.sourcePlugin'
  | 'capability.sourceMarket'
  | 'capability.sourceOther'

/**
 * 「来源」徽章该显示哪一个（**唯一实现**）。
 *
 * 2026-09-20 修的真实 UI bug：原先「我的」分区同时渲染 `source` 徽章与
 * `mineSourceBadge`，匿名路径下两张都写「自制」—— 卡片上出现两个一模一样的胶囊。
 * 现在按分区二选一：市场分区用来源（市场/组织），我的分区用「这份内容是怎么来的」
 * （自制 / 来自组织 / 平台内置 / 来自市场 / 其它）。
 *
 * 抽成纯函数的理由（独立复审 2026-09-23 A6）：这两条分支此前埋在 `renderBadges`
 * 的 JSX 里，而本包没有 jsdom/渲染测试面 ⇒「同名商店行存在时还渲染得出
 * 「随客户端内置」徽章吗」这件事**没有任何用例能打坏**。现在判据可被单测直接钉住，
 * 与 {@link localRemoveEndpoint}（同一个 `originChannel` 的另一个消费点）成对。
 * @param item - 能力中心的一行（归并后的行）。
 * @param tab - 所在分区。
 * @returns 徽章文案的字典键。
 */
export function capabilitySourceBadgeKey(
  item: Pick<CapabilityItem, 'source' | 'originChannel'>,
  tab: 'mine' | 'market',
): CapabilitySourceBadgeKey {
  if (tab === 'market') {
    return item.source === 'market'
      ? 'capability.sourceMarket'
      : item.source === 'org' ? 'capability.sourceOrg' : 'capability.sourceLocal'
  }
  if (item.source === 'local') return 'capability.sourceLocal'
  // 「我的」里的非本地行 = 从商店装进来的那一份；`originChannel` 来自磁盘 provenance。
  switch (item.originChannel) {
    case 'org': return 'capability.sourceOrg'
    case 'builtin': return 'capability.sourceBuiltin'
    // 随客户端内置（随包插件同步进技能库的技能，跨泳道契约 S2）：
    // 它不是用户作品，也不是市场/组织内容 —— 面板给它「卸载」，不给「上传」。
    case 'plugin': return 'capability.sourcePlugin'
    case 'market': return 'capability.sourceMarket'
    default: return 'capability.sourceOther'
  }
}

/** 分区里的一条可见卡：内置入口卡（builtin）或普通条目卡（item）。 */
export type SectionCard =
  | { type: 'builtin'; card: BuiltinCard }
  | { type: 'item'; item: CapabilityItem }

/**
 * 内置技能**清单**读失败时的提示（`null` ⇒ 不渲染任何东西）——R21 FIX-7 ②。
 *
 * 为什么必须有：`useBuiltinSkills` 已经把"读失败"（5xx / 网络 / 超时）与"这台服务端
 * 确实没有这条路由"分开（`builtinSkillsLoadOutcome` 的 `ok`/`absent`/`failed` 三态），
 * 但面板此前只读 `rows/installed/versions/busy/failed/install` —— 新增的 `error` 态
 * **没有消费者**，于是 500 与"平台没有内置技能"在界面上同形（FIX-1 的 D1 残项：
 * 用户与运维都看不到任何痕迹）。
 *
 * 文案一律走字典（`capability.builtinLoadFailed` / `capability.builtinRetry`；
 * 本文件不出现任何字面文案）。抽成纯函数是为了让"**把 error 当 ok**"这条回退能被
 * 单测直接打坏 —— 本包的测试环境是 node（没有 jsdom），React 节点不能渲染，
 * 所以这里返回的是**判定 + 取值**，渲染留在调用点。
 *
 * 变异验证：`if (error === null) return null` 改成恒 `null`（= 回到不渲染）⇒
 * `tests/capability-builtin-load-error.spec.ts` 的「读失败必须给出提示」红。
 * @param error - `useBuiltinSkills` 的清单级错误；`null` = 没失败（可用 / 404 的 absent）。
 * @returns 提示与重试按钮的文案；没失败 ⇒ `null`。
 */
export function builtinLoadNotice(error: string | null): { message: string, retry: string } | null {
  if (error === null) return null
  return { message: t('capability.builtinLoadFailed', { error }), retry: t('capability.builtinRetry') }
}

/**
 * 「我的」分区最终渲染的卡片清单（**唯一真源**：渲染层只做 map，不再自己拼数组）。
 *
 * 去重口径（R2-SK-6）：内置入口已经为某个技能出卡（「安装」或「更新到 vX」）时，
 * 本机技能库里那张**同名技能**普通卡不再渲染 —— 否则"可更新"的技能会在「我的」里
 * 显示两张卡：一张 `[更新到 v1.1.0]`，另一张是 provenance=builtin 的本地卡（页脚
 * 还带一个误导性的 `[上传]`）。planBuiltinCards 只处理了"已装且同版本不出卡"，
 * 可更新这一档两张都出。
 *
 * 只吞 `kind === 'skill'` 的同名项：技能与智能体允许同名（复合键语义），不能互相吞。
 * 顺序不变：内置卡在前（平台自带、数量少），其余保持调用方给出的既有排序。
 *
 * 变异验证：去掉这里的过滤（回到 `[...builtinCards, ...rows]` 直接拼接）⇒
 * `capability-center-panel.spec.ts` 的「同一技能只出一张卡（数量断言）」必红。
 */
export function planSectionCards(options: {
  rows: readonly CapabilityItem[]
  builtinCards: readonly BuiltinCard[]
}): SectionCard[] {
  const claimed = new Set(options.builtinCards.map(card => card.skill.name))
  const rows = options.rows.filter(item => item.kind !== 'skill' || !claimed.has(item.name))
  return [
    ...options.builtinCards.map(card => ({ type: 'builtin' as const, card })),
    ...rows.map(item => ({ type: 'item' as const, item })),
  ]
}

/** 单测用：按（kind, source）解析卸载端点(与安装同一来源规则)。 */
export function uninstallEndpoint(item: CapabilityItem, version: string): string {
  // 平台内置 / 随客户端内置（不随市场/组织目录走）的技能优先（审计 A6 + 跨泳道契约 S2）。
  const local = localRemoveEndpoint(item)
  if (local !== undefined) return local
  if (item.kind === 'skill') {
    return item.source === 'market'
      ? `/api/zeokeel/skills/${encodeURIComponent(item.name)}/uninstall`
      : `/api/zeokeel/shared-skills/${encodeURIComponent(item.name)}/${encodeURIComponent(version)}/uninstall`
  }
  return `/api/zeokeel/agent-presets/${encodeURIComponent(item.name)}/uninstall`
}

/**
 * 上传预检撞上同名内容时的提示文案（**必须走字典**）。
 *
 * 抽成纯函数的原因与 connectors 的 `status-label.ts` 相同：文案取自模块级
 * `t()`，只有"切语言后跟着变"这种断言才有判别力 —— 写成硬编码字符串时，
 * 渲染测试照样全绿（2026-09-16 审计：本文件已用 t() 74 次，只有这一条漏网，
 * 英文界面下整句是中文）。
 * @param displayName - 占用该名称的条目展示名（调用方已回退到 name）。
 * @returns 当前界面语言下的提示文案。
 */
export function nameTakenError(displayName: string): string {
  return t('capability.nameTaken', { name: displayName })
}

/**
 * 上传被服务端拒绝时的用户可见文案（**按稳定错误码映射，不看 HTTP 状态码**）。
 *
 * 为什么判据必须是 `code` 而不是 `status`（R5-B-1 的客户端尾巴，2026-09-23 跨泳道
 * 补齐）：本机写面（`auth-gate` 的 `/api/zeokeel/shared-skills/upload` 与
 * `/api/zeokeel/agent-presets/upload`）会**透传服务端原始状态码**，而 409 同时是
 * `NAME_TAKEN` / `VERSION_*` / `CONFLICT` / `ARCHIVE_CLEARED` / `APP_DELISTED`
 * 的码 —— 按 409 一律说「名称已被占用」会把「已下架冻结」说成重名（本仓踩过同形的坑）。
 * 因此只有 `APP_DELISTED` 走专用文案；**其它任何码都逐字沿用本函数引入前的行为**
 * （服务端 message 优先，缺省回落 `HTTP <status>`），不被这条分支吞掉。
 *
 * 抽成纯函数的理由与 {@link nameTakenError} 相同：文案取自模块级 `t()`，只有
 * "切语言后跟着变"的断言才有判别力，且"其它码不被吞"需要能被直接打坏。
 * @param failure - 本机写面返回的错误信封（`code` 缺省 = 旧宿主 / 非信封错误）。
 * @returns 当前界面语言下的提示文案。
 */
export function uploadFailureText(
  failure: { code?: string | undefined; message?: string | undefined; status: number },
): string {
  if (failure.code === 'APP_DELISTED') return t('capability.delistedFrozen')
  if (failure.message !== undefined && failure.message !== '') return failure.message
  return `HTTP ${String(failure.status)}`
}

/**
 * 跨源同名行的**权威序**：市场 > 组织 > 本机（2026-08-25 决策"跨源同名的展示行
 * 保留市场"）。返回值只取决于行的 `source`，与数组到达顺序无关。
 * @param item - 能力中心的一行。
 * @returns 排序权重（越小越权威）。
 */
function sourceRank(item: CapabilityItem): number {
  return item.source === 'market' ? 0 : item.source === 'org' ? 1 : 2
}

/** 同源多行时的稳定次级键：同等级的行按内容定序，与到达顺序无关。 */
function stableRowKey(item: CapabilityItem): string {
  return JSON.stringify(item)
}

/** 按权威序取第一个可用值（`usable` 不成立就继续往后找），没有则 undefined。 */
function pickByAuthority<T>(
  ordered: readonly CapabilityItem[],
  read: (item: CapabilityItem) => T | undefined,
  usable: (value: T) => boolean,
): T | undefined {
  for (const item of ordered) {
    const value = read(item)
    if (value !== undefined && usable(value)) return value
  }
  return undefined
}

/** 数值字段取各行的最大值（全部缺失时保持 undefined）。 */
function maxOf(ordered: readonly CapabilityItem[], read: (item: CapabilityItem) => number | undefined): number | undefined {
  const values = ordered.map(read).filter((v): v is number => v !== undefined)
  return values.length === 0 ? undefined : Math.max(...values)
}

/**
 * 归并**同一张卡**的多行（同名 kind+name 的跨源/跨分区载荷）。
 *
 * 三条硬约定（独立复审 2026-09-23 A6 + N1 的修复面）：
 *
 *  1. **结果只取决于行集合，不取决于到达顺序**。面板 mount 时并发发
 *     `?source=market` 与 `?source=local` 两次取数（后者内部还要打 3 次上游），
 *     谁先回来不定。旧实现是"先到的行说了算"（`{...existing}` 打底、逐行覆写），
 *     于是同一份数据会渲染成两种卡：market-first 丢本机行的 `originChannel` ⇒
 *     **「随客户端内置」徽章与本机卸载入口都渲染不出来**（A6 的卸载入口在这个
 *     形态下不可达）；mine-first 则把已装技能渲染成「安装」。现在每个字段都有
 *     显式、与顺序无关的取值规则。
 *  2. **本机那一行是"这台机器上是什么"的权威**（A6）：`originChannel` /
 *     `originAppId` / `dirty` / `installedOrigin` 一律取 `source === 'local'` 行的
 *     值 —— 它们来自磁盘上的 provenance，只有本机行有，旧实现会被商店行吞掉。
 *  3. **磁盘上真有这一份 ⇒ 已安装**：存在本机行（`?source=local` 的本地行由
 *     `listLocalSkills`/`listLocalPresets` 扫盘得到）即 `installed: true`，
 *     否则「我的」里的本机卡会被渲染成「安装」。
 *
 * 其余口径保持 2026-08-25 决策：展示行来源市场优先；`displayName`/`description`
 * 取「较新」（版本高者优先）的非空值，避免市场行用与 name 同值的标题盖掉组织行的
 * 中文标题；`version` 展示最高 approved 版本（与来源无关的版本事实）。
 * @param items - 各来源的行（同一条可来自多个载荷）。
 * @returns 每个（kind, name）一行，按 `kind:name` 升序（面板随后自行排序）。
 */
export function mergeItems(items: readonly CapabilityItem[]): CapabilityItem[] {
  const groups = new Map<string, CapabilityItem[]>()
  for (const item of items) {
    const key = `${item.kind}:${item.name}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [item])
    else bucket.push(item)
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, rows]) => mergeItemGroup(rows))
}

/** {@link mergeItems} 的单组归并（行的到达顺序不得影响返回值）。 */
function mergeItemGroup(rows: readonly CapabilityItem[]): CapabilityItem {
  // 权威序：来源优先 + **内容**定序（`rows` 本身的到达顺序不得参与）。
  const byAuthority = [...rows].sort((a, b) => {
    const rank = sourceRank(a) - sourceRank(b)
    return rank !== 0 ? rank : stableRowKey(a).localeCompare(stableRowKey(b))
  })
  // 「较新」序：版本高的先；同版本时按内容定序 —— displayName/description 用它取值。
  const byFreshness = [...rows].sort((a, b) => {
    const byVersion = compareVersions(b.version, a.version)
    return byVersion !== 0 ? byVersion : stableRowKey(a).localeCompare(stableRowKey(b))
  })
  /** 本机那一行（磁盘事实的唯一来源）；没有本机行时为 undefined。 */
  const local = rows.find(row => row.source === 'local')

  const all = new Set<string>()
  for (const row of rows) {
    for (const version of row.versions) all.add(version)
    if (row.version !== '') all.add(row.version)
  }
  const versions = [...all].sort(compareVersions)
  const approved = versions.filter(v => rows.some(row => row.version === v && row.status === 'approved'))
  const version = approved[approved.length - 1] ?? versions[versions.length - 1] ?? byAuthority[0]!.version
  const name = byAuthority[0]!.name
  const displayName = pickByAuthority(byFreshness, row => row.displayName, v => v !== '' && v !== name)
    ?? pickByAuthority(byFreshness, row => row.displayName, v => v !== '')
    ?? ''
  const description = pickByAuthority(byFreshness, row => row.description, v => v !== '') ?? ''
  // 状态徽章是"用户自己的上传进度"：pending/rejected 优先透出（市场行常是
  // approved，按权威序取会把用户自己的待审状态吞掉）。
  const progress = byAuthority.find(row => row.status === 'pending' || row.status === 'rejected')
  const status = progress?.status ?? pickByAuthority(byAuthority, row => row.status, () => true)
  const reason = (progress?.reason !== undefined && progress.reason !== '')
    ? progress.reason
    : pickByAuthority(byAuthority, row => row.reason, v => v !== '')

  return {
    // 打底只为了带上宿主未来新增的透传字段（声明的字段全部在下面显式赋值，
    // 结果不依赖哪一行打底）。权威序首行 = 内容定序 ⇒ 与到达顺序无关。
    ...byAuthority[0]!,
    kind: byAuthority[0]!.kind,
    name,
    source: pickByAuthority(byAuthority, row => row.source, () => true) ?? 'local',
    displayName,
    description,
    author: pickByAuthority(byAuthority, row => row.author, v => v !== '') ?? '',
    version,
    versions,
    // 磁盘上真有这一份（本机行由扫盘得到）⇒ 已安装。
    installed: rows.some(row => row.installed === true || row.source === 'local'),
    installedVersion: pickByAuthority(byAuthority, row => row.installedVersion, () => true),
    // 本机行优先：来源判定只有磁盘上的 provenance 说得准（A2/A3/A6）。
    installedOrigin: local?.installedOrigin ?? pickByAuthority(byAuthority, row => row.installedOrigin, () => true),
    // 归属判据（R6-B-1）：只有宿主下发在本机行上，**只认本机行那一份**，且不做
    // "任一行有就取"的归并 —— 它描述的是"磁盘上这一份算不算当前账号的"，目录行
    // 上的任何字段都回答不了这个问题。
    //
    // **缺省必须归一化成 `'unknown'`（证明不了），绝不读成 `'mine'`**（第六轮独立复审
    // V2 边界①：`?? 'mine'` 这个变异此前没有任何判据，存活）。读成 `'mine'` 会让
    // "宿主根本没下发这个字段"（旧宿主 / 字段被裁剪 / 未来新增的调用点）与"宿主证明
    // 属于当前账号"在 {@link isDelistedItem} 第 3 条判据里完全等价，于是页脚又给出
    // **删除本机那一份** —— 正是 R6-B-1 要挡的那个跨账号破坏性动作。
    // 归一化成显式取值（而不是留在 `undefined`）是为了让"证明不了"在数据里就是一个
    // 取值：下游（含测试与探针）不必再区分"没这个字段"与"字段值是 undefined"。
    localOwnership: local?.localOwnership ?? 'unknown',
    originChannel: local?.originChannel ?? pickByAuthority(byAuthority, row => row.originChannel, () => true),
    originAppId: local?.originAppId ?? pickByAuthority(byAuthority, row => row.originAppId, () => true),
    originServer: local?.originServer ?? pickByAuthority(byAuthority, row => row.originServer, () => true),
    dirty: local?.dirty ?? pickByAuthority(byAuthority, row => row.dirty, () => true),
    originSymlink: local?.originSymlink ?? pickByAuthority(byAuthority, row => row.originSymlink, () => true),
    runtimeName: pickByAuthority(byAuthority, row => row.runtimeName, v => v !== ''),
    isLocal: rows.some(row => row.isLocal === true) ? true : undefined,
    uploadStatus: local?.uploadStatus ?? pickByAuthority(byAuthority, row => row.uploadStatus, () => true),
    quality: pickByAuthority(byAuthority, row => row.quality, v => v === 'featured')
      ?? pickByAuthority(byAuthority, row => row.quality, () => true),
    status,
    reason,
    official: rows.some(row => row.official === true) ? true : undefined,
    // 归属三态必须**如实**下发（R5-B-2）：`mergeItemGroup` 里原来的
    // `some(isOwner === true) ? true : undefined` 会把服务端明确说的 `false`
    // 抹成"未知"，于是"这一行已经转给别人了"在客户端**永远表达不出来**。
    // 归并语义：任一行说"是你的"⇒ 是你的；否则任一行明确说"不是你的"⇒ 不是你的；
    // 都没有该字段 ⇒ 未知（本机磁盘行）。
    isOwner: rows.some(row => row.isOwner === true)
      ? true
      : rows.some(row => row.isOwner === false) ? false : undefined,
    // 归属人账号（服务端下发时透出，供「已转交」说明用；缺省不编造）。
    owner: pickByAuthority(byAuthority, row => row.owner, v => v !== ''),
    // 下架标记（R5-B-1）：**任一行说下架就是下架**（它是 App 级事实，不是行级偏好）；
    // 没有任何一行带该字段 ⇒ undefined（未知，不得读成"上架"）。
    delisted: rows.some(row => row.delisted === true) ? true : undefined,
    // 上下架（R5-B-1）：**false 优先**（任一行说下架 ⇒ 下架）；没有该字段 ⇒
    // undefined（未知，不得读成"上架"）。
    enabled: rows.some(row => row.enabled === false)
      ? false
      : rows.some(row => row.enabled === true) ? true : undefined,
    downloads: maxOf(rows, row => row.downloads),
    calls: maxOf(rows, row => row.calls),
    score: maxOf(rows, row => row.score),
    // 时间戳是"这一份内容最近动过"的事实：归并取**最新的一个**（ISO 字符串可直接
    // 按字典序比较），没有就留 undefined（排序层按版本号兜底，不编造时间）。
    updatedAt: (() => {
      const stamps = rows.map(row => row.updatedAt).filter((v): v is string => v !== undefined && v !== '')
      return stamps.length === 0 ? undefined : stamps.reduce((best, v) => (v > best ? v : best))
    })(),
    changelog: pickByAuthority(byFreshness, row => row.changelog, v => v !== ''),
  }
}

/**
 * 详情子视图的目标：普通条目（能力中心聚合面的行）或内置技能入口卡。
 *
 * 两者进同一个视图 —— 用户看到的差异只是"徽章不同、动作不同"，形状与交互不分叉。
 * 2026-10-26 重构：详情从**弹层**改成面板内的**整页子视图**（`view` 状态切换），
 * 理由与原弹层相同（卡片里的描述必须定高），但不再遮住工具栏/侧栏、也不再需要
 * 焦点陷阱与 Esc 让位。`CapabilityDetailDialog` 仍导出，供既有外部引用兼容。
 */
type DetailTarget =
  | { kind: 'item', item: CapabilityItem }
  | { kind: 'builtin', card: BuiltinCard }

/** 加载态骨架卡数量（设计定案：6 张；加载中不再渲染一句「加载中…」）。 */
export const SKELETON_COUNT = 6

/**
 * 骨架卡的稳定 key（纯函数，单测直接打它 —— 数量是设计定案，不是随手写的常量）。
 * @param count - 张数（缺省 {@link SKELETON_COUNT}）。
 * @returns `capability-skeleton-0…n-1`。
 */
export function skeletonKeys(count: number = SKELETON_COUNT): string[] {
  return Array.from({ length: Math.max(0, Math.trunc(count)) }, (_, index) => `capability-skeleton-${String(index)}`)
}

/** 工具条里的排序下拉（颜色/边框只走 `--dsw-*` token）。 */
const SORT_SELECT: React.CSSProperties = {
  height: 30,
  padding: '0 8px',
  borderRadius: 9,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: 12,
  outline: 'none',
}

/** 标题下的 slug（副标题，弱化一档）。 */
const SLUG: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  lineHeight: '15px',
  color: 'var(--dsw-alias-label-caption)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** 卡片底部 meta 行（版本 · 作者 + 右侧小状态点）。 */
const META_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  marginTop: 'auto',
}

/** 一个小状态点 + 短文案（卡片里"其余状态"的唯一呈现形式）。 */
const DOT_ROW: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }
const DOT: React.CSSProperties = { width: 6, height: 6, borderRadius: 3, flex: 'none' }
const DOT_TEXT: React.CSSProperties = {
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-caption)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

/** 列表视图的一行（与网格卡共用同一套判定与动作）。 */
const LIST_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 12px',
  borderRadius: 12,
  minWidth: 0,
}
const LIST_DESC: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: '17px',
  color: 'var(--dsw-alias-label-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** 详情里的小节标题。 */
const LABEL_SM: React.CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-caption)' }

/** 状态说明段落（详情专用；卡片里不再放长段落）。 */
const HINT_TEXT: React.CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12,
  lineHeight: '19px',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'pre-wrap',
}

/** 一张卡的 Chip 规格（最多两个，见 {@link cardChips}）。 */
export interface CardChipSpec {
  key: CapabilityKey
  tone: PanelTone
  plain?: boolean | undefined
}

/**
 * 卡片里"状态/来源"那一枚 Chip 该显示什么（**唯一实现**）。
 *
 * 优先级：下架 > 已转交 > 审核中 > 未通过 > （我上传分区）已共享 / 未上传。
 * 其余状态一律不进 Chip（卡片最多两个 Chip），由 {@link cardStatusDots} 的小状态点
 * + 短文案表达；长说明只在详情里（2026-10-26 设计：卡片不放大段状态段落）。
 * @param item - 归并后的行。
 * @param tab - 所在分段（`own` 分区要显示"已共享/未上传"这类提交状态）。
 * @param tabIsMineSource - 来源徽章的口径（市场分区用目录口径，其余用本机口径）。
 * @returns 状态 Chip；没有状态可报时返回 null。
 */
export function cardStatusChip(item: CapabilityItem, tab: SourceTab | 'mine'): CardChipSpec | null {
  if (isDelistedItem(item)) return { key: 'capability.delisted', tone: 'neutral' }
  if (isTransferredItem(item)) return { key: 'capability.transferred', tone: 'warn' }
  if (item.status === 'pending') return { key: 'capability.pending', tone: 'warn' }
  if (item.status === 'rejected') return { key: 'capability.rejected', tone: 'danger' }
  if (tab === 'own') {
    if (item.status === 'approved' || item.uploadStatus === 'approved') return { key: 'capability.approved', tone: 'success' }
    if (item.source === 'local') return { key: 'capability.draftNotUploaded', tone: 'neutral' }
  }
  return null
}

/**
 * 一张卡的 Chip 清单（**最多两个**：官方 + 一个状态/来源）。
 *
 * 设计定案（2026-10-26）：卡面只留两枚 Chip，避免同一张卡上出现「技能/市场/官方/
 * 精选/已安装/已下架/已转交/已本地修改」这种一面墙的胶囊（旧实现的现场）。类型由
 * 图标色调与详情表达，不占 Chip。
 * @param item - 归并后的行。
 * @param tab - 所在分段。
 * @returns 0–2 枚 Chip 的规格。
 */
export function cardChips(item: CapabilityItem, tab: SourceTab | 'mine'): CardChipSpec[] {
  const chips: CardChipSpec[] = []
  if (item.official === true) chips.push({ key: 'capability.official', tone: 'brand' })
  const status = cardStatusChip(item, tab)
  if (status !== null) {
    chips.push(status)
  } else if (chips.length === 0) {
    // 没有官方、也没有状态 ⇒ 用来源徽章（六选一的口径由既有纯函数决定）。
    chips.push({ key: capabilitySourceBadgeKey(item, tab === 'market' ? 'market' : 'mine'), tone: 'neutral', plain: true })
  }
  return chips.slice(0, 2)
}

/**
 * 卡面上的"小状态点 + 短文案"（最多两个）—— 其余状态都归到这里。
 *
 * 与 {@link cardChips} 的分工：Chip 表达"这张卡现在处于什么业务态"（官方/审核/下架），
 * 状态点表达"本机这一份有什么值得注意的事实"（已本地修改 / 来自另一台服务端 /
 * 符号链接 / 已安装）。两者都只给结论，解释在详情里。
 * @param item - 归并后的行。
 * @param tab - 所在分段（`installed` 分区里"已安装"是隐含的，不再重复报）。
 * @returns 0–2 个小状态点。
 */
export function cardStatusDots(item: CapabilityItem, tab: SourceTab | 'mine'): CardChipSpec[] {
  const dots: CardChipSpec[] = []
  if (item.dirty === true) dots.push({ key: 'capability.dirty', tone: 'warn' })
  if (item.originServer !== undefined) dots.push({ key: 'capability.originOtherServer', tone: 'warn' })
  if (item.originSymlink === true) dots.push({ key: 'capability.originSymlink', tone: 'neutral' })
  if (item.installed === true && tab !== 'installed' && tab !== 'own') dots.push({ key: 'capability.installed', tone: 'success' })
  return dots.slice(0, 2)
}

/**
 * 分段的计数（SegmentedControl 的数字角标；**唯一实现**）。
 * @param items - 已归并的行（同 kind:name 只算一次）。
 * @returns 四个分段各自可见的行数。
 */
export function tabCounts(items: readonly CapabilityItem[]): Record<SourceTab, number> {
  return {
    all: itemsForTab(items, 'all').length,
    installed: itemsForTab(items, 'installed').length,
    own: itemsForTab(items, 'own').length,
    market: itemsForTab(items, 'market').length,
  }
}

/**
 * 页脚/详情里的动作判定（`planCardAction` + 分段口径的收窄，**唯一入口**）。
 *
 * 只加一条分段语义（2026-10-26）：在「我上传」里，**没有本机副本的 pending/rejected
 * 行**不给「安装」按钮 —— 服务端不会分发未通过/已驳回的版本，给按钮就是假入口；
 * 这一格只报状态（`review`）。其余动作逐字沿用 {@link planCardAction}。
 * @param item - 归并后的行。
 * @param tab - 所在分段。
 * @returns 页脚动作。
 */
export function planCardActionForTab(item: CapabilityItem, tab: SourceTab | 'mine'): CardActionPlan {
  const plan = planCardAction(item)
  // 未通过/待审的版本**不会**被服务端分发 ⇒ 没有本机副本时「安装」必然失败。
  // 「我上传」与「全部」都会渲染作者面（own）的行，所以两处都要收窄；「市场」不渲染
  // 这类行（服务端目录面不列未通过版本），判据保持 planCardAction 原样。
  const showsAuthorRows = tab === 'own' || tab === 'all'
  if (showsAuthorRows && plan.kind === 'install' && (item.status === 'pending' || item.status === 'rejected')) {
    return { kind: 'review', status: item.status }
  }
  return plan
}

/** 详情子视图的 props（C-03：按钮必须同时吃 own-key busy 与站级 blocked）。 */
export interface CapabilityDetailViewProps {
  target: DetailTarget
  /** 本视图目标自己的动作在飞。 */
  busy: boolean
  /** 站级闸（另有动作在飞）——`install()` 对它静默 return，所以必须禁用并说明。 */
  blocked: boolean
  /** 分段（Chip/来源口径与列表一致）。 */
  tab: SourceTab
  /** 页脚动作（由面板按同一套 `planCardActionForTab` 渲染后传入）。 */
  actions: React.ReactNode
  /** 页脚上方的瞬时提示（例如卸载覆盖确认的后果说明）；无则 null。 */
  notice?: React.ReactNode | undefined
  onInstallVersion: (version: string) => void
  onBack: () => void
  onClose: () => void
}

/** 渲染一枚 Chip（规格来自 {@link cardChips} / {@link cardStatusDots}）。 */
function renderChipSpec(spec: CardChipSpec): React.ReactNode {
  return <Chip key={spec.key} tone={spec.tone} plain={spec.plain}>{t(spec.key)}</Chip>
}

/** 渲染一个小状态点 + 短文案。 */
function renderStatusDot(spec: CardChipSpec, index: number): React.ReactNode {
  return (
    <span key={`${spec.key}:${String(index)}`} style={DOT_ROW} title={t(spec.key)}>
      <span style={{ ...DOT, background: TONE_COLOR[spec.tone] }} aria-hidden="true" />
      <span style={DOT_TEXT}>{t(spec.key)}</span>
    </span>
  )
}

/**
 * 详情（面板内整页子视图）。
 *
 * 内容顺序：标题/来源 → 状态说明 → 描述/更新说明 → 版本列表 → 动作。状态说明在这里
 * 才展开（下架/转交/拒因/审核提示/本地修改/另一台服务端/符号链接），卡片上只留 Chip
 * 与小状态点。
 * @param props - 目标、忙碌/站级闸、分段、动作节点与回调。
 */
export function CapabilityDetailView({
  target,
  busy,
  blocked,
  tab,
  actions,
  notice,
  onInstallVersion,
  onBack,
  onClose,
}: CapabilityDetailViewProps): JSX.Element {
  const skill = target.kind === 'builtin' ? target.card.skill : undefined
  const item = target.kind === 'item' ? target.item : undefined
  const title = skill !== undefined
    ? (skill.title !== undefined && skill.title !== '' ? skill.title : skill.name)
    : (item!.displayName !== '' ? item!.displayName : item!.name)
  const name = skill !== undefined ? skill.name : item!.name
  const description = skill !== undefined ? (skill.description ?? '') : item!.description
  const author = skill !== undefined ? (skill.author ?? '') : item!.author
  const version = skill !== undefined ? skill.version : item!.version
  const chips = item === undefined ? [] : cardChips(item, tab)
  const dots = item === undefined ? [] : cardStatusDots(item, tab)
  const kindKey: CapabilityKey = (skill !== undefined || item!.kind === 'skill') ? 'capability.typeSkill' : 'capability.typeAgent'
  const versions = item !== undefined && versionInstallSupported(item) ? item.versions : []
  const marketLatestOnly = item !== undefined && item.kind === 'skill' && item.source === 'market'
  const rejected = item !== undefined && item.status === 'rejected'
  const delisted = item !== undefined && isDelistedItem(item)
  const transferred = item !== undefined && isTransferredItem(item)
  return (
    <div data-role="capability-detail" data-key={skill !== undefined ? `builtin:${name}` : `${item!.kind}:${name}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <PanelButton variant="secondary" size="sm" icon={<icons.IconBack size={14} />} onClick={onBack}>
          {t('capability.detailBack')}
        </PanelButton>
        <span style={{ flex: 1 }} />
        <PanelButton variant="ghost" size="sm" aria-label={t('capability.close')} onClick={onClose}>{'✕'}</PanelButton>
      </div>
      <Card style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px', borderRadius: 16 }} className="zeokeel-skill-card">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <IconTile size={42} radius={13} tone={item === undefined ? 'brand' : item.kind === 'skill' ? 'brand' : 'neutral'} label={title.charAt(0)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <p style={{ ...NAME, fontSize: 16, whiteSpace: 'normal' }}>{title}</p>
              {chips.map(renderChipSpec)}
              {item !== undefined && item.quality === 'featured' && <Chip tone="warn">{t('capability.featured')}</Chip>}
            </div>
            <p style={{ ...SLUG, marginTop: 2 }} title={name}>{name}</p>
            <p style={{ ...META, marginTop: 2 }}>
              {`v${version}${author !== '' ? ` · ${author}` : ''}`}
              {' · '}
              {t(kindKey)}
              {item !== undefined ? ` · ${t('capability.detailSource')}: ${t(capabilitySourceBadgeKey(item, tab === 'market' || tab === 'own' ? 'market' : 'mine'))}` : ''}
            </p>
          </div>
        </div>
        {dots.length > 0 && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{dots.map(renderStatusDot)}</div>
        )}
        {(rejected || delisted || transferred || (item !== undefined && showsMarketReviewHint(item))
          || (item !== undefined && item.dirty === true)
          || (item !== undefined && item.originServer !== undefined)
          || (item !== undefined && item.originSymlink === true)
          || (item !== undefined && item.official === true)) && (
          <div data-role="capability-detail-status">
            <div style={LABEL_SM}>{t('capability.detailStatus')}</div>
            {delisted && (
              // 徽章在标题行（cardChips），这一段只放整句说明 —— 卡片的 Chip 与小状态点
              // 只给结论，完整"为什么 + 还能做什么"在这里（2026-10-26 设计）。
              <p style={HINT_TEXT} data-role="card-delisted-reason">{t('capability.delistedHint')}</p>
            )}
            {transferred && (
              <p style={HINT_TEXT} data-role="card-transferred-reason">{t('capability.transferredHint')}</p>
            )}
            {rejected && (
              <p style={{ ...HINT_TEXT, color: 'var(--dsw-alias-state-error-primary)' }} data-role="detail-rejected-reason">
                {t('capability.rejectReason', { reason: item!.reason ?? '' })}
              </p>
            )}
            {item !== undefined && showsMarketReviewHint(item) && (
              <p style={HINT_TEXT} data-role="card-market-review-hint">{t('capability.marketReviewHint')}</p>
            )}
            {item !== undefined && item.dirty === true && (
              <p style={HINT_TEXT} data-role="detail-dirty-hint">{t('capability.dirtyHint')}</p>
            )}
            {item !== undefined && item.originServer !== undefined && (
              <p style={HINT_TEXT} data-role="detail-origin-server-hint">{t('capability.originOtherServerHint')}</p>
            )}
            {item !== undefined && item.originSymlink === true && (
              <p style={HINT_TEXT} data-role="detail-symlink-hint">{t('capability.originSymlinkHint')}</p>
            )}
            {item !== undefined && item.official === true && (
              <p style={HINT_TEXT} data-role="detail-official-hint">{t('capability.officialHint')}</p>
            )}
            {item !== undefined && item.runtimeName !== undefined && item.runtimeName !== '' && item.runtimeName !== item.name && (
              <p style={HINT_TEXT} data-role="detail-runtime-name">
                {t('capability.runtimeName')}: {item.runtimeName} — {t('capability.runtimeNameHint')}
              </p>
            )}
          </div>
        )}
        <div>
          <div style={LABEL_SM}>{t('capability.detailDescription')}</div>
          <p style={{ ...DESC, whiteSpace: 'pre-wrap', marginTop: 4 }} data-role="detail-description">
            {description === '' ? t('capability.detailNoDescription') : description}
          </p>
        </div>
        {item !== undefined && item.changelog !== undefined && item.changelog !== '' && (
          <div>
            <div style={LABEL_SM}>{t('capability.detailChangelog')}</div>
            <p style={{ ...DESC, whiteSpace: 'pre-wrap', marginTop: 4 }} data-role="detail-changelog">{item.changelog}</p>
          </div>
        )}
        {versions.length > 0 && (
          <div>
            <div style={LABEL_SM}>{t('capability.detailVersions')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {versions.map(versionEntry => (
                <PanelButton
                  key={versionEntry}
                  variant={versionEntry === item!.version ? 'primary' : 'secondary'}
                  size="sm"
                  // C-03：own-key busy 与站级闸都要禁用（`install()` 对后者静默 return）。
                  disabled={busy || blocked}
                  title={blocked && !busy ? t('capability.busyHint') : undefined}
                  onClick={() => { onInstallVersion(versionEntry) }}
                >
                  v{versionEntry}
                </PanelButton>
              ))}
            </div>
          </div>
        )}
        {versions.length === 0 && marketLatestOnly && (
          <p style={HINT_TEXT} data-role="market-latest-only">{t('capability.marketLatestOnly')}</p>
        )}
        {notice === undefined ? null : notice}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' }}>
          {actions}
        </div>
      </Card>
    </div>
  )
}

/** 弹层骨架的几何（颜色由 `.zeokeel-card` / 共享按钮类负责）。 */
const DIALOG_MASK: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'var(--dsw-alias-bg-mask-1)',
  backdropFilter: 'var(--dsw-mask-blur)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
}

const DIALOG_BOX: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(640px, 100%)',
  boxSizing: 'border-box',
  maxHeight: 'min(78vh, 720px)',
  borderRadius: 18,
  padding: '18px 20px',
  boxShadow: 'var(--dsw-shadow-lv3)',
  outline: 'none',
}

/**
 * 详情弹层（**兼容导出**）。
 *
 * 2026-10-26 起面板不再使用弹层 —— 详情是 {@link CapabilityDetailView} 的整页子视图。
 * 本导出保留是因为它是对外 API（`CapabilityCenterPanel` 模块的既有 export）：删掉会
 * 让外部引用在编译期断掉。行为保持原样（Esc / 遮罩关闭 / 焦点环），只是不再是产品路径。
 */
export function CapabilityDetailDialog({ target, busy, blocked, onInstallVersion, onClose }: {
  target: DetailTarget
  /** 本弹层目标自己的动作在飞。 */
  busy: boolean
  /** 站级闸（另有动作在飞）：`install()` 会静默 return，按钮必须禁用并说明。 */
  blocked: boolean
  onInstallVersion: (version: string) => void
  onClose: () => void
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    boxRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])
  const skill = target.kind === 'builtin' ? target.card.skill : undefined
  const item = target.kind === 'item' ? target.item : undefined
  const title = skill !== undefined
    ? (skill.title !== undefined && skill.title !== '' ? skill.title : skill.name)
    : (item!.displayName !== '' ? item!.displayName : item!.name)
  const description = skill !== undefined ? (skill.description ?? '') : item!.description
  const versions = item !== undefined && versionInstallSupported(item) ? item.versions : []
  return (
    <div
      style={DIALOG_MASK}
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <Card
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${t('capability.detail')} ${title}`}
        style={DIALOG_BOX}
        data-role="capability-detail"
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <IconTile size={38} radius={12} tone="brand" label={title.charAt(0)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={NAME_WRAP}>
              <p style={{ ...NAME, whiteSpace: 'normal' }}>{title}</p>
              {skill !== undefined && <Chip tone="neutral" plain>{t('capability.builtinBadge')}</Chip>}
            </div>
            <p style={META}>{skill !== undefined ? `v${skill.version}` : `v${item!.version}`}</p>
          </div>
          <PanelButton variant="ghost" size="sm" aria-label={t('capability.close')} onClick={onClose}>{'✕'}</PanelButton>
        </div>
        <div className="zeokeel-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 12 }}>
          <div style={LABEL_SM}>{t('capability.detailDescription')}</div>
          <p style={{ ...DESC, whiteSpace: 'pre-wrap', marginTop: 4 }} data-role="detail-description">
            {description === '' ? t('capability.detailNoDescription') : description}
          </p>
          {versions.length > 1 && (
            <div style={{ marginTop: 14 }}>
              <div style={LABEL_SM}>{t('capability.viewVersions', { count: String(versions.length) })}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {versions.map(version => (
                  <PanelButton
                    key={version}
                    variant={version === item!.version ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={busy || blocked}
                    title={blocked && !busy ? t('capability.busyHint') : undefined}
                    onClick={() => { onInstallVersion(version) }}
                  >
                    v{version}
                  </PanelButton>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

/** 待用户确认的一发安装（普通条目卡、内置技能卡与详情视图共用）。 */
interface PendingInstall {
  /** `{kind}:{name}` 或 `builtin:{name}`（与 action.key 同口径）。 */
  key: string
  /** 展示用的技能名。 */
  name: string
  /**
   * 本机那一份不是"内容未改的商店内容" ⇒ 要走"会被覆盖"的措辞（**不是**第二套判据，
   * 就是 {@link needsOverwriteConfirm} 的结果；保留字段是为了兼容既有断言）。
   */
  localConflict: boolean
  /**
   * 确认条的措辞档位（唯一判据见 {@link overwriteConfirmReason}）：
   *  - `local`：本机那一份不是能力中心装的 ⇒ "自制内容"措辞 + 「仍要覆盖」；
   *  - `dirty`：商店来源但**被本地修改过**（R4-B-3）⇒ 明说"更新会丢掉你改过的内容"；
   *  - `store`：商店来源、内容未改、只是换渠道 ⇒ 通用覆盖措辞。
   */
  reason?: OverwriteConfirmReason | undefined
  /** 用户在详情视图里点选的版本（内置卡没有这一项）。 */
  version?: string | undefined
  /** 用户确认后真正执行的那一发（`overwrite` = 把 `?overwrite=1` 交给宿主）。 */
  run: (overwrite: boolean) => Promise<void>
}

/** 每个分区的加载状态（分区独立错误态）。 */
type SectionStatus = 'idle' | 'loading' | 'ok' | 'error'
interface SectionState {
  status: SectionStatus
  error: string
}

interface ActionState {
  key: string
  kind: 'installing' | 'uninstalling' | 'uploading' | 'done-install' | 'done-uninstall' | 'done-upload' | 'failed'
  error?: string | undefined
  name?: string | undefined
}

/** 一次只读取数（三个分区共用；错误信息带状态码，便于分区错误态显示）。 */
async function fetchCapabilityRows(source: 'market' | 'local' | 'own'): Promise<CapabilityItem[]> {
  const res = await fetch(`/api/zeokeel/capabilities?source=${source}`)
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
  return ((await res.json()) as { items?: CapabilityItem[] }).items ?? []
}

/**
 * 能力中心面板（2026-10-26 现代化重构）。
 *
 * 信息架构：4 个分段（全部 / 已安装 / 我上传 / 市场）× 类型筛选 × 搜索 × 排序 ×
 * 网格/列表视图；工具条全部收在 `PanelPage` 的 toolbar 里。卡片只留"标题 + slug +
 * 最多两个 Chip + 两行描述 + 版本/作者 + 主动作 + 详情"，长状态说明进详情子视图。
 * 取数是三分区（market / local / own）并发、各自独立错误态；own 是新增的
 * "我上传"通道（作者面，含 pending/rejected，无本机副本也可见）。
 * @param props - 面板出口（键返回到会话区由装载器负责）。
 */
export function CapabilityCenterPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SourceTab>('all')
  const [filter, setFilter] = useState<TypeFilter>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('updated')
  const [view, setView] = useState<ViewMode>('grid')
  // 平台内置技能：与普通技能**同一张卡片、同一个网格**（2026-09-18 用户口径：
  // "这里渲染应该是一个普通技能，而不是这种置顶的"）。
  // 已安装的那些**不在这里渲染** —— 它们本来就在本机列表里（本机技能库扫描
  // 出来的普通卡片，带「平台内置」来源徽章）；重复渲染会让同一个技能出现两张卡。
  // 装成功后刷新分区，让普通卡片立刻出现、这张"安装入口"卡片同时消失。
  const builtin = useBuiltinSkills(() => { loadAllRef.current?.() })
  const loadAllRef = useRef<(() => void) | null>(null)
  const [items, setItems] = useState<CapabilityItem[]>([])
  const [sections, setSections] = useState<Record<string, SectionState>>({})
  const [action, setAction] = useState<ActionState | null>(null)
  /**
   * 覆盖确认：待用户确认的那一发安装。
   *
   * 存"意图"（而不是只存一个 key）有三个理由（审计 A15/A11/A2）：
   *  ①确认条要重放**同一发**安装，包括详情视图里点的那一个版本（旧实现只存 key，
   *    确认后会退回 item.version）；
   *  ②措辞要按本机那一份的来源分档（用户自制 vs 商店）；
   *  ③**两个安装入口共用同一条确认条**：普通条目卡与内置技能入口卡（`run` 闭包
   *    分别指向 `performInstall` / `builtin.install`），否则内置技能的「更新到 vX」
   *    会绕过确认直接打到宿主（被 409 挡下 = 用户只看到一条报错）。
   */
  const [installConfirm, setInstallConfirm] = useState<PendingInstall | null>(null)
  /** 卸载确认 key（{kind}:{name}）。 */
  const [uninstallConfirmKey, setUninstallConfirmKey] = useState<string | null>(null)
  /** 正在看详情的卡；null = 列表视图（详情改为面板内整页子视图，2026-10-26）。 */
  const [detail, setDetail] = useState<DetailTarget | null>(null)
  const loadSeqRef = useRef(0)
  /**
   * 站内是否有动作在飞（安装/卸载/上传）。
   *
   * `install()` / `uninstall()` / `upload()` 的第一行都是"有动作在飞就 return"，但按钮
   * 只按**自己这张卡**的 key 置灰时，慢安装期间其它卡片的按钮外观仍是可点的启用态，
   * 点下去被静默吞掉（用户以为按钮坏了，2026-09-21 审计）。现在其它卡片一起置灰。
   */
  const inFlight = action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')
  /**
   * 动作结果条 / 覆盖确认条在**滚动区顶部**，列表滚到下方时看不见它们。
   * 任何一条出现或内容变化就把它滚进视口，否则用户点完按钮"界面零变化"。
   */
  const noticeRef = useRef<HTMLDivElement | null>(null)
  const noticeKey = action === null ? '' : `${action.kind}|${action.key}|${action.error ?? ''}`
  useEffect(() => {
    if (noticeRef.current === null) return
    if (noticeKey === '' && installConfirm === null) return
    noticeRef.current.scrollIntoView({ block: 'nearest' })
  }, [noticeKey, installConfirm])

  const setSection = (key: string, state: Partial<SectionState>): void => {
    setSections(prev => ({ ...prev, [key]: { status: prev[key]?.status ?? 'idle', error: prev[key]?.error ?? '', ...state } }))
  }

  const loadSection = async (key: SectionKey, fetcher: () => Promise<CapabilityItem[]>): Promise<void> => {
    const seq = loadSeqRef.current
    setSection(key, { status: 'loading', error: '' })
    try {
      const rows = await fetcher()
      if (seq !== loadSeqRef.current) return
      setItems(prev => applySectionRows(prev, key, rows))
      setSection(key, { status: 'ok' })
    } catch (cause) {
      if (seq !== loadSeqRef.current) return
      // R16B-26（2026-09-25，与 R16B-08 同族）：catch 把 cause **整个丢掉** ⇒ 用户
      // 只看到「加载失败」+ 重试，401/403/404/5xx/形状漂移一律不可区分，而且**零日志**
      // （打包版没有可见控制台，连支持都拿不到线索）。两个 fetcher 抛的都是
      // `HTTP <status>`（服务端业务信封原文优先），带上它：可见文案走带占位符的那条
      // 字典键（用户仍读到本地化的"加载失败"，机器可读的部分跟在后面），同时打一条
      // 可检索的 warn 供诊断包取用。
      const detailText = cause instanceof Error ? cause.message : ''
      if (detailText !== '') {
        console.warn(`[capability] loading the ${key} section failed: ${detailText}`)
        setSection(key, { status: 'error', error: t('capability.loadErrorDetail', { error: detailText }) })
        return
      }
      setSection(key, { status: 'error', error: t('capability.loadError') })
    }
  }

  const loadAll = (): void => {
    ++loadSeqRef.current
    // 三分区并发（各自独立错误态）：market = 市场+组织合并；local = 本机（已装 + 自制）；
    // own = 我上传（作者面，含 pending/rejected —— 盘点 F-08 的修法）。
    // loading 由分区状态驱动（renderSection 按 tab 显示骨架/错误/空态）。
    void loadSection('market', () => fetchCapabilityRows('market'))
    void loadSection('mine', () => fetchCapabilityRows('local'))
    void loadSection('own', () => fetchCapabilityRows('own'))
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc / 初始焦点 / 焦点陷阱**都不在这里做**（2026-09-21 删除；详情不再占用窗口键盘）。
  //
  // 现在的唯一权威是装载器 `@zeokeel/dsh-panel-surface`：它在 document 上处理 Esc
  // （检测到 `[role=dialog][aria-modal=true]` 时让给内层模态），并在激活时把焦点移到
  // 面板容器上。详情是面板内子视图，Esc 语义仍是"返回聊天"（与其它面板一致）。

  // 30s 静默轮询：审批状态会在**服务端**变化（管理员通过/驳回），而本机没有任何
  // 触发点 —— 盘点 F-11 的现场是「审核中」粘滞到重挂载。轮询 market（目录变化）与
  // own（作者面状态变化），**不轮询 local**（要扫盘 + 算内容哈希，代价高且磁盘事实
  // 只会在本机动作后变化，那些动作已经各自触发 loadAll）。
  useEffect(() => {
    const timer = setInterval(() => {
      const seq = loadSeqRef.current
      const refresh = async (key: SectionKey, source: 'market' | 'own'): Promise<void> => {
        try {
          const rows = await fetchCapabilityRows(source)
          if (seq !== loadSeqRef.current) return
          // 与 loadSection 同一条归约（唯一实现），不在这里另写一份 filter。
          setItems(prev => applySectionRows(prev, key, rows))
          // 后台刷新成功即退出先前 error 态——否则首次加载失败后,错误提示与
          // 重试按钮会遮住已刷新的数据(2026-09-01 深挖)。
          setSection(key, { status: 'ok', error: '' })
        } catch { /* 静默轮询失败不打扰用户；下一次再试 */ }
      }
      void refresh('market', 'market')
      void refresh('own', 'own')
    }, 30000)
    return () => { clearInterval(timer) }
  }, [])

  /**
   * 真正发请求的那一发安装（**不含**确认闸门 —— 闸门在 {@link install}）。
   * @param item - 能力中心的一行。
   * @param opts - overwrite / 用户点选的版本。
   */
  const performInstall = async (item: CapabilityItem, opts?: { overwrite?: boolean; version?: string }): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    setInstallConfirm(null)
    setAction({ key, kind: 'installing' })
    try {
      const url = installRequestUrl(item, opts)
      const res = await fetch(url, { method: 'POST' })
      // 409 的语义只有一种会进确认条：**目标是本机内容**（`LOCAL_CONTENT`，宿主在缺
      // `?overwrite=1` 时拒绝覆盖）。其它 409（APP_DELISTED / NAME_TAKEN / VERSION_*…）
      // 是业务拒绝，进确认条只会让用户反复点同一发注定失败的请求（盘点 F-10）。
      if (res.status === 409) {
        const data = await res.json().catch(() => ({})) as { error?: unknown; code?: unknown }
        // 错误信封有两种形状：本机路由是扁平的 `{ error, code }`，透传上游时可能是
        // `{ error: { code, message } }`。两种都读，读不到才算"旧宿主"。
        const nestedCode = typeof data.error === 'object' && data.error !== null
          ? (data.error as { code?: unknown }).code
          : undefined
        const code = typeof data.code === 'string'
          ? data.code
          : typeof nestedCode === 'string' ? nestedCode : ''
        // 空 code = 旧宿主（它的 409 只有 LOCAL_CONTENT 一种语义），按既有行为回确认条。
        if (code === '' || code === 'LOCAL_CONTENT') {
          setAction(null)
          setInstallConfirm({
            key, name: item.name, localConflict: true,
            reason: needsOverwriteConfirm(item) ? overwriteConfirmReason(item) : 'store',
            ...opts?.version === undefined ? {} : { version: opts.version },
            run: async (overwrite) => { await performInstall(item, { ...opts, overwrite }) },
          })
          return
        }
        const message = typeof data.error === 'string'
          ? data.error
          : typeof data.error === 'object' && data.error !== null
            ? (data.error as { message?: unknown }).message
            : undefined
        throw new Error(uploadFailureText({
          ...code === '' ? {} : { code },
          ...typeof message === 'string' && message !== '' ? { message } : {},
          status: res.status,
        }))
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      // 记账用**响应里的真实版本**（审计 A11）：市场归档端点只按当前 approved
      // 最高版取，请求里那个版本号可能根本没被采纳。拿不到版本就留 undefined
      // （宁可不提示更新，也不误报），并按磁盘事实重载一次。
      const data = await res.json().catch(() => ({})) as { version?: unknown }
      const appliedVersion = typeof data.version === 'string' && data.version !== '' ? data.version : undefined
      setItems(prev => prev.map(i => (i.kind === item.kind && i.name === item.name
        // `dirty: false`（R4-B-3）：装完之后磁盘上的内容就是商店那一份（安装器会重算
        // 内容哈希），「已本地修改」徽章必须同时熄灭 —— 否则覆盖成功后卡片还在说
        // "已本地修改"，用户会以为自己的改动还在。
        ? { ...i, installed: true, installedVersion: appliedVersion, installedOrigin: 'store', dirty: false }
        : i)))
      setAction({ key, kind: 'done-install', name: item.name })
      if (appliedVersion === undefined) loadAll()
      // 安装成功 ⇒ 三个分区都刷新一次（own 的审核态、market 的下载量、本机版本），
      // 避免"装完卡片还是旧状态"（盘点 F-09/F-11 的同族）。
      loadAll()
    } catch (cause) {
      setAction({ key, kind: 'failed', error: cause instanceof Error ? cause.message : undefined, name: item.name })
    }
  }

  /**
   * 安装入口（带覆盖确认闸门）。
   *
   * 审计 A2/A3/A15 + R4-B-3：**本机已装、且那一份不是"内容未改的商店内容"** ⇒
   * 先出确认条，用户点过之后才把 `?overwrite=1` 交给宿主。旧实现把"已装"一律当成
   * 要覆盖、更新按钮又硬编码 force ⇒ 确认条是死代码，用户手写的同名技能被静默整树
   * 替换；R4-B-3 补上第二档：商店来源但**被本地修改过**（dirty）同样必须先确认 ——
   * 否则一次单击「更新」就把用户加的文件与改过的正文整树删掉。
   * @param item - 能力中心的一行。
   * @param opts - overwrite（用户已确认）/ version（用户点选的版本）。
   */
  const install = async (item: CapabilityItem, opts?: { overwrite?: boolean; version?: string }): Promise<void> => {
    if (installNeedsConfirm(item, opts)) {
      setInstallConfirm({
        key: `${item.kind}:${item.name}`,
        name: item.name,
        localConflict: true,
        reason: overwriteConfirmReason(item),
        ...opts?.version === undefined ? {} : { version: opts.version },
        run: async (overwrite) => { await performInstall(item, { overwrite, ...opts?.version === undefined ? {} : { version: opts.version } }) },
      })
      return
    }
    await performInstall(item, opts)
  }

  /**
   * 内置技能入口卡的动作（安装 / 更新到 vX）。
   *
   * 与普通卡**共用同一条确认条与同一份判据**（{@link needsOverwriteConfirm}）：
   * 本机同名那一份是用户自制、或是**被本地修改过的**商店内容时，先确认再带
   * `?overwrite=1` 打宿主。
   *
   * R4-B-5（第四轮）：**面板的预检不是权威** —— 本机同名技能来自**另一条商店渠道**
   * （如组织库）时，`installedOrigin` 仍是 `store`、`dirty` 也是 false，于是这一发
   * 不带 `?overwrite=1`；宿主按"换渠道"正确地回 409，而内置卡此前只把服务端那句
   * 英文拒绝文案贴在卡片上、右边只有一个「重试」按钮 —— 点多少次都是同一发请求，
   * **没有任何路径能补上 `?overwrite=1`**（普通卡有确认条回落，内置卡漏了）。
   * 现在 `builtin.install` 把 409 如实报回来（`'conflict'`），这里落到同一条确认条。
   * @param card - 内置技能卡。
   */
  const activateBuiltinCard = (card: BuiltinCard): void => {
    const local = items.find(i => i.kind === 'skill' && i.name === card.skill.name && i.source === 'local')
    const key = `builtin:${card.skill.name}`
    /** 本机同名那一份需要覆盖确认（自制 / 已本地修改）⇒ 出确认条（唯一通道）。 */
    const ask = (reason: OverwriteConfirmReason): void => {
      setInstallConfirm({
        key, name: card.skill.name, localConflict: true, reason,
        run: async (overwrite) => { await builtin.install(card.skill, overwrite) },
      })
    }
    if (local !== undefined && needsOverwriteConfirm({ ...local, installed: true })) {
      ask(overwriteConfirmReason({ ...local, installed: true }))
      return
    }
    void builtin.install(card.skill).then((result) => {
      // 宿主说"目标是另一条渠道的同名内容，需要确认"（R4-B-5）⇒ 与普通卡的 409
      // 处理同形：回到确认条，而不是把一条拒绝文案永远贴在卡片上。
      if (result === 'conflict') ask('store')
    })
  }

  const uninstall = async (item: CapabilityItem): Promise<void> => {
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    if (uninstallConfirmKey !== key) { setUninstallConfirmKey(key); return }
    setUninstallConfirmKey(null)
    setAction({ key, kind: 'uninstalling' })
    try {
      // 第二步（用户已确认）才带 `?overwrite=1`：本机自制内容没有它宿主会 409 拒绝
      // （审计 A3）。商店来源不需要它，多带一个显式确认也无害。
      // C2-1：归属证明不了时同时带上 `?ownership=unknown`（宿主据此不写随包技能的
      // 机器级墓碑）—— 端点串与页脚动作本身都由 {@link uninstallRequestUrl} 一处决定。
      const res = await fetch(uninstallRequestUrl(item, { overwrite: true }), { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${String(res.status)}`)
      }
      // 卸载后**立即从列表里去掉本机那一份**（盘点 F-07：只翻 installed=false 会被
      // mergeItems 的"存在本机行即已安装"顶回来）。目录行保留（它仍然在市场里，
      // 只是回到「安装」态）；本机行整行移除。随后 loadAll 用磁盘事实对账。
      setItems(prev => prev
        .filter(i => !(i.kind === item.kind && i.name === item.name && i.source === 'local'))
        .map(i => (i.kind === item.kind && i.name === item.name
          ? { ...i, installed: false, installedVersion: undefined, installedOrigin: undefined, dirty: undefined }
          : i)))
      setAction({ key, kind: 'done-uninstall', name: item.name })
      // 刷新三个分区（本机删掉了、own 的状态、市场的可装态）——「审核中」不粘滞。
      loadAll()
    } catch (cause) {
      setAction({ key, kind: 'failed', error: cause instanceof Error ? cause.message : undefined, name: item.name })
    }
  }

  const upload = async (item: CapabilityItem): Promise<void> => {
    // 只拦进行中的动作（与 install/uninstall 守卫一致）；done-*/failed 是
    // 终态展示,不得阻断后续上传——此前 `action !== null` 会在动作终态后
    // 永久锁死上传/重新上传按钮。
    if (action !== null && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')) return
    const key = `${item.kind}:${item.name}`
    // 归属权预检(2026-09-02):同名同类型已在能力中心存在且**明确不是**本人归属 →
    // 不发送请求,直接提示「名称已被占用」。服务端仍是权威(他人待审行不可见,
    // 预检可能漏网,由 409 NAME_TAKEN「名称已被占用」兜底)。
    //
    // ⚠️ 判据是 `=== false` 而不是 `!== true`（盘点 F-29）：未下发 `is_owner`
    // （旧服务端 / 裁剪载荷）**不等于**"不是我的" —— 按 `!== true` 拦会把作者自己的
    // 上传入口挡掉，而服务端本来会接收这一发。
    const clash = items.find(i => i.kind === item.kind && i.name === item.name && i.source !== 'local')
    if (clash !== undefined && clash.isOwner === false) {
      setAction({
        key, kind: 'failed',
        error: nameTakenError(clash.displayName !== '' ? clash.displayName : clash.name),
        name: item.name,
      })
      return
    }
    setAction({ key, kind: 'uploading' })
    try {
      const path = item.kind === 'skill' ? '/api/zeokeel/shared-skills/upload' : '/api/zeokeel/agent-presets/upload'
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: item.name }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: unknown; code?: unknown }
        // R5-B-1 的客户端尾巴：下架冻结（409 APP_DELISTED）说清"为什么没成 + 怎么解"，
        // 而不是把服务端 message 原样（或 `HTTP 409`）丢给用户。判据**只看错误码**
        // （409 同时是 NAME_TAKEN/VERSION_*/CONFLICT 的码），其它码逐字沿用原行为。
        throw new Error(uploadFailureText({
          ...typeof data.code === 'string' ? { code: data.code } : {},
          ...typeof data.error === 'string' ? { message: data.error } : {},
          status: res.status,
        }))
      }
      setAction({ key, kind: 'done-upload', name: item.name })
      // 上传成功 ⇒ 刷新全部分区：**own** 会出现/更新这条的 pending 行（「我上传」与
      // 卡片上的状态徽章都靠它），否则用户会看到"传完了但界面还是未上传"（F-08/F-11）。
      loadAll()
    } catch (cause) {
      setAction({ key, kind: 'failed', error: cause instanceof Error ? cause.message : undefined, name: item.name })
    }
  }

  /** 已归并的全量行（卡片去重的唯一位置；计数/详情/分段都从它派生）。 */
  const mergedAll = useMemo(() => mergeItems(items), [items])

  /** 四个分段的角标计数（按归并行算，同 kind:name 只算一次）。 */
  const counts = useMemo(() => tabCounts(mergedAll), [mergedAll])

  /**
   * 当前分段可见的行：分段 → 搜索 → 类型 → 排序。搜索口径与内置技能一致
   * （name/displayName/description，大小写不敏感）。
   */
  const visible = useMemo(() => {
    const base = itemsForTab(mergedAll, tab)
    const q = search.trim().toLowerCase()
    const searched = q === '' ? base : base.filter(i =>
      (i.name ?? '').toLowerCase().includes(q)
      || (i.displayName ?? '').toLowerCase().includes(q)
      || (i.description ?? '').toLowerCase().includes(q),
    )
    const kindFiltered = filter === 'all' ? searched : searched.filter(i => i.kind === filter)
    return sortItems(kindFiltered, sort)
  }, [mergedAll, tab, filter, search, sort])

  // 让内置技能的"安装成功"回调拿到最新的 loadAll（hook 在 loadAll 之前调用）。
  loadAllRef.current = loadAll

  const sectionStatus = (key: SectionKey): SectionState => sections[key] ?? { status: 'idle', error: '' }
  /** 本机技能库已有的技能名（含已安装的平台内置技能）—— 用来避免重复渲染。 */
  const localSkillNames = useMemo(
    () => new Set(mergedAll.filter(i => i.kind === 'skill' && i.source === 'local').map(i => i.name)),
    [mergedAll],
  )

  /** 各分段"决定页面骨架"的分区（own 分区还要本机分区补草稿）。 */
  const primarySectionsFor = (which: SourceTab): SectionKey[] =>
    which === 'market' ? ['market'] : which === 'installed' ? ['mine'] : which === 'own' ? ['own', 'mine'] : ['market', 'mine']

  /** 骨架卡（6 张；加载态不说话，直接给卡片形状）。 */
  const renderSkeleton = (): React.ReactNode => (
    <>
      {skeletonKeys().map(key => (
        <Card key={key} style={{ padding: '12px 14px', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 8 }} data-role="capability-skeleton">
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="zeokeel-capability-skeleton-block" style={{ width: 32, height: 32, borderRadius: 9, flex: 'none' }} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <span className="zeokeel-capability-skeleton-block" style={{ width: '38%', height: 12 }} />
              <span className="zeokeel-capability-skeleton-block" style={{ width: '68%', height: 10 }} />
            </span>
          </span>
          <span className="zeokeel-capability-skeleton-block" style={{ width: '88%', height: 10 }} />
          <span style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 8 }}>
            <span className="zeokeel-capability-skeleton-block" style={{ width: 92, height: 24, borderRadius: 8 }} />
            <span className="zeokeel-capability-skeleton-block" style={{ width: 60, height: 24, borderRadius: 8 }} />
          </span>
        </Card>
      ))}
    </>
  )

  /** 空态（唯一实现）：标题按分段/筛选分档，主操作是"去市场"/"查看已安装"/"清除筛选"。 */
  const renderEmpty = (title: string): React.ReactNode => {
    const emptyAction = (filter !== 'all' || search.trim() !== '')
      ? <PanelButton variant="secondary" size="md" onClick={() => { setFilter('all'); setSearch('') }}>{t('capability.clearFilters')}</PanelButton>
      : tab === 'market'
        ? <PanelButton variant="secondary" size="md" onClick={() => { setTab('installed') }}>{t('capability.goInstalled')}</PanelButton>
        : <PanelButton variant="primary" size="md" onClick={() => { setTab('market') }}>{t('capability.goMarket')}</PanelButton>
    return (
      <div style={{ gridColumn: '1 / -1' }}>
        <EmptyState icon={<icons.IconCapability size={22} />} tone="neutral" title={title} action={emptyAction} />
      </div>
    )
  }

  /** 分段空态的标题（筛选/搜索生效时统一说"该类型暂无内容"）。 */
  const emptyTitle = (filter !== 'all' || search.trim() !== '')
    ? t('capability.emptyFilter')
    : tab === 'installed'
      ? t('capability.emptyInstalled')
      : tab === 'own'
        ? t('capability.emptyOwn')
        : tab === 'market'
          ? t('capability.emptyMarket')
          : t('capability.emptyAll')

  /**
   * 内置技能清单读失败的提示条（判定见 {@link builtinLoadNotice}）：`null` ⇒ 不渲染。
   *
   * 两处渲染口径：
   *  - `builtin.error !== null` 时**必须**出现（`builtinSkillsLoadOutcome` 的 `failed`）；
   *  - 404（旧版服务端没有这条路由）= `absent` ⇒ hook 不置错误 ⇒ 这里什么都不渲染
   *    （与既有口径一致：那块区域整块隐藏）。
   * 重试按钮接的是 `builtin.reload()`（重新拉一次清单），不是分区目录的 `loadAll()`。
   */
  const builtinNotice = builtinLoadNotice(builtin.error)
  const builtinErrorStrip = builtinNotice === null ? null : (
    <div style={{ gridColumn: '1 / -1' }} data-role="capability-builtin-error">
      <EmptyState
        icon={<icons.IconAlert size={22} />}
        tone="danger"
        title={builtinNotice.message}
        action={<PanelButton variant="secondary" size="md" onClick={() => { builtin.reload() }}>{builtinNotice.retry}</PanelButton>}
      />
    </div>
  )

  /**
   * 当前分段的分区渲染：骨架（加载）/ 错误（分区独立）/ 内置卡 + 条目卡，或空态。
   *
   * 内置技能按**动作**分流（2026-09-20 用户口径）：`install`（本机没装）⇒ 市场口径、
   * `update`（本机已装且有新版）⇒ 已安装口径；「全部」两者都出，「我上传」不出
   * （内置技能不是用户上传的内容）。出卡口径仍由 `planBuiltinCards` 决定。
   */
  const renderSection = (which: SourceTab): React.ReactNode => {
    const primary = primarySectionsFor(which)
    const settled = primary.every((key) => {
      const st = sectionStatus(key)
      return st.status === 'ok' || st.status === 'error'
    })
    if (!settled && items.length === 0) return renderSkeleton()
    // 分区错误态：先看本分区的主取数源（「我上传」优先 own、其余优先 market/mine）。
    // 错误与重试都**只影响本分区**，其余分区照常（R16B-26 之后的既有口径）。
    // 「全部」是三个来源的并集：只有**全部主取数源都失败**才把整页换成错误态，
    // 否则会把一侧可用的数据（例如本机已装）一起藏掉 —— 那正是"分区独立错误态"要避免的。
    const errored = primary.filter(key => sectionStatus(key).status === 'error')
    const errorKey = which === 'all'
      ? (primary.length > 0 && errored.length === primary.length ? errored[0] : undefined)
      : errored[0]
    const st = errorKey === undefined ? undefined : sectionStatus(errorKey)
    if (st !== undefined && st.status === 'error') {
      return (
        <div style={{ gridColumn: '1 / -1' }}>
          <EmptyState
            icon={<icons.IconAlert size={22} />}
            tone="danger"
            title={st.error}
            action={<PanelButton variant="secondary" size="md" onClick={() => { void loadAll() }}>{t('capability.retry')}</PanelButton>}
          />
        </div>
      )
    }
    const builtinAll = planBuiltinCards({
      rows: builtin.rows,
      // 两个事实源取并集：服务端下发的 installed[] + 面板列表里的本地技能名。
      installedNames: new Set([...builtin.installed, ...localSkillNames]),
      // 本机已装版本（provenance 的安装时版本）——"已装且更旧"就靠它与清单版本对比。
      installedVersions: builtin.versions,
      query: search,
      kindFilter: filter,
      busy: builtin.busy,
      failed: builtin.failed,
    })
    const builtinCards = which === 'own'
      ? []
      : which === 'market'
        ? builtinCardsForTab(builtinAll, 'market')
        : which === 'installed'
          ? builtinCardsForTab(builtinAll, 'mine')
          : builtinAll
    const cards = planSectionCards({ rows: visible, builtinCards })
    // 内置清单读失败 ⇒ 这一条**必须**出现：列表为空时它就是分区内容（否则空分区里
    // 错误与"什么都没有"同形），列表非空时挂在卡片前面（提示这份列表不完整）。
    if (cards.length === 0) {
      return builtinErrorStrip ?? renderEmpty(emptyTitle)
    }
    // 内置技能排在前面（数量少且是平台自带），其余按用户选择的排序；同名技能的重复卡
    // 已在 planSectionCards 里去掉（R2-SK-6）——这里只做渲染，不再自己拼数组。
    return (
      <>
        {builtinErrorStrip}
        {cards.map(card => (card.type === 'builtin'
          ? (view === 'grid' ? renderBuiltinCard(card.card) : renderBuiltinRow(card.card))
          : (view === 'grid' ? renderCard(card.item) : renderListRow(card.item))))}
      </>
    )
  }

  /**
   * 详情目标的**实时解析**（盘点 F-54：弹层里的快照会过期）。列表刷新后按
   * `kind:name` 重新取那一行；行没了（例如刚被卸载/删除）就保留最后一次快照，
   * 让用户还能看到"它已经不在了"的动作结果。
   */
  const resolvedDetail = useMemo(() => {
    if (detail === null) return null
    if (detail.kind === 'builtin') return detail
    const fresh = mergedAll.find(i => i.kind === detail.item.kind && i.name === detail.item.name)
    return fresh === undefined ? detail : { kind: 'item' as const, item: fresh }
  }, [detail, mergedAll])

  /**
   * 页脚动作的**唯一渲染入口**（网格卡、列表行、详情共用）。
   *
   * 判定全部来自 {@link planCardActionForTab}（A6/N1）：这里只做按钮映射。更新按钮
   * **不再因 official 置灰**（盘点 F-09：官方内容有新版时永远升不上去）；上传/卸载
   * 仍按归属/来源判定（`planCardAction` 的输出不变）。
   * @param item - 行。
   * @param plan - 该行在当前分段下的动作。
   * @param busy - 本行自己的动作在飞。
   * @param blocked - 站级闸（另有动作在飞）。
   * @param size - 按钮尺寸（网格 md / 列表 sm / 详情 md）。
   */
  const renderCardAction = (
    item: CapabilityItem,
    plan: CardActionPlan,
    busy: boolean,
    blocked: boolean,
    size: 'sm' | 'md' = 'md',
  ): React.ReactNode => {
    const key = `${item.kind}:${item.name}`
    return (
      plan.kind === 'uninstall' ? renderUninstall(item, key, busy, blocked, size)
        : plan.kind === 'update' ? (
          <PanelButton variant="primary" size={size} disabled={blocked} onClick={() => { void install(item) }}>
            {t('capability.updateTo', { version: plan.version })}
          </PanelButton>
        )
          : plan.kind === 'reupload'
            ? <PanelButton variant="secondary" size={size} disabled={blocked} onClick={() => { void upload(item) }}>{t('capability.reupload')}</PanelButton>
            : plan.kind === 'review'
              ? <Chip tone={plan.status === 'pending' ? 'warn' : plan.status === 'rejected' ? 'danger' : 'success'}>
                {plan.status === 'pending' ? t('capability.awaitingReview') : plan.status === 'rejected' ? t('capability.rejected') : t('capability.approved')}
              </Chip>
              // 已转交（R5-B-2）：这一格**没有**可达动作 —— 上传会被服务端 409 挡下，
              // 所以给状态胶囊而不是假按钮（形态与「等待审核」那一档一致）。
              : plan.kind === 'transferred'
                ? <Chip tone="warn">{t('capability.transferred')}</Chip>
                // 已下架且本机没有可卸的一份（R5-B-1）：同样只报状态。
                : plan.kind === 'delisted'
                  ? <Chip tone="neutral" plain>{t('capability.delisted')}</Chip>
                  // 符号链接形态（R17B-01）：`packSkill` 有意拒收 ⇒ 这一格只标事实。
                  : plan.kind === 'linked'
                    ? <Chip tone="neutral" plain>{t('capability.originSymlink')}</Chip>
                    : plan.kind === 'upload'
                      ? <PanelButton variant="primary" size={size} disabled={blocked} onClick={() => { void upload(item) }}>{t(uploadActionLabelKey(item))}</PanelButton>
                      : <PanelButton variant="primary" size={size} disabled={blocked} onClick={() => { void install(item) }}>{t('capability.install')}</PanelButton>
    )
  }

  /**
   * 「卸载」按钮区（两段式确认）。已装目录行与"本机内置（builtin/plugin）"行共用。
   * 本机自制内容那一档用 danger 文案（审计 A3）。
   */
  const renderUninstall = (item: CapabilityItem, key: string, busy: boolean, blocked: boolean, size: 'sm' | 'md'): React.ReactNode => {
    if (uninstallConfirmKey !== key) {
      return <PanelButton variant="secondary" size={size} disabled={blocked} onClick={() => { void uninstall(item) }}>{t('capability.uninstall')}</PanelButton>
    }
    return (
      <span style={{ display: 'flex', gap: 6 }}>
        <PanelButton variant="danger" size={size} disabled={blocked} onClick={() => { void uninstall(item) }}>
          {busy && action?.kind === 'uninstalling'
            ? t('capability.uninstalling')
            : needsOverwriteConfirm(item) ? t('capability.deleteLocal') : t('capability.confirmUninstall')}
        </PanelButton>
        <PanelButton variant="secondary" size={size} disabled={busy} onClick={() => { setUninstallConfirmKey(null) }}>{t('capability.cancel')}</PanelButton>
      </span>
    )
  }

  /** 详情按钮（ghost 图标 + 文案；E2E 按「详情」文案点击）。 */
  const renderDetailButton = (target: DetailTarget, title: string): React.ReactNode => (
    <PanelButton
      variant="ghost"
      size="sm"
      icon={<icons.IconInfo size={13} />}
      aria-label={`${t('capability.detail')} ${title}`}
      onClick={() => { setDetail(target); setInstallConfirm(null); setUninstallConfirmKey(null) }}
    >
      {t('capability.detail')}
    </PanelButton>
  )

  /**
   * 卸载覆盖确认的后果说明（两档措辞的唯一入口，R4-B-3 / R19B-07）。
   *
   * 只在用户点了「卸载」、确认按钮已换成「仍要删除/确认卸载」时出现 —— 这是**瞬时
   * 交互提示**，不是卡片常驻状态段落（设计：卡面只留短状态，长说明进详情）。
   * 两档：本机自制 vs 商店来源但被本地改过；文案全部在字典里（面板无第二份硬编码）。
   */
  const renderUninstallWarning = (item: CapabilityItem): React.ReactNode => (
    <p style={{ ...HINT_TEXT, color: 'var(--dsw-alias-state-error-primary)' }} data-role="local-remove-warning">
      {overwriteConfirmReason(item) === 'dirty'
        ? t('capability.confirmUninstallDirty', { name: item.name })
        : t('capability.confirmUninstallLocal', { name: item.name })}
    </p>
  )

  /** 网格卡（普通条目）。 */
  const renderCard = (item: CapabilityItem): React.ReactNode => {
    const key = `${item.kind}:${item.name}`
    const busy = action?.key === key && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')
    // 别的卡片正在装/卸/上传时，本卡片的按钮必须**置灰**：`install()`/`uninstall()`/
    // `upload()` 第一行是 `action 在飞就 return`，此前按钮外观仍是可点的启用态 ⇒ 慢
    // 安装期间其它卡片表现为"死按钮"（2026-09-21 审计）。
    const blocked = busy || inFlight
    const title = item.displayName !== '' ? item.displayName : item.name
    const plan = planCardActionForTab(item, tab)
    const delisted = isDelistedItem(item)
    return (
      <Card
        key={key}
        interactive
        muted={item.status === 'rejected' || delisted}
        style={CARD}
        className="zeokeel-skill-card"
        data-role="capability-card"
        data-key={key}
        data-kind={item.kind}
        data-source={item.source}
      >
        <div style={TITLE_ROW}>
          <IconTile size={36} radius={11} tone={item.kind === 'skill' ? 'brand' : 'neutral'} label={title.charAt(0)} />
          <div style={NAME_COL}>
            <div style={NAME_WRAP}>
              <p style={NAME} title={title}>{title}</p>
              {cardChips(item, tab).map(renderChipSpec)}
            </div>
            {title !== item.name && <p style={SLUG} title={item.name}>{item.name}</p>}
          </div>
        </div>
        {item.description !== '' && (
          <p style={DESC_CLAMP} title={item.description} data-role="card-description">{item.description}</p>
        )}
        {uninstallConfirmKey === key && needsOverwriteConfirm(item) && renderUninstallWarning(item)}
        <div style={META_ROW}>
          <span style={META}>{item.author !== '' ? `v${item.version} · ${item.author}` : `v${item.version}`}</span>
          <span style={{ flex: 1 }} />
          {cardStatusDots(item, tab).map(renderStatusDot)}
        </div>
        <div style={CARD_FOOT}>
          {renderCardAction(item, plan, busy, blocked)}
          {renderDetailButton({ kind: 'item', item }, title)}
        </div>
      </Card>
    )
  }

  /** 列表行（紧凑；与网格卡共用同一套判定与动作）。 */
  const renderListRow = (item: CapabilityItem): React.ReactNode => {
    const key = `${item.kind}:${item.name}`
    const busy = action?.key === key && (action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading')
    const blocked = busy || inFlight
    const title = item.displayName !== '' ? item.displayName : item.name
    const plan = planCardActionForTab(item, tab)
    return (
      <Card
        key={key}
        interactive
        muted={item.status === 'rejected' || isDelistedItem(item)}
        style={LIST_ROW}
        className="zeokeel-skill-card"
        data-role="capability-row"
        data-key={key}
        data-kind={item.kind}
        data-source={item.source}
      >
        <IconTile size={28} radius={8} tone={item.kind === 'skill' ? 'brand' : 'neutral'} label={title.charAt(0)} />
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <p style={{ ...NAME, fontSize: 13 }} title={title}>{title}</p>
            <span style={{ ...SLUG, flex: 'none' }} title={item.name}>{item.name}</span>
            {cardChips(item, tab).map(renderChipSpec)}
          </span>
          <p style={LIST_DESC} title={item.description} data-role="card-description">
            {item.description !== '' ? item.description : (item.runtimeName !== undefined ? `${t('capability.runtimeName')}: ${item.runtimeName}` : '')}
          </p>
        </span>
        <span style={{ flex: 'none', display: 'flex', gap: 8, alignItems: 'center' }}>
          {cardStatusDots(item, tab).map(renderStatusDot)}
        </span>
        <span style={{ flex: 'none', display: 'flex', gap: 6, alignItems: 'center' }}>
          {renderCardAction(item, plan, busy, blocked, 'sm')}
          {renderDetailButton({ kind: 'item', item }, title)}
        </span>
      </Card>
    )
  }

  /** 内置技能卡（网格）：与普通技能同构（同一套 CARD / 标题行 / 徽章 / 页脚按钮）。 */
  const renderBuiltinCard = (card: BuiltinCard): React.ReactNode => {
    const skill = card.skill
    const key = `builtin:${skill.name}`
    const title = skill.title !== undefined && skill.title !== '' ? skill.title : skill.name
    const label = card.action === 'update'
      ? t('capability.updateTo', { version: skill.version })
      : t('capability.builtinInstall')
    const busy = builtin.busy === skill.name
    return (
      <Card key={key} interactive style={CARD} className="zeokeel-skill-card"
        data-role="capability-card" data-key={key} data-kind="skill" data-source="builtin">
        <div style={TITLE_ROW}>
          <IconTile size={36} radius={11} tone="brand" label={title.charAt(0)} />
          <div style={NAME_COL}>
            <div style={NAME_WRAP}>
              <p style={NAME} title={title}>{title}</p>
              <Chip tone="neutral" plain>{t('capability.builtinBadge')}</Chip>
            </div>
            <p style={SLUG}>{skill.author !== undefined && skill.author !== '' ? `v${skill.version} · ${skill.author}` : `v${skill.version}`}</p>
          </div>
        </div>
        {skill.description !== undefined && skill.description !== '' && (
          <p style={DESC_CLAMP} title={skill.description} data-role="card-description">{skill.description}</p>
        )}
        <div style={CARD_FOOT}>
          {card.state === 'failed' && card.failure !== null ? (
            <>
              <span style={{ ...META, flex: 1, color: 'var(--dsw-alias-state-error-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={card.failure}>
                {card.failure}
              </span>
              <PanelButton variant="primary" size="md" disabled={inFlight} onClick={() => { activateBuiltinCard(card) }}>
                {t('capability.builtinRetry')}
              </PanelButton>
            </>
          ) : (
            <PanelButton variant="primary" size="md" disabled={inFlight || busy} onClick={() => { activateBuiltinCard(card) }}>{label}</PanelButton>
          )}
          {renderDetailButton({ kind: 'builtin', card }, title)}
        </div>
      </Card>
    )
  }

  /** 内置技能行（列表视图）。 */
  const renderBuiltinRow = (card: BuiltinCard): React.ReactNode => {
    const skill = card.skill
    const key = `builtin:${skill.name}`
    const title = skill.title !== undefined && skill.title !== '' ? skill.title : skill.name
    const label = card.action === 'update'
      ? t('capability.updateTo', { version: skill.version })
      : t('capability.builtinInstall')
    return (
      <Card key={key} interactive style={LIST_ROW} className="zeokeel-skill-card"
        data-role="capability-row" data-key={key} data-kind="skill" data-source="builtin">
        <IconTile size={28} radius={8} tone="brand" label={title.charAt(0)} />
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <p style={{ ...NAME, fontSize: 13 }} title={title}>{title}</p>
            <span style={{ ...SLUG, flex: 'none' }} title={skill.name}>{skill.name}</span>
            <Chip tone="neutral" plain>{t('capability.builtinBadge')}</Chip>
          </span>
          <p style={LIST_DESC} title={skill.description ?? ''} data-role="card-description">
            {skill.description ?? `v${skill.version}`}
          </p>
        </span>
        <span style={{ flex: 'none', display: 'flex', gap: 6, alignItems: 'center' }}>
          <PanelButton variant="primary" size="sm" disabled={inFlight || builtin.busy === skill.name} onClick={() => { activateBuiltinCard(card) }}>
            {label}
          </PanelButton>
          {renderDetailButton({ kind: 'builtin', card }, title)}
        </span>
      </Card>
    )
  }

  /** 详情子视图（面板内整页；不再用弹层）。 */
  const renderDetail = (target: DetailTarget): React.ReactNode => {
    const busyKey = target.kind === 'builtin' ? `builtin:${target.card.skill.name}` : `${target.item.kind}:${target.item.name}`
    const busy = action?.key === busyKey && inFlight
    let actions: React.ReactNode
    let notice: React.ReactNode
    if (target.kind === 'item') {
      actions = renderCardAction(target.item, planCardActionForTab(target.item, tab), busy, inFlight)
      notice = uninstallConfirmKey === `${target.item.kind}:${target.item.name}` && needsOverwriteConfirm(target.item)
        ? renderUninstallWarning(target.item)
        : undefined
    } else {
      const card = target.card
      const label = card.action === 'update'
        ? t('capability.updateTo', { version: card.skill.version })
        : t('capability.builtinInstall')
      actions = (
        <PanelButton variant="primary" size="md" disabled={inFlight || builtin.busy === card.skill.name} onClick={() => { activateBuiltinCard(card) }}>
          {label}
        </PanelButton>
      )
      notice = undefined
    }
    return (
      <CapabilityDetailView
        target={target}
        busy={busy}
        blocked={inFlight}
        tab={tab}
        actions={actions}
        notice={notice}
        onInstallVersion={version => {
          if (target.kind !== 'item') return
          // 不传 overwrite：本机自制同名时先出确认条（审计 A15）；版本随意图一起
          // 存进确认条，确认后重放的还是这一个版本（A11）。
          void install(target.item, { version })
        }}
        onBack={() => { setDetail(null) }}
        onClose={() => { setDetail(null) }}
      />
    )
  }

  /**
   * 覆盖确认条（唯一放行点；列表与详情两个视图共用）。
   *
   * 「两个视图共用」是必须的：详情里点历史版本安装时也可能撞上本机同名内容
   * （审计 A15），只把确认条放进列表视图会让那一发静默停在待确认态。
   */
  const renderConfirmStrip = (): React.ReactNode => installConfirm === null ? null : (
    <Card style={{ padding: '10px 14px', borderRadius: 12, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <icons.IconAlert size={15} style={{ color: 'var(--dsw-alias-state-warn-label)' }} />
      <span style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
        {confirmStripText(installConfirm)}
      </span>
      <PanelButton variant="primary" size="sm" onClick={() => {
        const pending = installConfirm
        setInstallConfirm(null)
        // 重放的是**同一发**安装（含用户在详情视图里点选的版本，审计 A11），
        // 并且只有这里才把 `?overwrite=1` 交给宿主（用户确认过的唯一凭据）。
        void pending.run(true)
      }}>{confirmStripAction(installConfirm)}</PanelButton>
      <PanelButton variant="secondary" size="sm" onClick={() => { setInstallConfirm(null) }}>{t('capability.cancel')}</PanelButton>
    </Card>
  )

  /** 动作结果条（终态；与确认条同位置，出现时滚进视口）。 */
  const renderResultStrip = (): React.ReactNode => action === null || action.kind === 'installing' || action.kind === 'uninstalling' || action.kind === 'uploading' ? null : (
    <Card style={{ padding: '9px 14px', borderRadius: 12, marginBottom: 12, fontSize: 13, color: action.kind === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' }}>
      {action.kind === 'done-install'
        ? t('capability.installedName', { name: action.name ?? '' })
        : action.kind === 'done-uninstall'
          ? t('capability.uninstalledName', { name: action.name ?? '' })
          : action.kind === 'done-upload'
            ? t('capability.uploadedName', { name: action.name ?? '' })
            : t('capability.failed', { error: action.error ?? '' })}
    </Card>
  )

  const content = renderSection(tab)

  return (
    <div className="zeokeel-capability" data-role="capability-page">
      <PanelPage
        icon={<icons.IconCapability size={16} />}
        title={t('capability.title')}
        subtitle={t('capability.subtitle')}
        backLabel={t('capability.backToChat')}
        onClose={onClose}
        width={1180}
        actions={(
          <PanelButton variant="secondary" size="sm" icon={<icons.IconRefresh size={13} />} aria-label={t('capability.refresh')} title={t('capability.refresh')} onClick={() => { loadAll() }} />
        )}
        toolbar={resolvedDetail === null ? (
          <div style={PANEL_TOOLBAR}>
            <SegmentedControl
              ariaLabel={t('capability.title')}
              value={tab}
              options={[
                { value: 'all' as const, label: t('capability.tabAll'), count: counts.all },
                { value: 'installed' as const, label: t('capability.tabInstalled'), count: counts.installed },
                { value: 'own' as const, label: t('capability.tabOwn'), count: counts.own },
                { value: 'market' as const, label: t('capability.tabMarket'), count: counts.market },
              ]}
              onChange={next => {
                setTab(next)
                setInstallConfirm(null)
                setUninstallConfirmKey(null)
              }}
            />
            <span style={{ display: 'flex', gap: 4 }}>
              {(['all', 'skill', 'agent'] as const).map(f => (
                <button
                  key={f}
                  type="button"
                  className="zeokeel-chipbtn"
                  data-active={filter === f ? 'true' : 'false'}
                  data-role={`capability-type-${f}`}
                  style={FILTER}
                  onClick={() => { setFilter(f) }}
                >
                  {f === 'all' ? t('capability.filterAll') : f === 'skill' ? t('capability.filterSkill') : t('capability.filterAgent')}
                </button>
              ))}
            </span>
            <span style={{ flex: 1 }} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={e => { setSearch(e.target.value) }}
              placeholder={t('capability.searchPlaceholder')}
              aria-label={t('capability.searchPlaceholder')}
              style={PANEL_SEARCH}
            />
            <select
              value={sort}
              aria-label={t('capability.sortLabel')}
              title={t('capability.sortLabel')}
              onChange={event => { setSort(event.target.value as SortKey) }}
              style={SORT_SELECT}
            >
              <option value="updated">{t('capability.sortUpdated')}</option>
              <option value="name">{t('capability.sortName')}</option>
              <option value="downloads">{t('capability.sortDownloads')}</option>
            </select>
            <span style={{ display: 'flex', gap: 4 }} role="group" aria-label={t('capability.viewGrid')}>
              <PanelButton
                variant={view === 'grid' ? 'secondary' : 'ghost'}
                size="sm"
                aria-label={t('capability.viewGrid')}
                aria-pressed={view === 'grid'}
                onClick={() => { setView('grid') }}
              >
                <span aria-hidden="true">{'▦'}</span>
              </PanelButton>
              <PanelButton
                variant={view === 'list' ? 'secondary' : 'ghost'}
                size="sm"
                aria-label={t('capability.viewList')}
                aria-pressed={view === 'list'}
                onClick={() => { setView('list') }}
              >
                <span aria-hidden="true">{'☰'}</span>
              </PanelButton>
            </span>
            <span style={{ ...META, margin: 0 }} data-role="capability-result-count">
              {t('capability.resultCount', { count: String(visible.length) })}
            </span>
          </div>
        ) : undefined}
      >
        {resolvedDetail !== null ? (<div ref={noticeRef}>{renderConfirmStrip()}{renderResultStrip()}{renderDetail(resolvedDetail)}</div>) : (
          <>
            {/* 结果条/确认条挂在滚动区顶部，出现时滚进视口（见 noticeRef 的注释）。 */}
            <div ref={noticeRef}>{renderConfirmStrip()}{renderResultStrip()}</div>
            {view === 'grid'
              ? <div style={PANEL_GRID} data-role="capability-grid">{content}</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-role="capability-list">{content}</div>}
          </>
        )}
      </PanelPage>
    </div>
  )
}
