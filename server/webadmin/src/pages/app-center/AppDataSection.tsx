/**
 * 详情抽屉的「数据」折叠块（审计 C-05）：表结构 + 行浏览。
 *
 * ## 为什么要它
 *
 * 管理面的两条只读数据面端点（`GET …/:app_id/schema` / `…/rows`）在服务端已经存在
 * （2026-09-21），**webadmin 里零调用点** —— 管理员要看应用库里到底有什么，只能 curl，
 * 或者向发布者要令牌（而借令牌会让审计记错人）。C-05 的原话就是"管理员仍只能 curl"。
 *
 * ## 三条实现纪律
 *
 *   1. **懒加载**：折叠块默认收起，展开才发请求（详情抽屉本来就重，一次点开不该带 3 个
 *      额外请求；另外未持 `capability:read` 的账号也不该发注定 403 的请求）。
 *   2. **三态分开**：加载中 / 空态（`tables:[]`、`rows:[]`）/ 错误（404、形状漂移、
 *      权限不足）各说各的话 —— 把"读不到"渲染成"没有数据"是本仓反复出现的缺陷形态。
 *   3. **原值必须二次确认**：`unmask=1` 会把 PII 渲到屏幕上，且服务端会单独写一条
 *      `wasm_app_rows_view_unmasked` 审计 ⇒ 点击 → 确认框 → 才发请求；页面上持续显示
 *      "当前是原值"，并有「恢复脱敏」。
 *
 * 已清除（purged）的应用不读数据面：目录已被真删（设计 §3.1），读也只会得到空库，
 * 这里直接明说并关掉入口，而不是让管理员点了看到一个"没有表"的假空态。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from '../../api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { errorText } from '../../lib/api-error'
import { ChevronDown, ChevronRight, Database, Eye, RefreshCw, ShieldCheck } from 'lucide-react'
import {
  cellText,
  DATA_AUDIT_NOTE,
  parseRows,
  parseSchema,
  pageSummary,
  PURGED_DATA_NOTE,
  ROWS_PAGE_SIZE,
  rowsPath,
  schemaPath,
  UNMASK_CONFIRM_TEXT,
  type RowsView,
  type SchemaView,
} from './app-data'
import { fmtSize } from './apps-lifecycle'

export interface AppDataSectionProps {
  appId: string
  canRead: boolean
  /** 已清除应用：数据面没有可读内容（目录已删），显示说明并关掉入口。 */
  purged: boolean
}

