import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { request, ADMIN_API } from '../../api'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Switch } from '../../components/ui/switch'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { EmptyState } from '../../components/empty-state'
import { PageHeader } from '../../components/page-header'
import { errorText } from '../../lib/api-error'
import { useFlash } from '../../lib/use-flash'
import { hasPermission, PERM_CAP_READ, PERM_CAP_WRITE } from '../../lib/rbac'
import { Boxes, Check, Download, Eye, Gauge, Megaphone, RefreshCw, Rocket, RotateCcw, Search, Stethoscope, Trash2, UserCog, X } from 'lucide-react'
// 访问级别（可写两值 + 历史值文案 + 筛选匹配）的唯一真源：见 access-level.ts 的
// 文件头。**不要**在本页另写一份标签/匹配逻辑 —— 那是"公开还能不能用"这类
// 误导性文案的滋生地（2026-09-19 契约 §4.4 / I6 / §19 Q13）。
import {
  ACCESS_FILTER_ALL,
  ACCESS_FILTERS,
  accessLevelRejectionMessage,
  accessMeta,
  isAccessFilterValue,
  matchesAccessFilter,
} from './access-level'
// F16 打开次数（契约 §8.9 / §19 Q11）+ §21.4 AI 用量：路径、类型、降级与聚合口径
// 全部收敛在 opens-contract.ts；本页只做渲染与请求编排。
import {
  OPENS_MISSING_ROW_NOTE,
  OPENS_SUMMARY_PATH,
  appOpenCounts,
  classifyEndpointFailure,
  countText,
  requireOpensSummary,
  shapeDrift,
  type EndpointFailure,
  type OpensAppRow,
} from './opens-contract'
import { AnnouncementTemplatesDialog } from './AnnouncementTemplatesDialog'
import { AppOpensSection } from './AppOpensSection'
import { AppAiUsageSection } from './AppAiUsageSection'
// 生命周期动作面（设计 §6.2/§7；审计 C-01…C-04/C-11）：端点、契约类型、生命周期文案与
// 错误码指引的**唯一实现**。页面不在这里重写一份"到期会自动删"的承诺 —— 那种分叉正是 C-01。
import {
  deleteReceipt,
  deployReceipt,
  fmtSize,
  fmtTime,
  freezeConfirmCopy,
  freezeReceipt,
  isDeleted,
  isFrozen,
  isPurged,
  lifecycleErrorText,
  pendingFromSwitch,
  releaseListErrorText,
  restorePath,
  restoreReceipt,
  retentionDaysOf,
  reviewCloseWarning,
  reviewSwitchReceipt,
  type AppLifecycleFields,
  type DeleteResultView,
  type DeployResult,
  type LifecycleActionResult,
  type ExportKind,
  type ReviewSwitchResponse,
} from './apps-lifecycle'
import { DeploymentsBlock, LifecycleBlock } from './LifecycleSections'
import { DeleteDialog, DeployDialog, ExportDialog } from './LifecycleDialogs'
import { PendingQueueDialog } from './PendingQueueDialog'
import { AppDataSection } from './AppDataSection'
import { AppLimitsSection } from './AppLimitsSection'
// per-app 限流覆盖（决策 `docs/decisions/2026-10-22-wasm-per-app-limits.md` §2.5，生产化评审
// 「管理员可发现/可审查」）：列表徽标 + 「只看有覆盖」筛选 + 覆盖总览对话框。
// 端点/类型/错误归一都在 `app-limits.ts`，本页只做取数与渲染。
import {
  LIMIT_OVERRIDES_PATH,
  limitOverridesErrorText,
  parseAppLimitOverrides,
  type AppLimitOverrideRow,
  type AppLimitOverridesView,
} from './app-limits'
import { LimitOverridesDialog } from './LimitOverridesDialog'

/**
 * 应用中心 · 应用(2026-09-19 页面合并):员工自建 WASM 应用的列表与平台级处置。
 *
 * 原 `/app-center` 单页(`pages/AppCenter.tsx`)的**列表部分**。并发/内存限制项在
 * `./Limits.tsx`,两者由 `./AppCenterLayout.tsx` 的子导航串起来(2026-09-19 用户
 * 要求「应用平台并入应用中心」)。
 *
 * 同页顶部的「应用域名」卡片曾在 2026-09-19 上半日搬进「设置」子页,随后随 WASM
 * 「客户端专属」改造**整页删除**(应用只在桌面客户端内以 `zeokeel-app://<app_id>/`
 * 打开,服务端不再有应用基域配置面;契约 §4.4/§4.5)。本页因此也**不渲染任何入口
 * 链接** —— `entry_url` 已从服务端响应与两端 UI 全部取消,唯一可分享形态是深链
 * `<渠道 scheme>://app/<app_id>`(由客户端应用中心给出,管理端不代拼)。**服务端
 * 接口仍在同一组、权限点不变**。
 *
 * 服务端管理面已就绪(server/internal/wasmapp/api/admin.go),本页只做组合与状态
 * 编排,不复制任何后端语义:
 *   GET  /wasm-apps?q=&status=&limit=&offset=  列表(含 total/truncated/积压)
 *   POST /wasm-apps/:app_id/publish     上架(幂等:已上架 changed:false)
 *   POST /wasm-apps/:app_id/unpublish   下架(同上,对称)
 *   POST /wasm-apps/:app_id/freeze      body {"frozen":true|false} 冻结/解冻
 *   PUT  /wasm-apps/:app_id/owner       body {"owner":"<用户名>"} 转移归属
 *   PUT  /wasm-apps/review              body {"required":true|false} 更新审批开关
 *   GET  /wasm-apps/:app_id/releases?status=pending   待审版本清单
 *   POST /wasm-apps/:app_id/releases/:version/approve|reject   审核出口
 *   GET  /wasm-apps/:app_id/diagnostics               运行诊断(失败码/hints/时间线)
 *
 * 本轮(P1-6/P1-7/P1-9/P2-6,2026-09-19 审计):
 *   - **待审批闭环**(P0-1 服务端已就绪,前端此前一行未接):行内徽标 + 状态筛选 +
 *     详情抽屉里的待审清单与「通过/拒绝」;
 *   - **不再静默截断**(P1-7):搜索 + 状态筛选 + 分页 + "共 N 条/当前显示 M 条",
 *     第 201 个应用可被检索;
 *   - **错误信封读全**(P1-6):统一走 errorText(message + details.field + hints),
 *     服务端说的"还差什么条件"不再丢;
 *   - **有代价的动作要二次确认**:开/关更新审批、冻结;
 *   - **运行诊断入口**(P1-9):详情抽屉里直接看失败码计数/hints/最近失败时间线。
 *
 * 两条边界:
 *   - 读面按 capability:read、写面按 capability:write 判定。前端只是**体验层**
 *     (没有权限就不渲染写控件、不发注定 403 的请求);服务端 RequirePermission
 *     才是护栏。**审核按钮例外:无写权限时禁用而不是隐藏** —— 审批队列本身是
 *     只读可见的信息(谁在等审批),按钮消失会让只读账号以为"没有待审"。
 *   - 状态徽章里**冻结优先于上下架**:冻结会连带把 enabled 置 false,只看 enabled
 *     会把"被平台冻结"误读成"员工自己下架了"。deleted_at 非空显示「已删除」。
 */

interface WasmApp extends AppLifecycleFields {
  app_id: string
  title: string
  description: string
  owner: string
  enabled: boolean
  /**
   * 访问级别:`login` 登录后全员 / `whitelist` 白名单。
   *
   * 2026-09-19(WASM 客户端专属改造,契约 §4.4):发布/校验只接受 `login|whitelist`;
   * **历史行仍可能写着 `public`**(匿名公开已废除),服务端读侧一律当 `login`。
   * 因此这里保留 `| string` 的宽松形态、不把 `public` 写进枚举 —— 渲染交给
   * `./access-level` 的 `accessMeta` 统一给出历史文案「已退役（历史值）」。
   */
  access: 'login' | 'whitelist' | string
  purpose: string
  data_sensitivity: string
  current_release_id: number
  /** 可能是空串(版本行已被保留策略回收);展示时回落 '—'。 */
  current_version: string
  /** 待审版本号 + 计数(服务端 adminList 每行下发;空数组不是 null)。 */
  pending_releases: string[]
  pending_count: number
  /**
   * 部署指针（设计 §4 的 `apps.current_deployment_id`）。
   *
   * 缺省 = 服务端未下发（后端泳道 L 未合入时的形态）；界面据此显示「—」而不是 0。
   */
  current_deployment_id?: number
  created_at: string
  updated_at: string
}

interface ListResponse {
  apps: WasmApp[]
  review_required: boolean
  setting_key: string
  /** 组织级待审积压(与分页无关)。 */
  pending_count: number
  /** 命中筛选的总条数(分页之前)。 */
  total: number
  /** 还有下一页。 */
  truncated: boolean
  limit: number
  offset: number
  /**
   * 访问级别筛选的**服务端回显**（2026-09-19，L6 契约依赖）。
   *
   * 服务端支持 `?access=login|whitelist` 时必须把生效值原样回显；前端据此判断
   * "分页与 total 是否已按访问级别过滤"。缺这个键 ⇒ 前端退化为**本页过滤**并
   * 显式提示（不得静默显示一个未过滤的全集数字）。
   */
  access?: string
  /**
   * 退役快照保留期天数（服务端 `limits.RetirementSnapshotRetentionDays`，设计 §5.4）。
   *
   * 为什么列表要带它：冻结确认框必须写出 `purge_after` 的**具体日期**（§7），而动作发生
   * 之前服务端还没写下 purge_after。字段缺省 ⇒ 页面**不推算**日期（宁可不显示，也不编一个）。
   */
  retirement_snapshot_retention_days?: number
  /** 同上（冻结/删除响应用短名；列表若用短名也认）。 */
  retention_days?: number
}

interface PendingRelease {
  id: number
  version: string
  status: string
  /** 提交的标题(版本行自己的值;approve 是它进全组织目录的唯一入口)。 */
  title: string
  /**
   * 提交的描述(版本行自己的值;与 title 同源,approve 会把这两列一起公开)。
   *
   * 老版本服务端不下发它 ⇒ 消费侧一律 `?? ''`(旧服务端 + 新前端不炸)。
   */
  description?: string
  publisher: string
  /** 制品体积(字节);服务端字段名是 size。 */
  size: number
  checksum: string
  changelog: string
  created_at: string
  /** 是否就是线上正在跑的版本。 */
  current: boolean
  /**
   * 审核结果理由(驳回理由)。
   *
   * ⚠️ **服务端 DTO 尚未下发**:`serverstore.WasmRelease` 没有 reason 列,
   * `api/admin.go` 的 adminReleases 行也没有这个字段 —— 拒绝理由目前只落在审计详情里
   * (`wasm_app_release_reject` 的 detail)。前端这里先把渲染位留好(有就显示),
   * 依赖清单见 `temp/wasm-review-r1/fix-wave3.md` 的 R1-uxw-4 条目。
   */
  reason?: string
}

/**
 * 待审版本**将公开的显示面**(标题/描述)与它相对线上生效版本的差异。
 *
 * 为什么必须在审批卡片上渲染(审计第三轮 B 区 CONFIRMED,2026-09-19):approve 是
 * title/description 进全组织目录的**唯一入口**(待审期间 `apps.title` 刻意不写),
 * 而首版待审时 `apps.title` 是 app_id 占位、按提交标题也搜不到 ⇒ 审批人此前只看到
 * 版本号/提交人/时间/体积/变更说明,对"改名/换描述"是在看不到新值的情况下点「通过」
 * 的(与上一批修掉的免审仿冒面同族)。
 *
 * 语义(占位不是标题,不伪造旧值):
 *   - 有生效版本(`current_release_id > 0`)且与待审值不同 ⇒ `changed`,界面渲染
 *     「现标题 X → 待审标题 Y」;
 *   - 首版待审(没有生效版本)⇒ `firstRelease`,只渲染待审值并明说目录暂以应用标识占位;
 *   - 值相同 ⇒ 只渲染一行现值(不制造"变更"的假象)。
 */
function pendingDisclosure(rel: PendingRelease, live: WasmApp): {
  key: 'title' | 'description'
  label: string
  current: string
  next: string
  changed: boolean
  firstRelease: boolean
}[] {
  const firstRelease = live.current_release_id <= 0
  const rows = [
    { key: 'title' as const, label: '标题', current: live.title ?? '', next: rel.title ?? '' },
    { key: 'description' as const, label: '描述', current: live.description ?? '', next: rel.description ?? '' },
  ]
  return rows
    .filter((row) => row.next !== '' || row.current !== '')
    .map((row) => ({
      ...row,
      // 首版待审时 `live.title` 是 app_id 占位 ⇒ 那不是"现标题",不构成"变更"。
      changed: !firstRelease && row.current !== '' && row.current !== row.next,
      firstRelease,
    }))
}

interface ReleasesResponse {
  app_id: string
  status: string
  current_version: string
  releases: PendingRelease[]
  pending_count: number
}

/** 运行诊断(admin.go 的 AdminDiagnostics 与员工面同一份口径)。 */
interface DiagnosticsSummary {
  total: number
  ok: number
  error: number
  killed: number
  failed: number
  reasons: { reason_code: string; count: number; hints: string[] }[]
  hints: string[]
  last_failure_at: string | null
}

interface Diagnostics {
  app_id: string
  app_enabled: boolean
  app_frozen: boolean
  app_deleted: boolean
  owner: string
  window_minutes: number
  retention_days: number
  summary: DiagnosticsSummary
  failures: {
    created_at: string
    outcome: string
    reason_code: string
    guest_exit_code: number
    stderr_tail: string
    cpu_ms: number
    peak_memory_bytes: number
  }[]
  hints: string[]
}

/**
 * 冻结/解冻响应（设计 §5.4：冻结 = frozen_at + purge_after + enabled=0 + **立即尝试快照**）。
 *
 * 真实形状见 `wasmapp/api/lifecycle_actions.go` ：快照结果在 **app 段**
 * （`snapshot_ok` / `snapshot_at` / `snapshot_error`），`purge_after` 也在 app 段；
 * 解冻时 app 段只有 app_id/enabled。归一读取在 `apps-lifecycle.ts` 的 `snapshotOutcome`。
 */
