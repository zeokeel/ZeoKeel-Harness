/**
 * 管理端**只读数据面**的契约（审计 C-05：管理员此前只能 curl 看表结构与行）。
 *
 * 端点（`server/internal/router/optional_apps_on.go:159-160`，与员工面同形同实现，
 * 差别只有鉴权：管理会话 + `capability:read`，操作者账号进审计）：
 *
 *   - `GET /api/server/admin/wasm-apps/:app_id/schema`
 *     200 `{schema:{app_id, db, size_bytes, max_bytes, max_tables, max_columns,
 *            column_types, reserved_columns, tables[{name,rows,columns[{name,type,not_null,pk}],
 *            skipped?,skip_reason?}], table_count, usage_percent, initialized, page_size, page_count}}`
 *     —— 库不存在时**仍然 200**（`initialized:false` + `tables:[]`，且不建库）：这是
 *     "这个应用还没写过数据"这个**状态**，不是错误。
 *   - `GET /api/server/admin/wasm-apps/:app_id/rows?table=&limit=&offset=&unmask=1`
 *     200 `{rows:{app_id, table, columns[{name,type,sensitive}], rows[[]], limit, offset,
 *            returned, total_rows, has_more, truncated, truncated_values, unmasked,
 *            masked_columns, value_max_bytes}}`
 *     —— 库不存在 ⇒ 404（hint 明说"这个应用还没有数据库"）；表不存在 ⇒ 404 +
 *     `details.available_tables`。
 *   - 审计（`rows.go`）：`wasm_app_schema_view` / `wasm_app_rows_view` /
 *     `wasm_app_rows_view_unmasked`，**只记表名/分页/行数与脱敏状态，不记行内容**。
 *     因此界面上的提示只能说这三件事，不得声称"已记录你看到的内容"。
 *
 * 三条纪律（都来自 C-05 的原始诉求 + 本仓的「缺后端不得显示 0」口径）：
 *   ① 加载 / 空态 / 错误**三态分开**：`tables:[]`（真没数据）与 404/形状漂移（读不到）
 *      必须是两句不同的话；
 *   ② 分页由**服务端**做（`limit`/`offset` + `has_more`/`total_rows`），前端不拉全表；
 *   ③ 原值必须**显式二次确认**才发 `unmask=1`，并在页面上持续显示"当前是原值"。
 *
 * 纯函数（路径 / 形状校验 / 单元格文本 / 原值提示文案）与渲染分开：`.test.ts` 直接咬，
 * 不必起 DOM。
 */
import { ADMIN_API } from '../../api'

/** 行浏览一页的行数（与员工面缺省 50 同口径；服务端上限 200）。 */
export const ROWS_PAGE_SIZE = 50

/** 服务端单页上限（`rows.go` 的 `rowsMaxLimit = 200`）。 */
export const ROWS_MAX_PAGE_SIZE = 200

export function schemaPath(appId: string): string {
  return `${ADMIN_API}/wasm-apps/${encodeURIComponent(appId)}/schema`
}

/**
 * 行浏览的路径。`unmask` 只有在调用方**显式确认过**之后才为 true
 * （`unmask=1`；服务端 `isTruthyQuery` 认 1/true/yes/on）。
 */
export function rowsPath(
  appId: string,
  opts: { table: string; limit?: number; offset?: number; unmask?: boolean },
): string {
  const limit = opts.limit ?? ROWS_PAGE_SIZE
  const offset = opts.offset ?? 0
  const query = [
    `table=${encodeURIComponent(opts.table)}`,
    `limit=${limit}`,
    `offset=${offset}`,
    ...(opts.unmask === true ? ['unmask=1'] : []),
  ].join('&')
  return `${ADMIN_API}/wasm-apps/${encodeURIComponent(appId)}/rows?${query}`
}

// ---------------------------------------------------------------------------
// 形状：schema
// ---------------------------------------------------------------------------

export interface SchemaColumn {
  name: string
  type: string
  notNull: boolean
  pk: boolean
}

export interface SchemaTable {
  name: string
  /** 表的总行数（服务端 `SELECT COUNT(*)`）。 */
  rows: number
  columns: SchemaColumn[]
  /** 表名不合平台规则/读不动 ⇒ 服务端标 skipped（其余表照常返回）。 */
  skipped: boolean
  skipReason: string
}

export interface SchemaView {
  appId: string
  /** 库文件是否存在（false = 应用还没执行过任何 db.define/db.exec）。 */
  initialized: boolean
  tableCount: number
  sizeBytes: number
  maxBytes: number
  /** 占用百分比（0~100；服务端算好的，前端不自己除）。 */
  usagePercent: number
  tables: SchemaTable[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 校验并归一 schema 响应。
 *
 * 形状不对 ⇒ `ok:false`（页面说「读取失败」）；`tables:[]` 才是真「没有表」。
 * 反证 F6 的同口径纪律：**不得**把"读不到"渲染成"这个应用没有数据"。
 */
export function parseSchema(raw: unknown): { ok: true; value: SchemaView } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: '响应不是对象（这不是「应用没有数据表」，请核对服务端接口）' }
  const body = raw.schema
  if (!isRecord(body)) return { ok: false, reason: '响应里没有 schema 对象（这不是「应用没有数据表」，请核对服务端接口）' }
  if (!Array.isArray(body.tables)) return { ok: false, reason: 'schema 里没有 tables 数组（这不是「应用没有数据表」）' }
  const tables: SchemaTable[] = []
  for (const item of body.tables) {
    if (!isRecord(item)) continue
    const name = str(item.name)
    if (name === '') continue
    const columns: SchemaColumn[] = []
    if (Array.isArray(item.columns)) {
      for (const col of item.columns) {
        if (!isRecord(col)) continue
        const colName = str(col.name)
        if (colName === '') continue
        columns.push({
          name: colName,
          type: str(col.type),
          notNull: col.not_null === true,
          pk: col.pk === true,
        })
      }
    }
    tables.push({
      name,
      rows: num(item.rows),
      columns,
      skipped: item.skipped === true,
      skipReason: str(item.skip_reason),
    })
  }
  return {
    ok: true,
    value: {
      appId: str(body.app_id),
      initialized: body.initialized === true,
      tableCount: typeof body.table_count === 'number' ? num(body.table_count) : tables.length,
      sizeBytes: num(body.size_bytes),
      maxBytes: num(body.max_bytes),
      usagePercent: num(body.usage_percent),
      tables,
    },
  }
}

