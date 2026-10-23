import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import SystemConfig, { type ConfigItem } from './SystemConfig'
import { request } from '../api'
import { setCurrentAdmin } from '../lib/rbac'

const mockRequest = vi.mocked(request)

const CONFIG_PATH = '/api/server/admin/config'

/**
 * 夹具与真实注册表同形（字段名/取值形态逐字对齐 serverauth.ConfigItem）。
 * 环境变量覆盖项用 wasm.memory_profile：它是**启动闸门**类键（restart），
 * 正好同时覆盖"环境变量徽标 + 顶部横幅 + 需重建容器提示"三个渲染面。
 */
const ITEMS: ConfigItem[] = [
  {
    key: 'deploy.update_endpoint',
    env: 'ZEOKEEL_UPDATE_ENDPOINT',
    title: '更新清单地址',
    description: '服务端检查新版本用的清单地址。留空 = 按本部署渠道取默认目录。',
    category: '对外地址与更新',
    kind: 'string',
    value: '',
    source: 'default',
    default: '',
    applies_at: 'hot',
    min: null,
    max: null,
    choices: [],
    env_value: '',
    setting_value: '',
    invalid: '',
  },
  {
    key: 'auth.login_max_attempts',
    env: 'ZEOKEEL_LOGIN_MAX_ATTEMPTS',
    title: '登录失败上限',
    description: '单账号在窗口内的登录失败上限，超限锁定。',
    category: '认证与安全',
    kind: 'int',
    value: '7',
    source: 'setting',
    default: '10',
    applies_at: 'hot',
    min: 1,
    max: 1000000,
    choices: [],
    env_value: '',
    setting_value: '7',
    invalid: '',
  },
  {
    key: 'auth.ldap_allow_plaintext',
    env: 'ZEOKEEL_LDAP_ALLOW_PLAINTEXT',
    title: '允许明文 LDAP',
    description: '放行非回环 ldap://（bind 密码明文过网）。',
    category: '认证与安全',
    kind: 'bool',
    value: 'false',
    source: 'default',
    default: 'false',
    applies_at: 'hot',
    min: null,
    max: null,
    choices: [],
    env_value: '',
    setting_value: '',
    invalid: '',
  },
  {
    key: 'wasm.memory_profile',
    env: 'ZEOKEEL_WASM_MEMORY_PROFILE',
    title: '应用平台内存档位',
    description: 'default = 32 并发 × 64 MiB；small = 3 并发；large = 64 并发。',
    category: '应用平台',
    kind: 'choice',
    value: 'small',
    source: 'env',
    default: 'default',
    applies_at: 'restart',
    min: null,
    max: null,
    choices: ['default', 'small', 'large'],
    env_value: 'small',
    setting_value: '',
    invalid: '',
  },
]

const CONFIG_RESPONSE = { items: ITEMS, env_overrides: ['wasm.memory_profile'] }

/** 按 (method) 分派 mock：GET 读面 / PUT 保存。 */
function mockApi(overrides: { get?: unknown; put?: unknown } = {}) {
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path !== CONFIG_PATH) throw new Error(`unexpected path: ${path}`)
    if (init?.method === 'PUT') {
      return (overrides.put ?? { saved: ['deploy.update_endpoint'], warnings: [] }) as never
    }
    return (overrides.get ?? CONFIG_RESPONSE) as never
  })
}

beforeEach(() => {
  mockRequest.mockReset()
  mockApi()
})

afterEach(() => {
  // 不把权限快照留给下一个用例（hasPermission 在无 permissions 时"默认放行"）。
  setCurrentAdmin(null)
})

