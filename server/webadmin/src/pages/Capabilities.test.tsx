import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { request } from '../api'
import { setCurrentAdmin } from '../lib/rbac'
import Capabilities, {
  DELISTED_PENDING_HINT,
  DELISTED_PENDING_MARKET_HINT,
  MARKET_PENDING_HINT,
  previewKeyOf,
} from './Capabilities'

// 2026-09 恢复统一审批:能力中心承载共享技能+共享 Agent 审核(技能/智能体
// 类型可筛选;approve/reject/delete 走服务端下发的 base_path = /api/server/admin/*)。
const SKILL_ROWS = [
  {
    kind: 'skill' as const, name: 'codeql', version: '1.0.0', display_name: 'CodeQL 审计',
    description: 'find vulns', author: 'bob', owner: 'alice', status: 'pending' as const, reason: '',
    quality: '' as const, downloads: 3, calls: 5, created_at: '2026-08-25T10:00:00Z',
    base_path: '/api/server/admin/shared-skills/codeql/1.0.0',
    grants_base: '/api/server/admin/shared-skills/codeql',
    preview_path: '/api/server/admin/shared-skills/codeql/1.0.0/preview',
  },
]
const AGENT_ROWS = [
  {
    kind: 'agent' as const, name: 'ppt-gen', version: '1.0.0', display_name: 'PPT 生成',
    description: 'make ppt', author: 'bob', owner: 'alice', status: 'pending' as const, reason: '',
    quality: '' as const, downloads: 1, created_at: '2026-08-25T10:00:00Z',
    base_path: '/api/server/admin/agent-presets/ppt-gen/1.0.0',
    grants_base: '/api/server/admin/agent-presets/ppt-gen',
    preview_path: '/api/server/admin/agent-presets/ppt-gen/1.0.0/preview',
  },
]

const mockRequest = vi.mocked(request)

// 归属转移弹窗(2026-09-04 起)从用户列表搜索选择,需 mock 用户列表端点。
const USERS = [
  { username: 'alice', display_name: 'Alice' },
  { username: 'bob', display_name: 'Bob' },
  { username: 'carol', display_name: 'Carol' },
]

beforeEach(() => {
  // F-49：审批页的上下架现在有确认弹层（与技能/智能体页同一口径）。
  window.confirm = vi.fn(() => true) as any
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/server/admin/users')) return { users: USERS, total: USERS.length }
    if (path === '/api/server/admin/capabilities/approvals?status=pending') return { approvals: [...SKILL_ROWS, ...AGENT_ROWS] }
    if (path === '/api/server/admin/capabilities/approvals?status=pending&type=skill') return { approvals: SKILL_ROWS }
    if (path === '/api/server/admin/capabilities/approvals?status=pending&type=agent') return { approvals: AGENT_ROWS }
    if (path === '/api/server/admin/capabilities/approvals?status=all') return { approvals: [...SKILL_ROWS, ...AGENT_ROWS] }
    if (path === '/api/server/admin/capabilities/approvals?status=all&type=skill') return { approvals: SKILL_ROWS }
    if (path === '/api/server/admin/departments') return { departments: [] }
    // 锁定管理面板(2026-09-01 D4)与审批队列同页,mock 需覆盖其清单端点。
    if (path === '/api/server/admin/capability-locks') return { locks: [] }
    if (path.endsWith('/preview')) {
      return { files: ['SKILL.md', 'scripts/run.sh'], skill_md: '# codeql\n', composition: '---\nid: ppt-gen\n---\n' } as any
    }
    return {}
  })
})

// 权限快照是模块级状态：本文件新增的权限门用例会显式 setCurrentAdmin，
// 必须复位，否则会污染同文件后续用例（照 usage-center.test.tsx 的口径）。
afterEach(() => setCurrentAdmin(null))

