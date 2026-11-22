import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { ApiError, request } from '../api'
import { setCurrentAdmin } from '../lib/rbac'
import Plugins from './Plugins'

// ---------------------------------------------------------------------------
// 全局客户端插件分发页（2026-11-22，契约 temp/client-plugin-distribution-contract.md）
//
// 本页的判据按**发出的请求**写，而不是"表格里第一行是谁"：
//   ① 列表来自 GET /api/server/admin/plugins → {"plugins":[…]}，展示 id/包名/版本/
//      sha256 前 12 位/人类可读大小/启停/更新人；
//   ② 上传必须把 **.tgz 的 base64** 以 JSON（`bundle_base64`，id 可省略）POST 出去，
//      不是 multipart、不是裸字节；
//   ③ 启停是 PUT …/:id/enabled + `{"enabled":bool}`；
//   ④ 删除必须先弹确认框，确认后才发 DELETE；
//   ⑤ 只读账号（无 capability:write）看得到列表，但上传/启停/删除入口一个都不渲染；
//   ⑥ 服务端失败原因（ApiError.message）必须显示出来。
// ---------------------------------------------------------------------------

const mockRequest = vi.mocked(request)

const LIST_PATH = '/api/server/admin/plugins'

const ROWS = [
  {
    id: 'demo-plugin',
    package_name: '@example/dsh-demo-plugin',
    display_name: '示例插件',
    description: '示例桌面插件',
    version: '0.2.0',
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    size: 2 * 1024 * 1024,
    enabled: true,
    updated_by: 'admin',
    updated_at: '2026-11-20T10:00:00+08:00',
  },
  {
    id: 'another-plugin',
    package_name: '@example/dsh-another-plugin',
    display_name: '另一个插件',
    description: '',
    version: '1.0.0',
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    size: 1536,
    enabled: false,
    updated_by: 'auditor',
    updated_at: '2026-11-19T09:30:00+08:00',
  },
]

interface Call {
  path: string
  method: string
  body?: string
}

/** 记录请求；GET 列表恒返回夹具，便于断言写动作后的刷新。 */
function installMock(rows: unknown[] = ROWS): Call[] {
  const calls: Call[] = []
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ path: String(path), method, body: init?.body === undefined ? undefined : String(init.body) })
    if (String(path) === LIST_PATH && method === 'GET') return { plugins: rows }
    if (String(path) === LIST_PATH && method === 'POST') {
      return { plugin: { ...ROWS[0], id: 'uploaded-plugin', display_name: '新上传插件' } }
    }
    return { ok: true }
  })
  return calls
}

const lastCall = (calls: Call[]): Call | undefined => calls[calls.length - 1]
const callsOf = (calls: Call[], predicate: (c: Call) => boolean): Call[] => calls.filter(predicate)

beforeEach(() => {
  mockRequest.mockReset()
  // 写面默认给全：个别用例（只读）自己覆盖成 capability:read。rbac 的当前管理员是
  // 模块级快照，必须在每个用例前复位，否则写权限会泄漏给后面的只读用例。
  setCurrentAdmin({ role: 'super_admin', permissions: ['capability:read', 'capability:write'] })
})

