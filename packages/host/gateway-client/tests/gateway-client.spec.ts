/**
 * 网关客户端叶子包的**契约判据**（2026-10-13，P0-b）。
 *
 * 为什么这份用例必须存在、而且必须钉在这儿：`auth.ts` 的实现从
 * `packages/host/enterprise/src/server-connector/auth.ts` 逐字迁到本包后，**三个**
 * 消费面同时依赖它 —— enterprise 的登录门/深链/通道同步、技能模块的四条本机路由、
 * 应用模块的本机路由与工具面。它的错误分类（哪个 401 算"令牌失效"、哪个算"账号被拒"）
 * 决定"要不要清掉本机令牌"，而那是**不可撤销**的动作。以下四条都是历史上真出过事
 * 的口径，逐条钉住：
 *
 *  1. `normalizeServerURL`：尾斜杠必须剥净（否则 `//api/...` 双斜杠）；
 *  2. `fetchJSON` 的 401 分流：只有 `AUTH_REQUIRED` / `AUTH_FAILED` / 老形态 `HTTP_401`
 *     才算 `auth_expired`；`AUDITOR_NOT_ALLOWED` 的凭据是好的，按普通 `ApiError`；
 *     带同样码的 **500** 也不算（服务端存储故障不该把全体在线员工登出）；
 *  3. `isPasswordChangeRequired` 只看稳定码，不看文案；
 *  4. `assertServerURLAllowed`：http 只放行回环。
 *
 * ---- 变异验证（把哪一处改回危险实现时，哪条用例必红）----
 *   - 401 分流去掉 `res.status === 401` 那一半（只看码）⇒ 第 2 组的 500 用例红；
 *   - `AUTH_EXPIRED_CODES` 加上 `AUDITOR_NOT_ALLOWED` ⇒ 第 2 组的审计账号用例红；
 *   - `normalizeServerURL` 改成只剥一个尾斜杠 ⇒ 第 1 组的双斜杠用例红；
 *   - `assertServerURLAllowed` 放过 http 非回环 ⇒ 第 4 组红。
 */
import { describe, expect, it, vi } from 'vitest'
import { ApiError, AuthError, assertServerURLAllowed, fetchJSON, isPasswordChangeRequired, loginWithToken, normalizeServerURL, PASSWORD_CHANGE_REQUIRED_CODE, sessionFromLoginPayload } from '../src/auth.ts'

/** 换掉全局 fetch 并记下出站 URL（判据里没有任何真实出网）。 */
function stubFetch(response: { status: number, body?: unknown, contentType?: string }): { urls: string[], headers: Array<Record<string, string>> } {
  const urls: string[] = []
  const headers: Array<Record<string, string>> = []
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    urls.push(typeof input === 'string' ? input : input.toString())
    headers.push((init?.headers ?? {}) as Record<string, string>)
    const text = response.body === undefined ? '' : JSON.stringify(response.body)
    return Promise.resolve(new Response(text, {
      status: response.status,
      headers: { 'content-type': response.contentType ?? 'application/json' },
    }))
  })
  return { urls, headers }
}

describe('normalizeServerURL：尾斜杠必须剥净', () => {
  it('一个、多个、前后空白都归一成同一个地址', () => {
    expect(normalizeServerURL('https://harness.example.com')).toBe('https://harness.example.com')
    expect(normalizeServerURL('https://harness.example.com/')).toBe('https://harness.example.com')
    expect(normalizeServerURL('  https://harness.example.com///  ')).toBe('https://harness.example.com')
    expect(normalizeServerURL('')).toBe('')
  })

  it('归一后的地址拼 API 路径只出现一个斜杠', () => {
    const { urls } = stubFetch({ status: 200, body: { ok: true } })
    return fetchJSON('https://harness.example.com///', '/api/client/v2/config/bootstrap').then(() => {
      expect(urls[0]).toBe('https://harness.example.com/api/client/v2/config/bootstrap')
    })
  })
})

describe('fetchJSON 的 401 分流（R21-A2-01）', () => {
  it('AUTH_REQUIRED / AUTH_FAILED / 老形态 HTTP_401 ⇒ auth_expired（可以清会话）', async () => {
    for (const code of ['AUTH_REQUIRED', 'AUTH_FAILED']) {
      stubFetch({ status: 401, body: { error: { code, message: 'nope' } } })
      await expect(fetchJSON('https://harness.example.com', '/x')).rejects.toMatchObject({ kind: 'auth_expired' })
    }
    stubFetch({ status: 401, body: {} })
    await expect(fetchJSON('https://harness.example.com', '/x')).rejects.toMatchObject({ kind: 'auth_expired' })
  })

  it('AUDITOR_NOT_ALLOWED 的凭据是好的 ⇒ 普通 ApiError，**不许**清会话', async () => {
    stubFetch({ status: 401, body: { error: { code: 'AUDITOR_NOT_ALLOWED', message: 'no' } } })
    const error = await fetchJSON('https://harness.example.com', '/x').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('AUDITOR_NOT_ALLOWED')
    expect((error as ApiError).status).toBe(401)
  })

  it('带同样码的 500（服务端存储故障）不算 auth_expired —— 否则一次抖动登出全体', async () => {
    stubFetch({ status: 500, body: { error: { code: 'AUTH_FAILED', message: 'storage down' } } })
    const error = await fetchJSON('https://harness.example.com', '/x').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as AuthError).kind).toBeUndefined()
  })

  it('期望 JSON 却拿到 HTML（误指门户页）⇒ 明确 NOT_JSON，而不是含糊的解析失败', async () => {
    stubFetch({ status: 200, body: undefined, contentType: 'text/html' })
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })))
    const error = await fetchJSON('https://harness.example.com', '/x').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('NOT_JSON')
  })
})