type FreezeResponse = LifecycleActionResult

/**
 * 恢复响应（设计 §5.5：清 deleted_at/frozen_at、enabled=0、**不自动上架**）。
 */
interface RestoreResponse {
  app?: AppLifecycleFields & { app_id?: string; enabled?: boolean; deleted?: boolean }
  retention_days?: number
}

// 访问级别的标签/历史值文案/筛选匹配**不在本页实现**：统一走 `./access-level`
// （两值可写 + 历史 public 渲染成「已退役（历史值）」+ login 命中历史行）。
// 这一页曾自己写一份 ACCESS_META，结果"公开"这类旧口径文字只在某一处被改掉，
// 另一处继续误导管理员（2026-09-19 收敛）。

type StatusVariant = 'success' | 'secondary' | 'destructive'

/** 冻结 > 上下架;已删除优先于一切(列表缺省不含已删,防漏判仍保留判定)。 */
function statusMeta(app: WasmApp): { label: string; variant: StatusVariant } {
  if (app.deleted_at) return { label: '已删除', variant: 'destructive' }
  if (app.frozen_at) return { label: '已冻结', variant: 'destructive' }
  if (app.enabled) return { label: '上架', variant: 'success' }
  return { label: '已下架', variant: 'secondary' }
}

// fmtTime / fmtSize 已移到 `./apps-lifecycle`（详情抽屉的生命周期块与部署历史块共用同一实现，
// 页面不再各自维护一份格式化函数）。

/** 列表页大小:管理面是"人在看"的列表,一页 20 条足够,翻页成本也低。 */
const PAGE_SIZE = 20

/**
 * `releases` 必须**真的是数组**，否则返回 null（调用方按读取失败处理）。
 *
 * F6（审计第二轮 A2-F6）：`out.releases ?? []` 会把"响应里没有版本清单"渲染成
 * "没有被拒的版本。"（对管理员是假陈述），而客户端半边 `app-releases.ts` 对同一份
 * 响应返回结构化失败（UNEXPECTED_RESPONSE）—— 同一功能的两半不能一个说"形状错误"、
 * 一个说"你没有"。
 */
function requireReleases(out: ReleasesResponse): PendingRelease[] | null {
  return Array.isArray(out?.releases) ? out.releases : null
}

/** 状态筛选:取值与**服务端**admin.go 的 status 参数逐字一致(不要本地另造词汇表)。 */
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待审批' },
  { value: 'published', label: '已上架' },
  { value: 'unpublished', label: '已下架' },
  { value: 'frozen', label: '已冻结' },
  // 软删行**默认不出现**在列表里;要复核"谁删了什么"、或对已删应用跑只读诊断/恢复/导出,
  // 必须先能筛出来(R1-uxw-7)。服务端支持 status=deleted,且它就是 include_deleted=1 的同义入口。
  // 这一行筛选器现在真的**有动作可用**（恢复/导出，C-04/C-11）；此前只有筛选没有动作 = 断头路。
  { value: 'deleted', label: '已删除' },
]

/**
 * 列表/看板共用的打开计数窗口（天）。
 *
 * §8.9 管理端出口 ① 要的是"今日 + 近 7 日"；详情抽屉另有 30/90/全部三档。
 */
const OPENS_WINDOW_DAYS = 7

interface AccessFilterState {
  /** 当前筛选值（`all` / `login` / `whitelist`）。 */
  value: string
  /** URL 里带来的**非法**取值（例如旧书签的 `?access=public`）；非空时页面必须明说原因。 */
  rejected: string
}

/**
 * 访问级别筛选的初值：支持 `?access=login|whitelist`（深链/书签）。
 *
 * 为什么读 URL：运营动作（§19 Q13"能筛出历史 public"）常常是"把这个筛选链接发给
 * 另一个管理员"；而旧书签/旧文档里完全可能写着 `?access=public`。
 * 那个值**不能静默当成"全部"**（静默降级 = 管理员以为筛过了，其实看的是全集），
 * 必须给出写侧口径的拒绝消息，并指出历史行该用哪个筛选值去找。
 */
function initialAccessFilter(): AccessFilterState {
  try {
    if (typeof window === 'undefined') return { value: ACCESS_FILTER_ALL, rejected: '' }
    const raw = new URLSearchParams(window.location.search).get('access') ?? ''
    if (raw === '') return { value: ACCESS_FILTER_ALL, rejected: '' }
    if (isAccessFilterValue(raw)) return { value: raw, rejected: '' }
    return { value: ACCESS_FILTER_ALL, rejected: raw }
  } catch {
    // 极端环境（无 URL/隐私模式）下不阻断页面：按"不筛选"渲染。
    return { value: ACCESS_FILTER_ALL, rejected: '' }
  }
}

/** 把筛选同步回 URL（只影响刷新/分享，不参与渲染；失败静默 —— 筛选本身照常工作）。 */
function writeAccessFilterToUrl(value: string) {
  try {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (value === ACCESS_FILTER_ALL) url.searchParams.delete('access')
    else url.searchParams.set('access', value)
    window.history.replaceState(window.history.state, '', url.toString())
  } catch { /* 见上 */ }
}

/**
 * 应用中心 · 应用页的**变体哨兵串**（P3；命名 = `zeokeel.feature.<模块>.v1`，模块名 `apps`
 * 与 Go 侧 `-tags`、渠道配置 `features` 逐字一致）。
 *
 * **每个模块页各自带哨兵**（不是只在分区布局 `AppCenterLayout.tsx` 上写一份）：产物判据的
 * 内容面按"这个文件会不会被别的 chunk 拉进来"判，而静态引用一个子页时（审计 M6 的形态）
 * 被拉进来的正是**这个文件** —— 哨兵不在它身上，泄漏就没有任何观测面。落点必须是**真的
 * 会渲染**的那条路径（这里作为根元素的 data 属性渲染出去）；双侧判据与两条纪律见
 * `pages/CapabilityCenter.tsx` 的同名常量，产物级断言在 `scripts/check-feature-chunks.mjs`。
 */
export const FEATURE_SENTINEL = 'zeokeel.feature.apps.v1'