describe('Capabilities 能力中心(统一审批)', () => {
  it('默认请求 pending 全类型并渲染技能+智能体', async () => {
    render(<Capabilities />)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/capabilities/approvals?status=pending')
    })
    expect(await screen.findByText('CodeQL 审计')).toBeInTheDocument()
    expect(screen.getByText('PPT 生成')).toBeInTheDocument()
  })

  it('类型筛选只请求对应 kind', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click(screen.getByRole('button', { name: '智能体' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/capabilities/approvals?status=pending&type=agent')
    })
  })

  it('点击技能通过调用共享技能 approve 端点', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const rows = screen.getAllByText('通过')
    fireEvent.click(rows[0]!)
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/shared-skills/codeql/1.0.0/approve', { method: 'POST' })
    })
  })

  it('拒绝必填理由', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const rejectBtns = screen.getAllByText('拒绝')
    fireEvent.click(rejectBtns[0]!)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    const confirmBtn = screen.getByRole('button', { name: '确认' })
    await waitFor(() => {
      expect(confirmBtn).toBeDisabled()
    })
  })

  it('技能预览主文件为 SKILL.md 且文件可点击查看内容', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const btns = await screen.findAllByTitle('查看内容预览')
    fireEvent.click(btns[0]!)
    // 主标题 h4 与文件清单 chip 均含 SKILL.md,用 heading role 精确匹配主标题。
    expect(await screen.findByRole('heading', { name: 'SKILL.md' })).toBeInTheDocument()
    const fileChip = await screen.findByText('scripts/run.sh')
    fireEvent.click(fileChip)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/shared-skills/codeql/1.0.0/file?path=scripts%2Frun.sh')
    })
  })

  it('智能体预览主文件为 agent.cordis.yml', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click(screen.getByRole('button', { name: '智能体' }))
    await waitFor(() => { expect(screen.queryByText('CodeQL 审计')).not.toBeInTheDocument() })
    const btns = await screen.findAllByTitle('查看内容预览')
    fireEvent.click(btns[0]!)
    expect(await screen.findByText('agent.cordis.yml')).toBeInTheDocument()
  })

  it('已通过行展示质量 Select 与授权按钮', async () => {
    const u = userEvent.setup()
    const approvedSkill = {
      ...SKILL_ROWS[0]!, status: 'approved' as const, quality: 'featured' as const,
    }
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=approved') return { approvals: [approvedSkill] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<Capabilities />)
    // 默认 tab=pending,切到「已通过」触发 status=approved 请求。
    await u.click(screen.getByRole('tab', { name: '已共享（0）' }))
    await screen.findByText('CodeQL 审计')
    // 质量 Select(已无「官方」选项——官方语义移交归属官方)
    const qualitySelect = screen.getAllByRole('combobox').find((el) => el.textContent?.includes('精选') || el.textContent?.includes('无'))
    expect(qualitySelect).toBeDefined()
    expect(screen.getByTitle('授权')).toBeInTheDocument()
  })

  it('已通过技能行：下架按钮 PUT enabled=false，已下架行显示徽标与上架按钮', async () => {
    const u = userEvent.setup()
    const live = { ...SKILL_ROWS[0]!, status: 'approved' as const, enabled: true }
    const off = { ...SKILL_ROWS[0]!, name: 'legacy', display_name: 'Legacy 审计', status: 'approved' as const, enabled: false,
      base_path: '/api/server/admin/shared-skills/legacy/1.0.0',
      grants_base: '/api/server/admin/shared-skills/legacy' }
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=approved') return { approvals: [live, off] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<Capabilities />)
    await u.click(screen.getByRole('tab', { name: '已共享（0）' }))
    await screen.findByText('CodeQL 审计')

    // 已上架 → 给「下架」；已下架 → 给「上架」+ 徽标。
    expect(screen.getByRole('button', { name: '下架' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新上架' })).toBeInTheDocument()
    expect(screen.getByText('已下架')).toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: '下架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/shared-skills/codeql/enabled',
        { method: 'PUT', body: JSON.stringify({ enabled: false }) },
      )
    })

    // 组件已修（isBusy 覆盖 'enabled'）：在途时该行按钮置灰，链跑完自动恢复。
    // 但**仍需"点到成功为止"**：负载下 waitFor 观察到 enabled 与 React 替换该 DOM
    // 节点可能相邻发生，单击会落在旧节点上（400ms 注入实测：单击版红、重试版绿，
    // 且 PUT 次数=1，不会重复提交）。
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: '重新上架' }))
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/shared-skills/legacy/enabled',
        { method: 'PUT', body: JSON.stringify({ enabled: true }) },
      )
    })
    // 重试式点击不得变成重复提交（成功一次即停）。
    expect(mockRequest.mock.calls.filter(([p, init]) => String(p).endsWith('/shared-skills/legacy/enabled')
      && (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(1)
  })

  it('上下架在途时行内按钮置灰（busy 键必须覆盖 enabled，审计 P2）', async () => {
    const u = userEvent.setup()
    const live = { ...SKILL_ROWS[0]!, status: 'approved' as const, enabled: true }
    const off = { ...SKILL_ROWS[0]!, name: 'legacy', display_name: 'Legacy 审计', status: 'approved' as const, enabled: false,
      base_path: '/api/server/admin/shared-skills/legacy/1.0.0',
      grants_base: '/api/server/admin/shared-skills/legacy' }
    let releasePut: () => void = () => {}
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/capabilities/approvals?status=approved') return { approvals: [live, off] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      if (init?.method === 'PUT') { await putGate; return {} }
      return {}
    })
    render(<Capabilities />)
    await u.click(screen.getByRole('tab', { name: '已共享（0）' }))
    await screen.findByText('CodeQL 审计')

    await u.click(screen.getByRole('button', { name: '下架' }))
    // PUT 在途：**该行**的按钮必须禁用（busy 是 per-row 的键；回退 isBusy 的
    // 'enabled' 分支即红）。另一行（legacy）不受影响，故这里查的是「下架」本身。
    await waitFor(() => expect(screen.getByRole('button', { name: '下架' })).toBeDisabled())
    releasePut()
    await waitFor(() => expect(screen.getByRole('button', { name: '下架' })).toBeEnabled())
  })

  it('已通过智能体行同样可上下架 → PUT agent-presets/:name/enabled(SG-4)', async () => {
    const u = userEvent.setup()
    const agent = { ...AGENT_ROWS[0]!, status: 'approved' as const, enabled: true }
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=approved') return { approvals: [agent] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<Capabilities />)
    await u.click(screen.getByRole('tab', { name: '已共享（0）' }))
    await screen.findByText('PPT 生成')
    // 修复前按钮被 `row.kind === 'skill'` 挡住:智能体行没有任何上下架入口。
    await u.click(screen.getByRole('button', { name: '下架' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/agent-presets/ppt-gen/enabled',
        { method: 'PUT', body: JSON.stringify({ enabled: false }) },
      )
    })
  })

  it('归属列显示 apps.owner(与上传者可不同)', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    expect(screen.getByRole('columnheader', { name: '归属（负责人）' })).toBeInTheDocument()
    // SKILL_ROWS/AGENT_ROWS:author=bob(上传者)、owner=alice(归属人)→ 两列都渲染。
    expect(screen.getAllByText('alice', { selector: 'td' }).length).toBeGreaterThan(0)
    expect(screen.getAllByText('bob', { selector: 'td' }).length).toBeGreaterThan(0)
  })

  it('转移归属:从用户列表搜索选择负责人 → PUT apps/:kind/:name/owner', async () => {
    const u = userEvent.setup()
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click((await screen.findAllByTitle('转移归属(负责人)'))[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('转移归属')
    // 打开候选列表 → 输入搜索(防抖后服务端 q= 搜索)
    fireEvent.click(screen.getByRole('combobox'))
    const input = await screen.findByLabelText('新归属人用户名')
    await u.type(input, 'carol')
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/users?page=1&size=200&q=carol')
    })
    // 从候选点选 carol(不允许自由输入;选中后确认按钮才可用)
    fireEvent.click(await screen.findByText('carol'))
    fireEvent.click(screen.getByRole('button', { name: '确认转移' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/apps/skill/codeql/owner',
        { method: 'PUT', body: JSON.stringify({ owner: 'carol' }) },
      )
    })
  })


  // ID-01(审计 2026-09-23,P0):已通过审核的版本**不得**提供「拒绝」入口 ——
  // 拒绝与释放归档是同一条 UPDATE,对在服务的版本执行它会不可恢复地销毁归档
  // 字节、让该版本对全员 404、并烧掉版本号;可逆动作是「下架」。
  // 同时确认文案必须与事实一致(不能写「可重新上传」)。
  it('已通过行不渲染拒绝按钮,拒绝文案与事实一致(不可恢复 + 指路下架)', async () => {
    const u = userEvent.setup()
    const live = { ...SKILL_ROWS[0]!, status: 'approved' as const, enabled: true }
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=approved') return { approvals: [live] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<Capabilities />)
    await u.click(screen.getByRole('tab', { name: '已共享（0）' }))
    await screen.findByText('CodeQL 审计')
    expect(screen.queryByText('拒绝')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下架' })).toBeInTheDocument()
  })

  it('待审行渲染拒绝按钮,确认文案说明归档释放不可恢复且指路下架', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    const rejectBtns = screen.getAllByText('拒绝')
    fireEvent.click(rejectBtns[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('不可恢复')
    expect(dialog).toHaveTextContent('下架')
    // 误导文案(曾写「可重新上传」)不得复现。
    expect(dialog).not.toHaveTextContent('可重新上传')
  })

  it('转移归属:未选择时确认按钮禁用,当前归属人不可选', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click((await screen.findAllByTitle('转移归属(负责人)'))[0]!)
    await screen.findByRole('dialog')
    // 未选择新负责人 → 确认禁用(不预填,杜绝直接回车提交错误用户名)。
    expect(screen.getByRole('button', { name: '确认转移' })).toBeDisabled()
    // 当前归属人在候选列表中标记且不可选。
    fireEvent.click(screen.getByRole('combobox'))
    expect(await screen.findByText('当前归属')).toBeInTheDocument()
    const currentItems = screen
      .getAllByText('alice')
      .map((el) => el.closest('[cmdk-item]'))
      .filter((el) => el !== null)
    expect(currentItems.length).toBeGreaterThan(0)
    expect(currentItems[0]?.getAttribute('data-disabled')).toBe('true')
  })
})

