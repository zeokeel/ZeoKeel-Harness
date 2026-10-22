/**
 * 作者生命周期编排的**纯逻辑**用例（`app-lifecycle.ts`）。
 *
 * 行为级用例在 `app-center-mount.spec.tsx`（真挂载 + 真 fetch 假响应）；这里只钉三件
 * 纯函数层的事，因为它们各自是一条**契约**，而不是某个界面的细节：
 *
 *  1. **路径**：app_id 走 `encodeURIComponent`（它是路径段，不是可信输入），后缀与宿主
 *     路由逐字一致（宿主：`packages/host/enterprise/src/wasm-apps.ts` 的 prefix handler；
 *     服务端：`server/internal/wasmapp/api/release.go` 的 `publishTarget` **以后缀为准**）；
 *  2. **只有服务端说了才算**：`app.enabled` / `app.deleted` 缺席或类型不对 ⇒ 结构化失败，
 *     **绝不**回落成"我请求的那个值"（那就是乐观更新，本模块存在的理由就是防它）；
 *  3. **失败不抛**：传输层/信封/非 JSON 一律回落成 `PublishFailure`。
 *
 * ---- 变异验证 ----
 *   - `parseSetPublishedOutcome` 里 `enabled` 缺席时回落成 `true`（或直接返回请求值）⇒
 *     「缺席即形状错误」红；
 *   - `parseDeleteOutcome` 不查 `deleted` ⇒ 「未确认 deleted 即失败」红；
 *   - `setPublishedPath` 去掉 `encodeURIComponent` ⇒ 路径编码那条红。
 */
import { describe, expect, it } from 'vitest'
import {
  deleteApp,
  deletePath,
  deployVersion,
  deploymentsPath,
  diagnosticsPath,
  fetchDeployments,
  fetchDiagnostics,
  parseDeleteOutcome,
  parseDeployOutcome,
  parseDeploymentsOutcome,
  parseDiagnosticsOutcome,
  parseRestoreOutcome,
  parseRowsOutcome,
  parseSchemaOutcome,
  parseSetPublishedOutcome,
  rowsPath,
  schemaPath,
  restoreApp,
  restorePath,
  setAppPublished,
  setPublishedPath,
  withdrawRelease,
  withdrawReleasePath,
  parseWithdrawOutcome,
} from './app-lifecycle.ts'

describe('本机路径：app_id 是路径段（必须编码），后缀与服务端判据一致', () => {
  it('上下架路径的后缀是 publish / unpublish（服务端 publishTarget 只认后缀）', () => {
    expect(setPublishedPath('roster', true)).toBe('/api/zeokeel/apps/wasm/roster/publish')
    expect(setPublishedPath('roster', false)).toBe('/api/zeokeel/apps/wasm/roster/unpublish')
    expect(deletePath('roster')).toBe('/api/zeokeel/apps/wasm/roster')
    expect(diagnosticsPath('roster')).toBe('/api/zeokeel/apps/wasm/roster/diagnostics')
  })

  it('app_id 里的非安全字符被编码（不制造第二个路径段）', () => {
    // 服务端的 app_id 形态本就只允许 [a-z0-9-]，但客户端不能依赖这一点：
    // 一个含 `/` 或 `?` 的值必须变成一个路径段，而不是改变路由。
    const path = setPublishedPath('a/b?c#d', false)
    expect(path).toBe('/api/zeokeel/apps/wasm/a%2Fb%3Fc%23d/unpublish')
    expect(path.split('/').at(-1)).toBe('unpublish')
  })
})