export default function Apps() {
  const [apps, setApps] = useState<WasmApp[]>([])
  const [reviewRequired, setReviewRequired] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 处置类动作失败(下架/冻结/转移…):列表本身仍然可信,只是那一次操作没成功。 */
  const [error, setError] = useState('')
  /**
   * **列表读取**失败(与上面的动作失败分开)。
   *
   * 分开的理由就是 R1-uxw-2:两者混用一个 error 时,"翻页请求失败"与"下架失败"
   * 在界面上长得一模一样,而前者意味着屏幕上的行数/范围数字已经不可信。
   */
  const [loadError, setLoadError] = useState('')
  /** 成功加载过一次(用来区分"还在读"与"真的没有应用")。 */
  const [loaded, setLoaded] = useState(false)
  /**
   * 服务端回显的 offset = 屏幕上这批行在全集里的起始下标。
   *
   * 范围标签只认它:本地 offset 是"我想看第几页",越界时服务端给的是空页 ——
   * 用本地 offset 自算就会写出"共 25 条,当前显示第 21–40 条"而屏幕上是第一页
   * 的假数字(审计 R1-uxw-2 实测文本)。
   */
  const [pageStart, setPageStart] = useState(0)
  /** 还有下一页:**服务端 truncated 字段**(不再用 offset+shown<total 自算)。 */
  const [truncated, setTruncated] = useState(false)
  /** 在途操作键(`<app_id>:<动作>` 或 'review');非空时禁用写控件防连点。 */
  const [busy, setBusy] = useState('')
  const [ownerTarget, setOwnerTarget] = useState<WasmApp | null>(null)
  const [ownerInput, setOwnerInput] = useState('')
  /** 转移归属弹窗内的失败反馈(渲染在弹窗里,否则被遮罩盖住 = "点了没反应")。 */
  const [ownerError, setOwnerError] = useState('')
  const [detail, setDetail] = useState<WasmApp | null>(null)
  /**
   * 详情抽屉内的成败反馈。
   *
   * R1-uxw-1:审核的「通过/拒绝」是在**弹窗里**点的,而反馈此前渲染在页面级
   * (`apps-error`/`apps-flash`)—— Radix 的整屏遮罩(`fixed inset-0 z-50 bg-black/80`)
   * 把它压住,管理员看到的是"点了没反应"(真实 Chromium 命中测试:错误文本中心点
   * 命中的是弹窗标题)。现在反馈渲染进 `DialogContent` 内部。
   */
  const [detailFeedback, setDetailFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 拒绝确认框内的失败反馈(理由输入在这里,失败必须原地可见)。 */
  const [rejectError, setRejectError] = useState('')
  /**
   * 刚提交的驳回(版本 + 理由)。
   *
   * 服务端 DTO 还没有 `reason` 字段(见 PendingRelease.reason 注释),所以拒绝成功后
   * 那一行就从待审清单里消失了 —— 管理员刚写下的理由会在界面上蒸发。这里如实回显
   * "我刚才驳回了谁、理由是什么",服务端补上字段后由 `rel.reason` 接管。
   */
  const [lastRejection, setLastRejection] = useState<{ version: string; reason: string } | null>(null)
  /** 审核开关的**待确认**目标值(null = 没有待确认的变更)。 */
  const [reviewPrompt, setReviewPrompt] = useState<boolean | null>(null)
  /** 冻结的**待确认**目标行(null = 无)。解冻不确认(恢复服务,无破坏性)。 */
  const [freezeTarget, setFreezeTarget] = useState<WasmApp | null>(null)
  /** 下架的**待确认**目标行(R1-uxw-13:下架=全组织员工当场不可用,不能一键生效)。 */
  const [unpublishTarget, setUnpublishTarget] = useState<WasmApp | null>(null)
  /** 拒绝理由的目标版本(null = 关闭)。 */
  const [rejectTarget, setRejectTarget] = useState<PendingRelease | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [flashMsg, flash] = useFlash()

  // 列表筛选/分页状态(全部进查询串,服务端才是过滤真源)。
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  /**
   * 访问级别筛选(2026-09-19 契约 §19 Q13)。
   *
   * 取值只有 `all | login | whitelist`（两值 + 全部）；历史 `public` 行由 `login`
   * 命中（读侧同口径），历史行的访问级别列渲染成「已退役（历史值）」——
   * 服务端拿到 `access=` 才算服务端过滤，拿不到就退化成本页过滤 + 明说（见
   * `accessFilterSupported`）。**不做静默的部分过滤**：那会让"共 N 条"撒谎。
   */
  const [accessFilter, setAccessFilter] = useState<AccessFilterState>(() => initialAccessFilter())
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [pendingTotal, setPendingTotal] = useState(0)
  /**
   * 服务端**回显**的访问级别筛选值（admin.go 的列表响应）。
   *
   * 这是判断"服务端到底支不支持 access= 过滤"的唯一依据：回显相等 ⇒ 服务端过滤
   * 生效，分页与 total 都可信；回显缺失 ⇒ 只在本页做本地过滤，并显式提示
   * "共 N 条与翻页仍是未筛选全集"。契约依赖见 L6-status.md。
   */
  const [accessEcho, setAccessEcho] = useState('')

  // 打开次数(F16):跨应用聚合一次取回,列表列与详情抽屉共用(见 opens-contract.ts)。
  const [opensRows, setOpensRows] = useState<Record<string, OpensAppRow>>({})
  const [opensFailure, setOpensFailure] = useState<EndpointFailure | null>(null)
  const [announceOpen, setAnnounceOpen] = useState(false)

  // ---------------------------------------------------------------------------
  // per-app 限流覆盖（决策 §2.5；生产化评审「管理员视角」缺口）
  // ---------------------------------------------------------------------------
  /**
   * 全部覆盖（`GET /wasm-apps/limit-overrides`）。
   *
   * 一次取回同时服务三件事：行内徽标（哪些应用有覆盖）、页头「限流覆盖（N）」的计数、
   * 「只看有覆盖」筛选。**读失败时 `overrides` 为 null** ⇒ 徽标不渲染、筛选禁用，并且
   * 页面上明说"覆盖清单未读到" —— 缺数据被渲染成"没有覆盖"会让管理员得出相反结论。
   */
  const [overrides, setOverrides] = useState<AppLimitOverridesView | null>(null)
  const [overridesError, setOverridesError] = useState('')
  const [overridesLoading, setOverridesLoading] = useState(false)
  /** 「只看有覆盖」筛选：**只筛当前页**，不改分页/排序语义（全量清单在总览对话框里）。 */
  const [onlyOverrides, setOnlyOverrides] = useState(false)
  const [overridesOpen, setOverridesOpen] = useState(false)

  // ---------------------------------------------------------------------------
  // 生命周期动作面（设计 §7；审计 C-02/C-03/C-04/C-11）
  // ---------------------------------------------------------------------------
  /** 跨应用待审队列：页头「待审 N」徽标可点 ⇒ 打开（C-07 的断头路出口）。 */
  const [pendingQueueOpen, setPendingQueueOpen] = useState(false)
  /** 部署/回滚对话框的目标行（null = 关闭）。 */
  const [deployTarget, setDeployTarget] = useState<WasmApp | null>(null)
  /** 删除对话框的目标行。 */
  const [deleteTarget, setDeleteTarget] = useState<WasmApp | null>(null)
  /** 导出对话框的目标行。 */
  const [exportTarget, setExportTarget] = useState<WasmApp | null>(null)
  /**
   * 退役快照保留期天数（服务端下发；null = 未下发）。
   *
   * null 时冻结/删除确认框**不推算**清理日期，只明说「由服务端在冻结/删除时登记」——
   * 编一个日期出来就是 C-01 的假承诺形态。
   */
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  /** 部署成功后 bump ⇒ 抽屉里的部署历史块立刻重拉。 */
  const [deployReload, setDeployReload] = useState(0)


  // 详情抽屉的待审清单 + 运行诊断。
  const [pending, setPending] = useState<PendingRelease[]>([])
  const [pendingCurrent, setPendingCurrent] = useState('')
  /** 待审清单是否**成功读到**过(读失败时不能拿抽屉快照冒充服务端真值)。 */
  const [pendingLoaded, setPendingLoaded] = useState(false)
  const [pendingError, setPendingError] = useState('')
  /**
   * 最近被拒的版本(R1-uxw-4)。
   *
   * 服务端此前连 reason 都不下发,拒绝理由只躺在审计详情里 —— 审批面自己都回看不了
   * "我上次为什么拒的"。这条独立取数(status=rejected)与待审队列分开,读失败不会把
   * 待审队列一起打成错误态。
   */
  const [rejected, setRejected] = useState<PendingRelease[]>([])
  const [rejectedError, setRejectedError] = useState('')
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [diagError, setDiagError] = useState('')

  const loadSeq = useRef(0)
  /**
   * 详情抽屉的请求序号(WEB-3,2026-09-23 审计 P1)。
   *
   * 三个 loader(`loadPending`/`loadRejected`/`loadDiagnostics`)**原先没有任何
   * 序号守卫**:打开 A 详情(其 `/releases` 慢)→ 关闭 → 打开 B 详情(B 的响应先到)
   * → A 的迟到响应落地,把 A 的待审清单(与 `currentVersionShown`)写进 **B 的抽屉**。
   * 而「通过」按钮把 `detail`(=当前应用 B)与 `rel`(=A 的版本号)拼成一条请求:
   * `POST /wasm-apps/B/releases/<A 的版本>/approve` —— 版本号只在**应用内**唯一
   * (首发普遍都是 1.0.0),所以这不是必然 404,而是**批准了一个从未在审批界面
   * 展示过的版本**。
   *
   * 与同文件 `load` 的 `loadSeq` 同形:只有"当前抽屉"的响应能落地。
   */
  const detailSeq = useRef(0)

  // 体验层能力判定:服务端 RequirePermission 才是护栏(见页面头注释)。
  const canRead = hasPermission(PERM_CAP_READ)
  const canWrite = hasPermission(PERM_CAP_WRITE)
  /** 列表读取成功 = 「更新审批」开关的取值可信(R15C-W-08);失败/未读到 ⇒ 状态未知、开关禁用。 */
  const reviewStateKnown = loaded && loadError === ''

  const listQuery = useMemo(() => {
    const params = new URLSearchParams()
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    if (q !== '') params.set('q', q)
    if (status !== 'all') {
      params.set('status', status)
      // 软删行必须显式带 include_deleted:服务端两条入口同义(status=deleted 也
      // 会打开 include_deleted),这里两条都带上,免得将来只改一端就静默查不到。
      if (status === 'deleted') params.set('include_deleted', '1')
    }
    // 访问级别筛选（两值）：`public` 永不进这个参数（它不是可写值）；
    // 历史 public 行由 `access=login` 命中（服务端读侧同口径）。
    if (accessFilter.value !== ACCESS_FILTER_ALL) params.set('access', accessFilter.value)
    return params.toString()
  }, [accessFilter.value, offset, q, status])

  const load = useCallback(async () => {
    // 没有 capability:read 时不发这个注定 403 的请求(与用量中心同口径)。
    if (!canRead) {
      setLoading(false)
      return
    }
    const current = ++loadSeq.current
    setLoading(true)
    setLoadError('')
    try {
      const data = await request<ListResponse>(`${ADMIN_API}/wasm-apps?${listQuery}`)
      if (current !== loadSeq.current) return // 刷新连点时只认最后一次响应
      setApps(data.apps ?? [])
      setReviewRequired(data.review_required === true)
      setTotal(typeof data.total === 'number' ? data.total : (data.apps ?? []).length)
      setPendingTotal(typeof data.pending_count === 'number' ? data.pending_count : 0)
      // 范围标签与翻页一律以**服务端回显**为准(见 pageStart/truncated 的注释)。
      setPageStart(typeof data.offset === 'number' && data.offset >= 0 ? data.offset : offset)
      setTruncated(data.truncated === true)
      // 访问级别筛选的服务端回显（缺 = 服务端还不支持 access=，见 accessEcho 注释）。
      setAccessEcho(typeof data.access === 'string' ? data.access : '')
      // 退役保留期（缺 = 服务端未下发 ⇒ 确认框不推算清理日期，见 retentionDays 注释）。
      setRetentionDays(retentionDaysOf(data))
      setLoaded(true)
    } catch (err: any) {
      if (current !== loadSeq.current) return
      // R1-uxw-2:失败时**清空**列表,不保留"看着像本次结果"的旧行。
      // 保留旧行的代价是:屏幕上是第 1 页的 20 行,标签却写着新 offset 编出来的
      // "第 21–40 条",而管理员分辨不出这是上一次成功的数据(审计实测现场)。
      // 清空 + 明说失败 + 重试,是唯一不会撒谎的形态。
      setApps([])
      setTotal(0)
      setTruncated(false)
      setLoadError(errorText(err, '加载失败'))
    } finally {
      if (current === loadSeq.current) setLoading(false)
    }
  }, [canRead, listQuery, offset])

  useEffect(() => { void load() }, [load])

  /**
   * 打开次数聚合（F16）：**一次**取回本窗口内全部应用的今日/近 7 日 PV+UV。
   *
   * 为什么是一次聚合而不是每行一个请求：列表一页 20 行、详情还要用同一批数字，
   * 20 个请求既慢又会把"某一行的取数失败"渲染成"这个应用没人用"。
   * 失败语义按 opens-contract 的硬要求：**缺后端不得显示 0** —— 这里只记录
   * 失败原因，列与详情面板统一渲染 `—` + 提示。
   */
  const loadOpens = useCallback(async () => {
    if (!canRead) return
    try {
      const raw = await request(`${OPENS_SUMMARY_PATH}?days=${OPENS_WINDOW_DAYS}&top=10`)
      const parsed = requireOpensSummary(raw)
      if (!parsed.ok) {
        setOpensRows({})
        setOpensFailure(shapeDrift('打开次数', parsed.detail))
        return
      }
      const map: Record<string, OpensAppRow> = {}
      for (const row of parsed.value.apps ?? []) {
        if (row && typeof row.app_id === 'string' && row.app_id !== '') map[row.app_id] = row
      }
      setOpensRows(map)
      setOpensFailure(null)
    } catch (err: unknown) {
      setOpensRows({})
      setOpensFailure(classifyEndpointFailure(err, '打开次数', OPENS_SUMMARY_PATH))
    }
  }, [canRead])

  useEffect(() => { void loadOpens() }, [loadOpens])

  /**
   * 取全部 per-app 限流覆盖（决策 §2.5；生产化评审「管理员可发现/可审查」）。
   *
   * 为什么在列表页就取一次：行内徽标与「只看有覆盖」筛选都需要"这个应用有没有覆盖"，
   * 而列表响应不带这个信息；按行各发一次 `/limits` 就是 20 个请求 + 把"某一行取数失败"
   * 渲染成"这个应用没有覆盖"。覆盖是**例外配置**，一次不分页的清单足够。
   *
   * 失败语义：`overrides=null` + 可见的错误文案 + 筛选禁用 —— 不静默当成"没有覆盖"。
   */
  const loadOverrides = useCallback(async () => {
    if (!canRead) {
      setOverridesLoading(false)
      return
    }
    setOverridesLoading(true)
    setOverridesError('')
    try {
      const parsed = parseAppLimitOverrides(await request<unknown>(LIMIT_OVERRIDES_PATH))
      if (!parsed.ok) {
        setOverrides(null)
        setOverridesError(`读取限流覆盖失败：${parsed.reason}`)
        return
      }
      setOverrides(parsed.value)
    } catch (err: unknown) {
      setOverrides(null)
      setOverridesError(limitOverridesErrorText(err, '读取限流覆盖失败'))
    } finally {
      setOverridesLoading(false)
    }
  }, [canRead])

  useEffect(() => { void loadOverrides() }, [loadOverrides])

  /** 详情抽屉打开时拉取该应用的待审版本(筛选变更/审核后重拉同一份)。 */
  const loadPending = useCallback(async (appId: string, appDeleted = false) => {
    const current = detailSeq.current // WEB-3:本次响应只属于发起时的那个抽屉
    setPendingError('')
    try {
      const out = await request<ReleasesResponse>(
        `${ADMIN_API}/wasm-apps/${appId}/releases?status=pending`,
      )
      if (current !== detailSeq.current) return // WEB-3:抽屉已换应用 ⇒ 丢弃
      const releases = requireReleases(out)
      if (releases === null) {
        // F6（审计第二轮 A2-F6）：形状漂移不能显示成"没有待审版本"。
        setPending([])
        setPendingLoaded(false)
        setPendingError('读取待审版本失败：响应里没有版本清单（这不是"没有待审版本"，请核对服务端接口）')
        return
      }
      setPending(releases)
      setPendingCurrent(out.current_version ?? '')
      setPendingLoaded(true)
    } catch (err: any) {
      if (current !== detailSeq.current) return // WEB-3:过期响应不写错误/不误报"读取失败"
      setPending([])
      setPendingLoaded(false)
      // 反证 F-3：已删除/已清除行的详情是**只读**的，服务端已把 releases 端点改成放行
      // 退役行；旧版本服务端仍会 404 —— 那时要说清"这不影响恢复/导出"，而不是甩一句
      // 「应用已退役」，让管理员以为整个抽屉都坏了。
      setPendingError(releaseListErrorText(err, appDeleted, '读取待审版本失败'))
    }
  }, [])

  /**
   * 详情抽屉打开时拉取该应用的**最近被拒**版本(R1-uxw-4:驳回理由的唯一可回看来源)。
   *
   * 为什么单独取一次 `status=rejected`:待审队列按定义看不到被拒版本,而"我上次为什么
   * 拒的"恰恰只能从那一条回答 —— 服务端此前连 reason 都不下发,理由只躺在审计详情里。
   * 与待审清单分开取还有两个好处:①待审队列的语义与请求形状一个字不变(既有门禁照旧);
   * ②被拒清单读失败不会把待审队列一起打成错误态(两条错误各自可见)。
   */
  const loadRejected = useCallback(async (appId: string, appDeleted = false) => {
    const current = detailSeq.current // WEB-3:同 loadPending 的抽屉归属判定
    setRejectedError('')
    try {
      const out = await request<ReleasesResponse>(
        `${ADMIN_API}/wasm-apps/${appId}/releases?status=rejected`,
      )
      if (current !== detailSeq.current) return // WEB-3:抽屉已换应用 ⇒ 丢弃
      const releases = requireReleases(out)
      if (releases === null) {
        // 与客户端半边同口径（`app-releases.ts` 对同样响应返回 UNEXPECTED_RESPONSE）：
        // 不把"解析不出来"说成"没有被拒的版本"（F6）。
        setRejected([])
        setRejectedError('读取被拒版本失败：响应里没有版本清单（这不是"没有被拒的版本"，请核对服务端接口）')
        return
      }
      setRejected(releases)
    } catch (err: any) {
      if (current !== detailSeq.current) return
      setRejected([])
      setRejectedError(releaseListErrorText(err, appDeleted, '读取被拒版本失败'))
    }
  }, [])

  /** 详情抽屉打开时拉取运行诊断(P1-9:管理端此前没有任何排障入口)。 */
  const loadDiagnostics = useCallback(async (appId: string) => {
    const current = detailSeq.current // WEB-3:同 loadPending 的抽屉归属判定
    setDiagError('')
    try {
      const out = await request<{ diagnostics: Diagnostics }>(
        `${ADMIN_API}/wasm-apps/${appId}/diagnostics`,
      )
      if (current !== detailSeq.current) return // WEB-3:抽屉已换应用 ⇒ 丢弃
      setDiag(out.diagnostics)
    } catch (err: any) {
      if (current !== detailSeq.current) return
      setDiag(null)
      setDiagError(errorText(err, '读取运行诊断失败'))
    }
  }, [])

  const openDetail = (row: WasmApp) => {
    detailSeq.current += 1 // WEB-3:从此上一个应用的在飞响应一律作废
    setDetail(row)
    setPending([])
    setPendingCurrent(row.current_version ?? '')
    setPendingLoaded(false)
    setPendingError('')
    setRejected([])
    setRejectedError('')
    setDetailFeedback(null)
    setLastRejection(null)
    setRejectError('')
    setDiag(null)
    setDiagError('')
    void loadPending(row.app_id, isDeleted(row))
    void loadRejected(row.app_id, isDeleted(row))
    void loadDiagnostics(row.app_id)
  }

  /** 写操作成功后按响应回填单行(服务端返回的就是该字段的新真值)。 */
  const patchRow = (appId: string, patch: Partial<WasmApp>) => {
    setApps((prev) => prev.map((a) => (a.app_id === appId ? { ...a, ...patch } : a)))
  }
  const togglePublished = async (row: WasmApp) => {
    if (busy || !canWrite) return
    const next = !row.enabled
    setBusy(`${row.app_id}:publish`)
    setError('')
    try {
      const out = await request<{ app?: { enabled?: boolean } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/${next ? 'publish' : 'unpublish'}`,
        { method: 'POST' },
      )
      patchRow(row.app_id, {
        // F2（审计第二轮 A2-F2）：响应缺 `enabled` 时**不臆测** —— 旧实现回落到乐观值
        // `next`，于是一个不带该字段的 200 就把行翻成「已下架」（探针实测）。这与同一
        // 文件冻结路径（:463 的"响应缺字段时不臆测"）本是同形响应，口径必须一致。
        ...(typeof out?.app?.enabled === 'boolean' ? { enabled: out.app.enabled } : {}),
      })
    } catch (err: any) {
      // 404 里的「如需恢复请联系平台管理员」在管理台是误导（C-04）：换成真实入口。
      setError(lifecycleErrorText(err, next ? '上架失败' : '下架失败'))
    } finally {
      setBusy('')
    }
  }

  /**
   * 冻结/解冻的真正提交(冻结方向由确认框调用,见 freezeTarget)。
   *
   * 回执按设计 §5.4 的**真实语义**写:快照有没有生成、清理日期是哪一天。
   * 此前这里只 flash 一句「已冻结:该应用立即停止服务」,而确认框又承诺「到期后台真删」——
   * 后台任务并不存在(C-01)。现在两种状态都以服务端回传的 snapshot/purge_after 为准。
   */
  const submitFrozen = async (row: WasmApp, frozen: boolean) => {
    if (busy || !canWrite) return
    setBusy(`${row.app_id}:freeze`)
    setError('')
    try {
      const out = await request<FreezeResponse>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/freeze`,
        { method: 'POST', body: JSON.stringify({ frozen }) },
      )
      const app = out?.app
      patchRow(row.app_id, {
        frozen_at: frozen ? (app?.frozen_at ?? null) : null,
        // 冻结会连带下架(服务端行为);解冻不改 enabled。响应缺字段时不臆测。
        ...(typeof app?.enabled === 'boolean' ? { enabled: app.enabled } : {}),
        ...(frozen
          ? {
              ...(app?.purge_after !== undefined ? { purge_after: app.purge_after } : {}),
              ...(app?.snapshot_at !== undefined ? { snapshot_at: app.snapshot_at } : {}),
              ...(app?.snapshot_error !== undefined ? { snapshot_error: app.snapshot_error } : {}),
            }
          : {
              // 反证 F-5：解冻会清时间线并**尽力删除快照目录**（设计 §5.4 /
              // lifecycle_actions.go），而解冻响应只回 `frozen_at:null`/`enabled` ——
              // 前端若不在这里清，生命周期块会继续显示已被删掉的快照时间与旧的
              // 「快照生成失败」，即界面陈述了一个磁盘上已不存在的事实。
              purge_after: null,
              snapshot_at: null,
              snapshot_error: null,
            }),
      })
      if (frozen) {
        flash(freezeReceipt(out))
      } else {
        // 本地回填只能覆盖"响应里回传的字段" ⇒ 再拉一次列表，让行与抽屉与服务端真值一致
        // （服务端是唯一真源；解冻还清空时间线并尽力删除快照目录）。
        flash('已解冻:应用恢复可处置状态;快照与清理时间线已清除(解冻会尽力删除快照目录);解冻不会自动上架,需要重新点「上架」才恢复服务')
        await load()
      }
    } catch (err: any) {
      setError(lifecycleErrorText(err, frozen ? '冻结失败' : '解冻失败'))
    } finally {
      setBusy('')
    }
  }

  /**
   * 恢复已删除应用（设计 §5.5 / 审计 C-04）。
   *
   * 恢复是**恢复类动作**（与解冻/上架同族），不弹二次确认；但回执必须写清「不自动上架」
   * —— 否则管理员会以为点完就恢复服务了（服务端 enabled=0）。
   */
  const restoreApp = async (row: WasmApp) => {
    if (busy || !canWrite) return
    setBusy(`${row.app_id}:restore`)
    setError('')
    try {
      const out = await request<RestoreResponse>(restorePath(row.app_id), { method: 'POST' })
      const app = out?.app
      patchRow(row.app_id, {
        deleted_at: null,
        frozen_at: null,
        purge_after: null,
        ...(typeof app?.enabled === 'boolean' ? { enabled: app.enabled } : {}),
        ...(app?.snapshot_at !== undefined ? { snapshot_at: app.snapshot_at } : {}),
      })
      flash(restoreReceipt(app))
      await load()
    } catch (err: any) {
      setError(lifecycleErrorText(err, '恢复失败'))
    } finally {
      setBusy('')
    }
  }

  /** 部署/回滚成功：回填当前版本 + 重拉列表与部署历史（回执文案在 deployReceipt）。 */
  const onDeployed = (row: WasmApp, result: DeployResult) => {
    setDeployTarget(null)
    if (result.changed) {
      patchRow(row.app_id, { current_version: result.current_version })
    }
    flash(deployReceipt(result))
    setDeployReload((n) => n + 1)
    void load()
  }

  /** 删除成功：回填软删/快照/清理日期（回执含「快照是否已生成」与 purge_after）。 */
  const onDeleted = (row: WasmApp, result: DeleteResultView) => {
    setDeleteTarget(null)
    const app = result?.app ?? {}
    patchRow(row.app_id, {
      deleted_at: app.deleted_at ?? new Date().toISOString(),
      frozen_at: app.frozen_at ?? row.frozen_at ?? new Date().toISOString(),
      ...(app.purge_after !== undefined ? { purge_after: app.purge_after } : {}),
      ...(app.snapshot_at !== undefined ? { snapshot_at: app.snapshot_at } : {}),
      ...(app.snapshot_error !== undefined ? { snapshot_error: app.snapshot_error } : {}),
      ...(typeof app.enabled === 'boolean' ? { enabled: app.enabled } : {}),
    })
    flash(deleteReceipt(result))
    setDeployReload((n) => n + 1)
    void load()
  }

  /** 导出入队回执（导出本身会写审计；这里只是页面上的即时反馈）。 */
  const onExported = (kind: ExportKind, filename: string) => {
    // **不**自动关闭导出对话框：管理员常要连导「JSON + 含数据」两种形态；
    // 关闭交给弹窗里的「关闭」（回显在弹窗内，见 ExportDialog 的 export-done）。
    const label = kind === 'json' ? '控制面 JSON' : kind === 'database' ? '含应用数据' : '含数据与资源'
    flash(`已导出（${label}）：${filename}（审计已记录 wasm_app_export）`)
  }
  /**
   * 审核开关的真正提交(由确认框调用:开/关都会改变全组织的发布行为)。
   *
   * 反证 F-2:此前把响应窄化成 `{review_required?}`,于是服务端**已经**下发的
   * `pending_releases`(全组织现存待审数)与 `note`(「现有 N 个待审版本将失去意义
   * （作者可撤回，管理面可逐个通过/拒绝）」)被整段丢弃,关闭方向只 flash 一句固定话。
   * 现在四个键全部读出来,回执由 `reviewSwitchReceipt` 统一生成(服务端 note 优先,
   * 它才是 §5.7/§5.3 的权威语义)。
   */
  const toggleReview = async (next: boolean) => {
    if (busy || !canWrite) return
    const prev = reviewRequired
    setBusy('review')
    setError('')
    setReviewRequired(next) // 乐观切换(开关手感);失败回滚
    try {
      const out = await request<ReviewSwitchResponse>(`${ADMIN_API}/wasm-apps/review`, {
        method: 'PUT',
        body: JSON.stringify({ required: next }),
      })
      if (typeof out?.review_required === 'boolean') setReviewRequired(out.review_required)
      // 服务端回报的积压数**直接接管**徽标（与列表 pending_count 同源）;没下发才用本地值。
      const reported = pendingFromSwitch(out)
      if (reported !== null) setPendingTotal(reported)
      flash(reviewSwitchReceipt(out, next, pendingTotal))
      // **不**在这里重拉列表：开关只改组织级设置，不改变任何版本的状态；重拉只会用列表的
      // pending_count 把上面刚接管的数字盖回去（两个数字同源时无差别，漂移时前后矛盾）。
      // 需要最新计数时用户点「刷新」，队列对话框自己也会重取 total。
    } catch (err: any) {
      setReviewRequired(prev)
      setError(errorText(err, '更新审批开关保存失败'))
    } finally {
      setBusy('')
    }
  }

  const openOwner = (row: WasmApp) => {
    setOwnerInput('')
    setOwnerError('')
    setOwnerTarget(row)
  }

  const submitOwner = async () => {
    const row = ownerTarget
    if (!row || busy || !canWrite) return
    const owner = ownerInput.trim()
    if (owner === '') {
      setOwnerError('请填写新负责人用户名')
      return
    }
    setBusy(`${row.app_id}:owner`)
    setOwnerError('')
    setError('')
    try {
      const out = await request<{ app?: { owner?: string } }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/owner`,
        { method: 'PUT', body: JSON.stringify({ owner }) },
      )
      patchRow(row.app_id, { owner: out?.app?.owner ?? owner })
      setOwnerTarget(null)
      setOwnerInput('')
      flash(`已转移归属:${row.title || row.app_id} → ${out?.app?.owner ?? owner}`)
    } catch (err: any) {
      // 弹窗里的动作,失败必须渲染在弹窗里(R1-uxw-1 同族:页面级红字被遮罩压住)。
      setOwnerError(errorText(err, '转移归属失败'))
    } finally {
      setBusy('')
    }
  }

  /** 审核通过:成功后刷新列表与抽屉(待审清单、积压数、当前生效版本都变了)。 */
  const approveRelease = async (row: WasmApp, rel: PendingRelease) => {
    if (busy || !canWrite) return
    // WEB-3:待审清单没读到(或不属于当前抽屉)时,`rel` 无从证明属于 `row` ——
    // 原地拒绝,不发 `POST /wasm-apps/<row>/releases/<别的应用的版本>/approve`。
    if (!pendingLoaded || detailRow?.app_id !== row.app_id) {
      setDetailFeedback({ kind: 'err', text: '待审清单未加载成功,审核已锁定——请关闭抽屉后重新打开该应用。' })
      return
    }
    setBusy(`${row.app_id}:approve`)
    setDetailFeedback(null)
    setError('')
    try {
      await request(
        `${ADMIN_API}/wasm-apps/${row.app_id}/releases/${encodeURIComponent(rel.version)}/approve`,
        { method: 'POST' },
      )
      // 弹窗内 + 页面级都写:抽屉关掉之后仍能看到"刚才发生了什么"。
      setDetailFeedback({ kind: 'ok', text: `已通过 v${rel.version}` })
      flash(`已通过 v${rel.version}`)
      await Promise.all([load(), loadPending(row.app_id)])
    } catch (err: any) {
      // R1-uxw-1:反馈必须在**抽屉内**可见(页面级的 apps-error 被 80% 不透明
      // 整屏遮罩压住,管理员看到的是"点了没反应")。
      setDetailFeedback({ kind: 'err', text: lifecycleErrorText(err, '审核通过失败') })
    } finally {
      setBusy('')
    }
  }

  /**
   * 审核拒绝(**理由必填**,≤200 字;服务端超过上限或没给理由都直接 400)。
   *
   * P2-5(2026-09-20 本机实测):服务端要求拒绝必须带非空理由 —— 理由同时进审计、
   * "最近被拒"清单与作者客户端(`my-releases` 的 `reason`),是作者改后再发的唯一依据。
   * 表单侧因此**前置**拦一次(空/纯空白 → 提交按钮禁用),不让一个注定 400 的请求出门;
   * 服务端那道闸门仍是权威(前端绕不过去)。
   */
  const rejectRelease = async () => {
    const row = detailRow
    const rel = rejectTarget
    if (!row || !rel || busy || !canWrite) return
    // WEB-3:与 approveRelease 同一判据 —— `rel` 必须来自**当前抽屉**读到的待审清单。
    if (!pendingLoaded) {
      setRejectError('待审清单未加载成功,审核已锁定——请关闭抽屉后重新打开该应用。')
      return
    }
    const reason = rejectReason.trim()
    if (reason === '') {
      // 兜底:按钮已禁用,但**回车提交/程序化点击**仍可能到这儿 —— 原地给文案而不是
      // 发一个注定 400 的请求(服务端文案也会经 catch 显示,这里是更快的反馈)。
      setRejectError('请填写拒绝理由:作者只能凭这段文字知道要改什么')
      return
    }
    setBusy(`${row.app_id}:reject`)
    setRejectError('')
    setError('')
    try {
      const rejected = await request<{ note?: unknown, version_occupied?: unknown }>(
        `${ADMIN_API}/wasm-apps/${row.app_id}/releases/${encodeURIComponent(rel.version)}/reject`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      )
      // A8 影响面（2026-10-22 终轮反证）：服务端在 reject 回执里给
      // `version_occupied=true` + `note`（版本号永久占位、重发必须升版本号）。
      // 管理台此前丢弃这两个键 ⇒ 管理员看不到"驳回会烧掉一个版本号"。
      const rejectNote = typeof rejected?.note === 'string' ? rejected.note.trim() : ''
      flash(rejectNote === '' ? `已拒绝 v${rel.version}` : `已拒绝 v${rel.version}：${rejectNote}`)
      setRejectTarget(null)
      setRejectReason('')
      // 驳回理由要留在管理员眼前:拒绝成功后那一行就从**待审**清单消失。两条留痕一起给
      // —— ①即时回显(拒绝响应里带 reason,不必等取数);②重取被拒清单(权威来源)。
      setLastRejection({ version: rel.version, reason })
      setDetailFeedback({ kind: 'ok', text: rejectNote === '' ? `已拒绝 v${rel.version}` : `已拒绝 v${rel.version}：${rejectNote}` })
      await Promise.all([load(), loadPending(row.app_id), loadRejected(row.app_id)])
    } catch (err: any) {
      // 失败时**不关闭**拒绝框:理由还在输入框里,原地显示原因让管理员能改后重试。
      setRejectError(lifecycleErrorText(err, '审核拒绝失败'))
    } finally {
      setBusy('')
    }
  }

  const submitSearch = (e?: FormEvent) => {
    e?.preventDefault()
    setOffset(0) // 换搜索词必须回到第一页,否则会停在一个"搜索结果的第 3 页"上
    setQ(qInput.trim())
  }

  const shown = apps.length
  // 翻页判据只用**服务端回显**:pageStart(实际渲染的第一行)与 truncated(还有下一页)。
  // hasPrev 用 pageStart>0 而不是 offset>0 —— 越界失败后两者会分叉,而屏幕上真实
  // 渲染的位置才是管理员能验证的那个数(R1-uxw-2)。
  const hasPrev = pageStart > 0
  const hasNext = truncated
  /**
   * 访问级别筛选是否**由服务端执行**（= 响应回显了同一个取值）。
   *
   * 不支持时退化为"本页过滤"，并且必须在页面上说明 —— 否则"共 N 条"与翻页
   * 仍然按未筛选全集的数字走，管理员会把"这一页里没有"读成"系统里没有"。
   */
  const accessFilterActive = accessFilter.value !== ACCESS_FILTER_ALL
  const accessFilterSupported = !accessFilterActive || accessEcho === accessFilter.value
  /** 屏幕上真正渲染的行：服务端支持过滤时就是 `apps`；否则是它的本页子集。 */
  const visibleApps = accessFilterSupported
    ? apps
    : apps.filter((a) => matchesAccessFilter(a.access, accessFilter.value))
  /** 本页里命中"历史已退役"的行数（用于给筛选结果加一句可核对的说明）。 */
  const legacyShown = visibleApps.filter((a) => accessMeta(a.access).legacy).length

  /**
   * app_id → 覆盖行（行内徽标、tooltip、「只看有覆盖」筛选共用同一份）。
   *
   * 覆盖清单**不分页**（例外配置），所以这个 map 是全集；列表页拿它按行查即可。
   */
  const overrideByApp = useMemo(() => {
    const map: Record<string, AppLimitOverrideRow> = {}
    for (const row of overrides?.items ?? []) map[row.appId] = row
    return map
  }, [overrides])
  /** 覆盖清单是否读到过（false ⇒ 徽标不渲染、筛选禁用，并且页面明说原因）。 */
  const overridesKnown = overrides !== null
  /** 页头「限流覆盖（N）」：读到才有数字，否则是「…/—」而不是 0。 */
  const overridesCountText = overrides !== null ? String(overrides.total) : overridesLoading ? '…' : '—'
  /**
   * 「只看有覆盖」是否真的在生效。
   *
   * 清单没读到 ⇒ 即使开关停在 on 也不筛（否则会把"读不到覆盖"渲染成"本页没有任何应用
   * 有覆盖"）；开关同时被禁用。
   */
  const onlyOverridesActive = onlyOverrides && overridesKnown
  /** 屏幕上真正渲染的行：访问级别本页过滤 → 覆盖覆盖筛选（两段都只作用于本页）。 */
  const renderedApps = onlyOverridesActive
    ? visibleApps.filter((a) => overrideByApp[a.app_id] !== undefined)
    : visibleApps
  /** 本页有行、但「只看有覆盖」筛空了：与"系统里没有应用"必须分开说。 */
  const overrideFilterEmpty = onlyOverridesActive && renderedApps.length === 0 && apps.length > 0
  /** 页码越界:服务端返回空页但全集非空(数据缩水/筛选变化后翻页的典型现场)。 */
  const outOfRange = !loading && loadError === '' && shown === 0 && total > 0
  /** 只看本地过滤时的"本页没有命中"：与"系统里没有"必须分开说。 */
  const filteredEmptyLocally = !accessFilterSupported && visibleApps.length === 0 && apps.length > 0
  /**
   * 抽屉的**行**按 app_id 从最新列表解析（不是点开那一刻的快照）。
   *
   * 为什么：冻结/删除/恢复之后生命周期块必须立刻显示新时间线；继续用 `detail` 快照会让
   * 「刚删除」的应用在抽屉里仍显示「未删除」（half-new/half-old，R1-uxw-5 的同族形态）。
   * 列表被清空（刷新失败）时回落到点开时的对象，抽屉不因此变空。
   */
  const detailRow = detail === null ? null : (apps.find((a) => a.app_id === detail.app_id) ?? detail)

  /**
   * 抽屉里"当前生效版本"的**唯一取值**:待审清单读到了就以它为准(它比行快照新,
   * 审核通过后服务端返回的就是新版本),读不到才回落行快照。
   *
   * R1-uxw-5:此前 dl 用 `detail.current_version`(点开时的快照)、待审块用
   * `pendingCurrent`(刚拉的),通过 v1.2.0 之后同一屏上会出现"1.0.2"与"1.2.0"
   * 两个互相矛盾的"当前生效版本"。
   */
  const currentVersionShown = pendingLoaded ? pendingCurrent : (detailRow?.current_version ?? '')

  // 冻结确认框的文案（设计 §5.4 的真实语义：快照前置条件 + purge_after 具体日期）。
  // 唯一实现在 apps-lifecycle.ts，页面不再自己写"到期由后台任务真删"这类没有执行者的话。
  const freezeCopy = freezeConfirmCopy(freezeTarget, { retentionDays })

  return (
    <div className="space-y-4" data-feature-sentinel={FEATURE_SENTINEL}>
      <PageHeader
        title="应用"
        desc="员工自建的 WASM 应用:查看访问级别与运行状态,并做上下架、冻结、归属转移、版本审核等平台级处置"
        actions={
          <>
            {/* 组织级「更新审批」开关:开启后新版本进待审队列,线上仍旧版本。
                开/关都必须二次确认(见下方 Dialog):它会改变**全组织**的发布行为。 */}
            <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
              <Switch
                id="wasm-review-required"
                aria-label="更新审批"
                checked={reviewRequired}
                // R15C-W-08（审计 2026-09-25，P2）：取值来自列表 GET（review_required），
                // **没读到就不能给确定结论** —— 此前首屏 GET 失败时开关仍按初值 false
                // 渲染成「关闭:更新即生效」，管理员据此形成错误的状态认知（还会拿到问
                // 「开启更新审批?」的确认框，而真实状态可能已是开启）。同理禁用开关：
                // 在状态未知时点它会发出一个基于猜测的写请求。
                disabled={!canWrite || busy === 'review' || !reviewStateKnown}
                aria-describedby={!canWrite ? 'apps-readonly-note' : undefined}
                title={!canWrite ? '没有 capability:write 权限,仅可查看' : (reviewStateKnown ? undefined : '列表未读取成功,状态未知,已禁用')}
                onCheckedChange={(v) => { setReviewPrompt(v) }}
              />
              <Label htmlFor="wasm-review-required" className="text-xs">更新审批</Label>
              <span className="text-[11px] text-muted-foreground">
                {!reviewStateKnown ? '状态未知:列表未读取成功' : (reviewRequired ? '开启:新版本需审核' : '关闭:更新即生效')}
              </span>
              {reviewStateKnown && pendingTotal > 0 && (
                // C-07：这个徽标此前**不可点**（页头「待审 N」+ 没有跨应用清单 ⇒ 管理员
                // 知道有积压却找不到是哪几个）。现在点它直接打开跨应用待审队列（内联处置）。
                <Button
                  variant="destructive"
                  size="sm"
                  data-testid="org-pending-count"
                  title="全组织待审版本数：点开跨应用待审队列（内联通过/拒绝）"
                  aria-label={`全组织待审 ${pendingTotal} 个版本，点开待审队列`}
                  onClick={() => { setPendingQueueOpen(true) }}
                >
                  待审 {pendingTotal}
                </Button>
              )}
            </div>
            {/* per-app 限流覆盖总览（决策 §2.5；生产化评审「管理员可发现/可审查」）：
                此前只能逐个应用翻详情抽屉 ⇒ "哪些应用被单独限流/降额、已删应用是否留着
                残留覆盖"没有可发现面。计数读到才有数字（未读到是「…/—」，不是 0）。 */}
            <Button
              variant="outline"
              size="sm"
              data-testid="app-overrides-open"
              disabled={!canRead}
              title={
                overridesError !== ''
                  ? `覆盖清单读取失败：${overridesError}（点开后可重试）`
                  : !canRead
                    ? '没有 capability:read 权限，仅可查看'
                    : '全部按应用的限流覆盖：override / effective / 是否高于全局 / 更新时间与人'
              }
              onClick={() => { setOverridesOpen(true) }}
            >
              <Gauge className="mr-1 h-4 w-4" />限流覆盖（{overridesCountText}）
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="announcement-open"
              onClick={() => { setAnnounceOpen(true) }}
              title="面向员工的公告模板（访问级别收敛 / 只在客户端内打开）"
            >
              <Megaphone className="mr-1 h-4 w-4" />公告模板
            </Button>
            <Button variant="outline" size="sm" onClick={() => { void load() }} title="刷新" aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </>
        }
      />

      {/* 反馈都带 live 区(R1-uxw-14):读屏/键盘用户此前在保存失败或被拒时
          没有任何播报 —— flash/error 都只是普通 div。 */}
      {flashMsg && (
        <div
          data-testid="apps-flash"
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-muted px-3 py-2 text-sm"
        >
          {flashMsg}
        </div>
      )}
      {error && (
        <p data-testid="apps-error" role="alert" aria-live="assertive" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!canWrite && (
        <p id="apps-readonly-note" data-testid="apps-readonly-note" className="text-xs text-muted-foreground">
          当前账号没有 capability:write 权限 —— 仅可查看,处置按钮已禁用(服务端同样会拒绝写请求)。
        </p>
      )}

      {/* 搜索 + 状态筛选(P1-7):两者都进查询串由服务端过滤,第 201 个应用可被检索。
          ⚠️ 搜索**搜不到待审版本的新标题**:`q` 在服务端只匹配 apps 行的
          title/owner/app_id,而待审标题刻意不写进 apps.title(那会重开"不过审就改名"
          的免审仿冒面,见 publish.go 的 E1 注释)。取舍:审批人按 app_id/负责人/现标题
          定位到应用,再在详情抽屉的待审卡片上核对「现标题 → 待审标题」(卡片渲染真值)。
          不要为了搜索命中把待审标题写回 apps.title。 */}
      <form className="flex flex-wrap items-center gap-2" onSubmit={submitSearch}>
        <Input
          aria-label="搜索应用"
          data-testid="app-search"
          className="max-w-xs"
          placeholder="搜索应用名 / 应用 ID / 负责人"
          value={qInput}
          onChange={(e) => { setQInput(e.target.value) }}
        />
        <Button type="submit" variant="outline" size="sm" data-testid="app-search-submit">
          <Search className="mr-1 h-4 w-4" />搜索
        </Button>
        <Select
          value={status}
          onValueChange={(v) => { setOffset(0); setStatus(v) }}
        >
          <SelectTrigger className="w-40" aria-label="状态筛选" data-testid="app-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* 访问级别筛选（2026-09-19 契约 §19 Q13）。选项**只有两值 + 全部**：
            `public` 不可选（它已退役），但历史行由「登录后全员」命中（读侧同口径），
            所以"筛出历史 public"这个运营动作成立；每行的访问级别列还会标注
            「已退役（历史值）」。 */}
        <Select
          value={accessFilter.value}
          onValueChange={(v) => {
            setOffset(0)
            setAccessFilter({ value: v, rejected: '' })
            writeAccessFilterToUrl(v)
          }}
        >
          <SelectTrigger className="w-44" aria-label="访问级别筛选" data-testid="app-access-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACCESS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(q !== '' || status !== 'all' || accessFilterActive) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="app-clear-filters"
            onClick={() => {
              setQInput(''); setQ(''); setStatus('all'); setOffset(0)
              setAccessFilter({ value: ACCESS_FILTER_ALL, rejected: '' })
              writeAccessFilterToUrl(ACCESS_FILTER_ALL)
            }}
          >
            清除筛选
          </Button>
        )}
        {/* 显式总数:没有它,"被截断的列表"和"就这么多应用"在页面上长得一样(P1-7)。
            数字全部来自**实际渲染的这批行 + 服务端回显的 total/offset**(R1-uxw-2);
            读取失败时明说"条数未知",不拿 0 或者上一次的数字充数。 */}
        <span className="text-xs text-muted-foreground" data-testid="app-total">
          {loadError !== ''
            ? '读取失败,条数未知'
            : !loaded
              ? '加载中…'
              : `共 ${total} 条${shown > 0 ? `,当前显示第 ${pageStart + 1}–${pageStart + shown} 条` : ''}`}
        </span>
      </form>

      {/* per-app 限流覆盖的**可发现面**（决策 §2.5；不做成新列）：
          开关只筛当前页（与访问级别筛选的降级口径一致：分页/「共 N 条」仍是未筛选全集），
          全量清单在页头「限流覆盖（N）」里。清单读不到时开关禁用 + 明说原因，绝不把
          "读不到"渲染成"没有应用有覆盖"。 */}
      <div className="flex flex-wrap items-center gap-2" data-testid="app-overrides-bar">
        <Switch
          id="app-only-overrides"
          data-testid="app-only-overrides"
          aria-label="只看有覆盖"
          checked={onlyOverridesActive}
          disabled={!canRead || !overridesKnown}
          aria-describedby={overridesKnown ? 'app-overrides-page-note' : 'app-overrides-unknown-note'}
          title={
            overridesKnown
              ? '只显示本页里有单独限流覆盖的应用（全量清单在页头「限流覆盖」里）'
              : '限流覆盖清单未读取成功，无法判断哪些应用有覆盖'
          }
          onCheckedChange={(v) => { setOnlyOverrides(v) }}
        />
        <Label htmlFor="app-only-overrides" className="text-xs">只看有覆盖</Label>
        <span className="text-[11px] text-muted-foreground" data-testid="app-overrides-count-note">
          {overrides !== null
            ? `全组织共 ${overrides.total} 个应用有单独限流覆盖`
            : overridesLoading
              ? '限流覆盖清单读取中…'
              : '限流覆盖清单未读到（不是「没有应用有覆盖」）'}
        </span>
        {overridesError !== '' && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="app-overrides-retry"
            title={overridesError}
            onClick={() => { void loadOverrides() }}
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />重试覆盖清单
          </Button>
        )}
      </div>
      {overridesError !== '' && (
        <p
          data-testid="app-overrides-error"
          role="alert"
          aria-live="polite"
          className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
        >
          {overridesError}。列表行不显示覆盖徽标，「只看有覆盖」已禁用 —— 这不是「没有应用有覆盖」。
        </p>
      )}
      {onlyOverridesActive && (
        <p id="app-overrides-page-note" data-testid="app-overrides-page-note" className="text-xs text-muted-foreground">
          「只看有覆盖」只在本页 {shown} 条内生效：上面的「共 N 条」与翻页仍是未筛选全集。
          要看全部例外配置，请点页头的「限流覆盖（{overridesCountText}）」。
        </p>
      )}
      {!overridesKnown && overridesError === '' && (
        <p id="app-overrides-unknown-note" className="sr-only">限流覆盖清单尚未读取成功</p>
      )}

      {/* URL 里带来的非法访问级别（例如旧书签 `?access=public`）：**不能静默当成"全部"**，
          否则管理员以为筛过了、其实看的是全集。消息只说两值口径（唯一一份实现）。 */}
      {accessFilter.rejected !== '' && (
        <p
          data-testid="app-access-rejected"
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {accessLevelRejectionMessage(accessFilter.rejected)}
        </p>
      )}

      {/* 服务端还不支持 `access=` 时的**显式降级**：筛选只作用于本页，数字与翻页仍是
          未筛选全集。不说明就等于给管理员一个假的"筛过了"。 */}
      {accessFilterActive && !accessFilterSupported && !loadError && (
        <p data-testid="app-access-local-note" className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          服务端未回显访问级别筛选（`GET /wasm-apps` 尚不支持 `access=`）：当前筛选只在**本页 {shown} 条**内生效，
          上面的"共 N 条"与翻页仍是未筛选全集。历史 public 行按「登录后全员」口径判定。
        </p>
      )}

      {/* 历史值提示：筛到历史行时给一句可核对的话（不隐藏、也不说成"公开"）。 */}
      {accessFilterActive && accessFilterSupported && legacyShown > 0 && (
        <p data-testid="app-access-legacy-note" className="text-xs text-muted-foreground">
          本页有 {legacyShown} 条应用仍是历史值 public（已退役，服务端按「登录后全员」执行）；
          如需只给部分人使用，请让负责人在应用配置里改为 whitelist 并发布新版本。
        </p>
      )}

      {/* 打开次数取数失败（F16）：明说"数据源不可用"，列表里那一列显示「—」。
          **不得静默显示 0** —— 管理员会据此判断"这个应用没人用"。 */}
      {canRead && opensFailure !== null && (
        <div className="space-y-1" data-testid="apps-opens-failure-block">
          <p data-testid="apps-opens-failure" role="alert" aria-live="polite" className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {opensFailure.text}
          </p>
          <Button variant="outline" size="sm" data-testid="apps-opens-retry" onClick={() => { void loadOpens() }}>
            <RefreshCw className="mr-1 h-4 w-4" />重试打开次数
          </Button>
        </div>
      )}

      {loading ? (
        <EmptyState icon={<Boxes className="h-6 w-6" />} title="加载中…" desc="请稍候" />
      ) : !canRead ? (
        <EmptyState
          icon={<Boxes className="h-6 w-6" />}
          title="没有查看应用中心的权限"
          desc="需要 capability:read 权限,请联系平台管理员"
        />
      ) : loadError !== '' ? (
        // R1-uxw-2:列表读取失败 = 页面级的确定态(错误 + 重试),**不渲染任何行**。
        // 此前这里保留旧行,于是"共 25 条,当前显示第 21–40 条"与屏幕上的第 1 页
        // 同屏出现 —— 数字全是编的。
        <div className="space-y-2" data-testid="apps-load-error-block">
          <p data-testid="apps-load-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {loadError}
          </p>
          <Button variant="outline" size="sm" data-testid="apps-retry" onClick={() => { void load() }}>
            <RefreshCw className="mr-1 h-4 w-4" />重试
          </Button>
        </div>
      ) : apps.length === 0 ? (
        outOfRange ? (
          // 越界空页:服务端 offset 越界时返回空数组但 total>0(先过滤再分页)。
          // 此前这里渲染「暂无应用」,与标签里的"共 5 条"直接互相矛盾(A2 现场)。
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title="这一页没有数据"
            desc={`共 ${total} 条,当前页码已越界(数据可能因下架/删除变少了)`}
            action={
              <Button variant="outline" size="sm" data-testid="apps-first-page" onClick={() => { setOffset(0) }}>
                回到第一页
              </Button>
            }
          />
        ) : filteredEmptyLocally ? (
          // 本页没有命中（服务端不支持该筛选）≠ 系统里没有：两句话必须分开说。
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title="本页没有匹配该访问级别的应用"
            desc="服务端尚未支持按访问级别过滤，当前只在本页内筛选；其他页可能有匹配项，可翻页或清除筛选。"
          />
        ) : (
          // 加载失败时 apps 必为空,且上面 loadError 分支已接管 —— 走到这里就是
          // 服务端如实回答"没有数据"(写操作失败时 apps 非空,走表格分支)。
          <EmptyState
            icon={<Boxes className="h-6 w-6" />}
            title={q !== '' || status !== 'all' || accessFilterActive ? '没有匹配的应用' : '暂无应用'}
            desc={q !== '' || status !== 'all' || accessFilterActive ? '换个关键词或筛选条件再试' : '员工发布的 WASM 应用将出现在这里'}
          />
        )
      ) : overrideFilterEmpty ? (
        // 「只看有覆盖」筛空了本页：与"系统里没有应用"是两句不同的话（本页 20 条里没有例外，
        // 不代表全组织没有）。全量清单在页头「限流覆盖（N）」里 —— 这里直接给出入口。
        <EmptyState
          icon={<Gauge className="h-6 w-6" />}
          title="本页没有带限流覆盖的应用"
          desc={`「只看有覆盖」只在本页 ${shown} 条内生效。全组织共有 ${overrides?.total ?? 0} 个应用有单独限流覆盖，可翻页或直接看总览。`}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" size="sm" data-testid="app-overrides-empty-open" onClick={() => { setOverridesOpen(true) }}>
                <Gauge className="mr-1 h-4 w-4" />看限流覆盖总览
              </Button>
              <Button variant="ghost" size="sm" data-testid="app-overrides-empty-clear" onClick={() => { setOnlyOverrides(false) }}>
                取消筛选
              </Button>
            </div>
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>应用</TableHead>
                <TableHead>访问级别</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>负责人</TableHead>
                <TableHead>当前版本</TableHead>
                {/* F16（§8.9 管理端出口 ①）：每应用今日 / 近 7 日 PV+UV。
                    数据来自跨应用聚合；聚合不可用时这里是「—」+ 页面上方的显式提示，
                    **不是 0**（把"读不到"显示成 0 会被读成"没人用"）。 */}
                <TableHead>打开次数</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="sticky right-0 z-10 bg-muted/60 text-right backdrop-blur-sm">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {renderedApps.map((row) => {
                const am = accessMeta(row.access)
                const sm = statusMeta(row)
                const isBusy = busy.startsWith(`${row.app_id}:`)
                // 用 isFrozen 而不是裸比较：服务端未下发该列时 `undefined !== null` 为真，
                // 裸比较会把「没下发」当成「已冻结」（未下发 ≠ 已冻结，同 lifecycleRows 的口径）。
                const frozen = isFrozen(row)
                // C-11：已删除行**只保留只读详情 + 恢复 + 导出**（其余动作不渲染）；
                // 已清除（purged）的行连恢复都没有（设计 §3.1：数据面 410 APP_PURGED）。
                const deleted = isDeleted(row)
                const purged = isPurged(row)
                const pendingCount = row.pending_count ?? (row.pending_releases ?? []).length
                const orow = opensRows[row.app_id]
                // per-app 限流覆盖（决策 §2.5）：只有**读到过**覆盖清单时才可能渲染徽标；
                // 清单读失败时 overrideByApp 是空 map，徽标缺席由页面上方的错误条解释。
                const overrideRow = overridesKnown ? overrideByApp[row.app_id] : undefined
                // 缺"行"≠ 缺"字段"（R2-L6-4）：聚合可用但服务端没下发该应用的行
                // （GROUP BY app_id 会省略零打开的应用）⇒ 该窗口内确实没有打开记录
                // ⇒ **按 0 计** + title 说明；行在而字段缺失 = 形状漂移 ⇒ 仍显示 —。
                const counts = appOpenCounts(orow)
                return (
                  <TableRow key={row.app_id}>
                    <TableCell className="max-w-[16rem]">
                      <div className="truncate font-medium" title={row.title || row.app_id}>{row.title || row.app_id}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground" title={row.app_id}>{row.app_id}</div>
                    </TableCell>
                    <TableCell>
                      {/* 历史 public 渲染成「已退役（历史值）」并带解释；不显示裸值、
                          也不显示成"公开"（会让人以为匿名仍可达），更不隐藏
                          （隐藏 = 这些应用的访问级别看起来丢了）。 */}
                      <Badge variant={am.variant} title={am.title} data-testid={`app-access-${row.app_id}`}>{am.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        {/* 待审批徽标(P0-1 前端闭环):有积压的行必须在列表上就能看出来,
                            否则"审核开着但没人知道谁在等"就是这次审计的 P0 现场。
                            R1-uxw-14:版本清单此前只挂在 hover 的 title 上 —— 徽标改成
                            可聚焦 + aria-label,键盘/读屏用户同样读得到在等哪个版本。 */}
                        {pendingCount > 0 && (
                          <Badge
                            variant="destructive"
                            data-testid="pending-badge"
                            tabIndex={0}
                            title={`待审版本:${(row.pending_releases ?? []).join('、')}`}
                            aria-label={`待审批 ${pendingCount} 个版本:${(row.pending_releases ?? []).join('、')}`}
                          >
                            待审批 {pendingCount}
                          </Badge>
                        )}
                        {/* per-app 限流覆盖标记（决策 §2.5；生产化评审「管理员可发现」）：
                            **不新增列**（把例外做成日常噪音是本决策明确不做的），只在状态格里
                            加一枚 outline 徽标 —— 有覆盖才出现，高于全局时用 destructive 变体 +
                            可聚焦的 aria-label，把"这个应用比别人多占槽位"顶到眼前。
                            徽标不是按钮：点它不开抽屉（避免和行内其它动作抢命中区），
                            tooltip/读屏文案指向页头「限流覆盖（N）」这个真正可点的入口。 */}
                        {overrideRow !== undefined && (
                          <Badge
                            variant={overrideRow.exceedsAny ? 'destructive' : 'outline'}
                            data-testid={`app-override-badge-${row.app_id}`}
                            tabIndex={0}
                            title={
                              overrideRow.exceedsAny
                                ? '该应用有单独限流覆盖，且生效值有轴高于全局（比其他应用占更多槽位）；点页头「限流覆盖」查看'
                                : '该应用有单独限流覆盖（按应用降额/放宽）；点页头「限流覆盖」查看'
                            }
                            aria-label={
                              overrideRow.exceedsAny
                                ? '该应用有单独限流覆盖，且高于全局'
                                : '该应用有单独限流覆盖'
                            }
                          >
                            限流覆盖{overrideRow.exceedsAny ? '·高于全局' : ''}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{row.owner || '—'}</TableCell>
                    <TableCell className="font-mono text-sm">{row.current_version || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {/* 打开次数（F16）：聚合不可用时整格显示「—」并附页面上方提示。
                          聚合可用但该应用**没有行** ⇒ 窗口内没有打开记录（服务端 `GROUP BY
                          app_id` 会省略零打开的应用）⇒ **按 0 计**并带 title 说明；
                          这与"行在但字段缺失（形状漂移）显示 —"是两件事（R2-L6-4 / CTL-11）。 */}
                      {opensFailure !== null ? (
                        <span data-testid={`app-opens-cell-${row.app_id}`} title={opensFailure.text}>—</span>
                      ) : (
                        <div
                          data-testid={`app-opens-cell-${row.app_id}`}
                          title={counts.missingRow ? OPENS_MISSING_ROW_NOTE : 'PV=每次打开 +1（不去重）；UV=按用户去重（服务端聚合）'}
                        >
                          <div>
                            今日 <span className="font-mono">{countText(counts.todayPv)}</span>
                            {' / '}
                            <span className="font-mono">{countText(counts.todayUv)}</span>
                          </div>
                          <div className="text-muted-foreground">
                            近 {OPENS_WINDOW_DAYS} 日 <span className="font-mono">{countText(counts.windowPv)}</span>
                            {' / '}
                            <span className="font-mono">{countText(counts.windowUv)}</span>
                          </div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtTime(row.updated_at)}</TableCell>
                    {/* 操作列:窄屏(375px)下**吸右**。此前它整体落在视口之外
                        (`right` 632~782 > 375),管理员只看得到列表、点不到任何处置
                        (R1-uxw-8 的真实 Chromium 实测)。sticky 让它在横向滚动条
                        的右缘常驻,按钮允许换行避免被压成图标。 */}
                    <TableCell className="sticky right-0 z-10 bg-background text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.15)]">
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { openDetail(row) }}
                          title="详情"
                          aria-label="详情"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {/* 已删除行（C-11）：只保留只读详情 + 恢复 + 导出，其余动作**不渲染**。
                            为什么不是禁用：禁用表示"现在不能"，而"删了"的语义是"这件事不再存在于这一行"；
                            此前它们全部渲染、点了必然 404（「已删除」筛选因此是断头路，C-04/C-11）。
                            已清除（purged）的行更进一步：设计 §3.1 规定 restore/数据面一律 410，
                            所以连「恢复」都不渲染，只在详情里显示「数据已清除，不可恢复」。 */}
                        {deleted ? (
                          <>
                            {canWrite && !purged && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isBusy}
                                data-testid={`app-restore-${row.app_id}`}
                                onClick={() => { void restoreApp(row) }}
                                title="恢复:清除删除/冻结状态，保持下架（不自动上架）"
                                aria-label="恢复"
                              >
                                <RotateCcw className="mr-1 h-4 w-4" />恢复
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isBusy}
                              data-testid={`app-export-${row.app_id}`}
                              onClick={() => { setExportTarget(row) }}
                              title="导出（控制面 JSON / 含数据 / 含资源）"
                              aria-label="导出"
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            {canWrite && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isBusy}
                                  data-testid={`app-deploy-${row.app_id}`}
                                  onClick={() => { setDeployTarget(row) }}
                                  title="部署/回滚（版本选择器只列 approved，标当前/最新）"
                                  aria-label="部署"
                                >
                                  <Rocket className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isBusy}
                                  onClick={() => { openOwner(row) }}
                                  title="转移归属(负责人)"
                                  aria-label="转移归属"
                                >
                                  <UserCog className="h-4 w-4" />
                                </Button>
                                {/* 禁用按钮不可聚焦 ⇒ 原因只写 title 等于没有(R1-uxw-14)。
                                    sr-only 的说明 + aria-describedby 让读屏也能读到"先解冻再上架";
                                    再加 tabIndex 让它**可聚焦**：键盘用户 Tab 到这一条就能听到
                                    原因，而不是对着一个点不动的按钮猜。 */}
                                {frozen && (
                                  <span
                                    id={`frozen-reason-${row.app_id}`}
                                    data-testid={`frozen-reason-${row.app_id}`}
                                    tabIndex={0}
                                    className="sr-only"
                                  >
                                    已冻结:交付面一律 404,先解冻再上架
                                  </span>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  // 冻结优先(P2-6):冻结期间交付面一律 404,所以"上架"没有意义
                                  // (服务端同样返回 403 APP_FROZEN + hint,这里只是别让它可点)。
                                  disabled={isBusy || frozen}
                                  aria-describedby={frozen ? `frozen-reason-${row.app_id}` : undefined}
                                  // R1-uxw-13:下架 = 全组织员工当场不可用(与冻结同级的可见性
                                  // 破坏),必须确认;上架是恢复动作,不打扰(与解冻一致)。
                                  onClick={() => { row.enabled ? setUnpublishTarget(row) : void togglePublished(row) }}
                                  title={
                                    frozen
                                      ? '已冻结:交付面一律 404,先解冻再上架'
                                      : row.enabled ? '下架(员工不可用,数据保留)' : '上架(员工可见可用)'
                                  }
                                  aria-label={row.enabled ? '下架' : '上架'}
                                >
                                  {row.enabled ? '下架' : '上架'}
                                </Button>
                                <Button
                                  size="sm"
                                  variant={frozen ? 'outline' : 'destructive'}
                                  disabled={isBusy}
                                  // 冻结是破坏性动作(立即停服 + 进入保留期)⇒ 先确认;
                                  // 解冻是恢复动作,不打扰。
                                  onClick={() => { frozen ? void submitFrozen(row, false) : setFreezeTarget(row) }}
                                  title={frozen ? '解冻(恢复服务)' : '冻结(停止服务 + 只读快照 + 保留期)'}
                                  aria-label={frozen ? '解冻' : '冻结'}
                                >
                                  {frozen ? '解冻' : '冻结'}
                                </Button>
                                {/* 删除（设计 §5.5）：软删 + 快照 + 保留期，必须二次确认
                                    （确认框写清"删除前必须快照"与 purge_after 具体日期）。 */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isBusy}
                                  data-testid={`app-delete-${row.app_id}`}
                                  onClick={() => { setDeleteTarget(row) }}
                                  title="删除（软删 + 只读快照 + 保留期；保留期内可恢复）"
                                  aria-label="删除"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                            {/* 导出对**只读账号**也开放（服务端 export 只要 capability:read）；
                                已删除行同样可导出（保留期内数据仍在），所以两个分支各渲染一次。 */}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isBusy}
                              data-testid={`app-export-${row.app_id}`}
                              onClick={() => { setExportTarget(row) }}
                              title="导出（控制面 JSON / 含数据 / 含资源）"
                              aria-label="导出"
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 分页(P1-7):不翻页也能看到"被截断了"(truncated),翻了才可能看到第 201 个。 */}
      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="app-prev-page"
            disabled={!hasPrev || loading}
            onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)) }}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="app-next-page"
            disabled={!hasNext || loading}
            onClick={() => { setOffset(offset + PAGE_SIZE) }}
          >
            下一页
          </Button>
        </div>
      )}

      {/* 转移归属:输入用户名 → PUT /wasm-apps/:app_id/owner(服务端校验用户存在)。 */}
      <Dialog
        open={ownerTarget !== null}
        onOpenChange={(open) => { if (!open) { setOwnerTarget(null); setOwnerInput('') } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              转移归属{ownerTarget ? `:${ownerTarget.title || ownerTarget.app_id}` : ''}
            </DialogTitle>
            <DialogDescription>
              转移后新负责人获得该应用的续传发布权,原负责人的发布请求将失效。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="wasm-app-owner" className="text-xs text-muted-foreground">新负责人用户名</Label>
            <Input
              id="wasm-app-owner"
              aria-label="新负责人用户名"
              value={ownerInput}
              placeholder="如 alice"
              disabled={busy !== ''}
              onChange={(e) => { setOwnerInput(e.target.value) }}
            />
            {ownerTarget && (
              <p className="text-xs text-muted-foreground">当前负责人:{ownerTarget.owner || '—'}</p>
            )}
            {ownerError && (
              <p data-testid="owner-error" role="alert" aria-live="assertive" className="text-sm text-destructive">
                {ownerError}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setOwnerTarget(null); setOwnerInput('') }}>取消</Button>
            <Button
              disabled={busy !== '' || ownerInput.trim() === ''}
              onClick={() => { void submitOwner() }}
            >
              确认转移
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 更新审批开关的二次确认:开启 = 全组织新版本停在待审;关闭 = 已积压的不会自动转正。 */}
      <Dialog open={reviewPrompt !== null} onOpenChange={(open) => { if (!open) setReviewPrompt(null) }}>
        <DialogContent data-testid="review-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{reviewPrompt ? '开启更新审批?' : '关闭更新审批?'}</DialogTitle>
            <DialogDescription>
              {reviewPrompt
                ? '开启后,员工发布的新版本会停在「待审批」状态,需要管理员在本页审批通过才能上线;线上继续运行当前生效版本,不会中断使用。'
                : '关闭后,员工发布的新版本立即生效,不再需要审批。下面写清现存积压会变成什么。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {reviewPrompt ? (
              <>
                <p>
                  代价:从此刻起<strong>全组织</strong>的新版本都不会自动上线,直到有人审批。
                </p>
                {pendingTotal > 0 && (
                  <p className="text-destructive" data-testid="review-pending-warning">
                    当前已有 {pendingTotal} 个待审版本积压(开启后仍需逐个审批)。
                  </p>
                )}
              </>
            ) : (
              <p className="text-destructive" data-testid="review-close-warning">
                {reviewCloseWarning(reviewStateKnown ? pendingTotal : null)}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setReviewPrompt(null) }}>取消</Button>
            <Button
              data-testid="review-confirm"
              disabled={busy !== ''}
              onClick={() => {
                const next = reviewPrompt
                setReviewPrompt(null)
                if (next !== null) void toggleReview(next)
              }}
            >
              {reviewPrompt ? '确认开启' : '确认关闭'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 下架确认(R1-uxw-13):下架 = 全组织员工当场不可用,与冻结同级的可见性破坏,
          此前却是一键生效;而同类风险的冻结/审批开关/拒绝都有重确认 ⇒ 语义不成体系。
          规则收敛为:**可见性下降/破坏性动作要确认(冻结、下架、关闭子域、拒绝),
          恢复类动作不打扰(解冻、上架)**。 */}
      <Dialog open={unpublishTarget !== null} onOpenChange={(open) => { if (!open) setUnpublishTarget(null) }}>
        <DialogContent data-testid="unpublish-confirm-dialog">
          <DialogHeader>
            <DialogTitle>
              下架应用{unpublishTarget ? `:${unpublishTarget.title || unpublishTarget.app_id}` : ''}?
            </DialogTitle>
            <DialogDescription>下架影响该应用的全部使用者,但不删除任何数据。</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li><strong>员工端立即不可用</strong>:该应用对所有人消失,已在用的人当场打不开。</li>
            <li><strong>数据保留</strong>:应用数据与已发布版本都不动,重新上架即恢复。</li>
            <li><strong>如何回滚</strong>:本页「上架」按钮即可恢复(恢复类动作不需要再确认)。</li>
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setUnpublishTarget(null) }}>取消</Button>
            <Button
              variant="destructive"
              data-testid="unpublish-confirm"
              disabled={busy !== ''}
              onClick={() => {
                const row = unpublishTarget
                setUnpublishTarget(null)
                if (row) void togglePublished(row)
              }}
            >
              确认下架
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 冻结确认：按设计 §5.4 的**真实语义**写（快照是否已生成、purge_after 具体日期）。
          此前这里承诺「保留期结束后由后台任务真正删除」，而那个后台任务并不存在（审计 C-01）
          —— 一句话即构成合规场景的假履约承诺，本对话框的文案因此由 apps-lifecycle 统一生成。 */}
      <Dialog open={freezeTarget !== null} onOpenChange={(open) => { if (!open) setFreezeTarget(null) }}>
        <DialogContent data-testid="freeze-confirm-dialog">
          <DialogHeader>
            <DialogTitle>
              {freezeCopy.title}{freezeTarget ? `:${freezeTarget.title || freezeTarget.app_id}` : ''}?
            </DialogTitle>
            <DialogDescription>{freezeCopy.intro}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="freeze-confirm-bullets">
            {freezeCopy.bullets.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p
            data-testid="freeze-irreversible"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive"
          >
            {freezeCopy.irreversible}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setFreezeTarget(null) }}>取消</Button>
            <Button
              variant="destructive"
              data-testid="freeze-confirm"
              disabled={busy !== ''}
              onClick={() => {
                const row = freezeTarget
                setFreezeTarget(null)
                if (row) void submitFrozen(row, true)
              }}
            >
              确认冻结
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 生命周期动作对话框（设计 §7）：部署/回滚、删除、导出。
          三者都只在**动作发生的那一刻**取数/写库，成功后由 onDone 交回页面统一回填与刷新
          （页面是列表与 flash 回执的唯一持有者）。 */}
      <DeployDialog
        target={deployTarget}
        open={deployTarget !== null}
        onClose={() => { setDeployTarget(null) }}
        canWrite={canWrite}
        onDone={(result) => { if (deployTarget !== null) onDeployed(deployTarget, result) }}
      />
      <DeleteDialog
        target={deleteTarget}
        open={deleteTarget !== null}
        onClose={() => { setDeleteTarget(null) }}
        canWrite={canWrite}
        retentionDays={retentionDays}
        onDone={(result) => { if (deleteTarget !== null) onDeleted(deleteTarget, result) }}
      />
      <ExportDialog
        target={exportTarget}
        open={exportTarget !== null}
        onClose={() => { setExportTarget(null) }}
        canRead={canRead}
        onDone={onExported}
      />
      {/* 跨应用待审队列（C-07）：页头「待审 N」徽标点开；处置成功后刷新列表与积压数。 */}
      <PendingQueueDialog
        open={pendingQueueOpen}
        onOpenChange={setPendingQueueOpen}
        canWrite={canWrite}
        badgeTotal={reviewStateKnown ? pendingTotal : null}
        onChanged={() => { void load() }}
      />
      {/* 限流覆盖总览（决策 §2.5；生产化评审「管理员可发现/可审查」）：
          对话框自己读清单 + 应用目录 + 运行时水位；清空某行后回调刷新列表徽标与计数。 */}
      <LimitOverridesDialog
        open={overridesOpen}
        onOpenChange={setOverridesOpen}
        canRead={canRead}
        canWrite={canWrite}
        onChanged={() => { void loadOverrides() }}
      />

      {/* 拒绝理由:**必填**,长度上限与服务端一致(200 字);空/纯空白或超限都直接禁用
          提交而不是等 400(P2-5:服务端拒收无理由的拒绝)。 */}
      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => { if (!open) { setRejectTarget(null); setRejectReason('') } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>拒绝 v{rejectTarget?.version}?</DialogTitle>
            <DialogDescription>
              拒绝会<strong>释放该版本的归档字节</strong>(不可恢复,版本号永久占位);发布者需要发布更高的新版本。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason" className="text-xs text-muted-foreground">
              拒绝理由(必填,将写入审计并回给作者)
            </Label>
            <Textarea
              id="reject-reason"
              aria-label="拒绝理由"
              data-testid="reject-reason"
              maxLength={200}
              value={rejectReason}
              placeholder="如:申请的数据范围超出该用途所需"
              onChange={(e) => { setRejectReason(e.target.value) }}
            />
            <p className="text-xs text-muted-foreground">{rejectReason.length}/200</p>
            {rejectError && (
              <p data-testid="reject-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
                {rejectError}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setRejectTarget(null); setRejectReason('') }}>取消</Button>
            <Button
              variant="destructive"
              data-testid="reject-submit"
              disabled={busy !== '' || rejectReason.length > 200 || rejectReason.trim() === ''}
              onClick={() => { void rejectRelease() }}
            >
              确认拒绝
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 详情:用途/数据敏感度/当前版本 id/创建与更新时间/描述 + 生命周期 + 部署历史
          + 待审版本 + 运行诊断。数据源是 detailRow（按 app_id 从最新列表解析，见其注释）。 */}
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detailRow ? `${detailRow.title || detailRow.app_id} 详情` : '应用详情'}</DialogTitle>
            <DialogDescription>{detailRow?.app_id}</DialogDescription>
          </DialogHeader>
          {/* R1-uxw-1:审核的成败反馈渲染在**对话框内部**。
              此前它走页面级的 apps-error/apps-flash,而 Radix 的整屏遮罩
              (`fixed inset-0 z-50 bg-black/80`)把它压在下面 —— 真实 Chromium 的
              elementFromPoint 命中测试显示:错误文本中心点命中的是弹窗标题,
              管理员看到的是"点了没反应"。放这里 = 天然浮在遮罩之上。 */}
          {detailFeedback && (
            <div
              data-testid="detail-feedback"
              role={detailFeedback.kind === 'err' ? 'alert' : 'status'}
              aria-live={detailFeedback.kind === 'err' ? 'assertive' : 'polite'}
              className={`rounded-md border px-3 py-2 text-sm ${
                detailFeedback.kind === 'err'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-border bg-muted'
              }`}
            >
              {detailFeedback.text}
            </div>
          )}
          {detailRow && (
            <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">用途</dt>
              <dd className="break-words">{detailRow.purpose || '—'}</dd>
              <dt className="text-muted-foreground">数据敏感度</dt>
              <dd>{detailRow.data_sensitivity || '—'}</dd>
              <dt className="text-muted-foreground">当前生效版本</dt>
              <dd className="font-mono" data-testid="detail-current-version">{currentVersionShown || '—'}</dd>
              <dt className="text-muted-foreground">当前版本 ID</dt>
              <dd className="font-mono">{detailRow.current_release_id > 0 ? detailRow.current_release_id : '—'}</dd>
              <dt className="text-muted-foreground">创建时间</dt>
              <dd>{fmtTime(detailRow.created_at)}</dd>
              <dt className="text-muted-foreground">更新时间</dt>
              <dd>{fmtTime(detailRow.updated_at)}</dd>
              <dt className="text-muted-foreground">描述</dt>
              <dd className="whitespace-pre-wrap break-words">{detailRow.description || '—'}</dd>
            </dl>
          )}

          {/* 详情抽屉的动作面（设计 §7「应用行/详情抽屉提供」）：抽屉关掉之前也能处置，
              不必回到列表找工作那一行。已删除行只给「恢复 + 导出」（C-11）。 */}
          {detailRow && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-2" data-testid="detail-actions">
              {isDeleted(detailRow) ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {isPurged(detailRow)
                      ? '该应用数据已清除：只读详情 + 控制面导出，不可恢复。'
                      : '该应用已删除（只读详情）：仅可恢复与导出；恢复后不会自动上架。'}
                  </span>
                  {canWrite && !isPurged(detailRow) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== ''}
                      data-testid="detail-restore"
                      onClick={() => { void restoreApp(detailRow) }}
                    >
                      恢复
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== ''}
                    data-testid="detail-export"
                    onClick={() => { setExportTarget(detailRow) }}
                  >
                    导出
                  </Button>
                </>
              ) : (
                <>
                  {canWrite && (
                    <Button
                      size="sm"
                      disabled={busy !== ''}
                      data-testid="detail-deploy"
                      onClick={() => { setDeployTarget(detailRow) }}
                    >
                      部署/回滚
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== ''}
                    data-testid="detail-export"
                    onClick={() => { setExportTarget(detailRow) }}
                  >
                    导出
                  </Button>
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy !== ''}
                      data-testid="detail-delete"
                      onClick={() => { setDeleteTarget(detailRow) }}
                    >
                      删除
                    </Button>
                  )}
                </>
              )}
            </div>
          )}

          {/* 生命周期块（设计 §7）：frozen_at / deleted_at / purge_after / snapshot_at / purged_at。
              已清除的应用在这里显示「数据已清除，不可恢复」。 */}
          {detailRow && <LifecycleBlock app={detailRow} />}

          {/* 限流（per-app 覆盖，契约 `docs/decisions/2026-10-22-wasm-per-app-limits.md` §2.5）：
              与「生命周期」「数据」同级。空 = 继承全局（占位符 = 全局默认）；保存前展示
              effective，超过全局时二次确认；保存成功回读服务端视图；失败不乐观更新。
              已删除/已清除的行只显示"不能配置"的说明，不渲染写入口（服务端 404）。 */}
          {detailRow && (
            <AppLimitsSection
              appId={detailRow.app_id}
              app={detailRow}
              canRead={canRead}
              canWrite={canWrite}
            />
          )}

          {/* 数据面（审计 C-05）：表结构 + 行浏览（schema/rows 两条只读端点）。
              折叠 + 懒加载：展开才发请求；已清除应用直接说明数据已删，不去读一个空库。 */}
          {detailRow && (
            <AppDataSection
              appId={detailRow.app_id}
              canRead={canRead}
              purged={isPurged(detailRow)}
            />
          )}

          {/* 部署历史（设计 §7）：id/version/kind/actor/actor_role/created_at/current。 */}
          {detailRow && (
            <DeploymentsBlock
              appId={detailRow.app_id}
              canRead={canRead}
              reloadToken={deployReload}
            />
          )}

          {/* 待审版本(P0-1 的前端出口):版本号/提交时间/提交人/体积/当前生效版本 + 通过/拒绝。 */}
          {detailRow && (
            <section className="space-y-2 rounded-md border p-3" data-testid="pending-block">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">待审版本({pending.length})</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void loadPending(detailRow.app_id, isDeleted(detailRow))
                    void loadRejected(detailRow.app_id, isDeleted(detailRow))
                  }}
                  data-testid="pending-refresh"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {/* 与上面 dl 里的「当前生效版本」共用同一个取值(currentVersionShown):
                    两处各读各的会出现"同屏两个当前生效版本"(R1-uxw-5)。 */}
                当前生效版本:<span className="font-mono" data-testid="pending-current-version">{currentVersionShown || '—'}</span>
                (审批通过后线上切到新版本;拒绝会释放归档字节)
              </p>
              {pendingError && <p className="text-sm text-destructive" role="alert" aria-live="assertive" data-testid="pending-error">{pendingError}</p>}
              {/* 禁用原因不能只写 title(R1-uxw-14):禁用按钮不可聚焦,读屏/键盘用户
                  只能看到一个点不动的「通过」。常驻 sr-only 说明 + aria-describedby。 */}
              {!canWrite && (
                <span id="pending-write-note" data-testid="pending-write-note" tabIndex={0} className="sr-only">
                  没有 capability:write 权限:通过/拒绝按钮已禁用(服务端同样会拒绝写请求)
                </span>
              )}
              {/* 刚提交的驳回:理由必须留在管理员眼前。下面「最近被拒」子清单是权威来源
                  (服务端 status=rejected 下发 reason),这一条是即时回显。 */}
              {lastRejection && (
                <p className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs" data-testid="last-rejection">
                  已拒绝 v{lastRejection.version}
                  {lastRejection.reason !== '' ? `:${lastRejection.reason}` : '(未填写理由)'}
                </p>
              )}
              {!pendingError && pending.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="pending-empty">
                  没有待审版本。员工发布新版本后,若组织开启了更新审批,会出现在这里。
                </p>
              ) : (
                <ul className="space-y-2" data-testid="pending-list">
                  {pending.map((rel) => (
                    <li key={rel.version} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0 last:pb-0">
                      <div className="space-y-0.5">
                        <div className="font-mono text-sm">
                          v{rel.version}
                          {rel.current && <Badge variant="secondary" className="ml-2">当前生效</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          提交人 {rel.publisher || '—'} · {fmtTime(rel.created_at)} · {fmtSize(rel.size)}
                        </div>
                        {/* 待审版本将公开的显示面(审计第三轮 B 区 CONFIRMED):approve 是
                            title/description 生效的唯一入口,审批人必须在**批准前**看到它们;
                            与线上不同时用「现 X → 待审 Y」把变更顶到眼前(首版待审没有
                            "现标题"—— 那时 apps.title 是 app_id 占位,不伪造旧值)。 */}
                        {pendingDisclosure(rel, detailRow).map((row) => (
                          <div
                            key={row.key}
                            className="text-xs"
                            data-testid={`pending-${row.key}-${rel.version}`}
                          >
                            {row.changed ? (
                              <>
                                <span className="text-muted-foreground">现{row.label}</span>{' '}
                                <span data-testid={`pending-${row.key}-current-${rel.version}`}>{row.current}</span>
                                <span className="mx-1" aria-hidden="true">→</span>
                                <span className="sr-only">改为</span>
                                <span className="text-muted-foreground">待审{row.label}</span>{' '}
                                <span className="font-medium" data-testid={`pending-${row.key}-next-${rel.version}`}>
                                  {row.next || '(空)'}
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="text-muted-foreground">{row.label}:</span>{' '}
                                <span className="font-medium" data-testid={`pending-${row.key}-next-${rel.version}`}>
                                  {row.next || '—'}
                                </span>
                                {row.firstRelease && row.key === 'title' && (
                                  <span className="ml-1 text-muted-foreground">
                                    (首版待审;目录暂以应用标识占位)
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        ))}
                        {rel.changelog && (
                          <div className="text-xs text-muted-foreground">变更说明:{rel.changelog}</div>
                        )}
                        {/* 审核理由(驳回理由):服务端在**每一行**下发 reason(非 rejected
                            行为空串),渲染位与「最近被拒」子清单共用同一字段名。 */}
                        {rel.reason && (
                          <div className="text-xs text-destructive" data-testid={`pending-reason-${rel.version}`}>
                            审核理由:{rel.reason}
                          </div>
                        )}
                      </div>
                      {/* 无写权限时**禁用而不是隐藏**(与开关同风格):待审清单本身是
                          只读可见的信息,按钮消失会让只读账号以为"没有待审"。
                          WEB-3:再加 `!pendingLoaded` —— 这份清单必须真的属于当前抽屉
                          (读失败/未落地时不能拿它去批准任何版本)。 */}
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          data-testid={`pending-approve-${rel.version}`}
                          disabled={!canWrite || busy !== '' || !pendingLoaded}
                          aria-describedby={!canWrite ? 'pending-write-note' : undefined}
                          title={canWrite ? '通过:该版本上线' : '没有 capability:write 权限'}
                          onClick={() => { void approveRelease(detailRow, rel) }}
                        >
                          <Check className="mr-1 h-4 w-4" />通过
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          data-testid={`pending-reject-${rel.version}`}
                          disabled={!canWrite || busy !== '' || !pendingLoaded}
                          aria-describedby={!canWrite ? 'pending-write-note' : undefined}
                          title={canWrite ? '拒绝:释放归档字节(不可恢复)' : '没有 capability:write 权限'}
                          onClick={() => { setRejectReason(''); setRejectTarget(rel) }}
                        >
                          <X className="mr-1 h-4 w-4" />拒绝
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* 最近被拒(R1-uxw-4):服务端此前连 reason 都不下发 —— 管理员写过的拒绝理由
                  只躺在审计详情里,审批面自己都回看不了。这里用 status=rejected 取回
                  (含 reason),与待审队列并列显示,失败/空态各自可见。 */}
              <div className="space-y-1 border-t pt-2" data-testid="rejected-block">
                <h4 className="text-xs font-semibold text-muted-foreground">最近被拒版本({rejected.length})</h4>
                {rejectedError && (
                  <p className="text-sm text-destructive" role="alert" aria-live="assertive" data-testid="rejected-error">{rejectedError}</p>
                )}
                {!rejectedError && rejected.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="rejected-empty">没有被拒的版本。</p>
                ) : (
                  <ul className="space-y-1" data-testid="rejected-list">
                    {rejected.map((rel) => (
                      <li key={rel.version} className="text-xs" data-testid={`rejected-${rel.version}`}>
                        <span className="font-mono">v{rel.version}</span>
                        {rel.publisher && <span className="text-muted-foreground">{` · 提交人 ${rel.publisher}`}</span>}
                        <span className="text-muted-foreground">{` · ${fmtTime(rel.created_at)}`}</span>
                        {/* 被拒理由(驳回结果)必须显示出来:它就是"为什么没过"的答案。 */}
                        <div className="text-destructive" data-testid={`rejected-reason-${rel.version}`}>
                          {`审核理由:${rel.reason && rel.reason !== '' ? rel.reason : '(未填写理由)'}`}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {/* F16 ② 打开次数（契约 §8.9 / §19 Q11：应用页显示打开次数 + 隐私说明）：
              与运行诊断同层，数据源是 :app_id/opens（独立取数，端点在不在都不拖累
              其他区块）。概览用列表那份跨应用聚合；**聚合不可用**（请求失败/形状漂移）
              时传 null ⇒ 该处显示 —（缺的是数据源，不是"没人用过"）；
              聚合可用而该应用没有行 ⇒ 按 0 计（R2-L6-4：缺"行"≠ 缺"字段"）。 */}
          {detailRow && (
            <AppOpensSection
              appId={detailRow.app_id}
              canRead={canRead}
              overview={(() => {
                if (opensFailure !== null) return null
                const counts = appOpenCounts(opensRows[detailRow.app_id])
                return {
                  days: OPENS_WINDOW_DAYS,
                  todayPv: counts.todayPv ?? undefined,
                  todayUv: counts.todayUv ?? undefined,
                  windowPv: counts.windowPv ?? undefined,
                  windowUv: counts.windowUv ?? undefined,
                }
              })()}
            />
          )}

          {/* §21.1 第 12 问 / §21.4：应用详情页的 AI 用量面板（次数/token/费用），
              与打开计数同页展示；无归因数据时是空状态而不是 0。 */}
          {detailRow && <AppAiUsageSection appId={detailRow.app_id} canRead={canRead} />}

          {/* 运行诊断(P1-9):管理端此前零入口,排障只能找发布者要令牌。 */}
          {detailRow && (
            <section className="space-y-2 rounded-md border p-3" data-testid="diag-block">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1 text-sm font-semibold">
                  <Stethoscope className="h-4 w-4" />运行诊断
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void loadDiagnostics(detailRow.app_id) }}
                  data-testid="diag-refresh"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              {diagError && <p className="text-sm text-destructive" data-testid="diag-error">{diagError}</p>}
              {!diagError && diag && (
                <>
                  <p className="text-xs text-muted-foreground">
                    近 {Math.round((diag.window_minutes ?? 0) / 60)} 小时:共 {diag.summary.total} 次调用,
                    失败 {diag.summary.failed}(错误 {diag.summary.error} / 被杀 {diag.summary.killed});
                    调用事件保留 {diag.retention_days} 天
                  </p>
                  {diag.summary.reasons.length === 0 ? (
                    <p className="text-sm text-muted-foreground" data-testid="diag-empty">该窗口内没有失败记录</p>
                  ) : (
                    <ul className="space-y-1 text-sm" data-testid="diag-reasons">
                      {diag.summary.reasons.map((r) => (
                        <li key={r.reason_code}>
                          <span className="font-mono">{r.reason_code}</span> × {r.count}
                          {r.hints.length > 0 && (
                            <ul className="list-disc pl-5 text-xs text-muted-foreground">
                              {r.hints.map((h) => <li key={h}>{h}</li>)}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {diag.failures.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">最近失败</div>
                      <ul className="space-y-1 text-xs text-muted-foreground" data-testid="diag-failures">
                        {diag.failures.slice(0, 10).map((f, i) => (
                          <li key={`${f.created_at}-${i}`} className="font-mono">
                            {fmtTime(f.created_at)} · {f.outcome} · {f.reason_code} · exit {f.guest_exit_code} · cpu {f.cpu_ms}ms
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* hints 是"下一步改什么"(第一消费者是排障的人/AI),原文照显。 */}
                  {diag.hints.length > 0 && (
                    <ul className="list-disc pl-5 text-xs" data-testid="diag-hints">
                      {diag.hints.slice(0, 8).map((h) => <li key={h}>{h}</li>)}
                    </ul>
                  )}
                </>
              )}
              {!diagError && !diag && <p className="text-sm text-muted-foreground">读取中…</p>}
            </section>
          )}

          <div className="flex justify-end">
            <Button variant="outline" onClick={() => { setDetail(null) }}>关闭</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 公告模板（§19 Q13）：面向员工的访问级别变更 / 客户端专属打开方式文案。 */}
      <AnnouncementTemplatesDialog open={announceOpen} onOpenChange={setAnnounceOpen} />
    </div>
  )
}