/**
 * R6-B P2（第六轮审计，2026-09-23）：待审版本叠在**已下架应用**上时，页面此前给出
 * 一个可点的「通过」—— 点下去服务端必回 409 `APP_DELISTED`
 * （`server/internal/sharedskills/routes.go` 的 `Distribution.Writable()`；
 * `internal/capabilities/r5b_delist_owner_semantics_test.go` 明确造出这个状态并断言 409），
 * 而下架徽标只在 `status === 'approved'` 的行上渲染 ⇒ 管理员看到的是一个"正常待审"的行，
 * 事前零标记、事后只拿到失败文案。
 *
 * 判据：`enabled === false` 的行（**不看 status**）必须同时有 ①下架徽标、②置灰的「通过」、
 * ③说明文案（挂在按钮外层 span 上：禁用按钮不派发鼠标事件，浏览器不显示它自己的 title），
 * 且 ④「拒绝」保持可用（拒绝不是注定失败的动作），⑤点「通过」不发任何请求、不开确认弹窗。
 *
 * 变异验证（见 `temp/r6b-fix/MUTATION.md`）：把 `row.enabled === false` 从按钮的 disabled
 * 条件里去掉（= 修复前的形态）⇒ 本组第一条必红。
 */
describe('R6-B P2：待审 + 应用已下架', () => {
  /** 待审版本 + 应用级下架（`apps.enabled=false`，服务端审批队列会下发 `enabled`）。 */
  const delistedPending = {
    ...SKILL_ROWS[0]!, name: 'finance-report', display_name: '财务月报', version: '1.1.0',
    enabled: false,
    base_path: '/api/server/admin/shared-skills/finance-report/1.1.0',
    grants_base: '/api/server/admin/shared-skills/finance-report',
  }

  function mockWith(row: typeof delistedPending): void {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=pending') return { approvals: [row] }
      if (path === '/api/server/admin/capabilities/approvals?status=all') return { approvals: [row] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      if (path === '/api/server/admin/capability-locks') return { locks: [] }
      return {}
    })
  }

  it('显示「已下架」徽标 + 「通过」置灰 + 说明文案，且点了不发请求', async () => {
    mockWith(delistedPending)
    render(<Capabilities />)
    await screen.findByText('财务月报')

    // ① 事前标记（修前：只在 approved 行渲染 ⇒ pending 行零标记）。
    expect(screen.getByText('已下架')).toBeInTheDocument()
    // ② 注定失败的按钮必须点不动。
    const approve = screen.getByRole('button', { name: '通过' })
    expect(approve).toBeDisabled()
    // ③ 文案说明（与 409 APP_DELISTED 语义一致 + 给出本页可达的处置路径）。
    const hint = screen.getByTitle(DELISTED_PENDING_HINT)
    expect(hint).toBeInTheDocument()
    expect(DELISTED_PENDING_HINT).toContain('APP_DELISTED')
    // ④ 拒绝不是注定失败的动作，保持可用。
    expect(screen.getByRole('button', { name: '拒绝' })).toBeEnabled()
    // ⑤ 点「通过」不得发出任何请求、也不得弹确认框。
    fireEvent.click(approve)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mockRequest.mock.calls.some(([p]) => String(p).endsWith('/approve'))).toBe(false)
  })

  it('对照：未下架（enabled 未下发或 true）的待审行照旧可点「通过」，且无下架徽标', async () => {
    mockWith({ ...delistedPending, enabled: true })
    render(<Capabilities />)
    await screen.findByText('财务月报')
    expect(screen.queryByText('已下架')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '通过' })).toBeEnabled()
  })
})

