/**
 * 详情抽屉「数据」折叠块（审计 C-05）：表结构 + 行浏览的行为级用例。
 *
 * 这一组咬的是**行为**，不是"页面上出现过某个字符串"：
 *   - 折叠时**一个请求都不发**（懒加载）；展开才打 `GET …/:app_id/schema`；
 *   - 选表后打 `GET …/:app_id/rows?table=…&limit=…&offset=…`（分页由服务端做）；
 *   - **显式 unmask 二次确认**：确认前绝不发 `unmask=1`，确认后才发，并出现「当前是原值」；
 *   - 加载 / 空态 / 错误三态分开（`tables:[]` 与 404 是两句不同的话）；
 *   - purged 应用与无 `capability:read` 时**不发任何数据面请求**（目录已删 / 注定 403）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError, request } from '../../api'
import { AppDataSection } from './AppDataSection'
import {
  cellText,
  DATA_AUDIT_NOTE,
  pageSummary,
  parseRows,
  parseSchema,
  rowsPath,
  schemaPath,
  UNMASK_CONFIRM_TEXT,
} from './app-data'

const mockRequest = vi.mocked(request)

// ---------------------------------------------------------------------------
// 夹具：**逐键取自服务端真实响应**
// （`server/internal/wasmapp/api/read.go` 的 inspectAppDB / rows.go 的 rowsPayload）
// ---------------------------------------------------------------------------

const SCHEMA = {
  schema: {
    app_id: 'share-note',
    db: '<data_root>/apps/share-note/app.db',
    size_bytes: 12_288,
    max_bytes: 64 * 1024 * 1024,
    max_tables: 16,
    max_columns: 32,
    column_types: ['TEXT', 'INTEGER'],
    reserved_columns: ['_row_id'],
    tables: [
      {
        name: 'notes',
        rows: 3,
        columns: [
          { name: 'id', type: 'INTEGER', not_null: true, pk: true },
          { name: 'body', type: 'TEXT', not_null: false, pk: false },
          { name: 'owner_email', type: 'TEXT', not_null: false, pk: false },
        ],
      },
      { name: 'tags', rows: 0, columns: [{ name: 'name', type: 'TEXT', not_null: true, pk: false }] },
    ],
    table_count: 2,
    usage_percent: 0.02,
    initialized: true,
    page_size: 4096,
    page_count: 3,
  },
}

/** 行浏览：`owner_email` 是敏感列（服务端默认脱敏 ⇒ 值 `***`）。 */
const ROWS_PAGE_1 = {
  rows: {
    app_id: 'share-note',
    table: 'notes',
    columns: [
      { name: 'id', type: 'INTEGER', sensitive: false },
      { name: 'body', type: 'TEXT', sensitive: false },
      { name: 'owner_email', type: 'TEXT', sensitive: true },
    ],
    rows: [
      [1, '第一条', '***'],
      [2, null, '***'],
    ],
    limit: 50,
    offset: 0,
    returned: 2,
    total_rows: 3,
    has_more: true,
    truncated: false,
    truncated_values: 0,
    unmasked: false,
    masked_columns: ['owner_email'],
    value_max_bytes: 4096,
  },
}

const ROWS_PAGE_2 = {
  rows: {
    ...ROWS_PAGE_1.rows,
    rows: [[3, '第三条', '***']],
    offset: 50,
    returned: 1,
    has_more: false,
  },
}

/** 原值（unmask=1）：敏感列给出真值，`masked_columns` 为空。 */
const ROWS_UNMASKED = {
  rows: {
    ...ROWS_PAGE_1.rows,
    rows: [[1, '第一条', 'alice@example.com']],
    unmasked: true,
    masked_columns: [],
  },
}

let schemaMode: 'ok' | 'missing' | 'drift' | 'empty' = 'ok'
let rowsMode: 'ok' | 'empty' | 'missing' | 'drift' = 'ok'

