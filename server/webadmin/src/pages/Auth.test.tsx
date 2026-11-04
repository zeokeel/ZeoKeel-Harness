import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { request } from '../api'
import Auth from './Auth'

const mockRequest = vi.mocked(request)

const AUTH_SAMPLE = {
  auth: {
    mode: 'local',
    enabled: 'local,ldap,oidc',
    hide_local: false,
    ldap: {
      server_url: 'ldap://ldap.example.com:389',
      bind_dn: 'cn=admin,dc=example,dc=com',
      bind_password: '***',
      base_dn: 'dc=example,dc=com',
      user_filter: '(uid=%s)',
      group_filter: '(memberOf=cn=%s)',
      group_attr: 'cn',
    },
    oidc: {
      issuer: 'https://idp.example.com',
      client_id: 'webadmin-client',
      client_secret: '***',
      redirect_url: 'https://zeokeel.example.com/api/auth/oidc/callback',
    },
    openid: { issuer: '', client_id: '', client_secret: '', redirect_url: '' },
    // 2026-11-03 扫码登录:读面 secret 已存 = *** (掩码,只标记已设置,不回填)
    wecom: {
      corp_id: 'ww1234567890abcdef',
      agent_id: '1000002',
      secret: '***',
      redirect_url: 'https://zeokeel.example.com/api/client/v2/auth/wecom/callback',
    },
    dingtalk: {
      client_id: 'dingabcdef',
      client_secret: '***',
      redirect_url: 'https://zeokeel.example.com/api/client/v2/auth/dingtalk/callback',
    },
    // 2026-11-03 外部权限源(RBAC):默认关闭时不影响扫码；这里给一份已启用配置。
    identity: {
      enabled: true,
      endpoint: 'https://rbac.example.com/internal/v1/identity/resolve',
      token: '***',
      methods: 'wecom,dingtalk',
      timeout_ms: 3000,
      sync_groups: true,
      rbac_user_count: 0,
    },
  },
}

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string) => {
    if (path === '/api/server/admin/auth') return AUTH_SAMPLE
    return {}
  })
})

afterEach(() => {
  // 回调地址复制用例会替换 navigator(注入剪贴板);用例间必须还原。
  vi.unstubAllGlobals()
})