/**
 * 市场待审版本(2026-10-23):队列从「只读 org」扩到「org + market」。
 *
 * 背景:市场渠道内容由管理端直发，但**员工归属人**上传的新版本需要管理员审核才生效；
 * 此前审批队列只读 org 渠道 ⇒ market 待审版本没有任何审核面，已上架内容永远停在
 * 首版(「已上架技能无法更新」的第三处根因)。服务端现在按行下发 `channel`，
 * market 行的 base_path 是**版本级** `/api/server/admin/skills|agents/<name>/<version>`。
 *
 * 本组钉住四件事:
 *  ① 来源列可读(市场/组织)；
 *  ② market 行**不渲染**没有端点的动作(删除/质量/上下架/授权)，但保留
 *    通过/拒绝/内容预览/下载归档/转移归属；
 *  ③ 通过/拒绝打到**服务端下发的 base_path**(不是前端自拼的市场 name 级前缀)；
 *  ④ market 待审行有影响面说明；已下架的 market 待审行「通过」置灰且给原因。
 */
describe('市场待审版本(queued market rows)', () => {
  /** 市场行:服务端下发的 channel/版本级基路径;市场行**恒为 pending**。 */
  const MARKET_ROW = {
    ...SKILL_ROWS[0]!, name: 'data-extract', version: '2.0.0', display_name: '数据提取 v2',
    description: '数据提取(员工提交的新版本)', status: 'pending' as const, enabled: true,
    channel: 'market' as const,
    base_path: '/api/server/admin/skills/data-extract/2.0.0',
    grants_base: '/api/server/admin/skills/data-extract',
    preview_path: '/api/server/admin/skills/data-extract/2.0.0/preview',
  }

  /** 只有一行时用它铺 mock(避开 beforeEach 里两份夹具的干扰)。 */
  function mockOnly(rows: unknown[]): void {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=pending') return { approvals: rows }
      if (path === '/api/server/admin/capabilities/approvals?status=all') return { approvals: rows }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
  }

  it('来源列:market 行显示「市场」,未下发 channel 的行按组织显示', async () => {
    mockOnly([MARKET_ROW, SKILL_ROWS[0]])
    render(<Capabilities />)
    await screen.findByText('数据提取 v2')
    expect(screen.getByRole('columnheader', { name: '来源' })).toBeInTheDocument()
    // 两行:market 行 → 市场;旧服务端/org 行(无 channel) → 组织。
    expect(screen.getByText('市场')).toBeInTheDocument()
    expect(screen.getByText('组织')).toBeInTheDocument()
  })

  it('market 行不渲染没有端点的动作(删除/质量/上下架/授权),保留审校与核查动作', async () => {
    mockOnly([MARKET_ROW])
    render(<Capabilities />)
    await screen.findByText('数据提取 v2')
    // 通过/拒绝/预览/下载归档/转移归属 —— 服务端有端点(两渠道同形)。
    expect(screen.getByRole('button', { name: '通过' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument()
    expect(screen.getByTitle('查看内容预览')).toBeInTheDocument()
    expect(screen.getByTitle('下载归档核查')).toBeInTheDocument()
    expect(screen.getByTitle('转移归属(负责人)')).toBeInTheDocument()
    // 市场命名空间没有 删除 / 质量 / 版本级上下架 / 授权 端点 ⇒ 这些入口不渲染
    // (渲染出来点下去必然 404)。这与「org 行行为完全不变」不冲突:org 行仍全有。
    expect(screen.queryByRole('button', { name: '删除版本' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下架' })).toBeNull()
    expect(screen.queryByRole('button', { name: '重新上架' })).toBeNull()
    expect(screen.queryByTitle('授权')).toBeNull()
    // 质量 Select(已通过行才有)对 market 行不渲染。
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('market 行「通过」打到服务端下发的版本级 base_path', async () => {
    mockOnly([MARKET_ROW])
    render(<Capabilities />)
    await screen.findByText('数据提取 v2')
    fireEvent.click(screen.getByRole('button', { name: '通过' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/skills/data-extract/2.0.0/approve',
        { method: 'POST' },
      )
    })
    // 绝不落到市场 name 级前缀(那是「上传新版/元数据」的端点,不是审校入口)。
    expect(mockRequest).not.toHaveBeenCalledWith('/api/server/admin/skills/data-extract/approve', expect.anything())
  })

  it('market 行「拒绝」带上理由打到 base_path/reject,并释放归档(服务端语义)', async () => {
    mockOnly([MARKET_ROW])
    render(<Capabilities />)
    await screen.findByText('数据提取 v2')
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('拒绝理由'), { target: { value: '包内 SKILL.md 与版本不符' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        '/api/server/admin/skills/data-extract/2.0.0/reject',
        { method: 'POST', body: JSON.stringify({ reason: '包内 SKILL.md 与版本不符' }) },
      )
    })
  })

  it('market 待审行带影响面说明(通过=对全部授权用户生效)', async () => {
    mockOnly([MARKET_ROW])
    render(<Capabilities />)
    await screen.findByText('数据提取 v2')
    expect(screen.getByText(MARKET_PENDING_HINT('skill'))).toBeInTheDocument()
    expect(MARKET_PENDING_HINT('skill')).toContain('授权用户')
    // 市场行的说明必须点明"市场"这一来源,否则与 org 行的语义混淆。
    expect(MARKET_PENDING_HINT('skill')).toContain('市场')
  })

  it('已下架的 market 待审行:「通过」置灰,原因指向市场页重新上架(不是"联系管理员")', async () => {
    mockOnly([{ ...MARKET_ROW, enabled: false }])
    render(<Capabilities />)
    await screen.findByText('数据提取 v2')
    expect(screen.getByText('已下架')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: '通过' })
    expect(approve).toBeDisabled()
    expect(screen.getByTitle(DELISTED_PENDING_MARKET_HINT)).toBeInTheDocument()
    // 409 的成因写在文案里(APP_DELISTED),不得再出现「联系管理员」这类无操作性的指引。
    expect(DELISTED_PENDING_MARKET_HINT).toContain('APP_DELISTED')
    expect(DELISTED_PENDING_MARKET_HINT).toContain('市场')
    expect(DELISTED_PENDING_MARKET_HINT).not.toContain('联系管理员')
    // 拒绝仍可用(拒绝不是注定失败的动作)。
    expect(screen.getByRole('button', { name: '拒绝' })).toBeEnabled()
  })

  it('P0 F-01: 已通过 org 行不渲染删除(approved 不可删),下架/授权照旧', async () => {
    const approved = { ...SKILL_ROWS[0]!, status: 'approved' as const, quality: 'featured' as const, enabled: true }
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=approved') return { approvals: [approved] }
      if (path === '/api/server/admin/capabilities/approvals?status=all') return { approvals: [approved] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    render(<Capabilities />)
    const u = userEvent.setup()
    await u.click(screen.getByRole('tab', { name: '已共享（0）' }))
    await screen.findByText('CodeQL 审计')
    // 已通过版本删除会清空归档且不可恢复；服务端 409，UI 不渲染入口。
    expect(screen.queryByRole('button', { name: '删除版本' })).toBeNull()
    expect(screen.getByRole('button', { name: '下架' })).toBeInTheDocument()
    expect(screen.getByTitle('授权')).toBeInTheDocument()
  })

  it('P2 F-22: 已拒绝行不渲染预览/下载(归档已在拒绝时清理)', async () => {
    const rejected = { ...SKILL_ROWS[0]!, status: 'rejected' as const, reason: '内容不合规' }
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=rejected') return { approvals: [rejected] }
      if (path === '/api/server/admin/capabilities/approvals?status=all') return { approvals: [rejected] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      return {}
    })
    const u = userEvent.setup()
    render(<Capabilities />)
    await u.click(screen.getByRole('tab', { name: /未通过/ }))
    await screen.findByText('CodeQL 审计')
    expect(screen.queryByTitle('查看内容预览')).toBeNull()
    expect(screen.queryByTitle('下载归档核查')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// D 系列显示修复(2026-10-26):展示名优先级、预览 key、作者空值
// ---------------------------------------------------------------------------
describe('审批列表 · 展示名(D 系列)', () => {
  it('previewKeyOf 先归并展示名再拼 @version(运算符优先级回归)', () => {
    // 老写法 `display_name || name + '@' + version` 在这里会得到「数据提取 v2」,
    // 丢掉版本段 ⇒ 同一展示名的不同版本预览无法区分。
    expect(previewKeyOf({ display_name: '数据提取 v2', name: 'data-extract', version: '2.0.0' }))
      .toBe('数据提取 v2@2.0.0')
    expect(previewKeyOf({ name: 'data-extract', version: '2.0.0' })).toBe('data-extract@2.0.0')
  })

  it('作者为空显示 —;展示名与目录名相同时不重复渲染', async () => {
    const sameNameRow = { ...SKILL_ROWS[0]!, author: '', display_name: 'codeql' }
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/capabilities/approvals?status=pending') return { approvals: [sameNameRow] }
      if (path === '/api/server/admin/capabilities/approvals?status=all') return { approvals: [sameNameRow] }
      if (path === '/api/server/admin/departments') return { departments: [] }
      if (path === '/api/server/admin/capability-locks') return { locks: [] }
      return {}
    })
    render(<Capabilities />)
    await screen.findByText('codeql')
    // display_name === name ⇒ 只渲染一次(名称格里不再重复一行 slug)。
    expect(screen.getAllByText('codeql')).toHaveLength(1)
    // 作者列空值显示破折号,而不是空白单元格。
    expect(screen.getAllByText('—', { selector: 'td' })).toHaveLength(1)
  })

  it('转移归属弹窗用展示名(display_name)而不是 slug', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click((await screen.findAllByTitle('转移归属(负责人)'))[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('将「CodeQL 审计」')
  })
})

// ---------------------------------------------------------------------------
// F-48 / F-21 / F-24 / F-50 / F-51（2026-10-26）
//
// 审批页此前零权限门（只读账号看到必 403 的按钮）、「删除」与「下架」文案不分、
// official 未接、状态/来源术语与客户端两套叫法、market 历史缺口无任何说明。
// ---------------------------------------------------------------------------
describe('Capabilities 审批页 · 权限门/术语/归属（F-48 / F-21 / F-24 / F-50 / F-51）', () => {
  function mockRowsOnly(rows: unknown[]): void {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/server/admin/capabilities/approvals')) return { approvals: rows }
      if (path === '/api/server/admin/departments') return { departments: [] }
      if (path === '/api/server/admin/capability-locks') return { locks: [] }
      return {}
    })
  }

  it('F-48 正向夹具:持有 capability:write 时审批写入口可见', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['capability:read', 'capability:write'] })
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    // 待审行：通过 / 拒绝 / 删除版本 / 转移归属。
    expect(screen.getAllByRole('button', { name: '通过' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '拒绝' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '删除版本' }).length).toBeGreaterThan(0)
    expect(screen.getAllByTitle('转移归属(负责人)').length).toBeGreaterThan(0)
  })

  it('F-48 只读:没有 capability:write 时不渲染写入口(读仍可用)', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['capability:read'] })
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    expect(screen.queryAllByRole('button', { name: '通过' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: '拒绝' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: '删除版本' })).toHaveLength(0)
    expect(screen.queryAllByTitle('转移归属(负责人)')).toHaveLength(0)
    // 只读入口保留，管理员仍能核查内容。
    expect(screen.getAllByTitle('查看内容预览').length).toBeGreaterThan(0)
  })

  it('F-48 无 capability:read:不发审批请求,给确定态', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['market:read'] })
    render(<Capabilities />)
    expect(await screen.findByText('没有审批查看权限')).toBeInTheDocument()
    expect(
      mockRequest.mock.calls.some((c) => String(c[0]).includes('/capabilities/approvals')),
    ).toBe(false)
  })

  it('F-51 official 行:归属列显示「官方」徽标(owner 恒为空也不显示 —)', async () => {
    const officialRow = { ...SKILL_ROWS[0]!, owner: '', official: true }
    mockRowsOnly([officialRow])
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    expect(screen.getByText('官方')).toBeInTheDocument()
    // 恒 false 的历史 conflict 字段不再渲染「名称冲突」。
    expect(screen.queryByText('名称冲突')).toBeNull()
  })

  it('F-21 删除版本:标题写明「删除版本」，确认文案与下架(可恢复)区分', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    fireEvent.click(screen.getAllByRole('button', { name: '删除版本' })[0]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('确定删除版本')
    expect(dialog).toHaveTextContent('不可恢复')
    expect(dialog).toHaveTextContent('下架')
    expect(dialog).toHaveTextContent('可恢复')
  })

  it('F-50 术语:状态 Tab/徽章与客户端对齐（审核中/已共享/未通过），来源用市场/组织', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '审核中（2）' })).toBeInTheDocument()
    })
    expect(screen.getByRole('tab', { name: /已共享/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /未通过/ })).toBeInTheDocument()
    expect(screen.getAllByText('审核中').length).toBeGreaterThan(0)
    // 默认 mock 的两行都没有 channel ⇒ 组织。
    expect(screen.getAllByText('组织').length).toBeGreaterThan(0)
  })

  it('F-24「全部」标注市场历史去向(服务端不提供市场审批历史,前端不造假)', async () => {
    render(<Capabilities />)
    await screen.findByText('CodeQL 审计')
    expect(screen.getByText(/市场渠道只并入待审版本/)).toBeInTheDocument()
  })
})