describe('isPasswordChangeRequired：只看稳定码', () => {
  it('构造出的 ApiError 带那个码 ⇒ true；带别的码 / 别类错误 ⇒ false', () => {
    expect(isPasswordChangeRequired(new ApiError(PASSWORD_CHANGE_REQUIRED_CODE, '请先改密'))).toBe(true)
    expect(isPasswordChangeRequired(new ApiError('OTHER', '请先改密'))).toBe(false)
    expect(isPasswordChangeRequired(new AuthError('auth_expired'))).toBe(false)
    expect(isPasswordChangeRequired(new Error(PASSWORD_CHANGE_REQUIRED_CODE))).toBe(false)
  })
})

describe('assertServerURLAllowed：http 只放行回环', () => {
  it('https 任意主机通过', () => {
    expect(() => { assertServerURLAllowed('https://harness.example.com') }).not.toThrow()
  })

  it('http 只有 localhost / 127.0.0.1 / [::1] 通过', () => {
    for (const host of ['http://localhost:8080', 'http://127.0.0.1', 'http://[::1]:9000']) {
      expect(() => { assertServerURLAllowed(host) }).not.toThrow()
    }
    expect(() => { assertServerURLAllowed('http://harness.example.com') }).toThrow(AuthError)
  })

  it('不是 URL ⇒ AuthError(server_error)', () => {
    expect(() => { assertServerURLAllowed('not a url') }).toThrow(AuthError)
  })
})

// ---------------------------------------------------------------------------
// 扫码登录：Session 构造的唯一实现（2026-11-03）
// ---------------------------------------------------------------------------

/**
 * 为什么在叶子包钉住：密码登录与扫码登录的 `done` 载荷是同一形状，`Session`
 * 只能有**一处**构造。复制一份的典型失效是漏掉 `must_change_password` ——
 * 管理员重置密码后服务端对每个业务接口回 403，而客户端已经把人放进了应用。
 * 这里逐字段对拍，任何一侧少写一个字段都会红。
 */
describe('sessionFromLoginPayload / loginWithToken：Session 构造的唯一实现', () => {
  it('扫码 done 载荷：token/user/must_change_password 全部落进 Session', () => {
    const sess = loginWithToken(
      'https://harness.example.com/',
      'tok-once',
      { username: 'zhangsan', role: 'user', source: 'external', password_changeable: false },
      true,
    )
    expect(sess).toEqual({
      serverURL: 'https://harness.example.com',
      username: 'zhangsan',
      token: 'tok-once',
      role: 'user',
      source: 'external',
      passwordChangeable: false,
      mustChangePassword: true,
    })
  })

  it('显式账号（密码登录传用户输入）优先于载荷里回显的 username', () => {
    const sess = sessionFromLoginPayload(
      'https://harness.example.com',
      { token: 'tok', user: { username: 'server-canonical', role: 'admin' } },
      'typed-by-user',
    )
    expect(sess.username).toBe('typed-by-user')
    expect(sess.role).toBe('admin')
  })

  it('载荷没有可选字段时不写 undefined（exactOptionalPropertyTypes 的运行时同口径）', () => {
    const sess = loginWithToken('https://harness.example.com', 'tok', { username: 'alice' })
    expect(Object.keys(sess).sort()).toEqual(['serverURL', 'token', 'username'])
  })

  it('缺 token / 缺 username ⇒ AuthError(server_error)，绝不构造半条会话', () => {
    expect(() => loginWithToken('https://harness.example.com', '', { username: 'alice' }))
      .toThrow(AuthError)
    expect(() => loginWithToken('https://harness.example.com', 'tok', undefined))
      .toThrow('missing username in response')
    expect(() => sessionFromLoginPayload('https://harness.example.com', { token: 'tok', user: {} }))
      .toThrow('missing username in response')
    expect(() => sessionFromLoginPayload('https://harness.example.com', { user: { username: 'alice' } }))
      .toThrow('missing token in response')
  })
})