describe('Auth 认证配置页(v3b Tab 重设计)', () => {
  it('渲染启用方式与 hide_local 开关', async () => {
    render(<Auth />)
    expect(await screen.findByText('认证配置')).toBeInTheDocument()
    // 启用方式(恒有 local + 服务端 enabled 的 ldap/oidc)
    expect(screen.getByRole('checkbox', { name: /本地账号/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /LDAP/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /OIDC/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /OpenID/ })).toBeInTheDocument()
    // hide_local 开关
    const hide = screen.getByLabelText('隐藏客户端本地登录入口') as HTMLInputElement
    expect(hide.checked).toBe(false)
  })

  it('保存:提交 PUT /api/admin/auth 并提示(含 hide_local)', async () => {
    render(<Auth />)
    await screen.findByText('认证配置')
    // 直接点保存(不切换 Tab; 服务端启用方式已全配置, 前端校验通过)
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/auth', expect.objectContaining({ method: 'PUT' }))
    })
    expect(await screen.findByText('认证配置已保存(重启服务端后生效)')).toBeInTheDocument()
  })

  it('校验:启用 LDAP 但配置不完整 → 复选框禁用', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/auth') return { auth: { mode: 'local', enabled: 'local' } }
      return {}
    })
    render(<Auth />)
    await screen.findByText('认证配置')
    // 未配置 LDAP 必填 → checkbox disabled(启用绑定配置)
    const ldap = screen.getByRole('checkbox', { name: /LDAP/ }) as HTMLInputElement
    expect(ldap.disabled).toBe(true)
  })

  it('hide_local 开关: 勾选后保存提交 hide_local:true', async () => {
    render(<Auth />)
    await screen.findByText('认证配置')
    const hide = screen.getByLabelText('隐藏客户端本地登录入口')
    fireEvent.click(hide)
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/auth', expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"hide_local":true'),
      }))
    })
  })

  it('密码回显修复: 掩码不进输入框; 未改密码保存时回传 *** 保持现值', async () => {
    const user = userEvent.setup()
    render(<Auth />)
    await screen.findByText('认证配置')
    // 打开 LDAP tab(radix tabs 需要完整 pointer 事件)
    await user.click(screen.getByRole('tab', { name: 'LDAP' }))
    // Bind 密码输入框应为空(不显示 ***), 且有「已配置」徽标
    const pw = screen.getByLabelText(/Bind 密码/) as HTMLInputElement
    expect(pw.value).toBe('')
    expect(screen.getByText('已配置')).toBeInTheDocument()
    // 保存: 提交的 bind_password 必须是 *** (保持现值)
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/auth', expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"bind_password":"***"'),
      }))
    })
  })

  it('LDAP 测试连接: 返回目录统计并展示样例', async () => {
    const user = userEvent.setup()
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/auth') return AUTH_SAMPLE
      if (path === '/api/server/admin/auth/test') {
        return {
          ok: true,
          message: 'LDAP 连接成功',
          users: 128,
          groups: 9,
          sample: [
            { username: 'alice', display_name: 'Alice', email: 'alice@example.com', groups: ['admins'] },
            { username: 'bob', display_name: 'Bob', email: 'bob@example.com', groups: [] },
          ],
        }
      }
      return {}
    })
    render(<Auth />)
    await screen.findByText('认证配置')
    await user.click(screen.getByRole('tab', { name: 'LDAP' }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText(/匹配到/)).toBeInTheDocument()
    expect(screen.getByText(/128/)).toBeInTheDocument()
    expect(screen.getByText(/9/)).toBeInTheDocument()
    // 样例展示
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.getByText('admins')).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // 2026-11-03 企业微信/钉钉扫码登录(设计 §3/§6)
  // -------------------------------------------------------------------------
  it('企业微信/钉钉: 启用方式各多一个扫码开关(说明「扫码登录(仅客户端)」)', async () => {
    render(<Auth />)
    await screen.findByText('认证配置')
    const wecom = screen.getByRole('checkbox', { name: /企业微信/ }) as HTMLInputElement
    const dingtalk = screen.getByRole('checkbox', { name: /钉钉/ }) as HTMLInputElement
    // 两套配置在 AUTH_SAMPLE 里齐全(secret 是服务端掩码 ***)⇒ 开关可用。
    // 掩码只标记「已设置」, 不能让已配好的方式被判成「配置不完整」。
    expect(wecom.disabled).toBe(false)
    expect(dingtalk.disabled).toBe(false)
    expect(screen.getAllByText('扫码登录(仅客户端)')).toHaveLength(2)
  })

  it('企业微信扫码页: 四字段 + 回调地址 + 「逐字一致」提示', async () => {
    const user = userEvent.setup()
    render(<Auth />)
    await screen.findByText('认证配置')
    await user.click(screen.getByRole('tab', { name: '企业微信扫码' }))

    expect(screen.getByLabelText(/企业 ID/)).toHaveValue('ww1234567890abcdef')
    expect(screen.getByLabelText(/自建应用 AgentId/)).toHaveValue('1000002')
    expect(screen.getByLabelText(/自建应用 Secret/)).toHaveValue('')
    expect(screen.getByLabelText(/回调地址\(Redirect URL\)/))
      .toHaveValue('https://zeokeel.example.com/api/client/v2/auth/wecom/callback')

    // 回调地址 = location.origin + /api/client/v2/auth/wecom/callback(复制给服务商后台登记)
    const expected = `${window.location.origin}/api/client/v2/auth/wecom/callback`
    expect(screen.getByText(expected)).toBeInTheDocument()
    expect(screen.getByText(/请到服务商后台登记/)).toBeInTheDocument()
    expect(screen.getByText(/值必须逐字一致/)).toBeInTheDocument()
  })

  it('钉钉扫码页: AppKey/AppSecret/回调地址', async () => {
    const user = userEvent.setup()
    render(<Auth />)
    await screen.findByText('认证配置')
    await user.click(screen.getByRole('tab', { name: '钉钉扫码' }))

    expect(screen.getByLabelText(/AppKey/)).toHaveValue('dingabcdef')
    expect(screen.getByLabelText(/AppSecret/)).toHaveValue('')
    expect(screen.getByLabelText(/回调地址\(Redirect URL\)/))
      .toHaveValue('https://zeokeel.example.com/api/client/v2/auth/dingtalk/callback')
    expect(screen.getByText(`${window.location.origin}/api/client/v2/auth/dingtalk/callback`)).toBeInTheDocument()
  })

  it('回调地址复制: 写入剪贴板并回显「已复制」', async () => {
    const user = userEvent.setup()
    render(<Auth />)
    await screen.findByText('认证配置')
    await user.click(screen.getByRole('tab', { name: '企业微信扫码' }))

    // copyText 先走异步剪贴板 API;jsdom 没有 → 显式注入(否则回落 execCommand 失败)。
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/api/client/v2/auth/wecom/callback`)
    })
    expect(await screen.findByText('已复制')).toBeInTheDocument()
  })

  it('掩码不回填 + 保存 payload 含 wecom/dingtalk(未改 secret 回传 *** 保持现值)', async () => {
    const user = userEvent.setup()
    render(<Auth />)
    await screen.findByText('认证配置')

    // 企业微信: 已存 secret 显示为空输入框(不回填 ***), 但有「已配置」徽标
    await user.click(screen.getByRole('tab', { name: '企业微信扫码' }))
    expect(screen.getByLabelText(/自建应用 Secret/)).toHaveValue('')
    expect(screen.getByText('已配置')).toBeInTheDocument()

    // 钉钉: 同一套掩码语义
    await user.click(screen.getByRole('tab', { name: '钉钉扫码' }))
    expect(screen.getByLabelText(/AppSecret/)).toHaveValue('')
    expect(screen.getByText('已配置')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[1]?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put![1]!.body))
      // 未重新输入 secret ⇒ 提交 *** 保持现值(不是空串覆盖, 与 oidc/LDAP 同口径)
      expect(body.wecom).toEqual({
        corp_id: 'ww1234567890abcdef',
        agent_id: '1000002',
        secret: '***',
        redirect_url: 'https://zeokeel.example.com/api/client/v2/auth/wecom/callback',
      })
      expect(body.dingtalk).toEqual({
        client_id: 'dingabcdef',
        client_secret: '***',
        redirect_url: 'https://zeokeel.example.com/api/client/v2/auth/dingtalk/callback',
      })
    })
  })

  it('启用企业微信/钉钉: 保存的 enabled 追加两种方式', async () => {
    render(<Auth />)
    await screen.findByText('认证配置')
    fireEvent.click(screen.getByRole('checkbox', { name: /企业微信/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /钉钉/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[1]?.method === 'PUT')
      expect(put).toBeTruthy()
      expect(JSON.parse(String(put![1]!.body)).enabled).toBe('local,ldap,oidc,wecom,dingtalk')
    })
  })

  it('配置不齐: 企业微信开关禁用并提示「配置不完整」', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path === '/api/server/admin/auth') {
        return {
          auth: {
            ...AUTH_SAMPLE.auth,
            wecom: { corp_id: 'ww1234567890abcdef', agent_id: '', secret: '', redirect_url: '' },
          },
        }
      }
      return {}
    })
    render(<Auth />)
    await screen.findByText('认证配置')
    const wecom = screen.getByRole('checkbox', { name: /企业微信/ }) as HTMLInputElement
    expect(wecom.disabled).toBe(true)
    expect(wecom.closest('label')).toHaveTextContent('(配置不完整)')
  })

  it('清空已保存密钥: 保存提交空串(clearedSecrets 既有语义)', async () => {
    const user = userEvent.setup()
    render(<Auth />)
    await screen.findByText('认证配置')
    await user.click(screen.getByRole('tab', { name: '钉钉扫码' }))
    fireEvent.click(screen.getByText('清空已保存密钥'))
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[1]?.method === 'PUT')
      expect(put).toBeTruthy()
      expect(JSON.parse(String(put![1]!.body)).dingtalk.client_secret).toBe('')
    })
  })

  // -------------------------------------------------------------------------
  // 2026-09-23 审计 WEB-2(P0):`GET /auth` 失败时的写面闸门。
  //
  // 原缺陷:`load()` 的 `finally { setLoading(false) }` 是整页**唯一**闸门 ⇒
  // 读取失败后表单照样渲染并解锁,而初值是最空的一份(`enabled=['local']`、
  // `EMPTY_FORM`、`secrets={}`);前端校验只遍历"启用中的非 local"(空循环直接过)
  // ⇒ 一次「保存认证配置」就把 `auth.enabled` 收敛成 `local`、清空 LDAP/OIDC/
  // OpenID 全部字段,并用**空串的密文覆盖已存密钥**(不可恢复,全员 SSO/LDAP
  // 登录当场失败)。本用例锁住"读不到就不许写"。
  // -------------------------------------------------------------------------
  it('WEB-2:GET /auth 失败后写面锁定(保存禁用且不发 PUT),重新加载成功后才解锁', async () => {
    let fail = true
    mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/server/admin/auth' && (init?.method ?? 'GET') === 'GET') {
        if (fail) throw new Error('认证配置读取失败（模拟 500/网络错误）')
        return AUTH_SAMPLE
      }
      if (path === '/api/server/admin/auth' && init?.method === 'PUT') return { ok: true }
      return {}
    })
    render(<Auth />)

    // 错误原因 + "表单已锁定"的说明都在(空表单否则读起来像"当前没有任何认证方式")。
    expect(await screen.findByText(/认证配置读取失败/)).toBeInTheDocument()
    expect(screen.getByText(/表单已锁定/)).toBeInTheDocument()
    const save = screen.getByRole('button', { name: '保存认证配置' })
    expect(save).toBeDisabled()
    // 程序化点击(绕开 disabled)也不能发出那个把 SSO 与密钥抹掉的请求。
    fireEvent.click(save)
    expect(mockRequest.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false)

    // 正向对照(防"永远禁用"式假绿):服务端恢复后「重新加载配置」解锁,
    // 保存提交的是**服务端读到的**启用方式,而不是那份空初值。
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '重新加载配置' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存认证配置' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
    await waitFor(() => {
      const put = mockRequest.mock.calls.find((c) => c[1]?.method === 'PUT')
      expect(put).toBeTruthy()
      const body = JSON.parse(String(put![1]!.body))
      expect(body.enabled).toBe('local,ldap,oidc')
      // 未重新输入密码 ⇒ 回传 *** 保持现值(不是空串覆盖)。
      expect(body.ldap.bind_password).toBe('***')
      expect(body.oidc.client_secret).toBe('***')
      // 扫码方式的 secret 同样只能回传 ***, 不能是空串(那是"清空")。
      expect(body.wecom.secret).toBe('***')
      expect(body.dingtalk.client_secret).toBe('***')
    })
  })

  // -------------------------------------------------------------------------
  // 2026-11-03 外部权限源(RBAC): 扫码后到 RBAC 解析 uid/状态/部门。
  // 服务端契约见 task-5: GET/PUT /auth 的 identity 对象 + /auth/test type=identity。
  // -------------------------------------------------------------------------
  describe('外部权限源(RBAC)', () => {
    it('渲染 identity 配置: 开关/endpoint/令牌掩码/适用方式/超时/同步组', async () => {
      const user = userEvent.setup()
      render(<Auth />)
      await screen.findByText('认证配置')
      await user.click(screen.getByRole('tab', { name: '外部权限源' }))
      const panel = screen.getByTestId('identity-panel')

      const enable = within(panel).getByRole('switch', { name: '启用外部权限源' })
      expect(enable).toHaveAttribute('aria-checked', 'true')
      expect(within(panel).getByLabelText(/解析接口/))
        .toHaveValue('https://rbac.example.com/internal/v1/identity/resolve')
      // 掩码不回填, 只显示「已配置」徽标
      expect(within(panel).getByLabelText(/服务令牌/)).toHaveValue('')
      expect(within(panel).getByText('已配置')).toBeInTheDocument()
      expect(within(panel).getByRole('checkbox', { name: /企业微信/ })).toBeChecked()
      expect(within(panel).getByRole('checkbox', { name: /钉钉/ })).toBeChecked()
      expect(within(panel).getByLabelText(/超时/)).toHaveValue(3000)
      expect(within(panel).getByRole('switch', { name: '用 RBAC 部门替换 ZeoKeel 组' }))
        .toHaveAttribute('aria-checked', 'true')
    })

    it('保存 payload 含 identity(未改令牌回传 *** 保持现值)', async () => {
      render(<Auth />)
      await screen.findByText('认证配置')
      fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
      await waitFor(() => {
        const put = mockRequest.mock.calls.find((c) => c[1]?.method === 'PUT')
        expect(put).toBeTruthy()
        expect(JSON.parse(String(put![1]!.body)).identity).toEqual({
          enabled: true,
          endpoint: 'https://rbac.example.com/internal/v1/identity/resolve',
          token: '***',
          methods: 'wecom,dingtalk',
          timeout_ms: 3000,
          sync_groups: true,
        })
      })
    })

    it('清空已保存令牌: 关闭状态下保存提交空串(不把 *** 当新值)', async () => {
      const user = userEvent.setup()
      mockRequest.mockImplementation(async (path: string) => {
        if (path === '/api/server/admin/auth') {
          return { auth: { ...AUTH_SAMPLE.auth, identity: { ...AUTH_SAMPLE.auth.identity, enabled: false } } }
        }
        return {}
      })
      render(<Auth />)
      await screen.findByText('认证配置')
      await user.click(screen.getByRole('tab', { name: '外部权限源' }))
      const panel = screen.getByTestId('identity-panel')
      fireEvent.click(within(panel).getByText('清空已保存令牌'))
      fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
      await waitFor(() => {
        const put = mockRequest.mock.calls.find((c) => c[1]?.method === 'PUT')
        expect(put).toBeTruthy()
        expect(JSON.parse(String(put![1]!.body)).identity.token).toBe('')
      })
    })

    it('启用但配置不完整: 保存被拒且不发 PUT', async () => {
      mockRequest.mockImplementation(async (path: string) => {
        if (path === '/api/server/admin/auth') {
          return {
            auth: {
              ...AUTH_SAMPLE.auth,
              identity: { ...AUTH_SAMPLE.auth.identity, endpoint: '', methods: '' },
            },
          }
        }
        return {}
      })
      render(<Auth />)
      await screen.findByText('认证配置')
      fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
      expect(await screen.findByText(/外部权限源\(RBAC\)配置不完整/)).toBeInTheDocument()
      expect(mockRequest.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false)
    })

    it('关闭保护: 已有 RBAC 用户时必须勾选确认, 保存带 confirm_disable', async () => {
      const user = userEvent.setup()
      mockRequest.mockImplementation(async (path: string) => {
        if (path === '/api/server/admin/auth') {
          return { auth: { ...AUTH_SAMPLE.auth, identity: { ...AUTH_SAMPLE.auth.identity, rbac_user_count: 3 } } }
        }
        return {}
      })
      render(<Auth />)
      await screen.findByText('认证配置')
      await user.click(screen.getByRole('tab', { name: '外部权限源' }))
      const panel = screen.getByTestId('identity-panel')
      fireEvent.click(within(panel).getByRole('switch', { name: '启用外部权限源' }))
      expect(await within(panel).findByText(/仍有 3 个 RBAC 用户/)).toBeInTheDocument()

      // 未确认 → 前端拒绝, 不发 PUT
      fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
      expect(await screen.findByText(/请勾选「我确认关闭」/)).toBeInTheDocument()
      expect(mockRequest.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false)

      // 勾选确认 → 保存带 confirm_disable:true
      fireEvent.click(within(panel).getByRole('checkbox', { name: /我确认关闭/ }))
      fireEvent.click(screen.getByRole('button', { name: '保存认证配置' }))
      await waitFor(() => {
        const put = mockRequest.mock.calls.find((c) => c[1]?.method === 'PUT')
        expect(put).toBeTruthy()
        const body = JSON.parse(String(put![1]!.body))
        expect(body.identity.enabled).toBe(false)
        expect(body.identity.confirm_disable).toBe(true)
      })
    })

    it('测试解析: 调用 /auth/test(type=identity)并展示 uid/状态/部门', async () => {
      const user = userEvent.setup()
      mockRequest.mockImplementation(async (path: string) => {
        if (path === '/api/server/admin/auth') return AUTH_SAMPLE
        if (path === '/api/server/admin/auth/test') {
          return { ok: true, uid: 'zhangsan', name: '张三', status: 1, departments: ['研发部', '平台组'] }
        }
        return {}
      })
      render(<Auth />)
      await screen.findByText('认证配置')
      await user.click(screen.getByRole('tab', { name: '外部权限源' }))
      const panel = screen.getByTestId('identity-panel')
      fireEvent.change(within(panel).getByLabelText(/渠道用户 ID/), { target: { value: 'zhangsan' } })
      fireEvent.click(within(panel).getByRole('button', { name: '测试解析' }))
      await waitFor(() => {
        const call = mockRequest.mock.calls.find((c) => c[0] === '/api/server/admin/auth/test')
        expect(call).toBeTruthy()
        expect(JSON.parse(String(call![1]!.body))).toEqual({
          type: 'identity',
          provider: 'wecom',
          provider_user_id: 'zhangsan',
          union_id: '',
          mobile: '',
        })
      })
      expect(await within(panel).findByText(/uid:/)).toBeInTheDocument()
      expect(within(panel).getByText(/张三/)).toBeInTheDocument()
      expect(within(panel).getByText(/研发部、平台组/)).toBeInTheDocument()
    })

    it('测试解析: 未启用但已保存 endpoint/令牌时仍可测试（先测后启用）', async () => {
      const user = userEvent.setup()
      mockRequest.mockImplementation(async (path: string) => {
        if (path === '/api/server/admin/auth') {
          return { auth: { ...AUTH_SAMPLE.auth, identity: { ...AUTH_SAMPLE.auth.identity, enabled: false } } }
        }
        return {}
      })
      render(<Auth />)
      await screen.findByText('认证配置')
      await user.click(screen.getByRole('tab', { name: '外部权限源' }))
      const panel = screen.getByTestId('identity-panel')
      expect(within(panel).getByRole('button', { name: '测试解析' })).not.toBeDisabled()
      expect(within(panel).queryByText(/请先填写 endpoint\/令牌并保存后再测试/)).toBeNull()
    })

    it('测试解析: 未保存令牌时禁用并提示先保存', async () => {
      const user = userEvent.setup()
      mockRequest.mockImplementation(async (path: string) => {
        if (path === '/api/server/admin/auth') {
          return { auth: { ...AUTH_SAMPLE.auth, identity: { ...AUTH_SAMPLE.auth.identity, token: '' } } }
        }
        return {}
      })
      render(<Auth />)
      await screen.findByText('认证配置')
      await user.click(screen.getByRole('tab', { name: '外部权限源' }))
      const panel = screen.getByTestId('identity-panel')
      expect(within(panel).getByRole('button', { name: '测试解析' })).toBeDisabled()
      expect(within(panel).getByText(/请先填写 endpoint\/令牌并保存后再测试/)).toBeInTheDocument()
    })
  })
})