// ---------------------------------------------------------------------------
// 形状：rows
// ---------------------------------------------------------------------------

export interface RowsColumn {
  name: string
  type: string
  /** 该列**本次**是否被脱敏（服务端按列名启发式 ∪ 作者声明判定）。 */
  sensitive: boolean
}

export type CellValue = string | number | null | Record<string, unknown> | unknown[]

export interface RowsView {
  table: string
  columns: RowsColumn[]
  rows: unknown[][]
  limit: number
  offset: number
  returned: number
  /** 表的总行数（与分页无关）。 */
  totalRows: number
  hasMore: boolean
  /** appdb 的返回上限被命中（与 hasMore 是两件事）。 */
  truncated: boolean
  /** 本次按字节截断的值的个数（>0 时界面必须提示）。 */
  truncatedValues: number
  /** 本次是否要求了原值。 */
  unmasked: boolean
  /** 本次被脱敏的列名。 */
  maskedColumns: string[]
  valueMaxBytes: number
}

/**
 * 校验并归一行浏览响应。
 *
 * `rows:[]` = 这张表当前没有行（真空态）；缺 `rows.rows` 数组 = 形状漂移（错误态）。
 */
export function parseRows(raw: unknown): { ok: true; value: RowsView } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: '响应不是对象（这不是「这张表没有行」，请核对服务端接口）' }
  const body = raw.rows
  if (!isRecord(body)) return { ok: false, reason: '响应里没有 rows 对象（这不是「这张表没有行」，请核对服务端接口）' }
  if (!Array.isArray(body.rows)) return { ok: false, reason: 'rows 里没有行数组（这不是「这张表没有行」）' }
  if (!Array.isArray(body.columns)) return { ok: false, reason: 'rows 里没有 columns 数组（列结构是渲染表格的前提）' }
  const columns: RowsColumn[] = []
  for (const col of body.columns) {
    if (!isRecord(col)) continue
    const name = str(col.name)
    if (name === '') continue
    columns.push({ name, type: str(col.type), sensitive: col.sensitive === true })
  }
  const rows: unknown[][] = []
  for (const row of body.rows) {
    if (!Array.isArray(row)) continue
    rows.push(row)
  }
  const masked = Array.isArray(body.masked_columns)
    ? body.masked_columns.filter((c): c is string => typeof c === 'string')
    : []
  return {
    ok: true,
    value: {
      table: str(body.table),
      columns,
      rows,
      limit: num(body.limit) || ROWS_PAGE_SIZE,
      offset: num(body.offset),
      returned: typeof body.returned === 'number' ? num(body.returned) : rows.length,
      totalRows: num(body.total_rows),
      hasMore: body.has_more === true,
      truncated: body.truncated === true,
      truncatedValues: num(body.truncated_values),
      unmasked: body.unmasked === true,
      maskedColumns: masked,
      valueMaxBytes: num(body.value_max_bytes),
    },
  }
}

/** 单元格文本：NULL 与空串**分开**（'' 是"存了空字符串"，null 是"没有值"）。 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 原值（unmask）二次确认的原文。三件事必须都说到：
 *   ① 会把**敏感列的真实内容**显示在屏幕上（脱敏默认开启的原因）；
 *   ② 这一次**单独写审计**（动作名逐字来自 rows.go，管理员可据此自查）；
 *   ③ 审计**只记元数据**（表名/分页/行数），不记行内容 —— 不得让管理员以为"审计里有，屏幕上的可以随便截图"。
 */
export const UNMASK_CONFIRM_TEXT =
  '显示原值会把敏感列的真实内容（可能含员工 PII）渲染在本页上；服务端会为**这一次**读取单独写审计 ' +
  '`wasm_app_rows_view_unmasked`（含你的账号、表名、分页与行数，**不含行内容**）。' +
  '确认后本对话框关闭、表格立刻按原值重取；用完请点「恢复脱敏」。'

/** 数据面板常驻的审计提示（每次读取都会留痕）。 */
export const DATA_AUDIT_NOTE =
  '每次读取都会写审计：`wasm_app_schema_view`（表结构）/ `wasm_app_rows_view`（行浏览）/ ' +
  '`wasm_app_rows_view_unmasked`（原值）。审计只记表名、分页与行数，**不记行内容**。'

/** 已清除（purged）应用的数据面提示：目录已被真删，读也只会是空库。 */
export const PURGED_DATA_NOTE =
  '该应用数据已清除（purged）：应用库、资源与快照都已删除，数据面没有可读内容（设计 §3.1）。' +
  '控制面元数据与部署历史仍可导出（「导出」→ 控制面 JSON）。'

/** 分页说明（服务端 limit/offset + has_more/total_rows；前端不拉全表）。 */
export function pageSummary(view: RowsView): string {
  const from = view.returned === 0 ? 0 : view.offset + 1
  const to = view.offset + view.returned
  return `第 ${from}–${to} 行 / 共 ${view.totalRows} 行（limit=${view.limit}，offset=${view.offset}）`
}