describe('插件分发页', () => {
  it('渲染列表：编号/包名/版本/sha256 前 12 位/大小/启停/更新人', async () => {
    installMock()
    render(<Plugins />)

    const row = await screen.findByTestId('plugin-row-demo-plugin')
    expect(within(row).getByText('demo-plugin')).toBeInTheDocument()
    expect(within(row).getByText('@example/dsh-demo-plugin')).toBeInTheDocument()
    expect(within(row).getByText('示例插件')).toBeInTheDocument()
    expect(within(row).getByText('0.2.0')).toBeInTheDocument()
    expect(within(row).getByText('aaaaaaaaaaaa…')).toBeInTheDocument()
    expect(within(row).getByText('2.0 MiB')).toBeInTheDocument()
    expect(within(row).getByText('admin')).toBeInTheDocument()
    expect(within(row).getByRole('switch')).toBeChecked()

    const disabledRow = screen.getByTestId('plugin-row-another-plugin')
    expect(within(disabledRow).getByText('1.5 KiB')).toBeInTheDocument()
    expect(within(disabledRow).getByRole('switch')).not.toBeChecked()
    expect(within(disabledRow).getByText('auditor')).toBeInTheDocument()
    expect(mockRequest).toHaveBeenCalledWith(LIST_PATH)
  })

  it('空列表给出空状态', async () => {
    installMock([])
    render(<Plugins />)
    expect(await screen.findByText('暂无客户端插件')).toBeInTheDocument()
  })

  it('上传：浏览器内读成 base64，以 JSON 提交（id 省略时由服务端派生）', async () => {
    const calls = installMock()
    render(<Plugins />)
    await screen.findByTestId('plugin-row-demo-plugin')

    fireEvent.click(screen.getByRole('button', { name: '上传插件' }))
    const dialog = within(await screen.findByRole('dialog'))
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.tgz', { type: 'application/gzip' })
    fireEvent.change(dialog.getByLabelText('插件包（.tgz）'), { target: { files: [file] } })
    fireEvent.click(dialog.getByRole('button', { name: '上传' }))

    await waitFor(() => {
      const post = callsOf(calls, (c) => c.path === LIST_PATH && c.method === 'POST')
      expect(post).toHaveLength(1)
      // 3 字节 [1,2,3] 的标准 base64 = AQID；没有 id 键（服务端按包名派生）。
      expect(post[0]!.body).toBe(JSON.stringify({ bundle_base64: 'AQID' }))
    })
    // 成功后关闭对话框、提示并刷新列表。
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('新上传插件')
    await waitFor(() => expect(callsOf(calls, (c) => c.path === LIST_PATH && c.method === 'GET').length).toBeGreaterThanOrEqual(2))
  })

  it('上传：填写编号时随 payload 一起下发', async () => {
    const calls = installMock()
    render(<Plugins />)
    await screen.findByTestId('plugin-row-demo-plugin')

    fireEvent.click(screen.getByRole('button', { name: '上传插件' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('插件包（.tgz）'), {
      target: { files: [new File([new Uint8Array([1, 2, 3])], 'demo.tgz')] },
    })
    fireEvent.change(dialog.getByLabelText('插件编号（可选）'), { target: { value: 'custom-id' } })
    fireEvent.click(dialog.getByRole('button', { name: '上传' }))

    await waitFor(() => {
      const post = callsOf(calls, (c) => c.path === LIST_PATH && c.method === 'POST')
      expect(post).toHaveLength(1)
      expect(JSON.parse(post[0]!.body ?? '{}')).toEqual({ bundle_base64: 'AQID', id: 'custom-id' })
    })
  })

  it('启停：PUT .../:id/enabled，body 逐字等于 {"enabled":bool}', async () => {
    const calls = installMock()
    render(<Plugins />)
    const row = await screen.findByTestId('plugin-row-demo-plugin')

    fireEvent.click(within(row).getByRole('switch'))

    await waitFor(() => {
      const put = callsOf(calls, (c) => c.path === `${LIST_PATH}/demo-plugin/enabled`)
      expect(put).toHaveLength(1)
      expect(put[0]!.method).toBe('PUT')
      expect(put[0]!.body).toBe(JSON.stringify({ enabled: false }))
    })
  })

  it('删除：先确认，确认后才发 DELETE 并刷新', async () => {
    const calls = installMock()
    render(<Plugins />)
    const row = await screen.findByTestId('plugin-row-demo-plugin')

    fireEvent.click(within(row).getByRole('button', { name: '删除 示例插件' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('确定删除插件「示例插件」吗？')).toBeInTheDocument()
    // 只弹确认框时不得发任何 DELETE。
    expect(callsOf(calls, (c) => c.method === 'DELETE')).toHaveLength(0)

    fireEvent.click(dialog.getByRole('button', { name: '确认删除' }))

    await waitFor(() => {
      const del = callsOf(calls, (c) => c.method === 'DELETE')
      expect(del).toHaveLength(1)
      expect(del[0]!.path).toBe(`${LIST_PATH}/demo-plugin`)
    })
    await waitFor(() => expect(callsOf(calls, (c) => c.path === LIST_PATH && c.method === 'GET').length).toBeGreaterThanOrEqual(2))
  })

  it('只读账号（无 capability:write）：能看到列表，但没有上传/启停/删除入口', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['capability:read'] })
    installMock()
    render(<Plugins />)

    const row = await screen.findByTestId('plugin-row-demo-plugin')
    expect(within(row).getByText('示例插件')).toBeInTheDocument()
    // 启停以只读徽标展示，而不是可点的开关。
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(within(row).getByText('已启用')).toBeInTheDocument()
    expect(within(screen.getByTestId('plugin-row-another-plugin')).getByText('已禁用')).toBeInTheDocument()
    // 上传/删除入口整体不渲染（服务端仍会以 403 兜底）。
    expect(screen.queryByRole('button', { name: '上传插件' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除 示例插件' })).not.toBeInTheDocument()
    // 刷新是读动作，只读账号仍然可用。
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  })

  it('持有 capability:write 时上传/启停/删除入口可见（正向夹具）', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['capability:read', 'capability:write'] })
    installMock()
    render(<Plugins />)

    const row = await screen.findByTestId('plugin-row-demo-plugin')
    expect(screen.getByRole('button', { name: '上传插件' })).toBeInTheDocument()
    expect(within(row).getByRole('switch')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: '删除 示例插件' })).toBeInTheDocument()
  })

  it('服务端失败原因（ApiError.message）原样显示', async () => {
    installMock()
    // 首次 GET 正常返回列表；随后启停请求以 409 冲突失败。
    mockRequest.mockImplementationOnce(async () => ({ plugins: ROWS }))
    mockRequest.mockImplementationOnce(async () => {
      throw new ApiError(409, 'CONFLICT', '新版本必须与已存版本不同')
    })
    render(<Plugins />)
    const row = await screen.findByTestId('plugin-row-demo-plugin')

    fireEvent.click(within(row).getByRole('switch'))

    expect(await screen.findByText('新版本必须与已存版本不同')).toBeInTheDocument()
  })

  it('列表读取失败：显示原因并撤下旧行（写动作不得作用在过期快照上）', async () => {
    mockRequest.mockImplementation(async () => {
      throw new ApiError(500, 'INTERNAL', '服务暂时不可用，请稍后再试')
    })
    render(<Plugins />)

    expect(await screen.findByText('服务暂时不可用，请稍后再试')).toBeInTheDocument()
    expect(screen.getByText('插件列表未读取成功')).toBeInTheDocument()
    expect(screen.queryByTestId('plugin-row-demo-plugin')).not.toBeInTheDocument()
  })

  it('刷新按钮重新拉取列表', async () => {
    const calls = installMock()
    render(<Plugins />)
    await screen.findByTestId('plugin-row-demo-plugin')
    const before = callsOf(calls, (c) => c.path === LIST_PATH && c.method === 'GET').length

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))

    await waitFor(() => {
      expect(callsOf(calls, (c) => c.path === LIST_PATH && c.method === 'GET').length).toBe(before + 1)
    })
    // 非 GET 请求一条都不该有（刷新是纯读动作）。
    await waitFor(() => expect(lastCall(calls)?.method).toBe('GET'))
  })
})