describe('上下架：行状态只能来自服务端的 app.enabled', () => {
  it('读服务端返回值（不是请求值）', () => {
    const outcome = parseSetPublishedOutcome('roster', {
      app: { app_id: 'roster', enabled: false, changed: true },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.enabled).toBe(false)
    expect(outcome.changed).toBe(true)
    // 2026-09-19（冻结契约 §4.5）：上下架响应不再有 entry_url，返回体只有
    // app_id/enabled/changed —— 多带的字段也不会被客户端接住。
    expect(Object.keys(outcome).sort()).toEqual(['appId', 'changed', 'enabled', 'ok'])
    expect(outcome).not.toHaveProperty('entryURL')
  })

  it('服务端仍带 entry_url 时客户端也不认识它（迁移期不得复活入口链接）', () => {
    const outcome = parseSetPublishedOutcome('roster', {
      app: { app_id: 'roster', enabled: true, changed: false, entry_url: 'https://roster.apps.example.com/' },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(Object.keys(outcome).sort()).toEqual(['appId', 'changed', 'enabled', 'ok'])
    expect(JSON.stringify(outcome)).not.toContain('entry')
    expect(JSON.stringify(outcome)).not.toContain('apps.example.com')
  })

  it('`app.enabled` 缺席 / 类型不对 ⇒ 形状错误（不回落成"我请求的值"）', () => {
    for (const payload of [{ app: { app_id: 'roster', changed: true } }, { app: { app_id: 'roster', enabled: 'false' } }, {}]) {
      const outcome = parseSetPublishedOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    }
  })

  it('回显的 app_id 与请求不一致 ⇒ 形状错误（防止把别的应用的状态画到这一行）', () => {
    const outcome = parseSetPublishedOutcome('roster', { app: { app_id: 'other', enabled: true, changed: true } })
    expect(outcome.ok).toBe(false)
  })

  it('请求失败时抛出的异常被收成结构化失败（永不抛）', async () => {
    const result = await setAppPublished('roster', false, {
      fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('NETWORK_ERROR')
    expect(result.transport).toBe(true)
  })

  it('请求本身不带 body（服务端以后缀判定，不给它第二条判据）', async () => {
    const seen: Array<{ url: string, init: RequestInit }> = []
    const result = await setAppPublished('roster', false, {
      fetch: (async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({ app: { app_id: 'roster', enabled: false, changed: true } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(seen[0]!.url).toBe('/api/zeokeel/apps/wasm/roster/unpublish')
    expect(seen[0]!.init.method).toBe('POST')
    expect(seen[0]!.init.body).toBeUndefined()
  })
})

describe('删除：只有服务端确认 deleted 才算删掉', () => {
  it('读保留期与服务端说明（没给就是 undefined，不编造 90）', () => {
    const outcome = parseDeleteOutcome('roster', {
      app: { app_id: 'roster', deleted: true },
      retention_days: 90,
      note: '“真删”由后台任务执行（当前未实现）',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.deleted).toBe(true)
    expect(outcome.retentionDays).toBe(90)
    expect(outcome.note).toContain('后台任务')

    const bare = parseDeleteOutcome('roster', { app: { app_id: 'roster', deleted: true } })
    expect(bare.ok).toBe(true)
    if (!bare.ok) throw new Error('unreachable')
    expect(bare.retentionDays).toBeUndefined()
    expect(bare.note).toBe('')
  })

  it('没有 deleted:true ⇒ 形状错误（行不许消失）', () => {
    for (const payload of [{ app: { app_id: 'roster' } }, { app: { deleted: false } }, {}]) {
      const outcome = parseDeleteOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
    }
  })

  it('DELETE 方法走到位（服务端软删的唯一动词）', async () => {
    const seen: RequestInit[] = []
    await deleteApp('roster', {
      fetch: (async (_url: unknown, init?: RequestInit) => {
        seen.push(init ?? {})
        return new Response(JSON.stringify({ app: { app_id: 'roster', deleted: true } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    expect(seen[0]!.method).toBe('DELETE')
  })
})

describe('诊断：只读投影（reason_code / hints / 计数）', () => {
  const REPORT = {
    diagnostics: {
      app_id: 'roster',
      app_enabled: false,
      app_frozen: false,
      app_deleted: false,
      window_minutes: 1440,
      summary: { total: 12, failed: 3 },
      failures: [
        { created_at: '2026-09-19T01:00:00Z', outcome: 'error', reason_code: 'COMPILE_TIMEOUT', guest_exit_code: 1, stderr_tail: 'x' },
        { created_at: '2026-09-19T02:00:00Z', outcome: 'killed', reason_code: 'MEMORY_LIMIT', guest_exit_code: 137 },
      ],
      hints: ['把单次处理拆小', '把单次处理拆小', ''],
    },
  }

  it('映射服务端字段（计数、reason_code、hints 去空）', () => {
    const report = parseDiagnosticsOutcome('roster', REPORT)
    expect(report.ok).toBe(true)
    if (!report.ok) throw new Error('unreachable')
    expect(report.enabled).toBe(false)
    expect(report.windowMinutes).toBe(1440)
    expect(report.total).toBe(12)
    expect(report.failed).toBe(3)
    expect(report.failures.map(row => row.reasonCode)).toEqual(['COMPILE_TIMEOUT', 'MEMORY_LIMIT'])
    expect(report.failures[0]!.guestExitCode).toBe(1)
    expect(report.hints).toEqual(['把单次处理拆小', '把单次处理拆小'])
  })

  it('缺字段回落成空/0（不编造"没有失败"以外的结论，也不抛）', () => {
    const report = parseDiagnosticsOutcome('roster', { diagnostics: { app_id: 'roster' } })
    expect(report.ok).toBe(true)
    if (!report.ok) throw new Error('unreachable')
    expect(report.failures).toEqual([])
    expect(report.hints).toEqual([])
    expect(report.total).toBe(0)
    expect(report.failed).toBe(0)
  })

  it('没有 diagnostics 信封 ⇒ 形状错误（不把 404 页面渲染成"0 失败"）', () => {
    for (const payload of [{}, { diagnostics: {} }, null]) {
      const outcome = parseDiagnosticsOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
    }
  })

  it('服务端拒绝时信封原样带出（code/message/hints 不丢）', async () => {
    const result = await fetchDiagnostics('roster', {
      fetch: (async () => new Response(JSON.stringify({
        error: { code: 'NOT_FOUND', message: '应用不存在', hints: ['只有发布者本人能管理该应用'] },
      }), { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('NOT_FOUND')
    expect(result.message).toBe('应用不存在')
    expect(result.hints).toEqual(['只有发布者本人能管理该应用'])
  })
})

describe('作者数据面：路径与形状守卫（2026-09-21 新增）', () => {
  it('自省/数据路径与服务端申报逐字一致（后缀是唯一路由判据）', () => {
    expect(schemaPath('roster')).toBe('/api/zeokeel/apps/wasm/roster/schema')
    expect(rowsPath('roster', { table: 'notes' })).toBe('/api/zeokeel/apps/wasm/roster/rows?table=notes')
  })

  it('数据路径把 table 放进查询串并编码（表名是用户输入，不是路径段）', () => {
    const path = rowsPath('roster', { table: 'a b&c', limit: 50, offset: 100, unmask: true })
    // URLSearchParams 会把空格编成 `+`、`&` 编成 `%26`：两者都不改变查询串结构。
    expect(path).toContain('table=a+b%26c')
    expect(path).toContain('limit=50')
    expect(path).toContain('offset=100')
    expect(path).toContain('unmask=1')
    expect(path.split('?')[0]).toBe('/api/zeokeel/apps/wasm/roster/rows')
  })

  it('unmask 缺省不发送（服务端按"未请求原值"处理，且这是审计分叉的唯一判据）', () => {
    expect(rowsPath('roster', { table: 'notes' })).not.toContain('unmask')
    expect(rowsPath('roster', { table: 'notes', unmask: false })).not.toContain('unmask')
  })

  it('schema 形状不符 ⇒ 结构化失败，**不回落成空表清单**', () => {
    // 回落成 `{tables: []}` 会把"服务端改了字段名/返回了 HTML/响应被截断"说成
    // "应用没有表" —— 作者会据此改代码，方向完全错（2026-09-21 审计 P2-2）。
    // 注意：`app_id` 在但 `tables` **缺失**也算形状不符；只有显式空数组才是"确实没有表"。
    for (const payload of [{}, { schema: {} }, null, { schema: { app_id: 'roster' } }, { schema: { app_id: 'roster', tables: 'nope' } }]) {
      expect(parseSchemaOutcome('roster', payload).ok).toBe(false)
    }
    // 正对照：显式空数组是"确实没有表"，必须通过。
    const empty = parseSchemaOutcome('roster', { schema: { app_id: 'roster', tables: [] } })
    expect(empty.ok).toBe(true)
  })

  it('rows 形状不符 ⇒ 结构化失败，**不回落成 0 行**', () => {
    // "0 行"会让作者以为"数据没写进去" —— 方向完全错。`rows`/`columns` 缺失或非数组都算。
    for (const payload of [
      {}, { rows: {} }, null,
      { rows: { table: 'notes' } },                                  // 缺 app_id
      { rows: { app_id: 'roster', table: 'notes' } },                // 缺 rows/columns
      { rows: { app_id: 'roster', table: 'notes', rows: {}, columns: [] } }, // rows 非数组
      { rows: { app_id: 'roster', table: 'notes', rows: [], columns: 'x' } }, // columns 非数组
    ]) {
      expect(parseRowsOutcome('roster', payload).ok).toBe(false)
    }
    // 正对照：显式空 rows 数组是"这张表确实没有行"，必须通过。
    const empty = parseRowsOutcome('roster', { rows: { app_id: 'roster', table: 'notes', rows: [], columns: [] } })
    expect(empty.ok).toBe(true)
  })

  it('rows 正常解析：列敏感标记、行值、分页与截断元数据都读服务端的', () => {
    const outcome = parseRowsOutcome('roster', {
      rows: {
        app_id: 'roster',
        table: 'notes',
        columns: [{ name: 'title', type: 'TEXT', sensitive: false }, { name: 'api_token', type: 'TEXT', sensitive: true }],
        rows: [['hello', '***'], ['world', null]],
        limit: 50,
        offset: 0,
        returned: 2,
        total_rows: 3,
        has_more: true,
        truncated: false,
        truncated_values: 1,
        unmasked: false,
        masked_columns: ['api_token'],
        value_max_bytes: 4096,
      },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.table).toBe('notes')
    expect(outcome.columns[1]?.sensitive).toBe(true)
    expect(outcome.rows[0]?.[1]).toBe('***')
    expect(outcome.rows[1]?.[1]).toBeNull()
    expect(outcome.totalRows).toBe(3)
    expect(outcome.hasMore).toBe(true)
    expect(outcome.truncatedValues).toBe(1)
    expect(outcome.maskedColumns).toEqual(['api_token'])
  })
})

/**
 * 生命周期 UI 的纯逻辑（2026-10-22 重设计 §6.1：部署历史 / 部署（回滚）/ 撤回）。
 *
 * 三条判据与既有模块同一口径：
 *  1. **路径**：`deployments` 后缀与宿主 `wasm-apps.ts` 的分支逐字一致；撤回路径里的
 *     版本号必须编码（它是路径段，来自不可信输入）；
 *  2. **只有服务端说了才算**：`changed` / `status=withdrawn` 缺席或类型不对 ⇒ 结构化
 *     失败，绝不回落成"我请求的就是事实"；
 *  3. **形状漂移不伪装成空**：`deployments` 缺席/非数组 ⇒ 形状错误（不是"没有部署"）。
 */
describe('部署历史 / 回滚 / 撤回（设计 §6.1/§8）', () => {
  /** 记录请求的假 fetch（回一个固定 JSON）。 */
  function stub(token: string | null): { calls: Array<{ url: string, method: string, body: string }>, fetch: typeof fetch } {
    const calls: Array<{ url: string, method: string, body: string }> = []
    const impl = (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : '',
      })
      return new Response(token ?? '{}', { status: token === null ? 404 : 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { calls, fetch: impl }
  }

  it('路径：deployments 后缀与宿主一致；撤回路径里的版本号被编码', () => {
    // 读面带「最近 N 条」（设计 §8），写面不带（查询串对 POST 无意义）。
    expect(deploymentsPath('roster')).toBe('/api/zeokeel/apps/wasm/roster/deployments?limit=20')
    expect(deploymentsPath('roster', 0)).toBe('/api/zeokeel/apps/wasm/roster/deployments')
    expect(withdrawReleasePath('roster', '1.2.0')).toBe('/api/zeokeel/apps/wasm/roster/releases/1.2.0/withdraw')
    // 版本号是路径段：`/` 之类的字符不得制造新的路径段。
    expect(withdrawReleasePath('roster', '1.2.0/../x')).toBe('/api/zeokeel/apps/wasm/roster/releases/1.2.0%2F..%2Fx/withdraw')
  })

  it('部署历史：解析行、current 标记（行上的 current 或顶层 current_version 两处来源）', () => {
    const report = parseDeploymentsOutcome('roster', {
      app_id: 'roster',
      current_version: '1.0.0',
      deployments: [
        { id: 7, version: '1.0.0', kind: 'publish', actor: 'carol', actor_role: 'owner', message: '首版', created_at: '2026-09-18T10:00:00Z' },
        { id: 6, version: '1.2.0', kind: 'review', actor: 'admin', actor_role: 'admin_session', message: '', created_at: '2026-09-17T10:00:00Z', current: true },
      ],
    })
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.currentVersion).toBe('1.0.0')
    expect(report.deployments.map(row => row.version)).toEqual(['1.0.0', '1.2.0'])
    // 两处来源合流：顶层 current_version == 行版本；行上显式 current 也认。
    expect(report.deployments[0]!.current).toBe(true)
    expect(report.deployments[1]!.current).toBe(true)
    expect(report.deployments[0]!.actorRole).toBe('owner')
  })

  it('部署历史：deployments 缺席/非数组 ⇒ 形状错误（不是"没有部署记录"）', () => {
    for (const payload of [{ app_id: 'roster' }, { deployments: 'nope' }, null]) {
      const outcome = parseDeploymentsOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    }
  })

  it('部署（回滚）：POST {version}；changed 必须是布尔值（缺席即形状错误）', async () => {
    const ok = stub(JSON.stringify({ deployment: { version: '1.2.0', kind: 'rollback' }, changed: false, note: '已经是这一版' }))
    const result = await deployVersion('roster', '1.2.0', { fetch: ok.fetch })
    expect(ok.calls).toEqual([{ url: deploymentsPath('roster', 0), method: 'POST', body: JSON.stringify({ version: '1.2.0' }) }])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.changed).toBe(false)
      expect(result.version).toBe('1.2.0')
      expect(result.note).toBe('已经是这一版')
    }

    const missing = stub(JSON.stringify({ deployment: { version: '1.2.0' } }))
    const refused = await deployVersion('roster', '1.2.0', { fetch: missing.fetch })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('UNEXPECTED_RESPONSE')
  })

  it('部署失败（服务端 409 RELEASE_NOT_DEPLOYABLE）⇒ 信封逐字段回来', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: unknown) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ error: { code: 'RELEASE_NOT_DEPLOYABLE', message: 'only approved releases can be deployed', hints: ['先审批'] } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const result = await deployVersion('roster', '1.1.0', { fetch: fetchImpl })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.code).toBe('RELEASE_NOT_DEPLOYABLE')
    expect(result.hints).toEqual(['先审批'])
  })

  it('撤回：POST …/releases/<v>/withdraw；status 必须是 withdrawn', async () => {
    // 服务端实际形状（`api/deployments.go` 的 `withdrawForApp`）：顶层 version/status。
    const ok = stub(JSON.stringify({ app_id: 'roster', version: '1.1.0', status: 'withdrawn', changed: true, note: '版本号永久占用' }))
    const result = await withdrawRelease('roster', '1.1.0', { fetch: ok.fetch })
    expect(ok.calls).toEqual([{ url: withdrawReleasePath('roster', '1.1.0'), method: 'POST', body: '' }])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe('withdrawn')
      expect(result.note).toBe('版本号永久占用')
    }

    // 包装形状（`{release:{…}}`）也认 —— 两条面的将来收敛不需要客户端跟着改。
    const wrapped = parseWithdrawOutcome('roster', '1.1.0', { release: { version: '1.1.0', status: 'withdrawn' } })
    expect(wrapped.ok).toBe(true)

    // 形状漂移：status 不是 withdrawn ⇒ 失败（不能说"撤回了"）。
    const wrong = stub(JSON.stringify({ release: { version: '1.1.0', status: 'pending' } }))
    const refused = await withdrawRelease('roster', '1.1.0', { fetch: wrong.fetch })
    expect(refused.ok).toBe(false)
    // 非 pending ⇒ 服务端 409 `RELEASE_NOT_PENDING`，原样透传。
    const notPending = parseWithdrawOutcome('roster', '1.1.0', { release: { version: '1.1.0', status: 'approved' } })
    expect(notPending.ok).toBe(false)
  })

  it('fetchDeployments：GET 本机路由（带 limit 查询串），失败不抛', async () => {
    const ok = stub(JSON.stringify({ app_id: 'roster', deployments: [] }))
    const report = await fetchDeployments('roster', { fetch: ok.fetch })
    expect(ok.calls[0]).toMatchObject({ url: deploymentsPath('roster'), method: 'GET' })
    expect(report.ok).toBe(true)

    const broken = stub(null)
    const refused = await fetchDeployments('roster', { fetch: broken.fetch })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.status).toBe(404)
  })

  it('parseDeployOutcome / parseDeploymentsOutcome 不读取客户端请求值冒充服务端结论', () => {
    // 部署成功但服务端没回显版本号 ⇒ 用请求值（两者在成功路径上相等），但 `changed`
    // 仍必须由服务端给出（这里用 changed:true 才能通过）。
    const ok = parseDeployOutcome('roster', '1.2.0', { deployment: {}, changed: true })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.version).toBe('1.2.0')
  })
})

/**
 * 恢复软删应用（设计 §5.5；反证审计 R-05）。
 *
 * 这一组只钉**协议半边**：作者面目录不下发软删行（`api/read.go` 的 catalog 走
 * `ListWasmApps(..., WasmAppFilter{})`，默认 `deleted_at IS NULL`），所以今天没有
 * 可点入口 —— 伪造一个列表里不存在的按钮只会变成"点了必然 404"的死按钮。
 * `restoreApp` 的作用是：等目录开始下发已删行时，详情页只需要加一个按钮。
 */
describe('恢复软删（R-05）：路径 / 请求形态 / changed 判据', () => {
  it('路径：/:app_id/restore（与宿主 restore 分支逐字一致，app_id 编码）', () => {
    expect(restorePath('roster')).toBe('/api/zeokeel/apps/wasm/roster/restore')
    expect(restorePath('a b')).toBe('/api/zeokeel/apps/wasm/a%20b/restore')
  })

  it('POST 且不带 body（服务端不读 body，身份由 Bearer + 路径决定）', async () => {
    const seen: Array<{ url: string, init: RequestInit }> = []
    const result = await restoreApp('roster', {
      fetch: (async (url: unknown, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({
          app: { app_id: 'roster', deleted: false, enabled: false },
          changed: true,
          retention_cleared: true,
          snapshot_cleanup_error: '',
          note: '已恢复：应用回到下架状态（不自动上架）',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(seen[0]!.url).toBe('/api/zeokeel/apps/wasm/roster/restore')
    expect(seen[0]!.init.method).toBe('POST')
    expect(seen[0]!.init.body).toBeUndefined()
  })

  it('真的恢复（changed:true）⇒ changed/enabled/note 全部来自服务端', () => {
    const outcome = parseRestoreOutcome('roster', {
      app: { app_id: 'roster', deleted: false, enabled: false },
      changed: true,
      retention_cleared: true,
      snapshot_cleanup_error: 'permission denied',
      note: '已恢复',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    // 恢复**不自动上架**（设计 §5.5）：enabled 是 false，界面不能显示"已上线"。
    expect(outcome.enabled).toBe(false)
    expect(outcome.changed).toBe(true)
    expect(outcome.retentionCleared).toBe(true)
    expect(outcome.snapshotCleanupError).toBe('permission denied')
    expect(outcome.note).toBe('已恢复')
  })

  it('幂等恢复（changed:false）⇒ changed=false（宿主据此**不**清存储）', () => {
    const outcome = parseRestoreOutcome('roster', {
      app: { app_id: 'roster', deleted: false, enabled: true },
      changed: false,
      note: '应用未处于删除状态（幂等：未写审计）',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.changed).toBe(false)
    expect(outcome.enabled).toBe(true)
    expect(outcome.retentionCleared).toBe(false)
  })

  it('changed 缺席 / 非布尔 ⇒ 形状错误（宁可不猜：它决定要不要删本地数据）', () => {
    for (const payload of [
      { app: { app_id: 'roster', deleted: false } },
      { app: { app_id: 'roster' }, changed: 'true' },
      {},
    ]) {
      const outcome = parseRestoreOutcome('roster', payload)
      expect(outcome.ok, JSON.stringify(payload)).toBe(false)
      if (outcome.ok) throw new Error('unreachable')
      expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    }
  })

  it('恢复成功的响应里 deleted:true 是形状矛盾；app_id 回显不一致也是', () => {
    expect(parseRestoreOutcome('roster', {
      app: { app_id: 'roster', deleted: true }, changed: true,
    }).ok).toBe(false)
    expect(parseRestoreOutcome('roster', {
      app: { app_id: 'other', deleted: false }, changed: true,
    }).ok).toBe(false)
  })
})