describe('SystemConfig 系统配置页', () => {
  it('按 category 分组渲染：标题/说明/生效值/来源徽标', async () => {
    render(<SystemConfig />)
    expect(await screen.findByText('对外地址与更新')).toBeInTheDocument()
    expect(screen.getByText('认证与安全')).toBeInTheDocument()
    expect(screen.getByText('应用平台')).toBeInTheDocument()

    expect(screen.getByText('更新清单地址')).toBeInTheDocument()
    expect(screen.getByText(/单账号在窗口内的登录失败上限/)).toBeInTheDocument()

    // 来源徽标三种形态：控制台 / 环境变量 / 默认
    expect(screen.getAllByText('控制台').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('环境变量').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('默认').length).toBeGreaterThanOrEqual(1)

    // 生效值回填到输入框（settings 来源的 7），默认值单独展示
    expect(screen.getByLabelText('登录失败上限')).toHaveValue('7')
    expect(screen.getByText('默认：10')).toBeInTheDocument()
    // 空值是合法状态（不是"加载中"）
    expect(screen.getByLabelText('更新清单地址')).toHaveValue('')
  })

  it('被环境变量覆盖的键在顶部横幅点名（只读提示）', async () => {
    render(<SystemConfig />)
    expect(await screen.findByText(/仍被环境变量覆盖（只读提示）/)).toBeInTheDocument()
    expect(screen.getByText(/环境变量优先级高于控制台/)).toBeInTheDocument()
    // 横幅里点名了具体的键与环境变量名
    expect(screen.getByText(/应用平台内存档位（wasm\.memory_profile）/)).toBeInTheDocument()
  })

  it('restart 类键标注"需重启/重建容器生效"', async () => {
    render(<SystemConfig />)
    await screen.findByText('应用平台')
    expect(screen.getByText('需重建容器生效')).toBeInTheDocument()
    expect(screen.getByText(/修改后需重启 \/ 重建容器生效/)).toBeInTheDocument()
  })

  it('只提交改动过的键；空值字段不提交（不把默认值写成显式 settings）', async () => {
    render(<SystemConfig />)
    const input = await screen.findByLabelText('更新清单地址')
    fireEvent.change(input, { target: { value: 'https://updates.example.com/latest.json' } })
    // 初始无改动时保存按钮禁用（避免"保存了一次但什么都没变"）
    fireEvent.click(screen.getByRole('button', { name: '保存 1 项' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(CONFIG_PATH, {
        method: 'PUT',
        body: JSON.stringify({ values: { 'deploy.update_endpoint': 'https://updates.example.com/latest.json' } }),
      })
    })
    // 保存后重新拉取（回填服务端真相）
    expect(mockRequest.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'PUT')).toHaveLength(2)
    expect(await screen.findByText('已保存 1 项')).toBeInTheDocument()
  })

  it('初始无改动时保存按钮禁用', async () => {
    render(<SystemConfig />)
    await screen.findByText('对外地址与更新')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('「清除控制台值」把该项作为空串提交（删除 settings 行、回落环境变量/默认）', async () => {
    render(<SystemConfig />)
    await screen.findByText('认证与安全')
    fireEvent.click(screen.getByRole('button', { name: '清除控制台值' }))
    fireEvent.click(screen.getByRole('button', { name: '保存 1 项' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(CONFIG_PATH, {
        method: 'PUT',
        body: JSON.stringify({ values: { 'auth.login_max_attempts': '' } }),
      })
    })
  })

  it('保存后展示服务端 warnings（"保存成功但被环境变量覆盖"的唯一线索）', async () => {
    mockApi({
      put: {
        saved: ['wasm.memory_profile'],
        warnings: [
          '应用平台内存档位（wasm.memory_profile）仍被环境变量覆盖，控制台修改不生效；覆盖它的环境变量是 ZEOKEEL_WASM_MEMORY_PROFILE —— 如需以控制台为准，请删除 .env 中的对应行（改完需重建容器）。',
        ],
      },
    })
    render(<SystemConfig />)
    await screen.findByText('应用平台')
    // 修改 choice 项（Radix Select → 点开选 large）
    fireEvent.click(screen.getByRole('combobox', { name: '应用平台内存档位' }))
    fireEvent.click(await screen.findByRole('option', { name: 'large' }))
    fireEvent.click(screen.getByRole('button', { name: '保存 1 项' }))
    expect(await screen.findByText(/覆盖它的环境变量是 ZEOKEEL_WASM_MEMORY_PROFILE/)).toBeInTheDocument()
  })

  it('读取失败时显示原因、表单与保存锁死（不拿默认值冒充真实配置）', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === CONFIG_PATH) throw new Error('配置读取失败，请稍后重试')
      throw new Error(`unexpected path: ${path}`)
    })
    render(<SystemConfig />)
    expect(await screen.findByText('配置读取失败，请稍后重试')).toBeInTheDocument()
    expect(screen.getByText('配置未加载成功，表单与保存已锁定。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(screen.queryByLabelText('更新清单地址')).toBeNull()
  })

  it('只有 config:read 时保存禁用并说明原因（auditor 拿不到任何配置权限）', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['config:read'] })
    render(<SystemConfig />)
    await screen.findByText('对外地址与更新')
    expect(screen.getByText(/只有 config:read 权限/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('持有 config:write 时保存按钮可用（正向夹具）', async () => {
    setCurrentAdmin({ role: 'super_admin', permissions: ['config:write'] })
    render(<SystemConfig />)
    const input = await screen.findByLabelText('更新清单地址')
    fireEvent.change(input, { target: { value: 'https://updates.example.com/latest.json' } })
    const save = screen.getByRole('button', { name: '保存 1 项' })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(CONFIG_PATH, expect.objectContaining({ method: 'PUT' }))
    })
  })

  it('保存失败不乐观更新：报错且不显示"已保存"、不假装回填成功', async () => {
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path !== CONFIG_PATH) throw new Error(`unexpected path: ${path}`)
      if (init?.method === 'PUT') throw new Error('保存失败：配置键 auth.login_max_attempts 的取值非法')
      return CONFIG_RESPONSE as never
    })
    render(<SystemConfig />)
    const input = await screen.findByLabelText('登录失败上限')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 1 项' }))
    expect(await screen.findByText(/保存失败：配置键 auth\.login_max_attempts 的取值非法/)).toBeInTheDocument()
    expect(screen.queryByText(/^已保存 \d+ 项$/)).toBeNull()
    // 只发过一次 GET（保存失败不触发回读），且没有把失败说成成功。
    expect(mockRequest.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'PUT')).toHaveLength(1)
  })
})