export function AppDataSection({ appId, canRead, purged }: AppDataSectionProps) {
  const [open, setOpen] = useState(false)
  return (
    <section className="space-y-2 rounded-md border p-3" data-testid="data-block">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1 text-sm font-semibold">
          <Database className="h-4 w-4" />数据（表结构 / 行浏览）
        </h3>
        <Button
          variant="ghost"
          size="sm"
          data-testid="data-block-toggle"
          aria-expanded={open}
          aria-controls="data-block-body"
          onClick={() => { setOpen((prev) => !prev) }}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {open ? '收起' : '展开'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{DATA_AUDIT_NOTE}</p>
      {purged ? (
        <p data-testid="data-purged" role="alert" aria-live="assertive" className="text-sm text-destructive">
          {PURGED_DATA_NOTE}
        </p>
      ) : !canRead ? (
        <p data-testid="data-no-permission" className="text-sm text-muted-foreground">
          没有 capability:read 权限：表结构与行浏览都不可用（服务端同样会拒绝读请求）。
        </p>
      ) : open ? (
        <div id="data-block-body" className="space-y-3">
          <DataExplorer appId={appId} />
        </div>
      ) : (
        <p data-testid="data-collapsed-hint" className="text-xs text-muted-foreground">
          展开后可查看该应用的 SQLite 表结构，并按页浏览行；默认按列名启发式脱敏，显示原值需二次确认。
        </p>
      )}
    </section>
  )
}

/** 内部：表结构 + 当前表的行（一块折叠区里的两段，分开取数、分开报错）。 */
function DataExplorer({ appId }: { appId: string }) {
  const [schema, setSchema] = useState<SchemaView | null>(null)
  const [schemaError, setSchemaError] = useState('')
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [table, setTable] = useState('')
  const [rows, setRows] = useState<RowsView | null>(null)
  const [rowsError, setRowsError] = useState('')
  const [rowsLoading, setRowsLoading] = useState(false)
  const [offset, setOffset] = useState(0)
  /** 已确认显示原值（只有这里为 true 才发 unmask=1）。 */
  const [unmasked, setUnmasked] = useState(false)
  const [unmaskPrompt, setUnmaskPrompt] = useState(false)
  const schemaSeq = useRef(0)
  const rowsSeq = useRef(0)

  const loadSchema = useCallback(async () => {
    const current = ++schemaSeq.current
    setSchemaLoading(true)
    setSchemaError('')
    try {
      const raw = await request<unknown>(schemaPath(appId))
      if (current !== schemaSeq.current) return
      const parsed = parseSchema(raw)
      if (!parsed.ok) {
        setSchema(null)
        setSchemaError(`读取表结构失败：${parsed.reason}`)
        return
      }
      setSchema(parsed.value)
    } catch (err: unknown) {
      if (current !== schemaSeq.current) return
      setSchema(null)
      setSchemaError(`读取表结构失败：${errorText(err, '请求失败')}`)
    } finally {
      if (current === schemaSeq.current) setSchemaLoading(false)
    }
  }, [appId])

  const loadRows = useCallback(async (target: string, at: number, raw: boolean) => {
    if (target === '') return
    const current = ++rowsSeq.current
    setRowsLoading(true)
    setRowsError('')
    try {
      const out = await request<unknown>(rowsPath(appId, { table: target, limit: ROWS_PAGE_SIZE, offset: at, unmask: raw }))
      if (current !== rowsSeq.current) return
      const parsed = parseRows(out)
      if (!parsed.ok) {
        setRows(null)
        setRowsError(`读取行失败：${parsed.reason}`)
        return
      }
      setRows(parsed.value)
    } catch (err: unknown) {
      if (current !== rowsSeq.current) return
      setRows(null)
      setRowsError(`读取行失败：${errorText(err, '请求失败')}`)
    } finally {
      if (current === rowsSeq.current) setRowsLoading(false)
    }
  }, [appId])

  // 展开即拉表结构（懒加载：折叠时不发请求）。
  useEffect(() => {
    void loadSchema()
  }, [loadSchema])

  // 抽屉换应用时清空（同一块折叠区被复用）。
  useEffect(() => {
    setTable('')
    setRows(null)
    setRowsError('')
    setOffset(0)
    setUnmasked(false)
    setUnmaskPrompt(false)
  }, [appId])

  const pickTable = (name: string) => {
    setTable(name)
    setOffset(0)
    setUnmasked(false)
    void loadRows(name, 0, false)
  }

  const goPage = (next: number) => {
    if (table === '') return
    setOffset(next)
    void loadRows(table, next, unmasked)
  }

  const applyUnmask = (raw: boolean) => {
    setUnmasked(raw)
    setUnmaskPrompt(false)
    if (table !== '') void loadRows(table, offset, raw)
  }

  const tables = schema?.tables ?? []
  return (
    <div className="space-y-3">
      {/* ① 表结构 */}
      {schemaError !== '' && (
        <p data-testid="data-schema-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
          {schemaError}
        </p>
      )}
      {schemaError === '' && schemaLoading && schema === null && (
        <p data-testid="data-schema-loading" className="text-sm text-muted-foreground">读取表结构…</p>
      )}
      {schemaError === '' && schema !== null && tables.length === 0 && (
        <p data-testid="data-schema-empty" className="text-sm text-muted-foreground">
          {schema.initialized
            ? '这个应用的数据库里还没有表：应用还没执行过 db.define（表结构由应用代码创建）。'
            : '这个应用还没有数据库：它从未成功执行过 db.define/db.exec。'}
        </p>
      )}
      {schemaError === '' && tables.length > 0 && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground" data-testid="data-schema-summary">
              共 {schema?.tableCount ?? tables.length} 张表 · 库占用 {fmtSize(schema?.sizeBytes)} / 上限 {fmtSize(schema?.maxBytes)}
              （{schema?.usagePercent ?? 0}%）
            </p>
            <Button variant="ghost" size="sm" data-testid="data-schema-refresh" aria-label="刷新表结构" disabled={schemaLoading} onClick={() => { void loadSchema() }}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <ul className="space-y-1" data-testid="data-tables">
            {tables.map((t) => (
              <li key={t.name}>
                <Button
                  variant={t.name === table ? 'default' : 'outline'}
                  size="sm"
                  className="w-full justify-start gap-2"
                  data-testid={`data-table-${t.name}`}
                  aria-pressed={t.name === table}
                  disabled={t.skipped}
                  title={t.skipped ? `该表被服务端跳过：${t.skipReason || '表名不合平台规则'}` : `浏览 ${t.name}`}
                  onClick={() => { pickTable(t.name) }}
                >
                  <span className="font-mono">{t.name}</span>
                  <Badge variant="secondary">{t.rows} 行</Badge>
                  <span className="text-xs text-muted-foreground">{t.columns.length} 列</span>
                  {t.skipped && <span className="text-xs text-destructive">已跳过:{t.skipReason || '表名不合规'}</span>}
                </Button>
                {t.name === table && t.columns.length > 0 && (
                  <ul className="mt-1 space-y-0.5 pl-4 text-xs text-muted-foreground" data-testid={`data-columns-${t.name}`}>
                    {t.columns.map((c) => (
                      <li key={c.name} data-testid={`data-column-${t.name}-${c.name}`}>
                        <span className="font-mono">{c.name}</span>
                        <span> · {c.type || '—'}</span>
                        {c.notNull && <span> · NOT NULL</span>}
                        {c.pk && <span> · PK</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ② 行浏览（选了表才有） */}
      {table !== '' && (
        <div className="space-y-2 border-t pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">
              行浏览:<span className="font-mono">{table}</span>
            </h4>
            <div className="flex items-center gap-1">
              {rows?.unmasked === true ? (
                <>
                  <Badge variant="destructive" data-testid="data-unmasked-badge">当前是原值</Badge>
                  <Button size="sm" variant="outline" data-testid="data-remask" disabled={rowsLoading} onClick={() => { applyUnmask(false) }}>
                    <ShieldCheck className="mr-1 h-4 w-4" />恢复脱敏
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" data-testid="data-unmask" disabled={rowsLoading} onClick={() => { setUnmaskPrompt(true) }}>
                  <Eye className="mr-1 h-4 w-4" />显示原值
                </Button>
              )}
              <Button variant="ghost" size="sm" data-testid="data-rows-refresh" aria-label="刷新行" disabled={rowsLoading} onClick={() => { void loadRows(table, offset, unmasked) }}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {rowsError !== '' && (
            <p data-testid="data-rows-error" role="alert" aria-live="assertive" className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive">
              {rowsError}
            </p>
          )}
          {rowsError === '' && rowsLoading && rows === null && (
            <p data-testid="data-rows-loading" className="text-sm text-muted-foreground">读取行…</p>
          )}
          {rowsError === '' && rows !== null && rows.rows.length === 0 && (
            <p data-testid="data-rows-empty" className="text-sm text-muted-foreground">
              这张表当前没有行（offset={rows.offset}）。行数统计：{rows.totalRows} 行。
            </p>
          )}
          {rowsError === '' && rows !== null && rows.rows.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground" data-testid="data-rows-page">{pageSummary(rows)}</p>
              {rows.maskedColumns.length > 0 && (
                <p className="text-xs text-muted-foreground" data-testid="data-rows-masked">
                  已脱敏列:{rows.maskedColumns.join('、')}（值显示为 ***；显示原值需二次确认）
                </p>
              )}
              {rows.truncatedValues > 0 && (
                <p className="text-xs text-destructive" data-testid="data-rows-truncated">
                  有 {rows.truncatedValues} 个值超过单值上限（{rows.valueMaxBytes} 字节）被截断显示。
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" data-testid="data-rows-table">
                  <thead className="text-muted-foreground">
                    <tr>
                      {rows.columns.map((c) => (
                        <th key={c.name} className="whitespace-nowrap py-1 pr-2">
                          <span className="font-mono">{c.name}</span>
                          {c.sensitive && <span className="ml-1 text-destructive">敏感</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.rows.map((row, i) => (
                      <tr key={i} className="border-t">
                        {rows.columns.map((c, j) => (
                          <td key={c.name} className="max-w-[16rem] truncate py-1 pr-2 font-mono" title={cellText(row[j])}>
                            {cellText(row[j])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="outline" data-testid="data-prev" disabled={rowsLoading || rows.offset <= 0} onClick={() => { goPage(Math.max(0, rows.offset - rows.limit)) }}>
                  上一页
                </Button>
                <Button size="sm" variant="outline" data-testid="data-next" disabled={rowsLoading || !rows.hasMore} onClick={() => { goPage(rows.offset + rows.limit) }}>
                  下一页
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ③ 原值二次确认（显式动作：确认前**不发** unmask=1 的请求） */}
      <Dialog open={unmaskPrompt} onOpenChange={(next) => { if (!next) setUnmaskPrompt(false) }}>
        <DialogContent data-testid="data-unmask-dialog">
          <DialogHeader>
            <DialogTitle>显示「{table}」的原值?</DialogTitle>
            <DialogDescription>这是显式动作：服务端会为这一次读取单独写审计。</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-destructive" data-testid="data-unmask-warning">{UNMASK_CONFIRM_TEXT}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setUnmaskPrompt(false) }}>取消（保持脱敏）</Button>
            <Button variant="destructive" data-testid="data-unmask-confirm" onClick={() => { applyUnmask(true) }}>
              确认显示原值
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