beforeEach(() => {
  schemaMode = 'ok'
  rowsMode = 'ok'
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    const raw = String(path)
    const url = new URL(raw, 'http://x')
    if (raw.endsWith('/schema')) {
      if (schemaMode === 'missing') throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在')
      if (schemaMode === 'drift') return { schema: { app_id: 'share-note' } }
      if (schemaMode === 'empty') {
        return { schema: { ...SCHEMA.schema, tables: [], table_count: 0, initialized: false, size_bytes: 0 } }
      }
      return SCHEMA
    }
    if (url.pathname.endsWith('/rows')) {
      if (rowsMode === 'missing') throw new ApiError(404, 'NOT_FOUND', '这个应用还没有数据库')
      if (rowsMode === 'drift') return { rows: { app_id: 'share-note', table: 'notes' } }
      if (rowsMode === 'empty') {
        return { rows: { ...ROWS_PAGE_1.rows, rows: [], returned: 0, total_rows: 0, has_more: false, masked_columns: [] } }
      }
      if (url.searchParams.get('unmask') === '1') return ROWS_UNMASKED
      return url.searchParams.get('offset') === '50' ? ROWS_PAGE_2 : ROWS_PAGE_1
    }
    return {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mount(props: Partial<Parameters<typeof AppDataSection>[0]> = {}) {
  render(<AppDataSection appId="share-note" canRead purged={false} {...props} />)
}

/** 展开折叠块（懒加载：展开前不该有任何请求）。 */
function expand() {
  fireEvent.click(screen.getByTestId('data-block-toggle'))
}

function dataCalls() {
  return mockRequest.mock.calls.map(([p]) => String(p)).filter((p) => p.includes('/wasm-apps/share-note/'))
}

describe('数据面 · 折叠与懒加载', () => {
  it('默认收起，收起时**不发**任何请求；展开才拉表结构', async () => {
    mount()
    expect(screen.getByTestId('data-block-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('data-collapsed-hint')).toBeInTheDocument()
    expect(dataCalls()).toEqual([])

    expand()
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(schemaPath('share-note'))
    })
    expect(screen.getByTestId('data-block-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  it('表结构渲染：表名/行数/列数；选中表后展开列结构', async () => {
    mount()
    expand()
    const tables = await screen.findByTestId('data-tables')
    expect(within(tables).getByTestId('data-table-notes')).toHaveTextContent('notes')
    expect(within(tables).getByTestId('data-table-notes')).toHaveTextContent('3 行')
    expect(within(tables).getByTestId('data-table-notes')).toHaveTextContent('3 列')
    expect(within(tables).getByTestId('data-table-tags')).toHaveTextContent('0 行')

    fireEvent.click(within(tables).getByTestId('data-table-notes'))
    const cols = await screen.findByTestId('data-columns-notes')
    expect(within(cols).getByTestId('data-column-notes-id')).toHaveTextContent('PK')
    expect(within(cols).getByTestId('data-column-notes-owner_email')).toHaveTextContent('TEXT')
  })
})

describe('数据面 · 三态分开（加载 / 空 / 错误）', () => {
  it('空库（tables:[] + initialized:false）⇒ 说「还没有数据库」，不是「读取失败」', async () => {
    schemaMode = 'empty'
    mount()
    expand()
    expect(await screen.findByTestId('data-schema-empty')).toHaveTextContent('还没有数据库')
    expect(screen.queryByTestId('data-schema-error')).toBeNull()
    expect(screen.queryByTestId('data-tables')).toBeNull()
  })

  it('端点 404 ⇒ 错误态（不渲染成"没有表"）', async () => {
    schemaMode = 'missing'
    mount()
    expand()
    const err = await screen.findByTestId('data-schema-error')
    expect(err).toHaveTextContent('读取表结构失败')
    expect(err).toHaveTextContent('请求的资源不存在')
    expect(screen.queryByTestId('data-schema-empty')).toBeNull()
  })

  it('形状漂移（没有 tables 数组）⇒ 错误态明说"这不是「应用没有数据表」"', async () => {
    schemaMode = 'drift'
    mount()
    expand()
    expect(await screen.findByTestId('data-schema-error')).toHaveTextContent('这不是「应用没有数据表」')
  })

  it('行浏览错误（库不存在 404）与空表（rows:[]）是两句不同的话', async () => {
    mount()
    expand()
    fireEvent.click(await screen.findByTestId('data-table-notes'))
    expect(await screen.findByTestId('data-rows-table')).toBeInTheDocument()

    // 空表：换一张确定没有行的表
    rowsMode = 'empty'
    fireEvent.click(screen.getByTestId('data-table-tags'))
    expect(await screen.findByTestId('data-rows-empty')).toHaveTextContent('这张表当前没有行')
    expect(screen.queryByTestId('data-rows-error')).toBeNull()

    rowsMode = 'missing'
    fireEvent.click(screen.getByTestId('data-table-notes'))
    expect(await screen.findByTestId('data-rows-error')).toHaveTextContent('这个应用还没有数据库')
    expect(screen.queryByTestId('data-rows-empty')).toBeNull()
  })
})

describe('数据面 · 行浏览与分页（服务端分页）', () => {
  it('选表 ⇒ 请求带 table/limit/offset（offset=0），渲染列/行与分页摘要', async () => {
    mount()
    expand()
    fireEvent.click(await screen.findByTestId('data-table-notes'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(rowsPath('share-note', { table: 'notes', limit: 50, offset: 0 }))
    })
    const table = await screen.findByTestId('data-rows-table')
    // 敏感列 `***` 与服务端回报的 mask 保持一致（页面不自己打码、也不透出原值）
    expect(table).toHaveTextContent('***')
    expect(table).not.toHaveTextContent('alice@example.com')
    // NULL 与空串分开展示
    expect(table).toHaveTextContent('NULL')
    expect(screen.getByTestId('data-rows-page')).toHaveTextContent('第 1–2 行 / 共 3 行')
    expect(screen.getByTestId('data-rows-masked')).toHaveTextContent('owner_email')
  })

  it('下一页把 offset 推到 50；没有更多行时下一页禁用', async () => {
    mount()
    expand()
    fireEvent.click(await screen.findByTestId('data-table-notes'))
    const next = await screen.findByTestId('data-next')
    expect(screen.getByTestId('data-prev')).toBeDisabled()
    fireEvent.click(next)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(rowsPath('share-note', { table: 'notes', limit: 50, offset: 50 }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('data-next')).toBeDisabled()
    })
    expect(screen.getByTestId('data-rows-page')).toHaveTextContent('第 51–51 行 / 共 3 行')
  })

  it('值超过单值上限 ⇒ 提示被截断的个数（不静默省略）', async () => {
    const original = mockRequest.getMockImplementation()!
    mockRequest.mockImplementation(async (path: string) => {
      const out = await original(path)
      if (String(path).includes('/rows?')) {
        return { rows: { ...ROWS_PAGE_1.rows, truncated_values: 2, value_max_bytes: 4096 } }
      }
      return out
    })
    mount()
    expand()
    fireEvent.click(await screen.findByTestId('data-table-notes'))
    expect(await screen.findByTestId('data-rows-truncated')).toHaveTextContent('有 2 个值超过单值上限')
  })
})

describe('数据面 · 原值（unmask）显式二次确认', () => {
  it('点「显示原值」只弹确认框：**不发** unmask 请求；确认后才发并显示「当前是原值」', async () => {
    mount()
    expand()
    fireEvent.click(await screen.findByTestId('data-table-notes'))
    await screen.findByTestId('data-rows-table')

    fireEvent.click(screen.getByTestId('data-unmask'))
    const dialog = await screen.findByTestId('data-unmask-dialog')
    expect(dialog).toHaveTextContent(UNMASK_CONFIRM_TEXT)
    expect(dialog).toHaveTextContent('wasm_app_rows_view_unmasked')
    // 确认之前：一次 unmask 请求都不许发（默认脱敏是服务端与本页的共同默认）
    expect(mockRequest.mock.calls.map(([p]) => String(p)).filter((p) => p.includes('unmask=1'))).toEqual([])

    fireEvent.click(screen.getByTestId('data-unmask-confirm'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        rowsPath('share-note', { table: 'notes', limit: 50, offset: 0, unmask: true }),
      )
    })
    expect(await screen.findByTestId('data-unmasked-badge')).toHaveTextContent('当前是原值')
    // 原值到了页面上（这是**管理员显式确认过**的那个动作的结果）
    await waitFor(() => {
      expect(screen.getByTestId('data-rows-table')).toHaveTextContent('alice@example.com')
    })
  })

  it('取消确认 ⇒ 保持脱敏、不发 unmask；「恢复脱敏」再取一次不带 unmask', async () => {
    mount()
    expand()
    fireEvent.click(await screen.findByTestId('data-table-notes'))
    await screen.findByTestId('data-rows-table')

    fireEvent.click(screen.getByTestId('data-unmask'))
    await screen.findByTestId('data-unmask-dialog')
    fireEvent.click(screen.getByRole('button', { name: '取消（保持脱敏）' }))
    expect(mockRequest.mock.calls.map(([p]) => String(p)).filter((p) => p.includes('unmask=1'))).toEqual([])
    expect(screen.queryByTestId('data-unmasked-badge')).toBeNull()

    // 走一遍完整的 unmask → remask，断言 remask 请求不带 unmask
    fireEvent.click(screen.getByTestId('data-unmask'))
    fireEvent.click(await screen.findByTestId('data-unmask-confirm'))
    await screen.findByTestId('data-unmasked-badge')
    mockRequest.mockClear()
    fireEvent.click(screen.getByTestId('data-remask'))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(rowsPath('share-note', { table: 'notes', limit: 50, offset: 0 }))
    })
    const calls = mockRequest.mock.calls.map(([p]) => String(p))
    expect(calls.some((p) => p.includes('unmask=1'))).toBe(false)
  })
})

describe('数据面 · 不该发请求的两种情形', () => {
  it('已清除（purged）应用：明说数据已删，且**不发**任何数据面请求', async () => {
    mount({ purged: true })
    expect(screen.getByTestId('data-purged')).toHaveTextContent('数据已清除')
    // 展开也不读（目录已被真删，读只会得到一个空库的假空态）
    fireEvent.click(screen.getByTestId('data-block-toggle'))
    expect(dataCalls()).toEqual([])
    expect(screen.queryByTestId('data-schema-empty')).toBeNull()
  })

  it('没有 capability:read：明说不可用，且不发注定 403 的请求', async () => {
    mount({ canRead: false })
    expect(screen.getByTestId('data-no-permission')).toHaveTextContent('capability:read')
    fireEvent.click(screen.getByTestId('data-block-toggle'))
    expect(dataCalls()).toEqual([])
  })

  it('常驻的审计提示说明"每次读取都留痕，且不记行内容"', () => {
    mount()
    expect(screen.getByText(DATA_AUDIT_NOTE)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// 纯函数口径（路径 / 形状 / 单元格 / 分页摘要）
// ---------------------------------------------------------------------------

describe('数据面契约（纯函数）', () => {
  it('路径：表名与 app_id 都进 encodeURIComponent；unmask 只在显式为 true 时出现', () => {
    expect(schemaPath('share-note')).toBe('/api/server/admin/wasm-apps/share-note/schema')
    expect(rowsPath('a/b', { table: 'x y', limit: 10, offset: 20 })).toBe(
      '/api/server/admin/wasm-apps/a%2Fb/rows?table=x%20y&limit=10&offset=20',
    )
    expect(rowsPath('app', { table: 't' })).not.toContain('unmask')
    expect(rowsPath('app', { table: 't', unmask: true })).toContain('unmask=1')
  })

  it('schema 解析：缺 tables 数组 ⇒ ok:false（不能读成"没有表"）', () => {
    expect(parseSchema({}).ok).toBe(false)
    expect(parseSchema({ schema: {} }).ok).toBe(false)
    const ok = parseSchema(SCHEMA)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.value.initialized).toBe(true)
      expect(ok.value.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'body', 'owner_email'])
      expect(ok.value.tables[0]!.columns[0]!.pk).toBe(true)
    }
  })

  it('rows 解析：缺 rows/columns 数组 ⇒ ok:false；正常响应读到 unmasked/masked_columns/has_more', () => {
    expect(parseRows({ rows: {} }).ok).toBe(false)
    expect(parseRows({ rows: { rows: [], columns: undefined } }).ok).toBe(false)
    const ok = parseRows(ROWS_PAGE_1)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.value.maskedColumns).toEqual(['owner_email'])
      expect(ok.value.hasMore).toBe(true)
      expect(ok.value.totalRows).toBe(3)
      expect(ok.value.offset).toBe(0)
    }
  })

  it('单元格文本：null ⇒ NULL（不是空串），空串保持空串，对象走 JSON', () => {
    expect(cellText(null)).toBe('NULL')
    expect(cellText(undefined)).toBe('NULL')
    expect(cellText('')).toBe('')
    expect(cellText(0)).toBe('0')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
  })

  it('分页摘要按服务端 offset/limit/returned 算（不是本页下标）', async () => {
    const ok = parseRows(ROWS_PAGE_2)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(pageSummary(ok.value)).toBe('第 51–51 行 / 共 3 行（limit=50，offset=50）')
    const empty = parseRows({ rows: { ...ROWS_PAGE_1.rows, rows: [], returned: 0 } })
    if (empty.ok) expect(pageSummary(empty.value)).toContain('第 0–0 行')
  })
})
