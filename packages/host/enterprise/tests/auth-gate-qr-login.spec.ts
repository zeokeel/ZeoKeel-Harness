import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../src/server-connector/config.ts'
import { apply as applyAuthGate, renderLoginPage, type Config } from '../src/auth-gate.ts'

/**
 * 企业微信 / 钉钉**扫码登录**的客户端判据（设计文档
 * `docs/planning/2026-11-03-wecom-dingtalk-qr-login.md` §7）。
 *
 * 这条链路有三个各自独立、都必须钉住的信任边界：
 *
 *  1. **页面**（渲染进程）：`/auth/methods` 里 `qr:true` 的方式要进二维码卡片而不是
 *     「浏览器登录」；二维码只能是 PNG data URL，服务端返回的任何其他内容都不许
 *     以标记形式进入登录页（登录页是认证前唯一的 HTML 面）；
 *  2. **宿主本地路由**：start/poll 与 `/api/zeokeel/auth/login` 同口径（guard +
 *     `proofOfPossession('required')`），转发前校验 server 地址；`qr_png` 必须匹配
 *     `^data:image/png;base64,[A-Za-z0-9+/=]+$` 且 ≤200_000，否则 502；
 *  3. **会话落地**：poll `done` 时由**宿主**用服务端 user 构造 `Session` 并
 *     `setSession`；服务端签发的一次性 token 绝不进返回体/页面（页面只有 status）。
 *
 * 夹具说明：本包没有 jsdom。第一半与 `auth-gate-browser-login-pending.spec.ts`
 * 同款 —— 从**真实渲染出的登录页**里切出脚本函数，在最小 DOM 桩上执行；第二半
 * 装真实的 `auth-gate.apply()`，用假 ctx + 打桩 fetch 打真实本地路由。
 */

// ---------------------------------------------------------------------------
// 第一半：登录页脚本（真实模板，函数级执行）
// ---------------------------------------------------------------------------

/** 求值后的登录页内联脚本（真实模板，含运行时占位符替换）。 */
function loginScript(locale: 'zh' | 'en' = 'zh'): string {
  const html = renderLoginPage(locale)
    .replaceAll('__DEFAULT_SERVER__', '')
    .replaceAll('__DEFAULT_SERVER_MARK__', '')
    .replaceAll('__BACK_BUTTON__', '<button type="button" class="back" id="back-btn">← 修改服务端地址</button>')
    .replaceAll('__BRAND_NAME__', 'Test')
    .replaceAll('__BRAND_JSON__', JSON.stringify({
      title: 'Test',
      login: { displayName: 'Test', shortName: 'Test', tagline: '', welcome: '' },
      client: { displayName: 'Test', shortName: 'Test', tagline: '' },
    }))
  return html.match(/<script>([\s\S]*?)<\/script>/i)![1]!
}

/** 切出具名函数的源码（花括号配平；正则截断会在函数体内出现嵌套大括号时失效）。 */
function extractFunction(script: string, header: string): string {
  const start = script.indexOf(header)
  expect(start, `login page script must define ${header}`).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = script.indexOf('{', start); i < script.length; i += 1) {
    if (script[i] === '{') depth += 1
    if (script[i] === '}') {
      depth -= 1
      if (depth === 0) return script.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces while extracting ${header}`)
}

/** 页面脚本里与扫码登录相关的全部函数（依赖关系见各自的函数声明）。 */
const QR_FUNCTIONS = [
  'function trimServer(s)',
  'function esc(s)',
  'function methodLabel(name)',
  'function isQrMethod(name)',
  'function isPngDataURL(value)',
  'function isAllowedQrFrameUrl(value)',
  'function qrMessage(data)',
  'function stopQrTimers()',
  'function hideQrCard()',
  'function qrStatusText(method)',
  'function qrExpired()',
  'function qrFailed(message, code)',
  'function startQrCountdown(generation, seconds)',
  'function startQrPoll(generation)',
  'async function startQr()',
  'function enterQrLogin()',
  'function updateFields()',
  'function renderMethodButtons(methods)',
] as const

interface ElementStub {
  style: Record<string, string>
  textContent: string
  innerHTML: string
  placeholder: string
  value: string
  disabled: boolean
  addEventListener: () => void
  querySelectorAll: () => unknown[]
}

interface FetchCall {
  url: string
  method: string
  body: string
}

interface PageHarness {
  updateFields: () => void
  enterQrLogin: () => void
  hideQrCard: () => void
  renderMethodButtons: (methods: unknown[]) => void
  setMethod: (method: string) => void
  state: () => { currentMethod: string, qrFlowId: string | null, qrMethod: string | null }
  get: (id: string) => ElementStub
  fetchCalls: FetchCall[]
  location: { reload: ReturnType<typeof vi.fn> }
  script: string
}

/** `qr:true` 的方式（服务端 /auth/methods 的形状）。 */
const WECOM = { name: 'wecom', configured: true, browser: false, qr: true, hidden: false }
const DINGTALK = { name: 'dingtalk', configured: true, browser: false, qr: true, hidden: false }
const LOCAL = { name: 'local', configured: true, browser: false, qr: false, hidden: false }
const OIDC = { name: 'oidc', configured: true, browser: true, qr: false, hidden: false }

/** 一份合法的服务端二维码（PNG data URL；体积远小于宿主上限）。 */
const PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='}`

/** 一次合法的 start 响应。 */
const FLOW_ID = 'a'.repeat(64)

/** 页面脚本默认显示状态（与模板里的 style="display:none" 对齐）。 */
const INITIAL_STYLE: Record<string, Record<string, string>> = {
  'qr-card': { display: 'none' },
  'qr-refresh': { display: 'none' },
  'browser-btn': { display: 'none' },
  waiting: { display: 'none' },
}

/**
 * 在最小 DOM 桩上执行**真实登录页脚本**里的扫码函数。
 * @param options - 方法列表、初始选中方式、服务端地址与 fetch 应答。
 * @returns 可调用的页面函数与观察面。
 */
function bootLoginPage(options: {
  methods: unknown[]
  method?: string
  server?: string
  /** 页面语言（默认 zh；en 用于验证失败文案按 code 本地化）。 */
  locale?: 'zh' | 'en'
  respond: (url: string) => { status: number, body: unknown }
}): PageHarness {
  const script = loginScript(options.locale ?? 'zh')
  // 自有断言：模板求值后的脚本必须仍是合法 JS（捕获 `\/` 之类转义破坏）。
  expect(() => { new Function(script) }).not.toThrow() // eslint-disable-line no-new-func

  // 页面文案由 `var T = {...}`（按语言注入）提供，从**真实脚本**里取这份字面量。
  const tLiteral = script.match(/var T = (\{[\s\S]*?\})\n/u)?.[1]
  expect(tLiteral, 'login page script must define the copy table T').toBeDefined()

  const elements = new Map<string, ElementStub>()
  const fakeDocument = {
    getElementById: (id: string): ElementStub => {
      let element = elements.get(id)
      if (element === undefined) {
        element = {
          style: { ...(INITIAL_STYLE[id] ?? {}) },
          textContent: '',
          innerHTML: '',
          placeholder: '',
          value: id === 'server' ? (options.server ?? 'https://harness.example') : '',
          disabled: false,
          addEventListener: () => {},
          querySelectorAll: () => [],
        }
        elements.set(id, element)
      }
      return element
    },
  }

  const fetchCalls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string, body?: string }) => {
    const url = String(input)
    fetchCalls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: typeof init?.body === 'string' ? init.body : '' })
    const { status, body } = options.respond(url)
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }))
  const location = { reload: vi.fn() }

  const factory = new Function('document', 'location', `
    var T = ${tLiteral}
    var currentMethod = ${JSON.stringify(options.method ?? 'wecom')}
    var currentMethods = ${JSON.stringify(options.methods)}
    var methodsBox = document.getElementById('methods')
    var f2 = document.getElementById('f2')
    var browserBtn = document.getElementById('browser-btn')
    var waiting = document.getElementById('waiting')
    var err2 = document.getElementById('err-step2')
    var qrCard = document.getElementById('qr-card')
    var qrFrame = document.getElementById('qr-frame')
    var qrTitle = document.getElementById('qr-title')
    var qrHint = document.getElementById('qr-hint')
    var qrRefreshBtn = document.getElementById('qr-refresh')
    var qrTimer = null
    var qrTick = null
    var qrFlowId = null
    var qrMethod = null
    var qrDeadline = 0
    var qrGeneration = 0
    ${QR_FUNCTIONS.map(header => extractFunction(script, header)).join('\n    ')}
    return {
      updateFields: updateFields,
      enterQrLogin: enterQrLogin,
      hideQrCard: hideQrCard,
      renderMethodButtons: renderMethodButtons,
      setMethod: function (m) { currentMethod = m },
      state: function () { return { currentMethod: currentMethod, qrFlowId: qrFlowId, qrMethod: qrMethod } },
      get: function (id) { return document.getElementById(id) },
    }
  `) // eslint-disable-line no-new-func

  return {
    ...factory(fakeDocument, location) as Omit<PageHarness, 'fetchCalls' | 'location' | 'script'>,
    fetchCalls,
    location,
    script,
  }
}

describe('登录页：扫码登录（企业微信/钉钉）', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('qr:true 的 wecom/dingtalk 渲染为「企业微信」「钉钉」按钮（而不是原始方式名）', () => {
    const page = bootLoginPage({
      methods: [LOCAL, WECOM, DINGTALK],
      respond: () => ({ status: 200, body: {} }),
    })
    page.renderMethodButtons([LOCAL, WECOM, DINGTALK])
    const html = page.get('methods').innerHTML
    expect(html).toContain('data-method="wecom"')
    expect(html).toContain('data-method="dingtalk"')
    expect(html).toContain('>企业微信</button>')
    expect(html).toContain('>钉钉</button>')
    // 未配置的方式仍然灰显（既有行为不回归）。注意：只有一个方式时按钮区整体
    // 隐藏（既有产品行为），所以这里给两个方式。
    page.renderMethodButtons([WECOM, { name: 'dingtalk', configured: false, qr: true }])
    expect(page.get('methods').innerHTML).toContain('disabled')
  })

  it('选中扫码方式 → 二维码卡片 + 宿主 start 请求，不再显示浏览器按钮/waiting', async () => {
    vi.useFakeTimers()
    const page = bootLoginPage({
      methods: [WECOM],
      method: 'wecom',
      respond: (url) => url === '/api/zeokeel/auth/qr/start'
        ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }
        : { status: 200, body: { status: 'pending' } },
    })

    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)

    const start = page.fetchCalls.find(call => call.url === '/api/zeokeel/auth/qr/start')
    expect(start, '选中扫码方式必须向宿主发起 start').toBeDefined()
    expect(start!.method).toBe('POST')
    expect(JSON.parse(start!.body)).toEqual({ server: 'https://harness.example', method: 'wecom' })

    expect(page.get('qr-card').style.display).not.toBe('none')
    expect(page.get('browser-btn').style.display).toBe('none')
    expect(page.get('waiting').style.display).toBe('none')
    expect(page.get('qr-title').textContent).toBe('使用 企业微信 扫码登录')
    // 二维码只以 img 形式进入页面，且 src 经过属性转义（数据 URL 无特殊字符）。
    expect(page.get('qr-frame').innerHTML).toBe(`<img class="qr-img" alt="QR" src="${PNG}">`)
    expect(page.get('qr-hint').textContent).toContain('企业微信')
    expect(page.get('qr-hint').textContent).toContain('秒后过期')

    // 2s 轮询：flow_id/method/server 都必须带回去。
    await vi.advanceTimersByTimeAsync(2000)
    const poll = page.fetchCalls.find(call => call.url.startsWith('/api/zeokeel/auth/qr/poll?'))
    expect(poll, '拿码后必须每 2s 轮询').toBeDefined()
    expect(poll!.url).toContain('server=https%3A%2F%2Fharness.example')
    expect(poll!.url).toContain('method=wecom')
    expect(poll!.url).toContain(`flow_id=${FLOW_ID}`)
  })

  it('钉钉方式的卡片标题/提示用「钉钉」而不是方式名', async () => {
    vi.useFakeTimers()
    const page = bootLoginPage({
      methods: [DINGTALK],
      method: 'dingtalk',
      respond: () => ({ status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }),
    })
    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)
    expect(page.get('qr-title').textContent).toBe('使用 钉钉 扫码登录')
    expect(page.get('qr-hint').textContent).toContain('钉钉')
  })

  it('服务端返回的二维码不是 PNG data URL 时页面不渲染（SVG/HTML 无进入路径）', async () => {
    vi.useFakeTimers()
    for (const hostile of [
      'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+',
      '<img src=x onerror=alert(1)>',
      'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    ]) {
      const page = bootLoginPage({
        methods: [WECOM],
        method: 'wecom',
        respond: () => ({ status: 200, body: { flow_id: FLOW_ID, qr_png: hostile, expires_in: 300 } }),
      })
      page.updateFields()
      await vi.advanceTimersByTimeAsync(0)
      expect(page.get('qr-frame').innerHTML, hostile).toBe('')
      expect(page.get('err-step2').textContent).not.toBe('')
      expect(page.get('qr-refresh').style.display).toBe('')
      vi.unstubAllGlobals()
    }
  })

  it('start 失败（429/网关错误）显示可读文案与「刷新二维码」入口', async () => {
    vi.useFakeTimers()
    const page = bootLoginPage({
      methods: [WECOM],
      method: 'wecom',
      respond: () => ({ status: 429, body: { error: '请求过于频繁' } }),
    })
    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)
    expect(page.get('qr-frame').innerHTML).toBe('')
    // 宿主自己的错误信封是诊断文本（gateway error: …），不直接当用户文案显示；
    // 页面落回本地化提示，不会把英文/内部细节漏进登录页。
    expect(page.get('err-step2').textContent).toBe('无法获取登录二维码，请重试')
    expect(page.get('err-step2').textContent).not.toContain('请求过于频繁')
    expect(page.get('qr-refresh').style.display).toBe('')
    // 失败后不得继续轮询（没有 flow_id 可轮）。
    const before = page.fetchCalls.length
    await vi.advanceTimersByTimeAsync(6000)
    expect(page.fetchCalls.length).toBe(before)
  })

  it('轮询 done → location.reload()，且页面拿不到 token（只有 status）', async () => {
    vi.useFakeTimers()
    const page = bootLoginPage({
      methods: [WECOM],
      method: 'wecom',
      respond: (url) => url === '/api/zeokeel/auth/qr/start'
        ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }
        : { status: 200, body: { status: 'done' } },
    })
    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(page.location.reload).toHaveBeenCalledTimes(1)
    // done 之后轮询停止（页面即将重载，不允许继续打宿主）。
    const before = page.fetchCalls.length
    await vi.advanceTimersByTimeAsync(8000)
    expect(page.fetchCalls.length).toBe(before)
  })

  it('轮询 failed 透出服务端可读 message 并停止轮询', async () => {
    vi.useFakeTimers()
    const page = bootLoginPage({
      methods: [WECOM],
      method: 'wecom',
      respond: (url) => url === '/api/zeokeel/auth/qr/start'
        ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }
        : { status: 200, body: { status: 'failed', message: '账号已被禁用，请联系管理员' } },
    })
    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(page.get('err-step2').textContent).toContain('账号已被禁用')
    expect(page.get('qr-refresh').style.display).toBe('')
    expect(page.location.reload).not.toHaveBeenCalled()
  })

  it('failed 带 RBAC 稳定 code 时按 code 显示本地化文案（zh/en 各一份，服务端中文不串台）', async () => {
    const cases = [
      ['IDENTITY_NOT_BOUND', '你的企业账号尚未在 RBAC 中绑定员工身份，请联系管理员',
        'Your enterprise account is not linked to an employee identity in RBAC. Contact your administrator.'],
      ['IDENTITY_DISABLED', '你的账号已在 RBAC 中停用，请联系管理员',
        'Your account has been disabled in RBAC. Contact your administrator.'],
      ['IDENTITY_AMBIGUOUS', '你的身份在 RBAC 中不唯一，请联系管理员处理',
        'Your identity is ambiguous in RBAC. Contact your administrator.'],
      ['IDENTITY_PROVIDER_UNAVAILABLE', '身份服务暂不可用，请稍后重试',
        'The identity service is temporarily unavailable. Please try again later.'],
      ['IDENTITY_CONFLICT', '该用户名已被本地账号占用，请联系管理员',
        'This username is already taken by a local account. Contact your administrator.'],
    ] as const
    for (const [code, zh, en] of cases) {
      for (const [locale, want] of [['zh', zh], ['en', en]] as const) {
        vi.useFakeTimers()
        const page = bootLoginPage({
          methods: [WECOM],
          method: 'wecom',
          locale,
          respond: (url) => url === '/api/zeokeel/auth/qr/start'
            ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }
            // 服务端 message 是中文；英文页面必须显示本地化文案而不是它。
            : { status: 200, body: { status: 'failed', message: '服务端中文兜底', code } },
        })
        page.updateFields()
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(2000)
        expect(page.get('err-step2').textContent, `${locale}/${code}`).toBe(want)
        expect(page.get('qr-refresh').style.display).toBe('')
        vi.unstubAllGlobals()
      }
    }
  })

  it('未知 / 缺失 code 回落 message；message 也缺失时回落默认文案', async () => {
    for (const [code, message, want] of [
      ['SOMETHING_ELSE', '服务端说明', '服务端说明'],
      // 原型链上的键不能被当成合法 code（hasOwnProperty 守卫）。
      ['toString', '服务端说明', '服务端说明'],
      ['', '', '扫码登录失败，请重试'],
    ] as const) {
      vi.useFakeTimers()
      const page = bootLoginPage({
        methods: [WECOM],
        method: 'wecom',
        respond: (url) => url === '/api/zeokeel/auth/qr/start'
          ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }
          : { status: 200, body: { status: 'failed', message, code } },
      })
      page.updateFields()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2000)
      expect(page.get('err-step2').textContent, `code=${code}`).toBe(want)
      vi.unstubAllGlobals()
    }
  })

  it('轮询 expired 显示过期文案；服务端 404（已消费）按过期处理', async () => {
    vi.useFakeTimers()
    for (const response of [
      { status: 200, body: { status: 'expired' } },
      { status: 404, body: { error: 'flow gone' } },
    ]) {
      const page = bootLoginPage({
        methods: [WECOM],
        method: 'wecom',
        respond: (url) => url === '/api/zeokeel/auth/qr/start'
          ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }
          : response,
      })
      page.updateFields()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2000)
      expect(page.get('qr-hint').textContent).toContain('二维码已过期')
      expect(page.get('qr-refresh').style.display).toBe('')
      vi.unstubAllGlobals()
    }
  })

  it('start 返回合法 qr_url 时嵌 iframe（官方页面自己完成回调），非法则回落 PNG', async () => {
    vi.useFakeTimers()
    const qrUrl = 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=ww-corp&agentid=100001&state=s'
    const page = bootLoginPage({
      methods: [WECOM],
      method: 'wecom',
      respond: (url) => url === '/api/zeokeel/auth/qr/start'
        ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, qr_url: qrUrl, expires_in: 300 } }
        : { status: 200, body: { status: 'pending' } },
    })
    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)
    const frame = page.get('qr-frame').innerHTML
    expect(frame).toContain('<iframe')
    expect(frame).toContain('src="https://open.work.weixin.qq.com/')
    expect(frame).toContain('qrConnect?')
    expect(frame).not.toContain('<img')

    const bad = bootLoginPage({
      methods: [WECOM],
      method: 'wecom',
      respond: (url) => url === '/api/zeokeel/auth/qr/start'
        ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, qr_url: 'https://evil.example/qr', expires_in: 300 } }
        : { status: 200, body: { status: 'pending' } },
    })
    bad.updateFields()
    await vi.advanceTimersByTimeAsync(0)
    expect(bad.get('qr-frame').innerHTML).toBe(`<img class="qr-img" alt="QR" src="${PNG}">`)
  })

  it('倒计时到 0 即本地判定过期（不等下一次 poll）', async () => {
    vi.useFakeTimers()
    const page = bootLoginPage({
      methods: [WECOM],
      method: 'wecom',
      respond: (url) => url === '/api/zeokeel/auth/qr/start'
        ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 3 } }
        : { status: 200, body: { status: 'pending' } },
    })
    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4000)
    expect(page.get('qr-hint').textContent).toContain('二维码已过期')
    expect(page.get('qr-refresh').style.display).toBe('')
  })

  it('切换方式（扫码 → 浏览器）停止轮询、复位卡片并露出浏览器按钮', async () => {
    vi.useFakeTimers()
    const page = bootLoginPage({
      methods: [WECOM, OIDC],
      method: 'wecom',
      respond: (url) => url === '/api/zeokeel/auth/qr/start'
        ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }
        : { status: 200, body: { status: 'pending' } },
    })
    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)

    page.setMethod('oidc')
    page.updateFields()
    expect(page.get('qr-card').style.display).toBe('none')
    expect(page.get('qr-frame').innerHTML).toBe('')
    expect(page.get('browser-btn').style.display).not.toBe('none')
    expect(page.state().qrFlowId).toBeNull()

    const before = page.fetchCalls.length
    await vi.advanceTimersByTimeAsync(8000)
    expect(page.fetchCalls.length, '切换后不得再轮询旧 flow').toBe(before)
  })

  it('返回 Step1（hideQrCard）同样停止轮询并复位', async () => {
    vi.useFakeTimers()
    const page = bootLoginPage({
      methods: [WECOM],
      method: 'wecom',
      respond: (url) => url === '/api/zeokeel/auth/qr/start'
        ? { status: 200, body: { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 } }
        : { status: 200, body: { status: 'pending' } },
    })
    page.updateFields()
    await vi.advanceTimersByTimeAsync(0)
    page.hideQrCard()
    expect(page.get('qr-card').style.display).toBe('none')
    expect(page.state().qrFlowId).toBeNull()
    const before = page.fetchCalls.length
    await vi.advanceTimersByTimeAsync(8000)
    expect(page.fetchCalls.length).toBe(before)
  })

  it('扫码文案 zh/en 各一份，en 侧不含中文（LOGIN_COPY 新增键必须成对）', () => {
    const enScript = renderLoginPage('en').match(/<script>([\s\S]*?)<\/script>/i)![1]!
    const enT = enScript.match(/var T = (\{[\s\S]*?\})\n/u)?.[1]
    expect(enT).toBeDefined()
    expect(enT).toContain('Refresh code')
    expect(enT).toContain('Scan with {method} to sign in')
    // 整份 en 文案（含既有键）都不许出现中文 —— 扫码键漏翻会在这里红。
    expect(enT).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u)

    const zhScript = renderLoginPage('zh').match(/<script>([\s\S]*?)<\/script>/i)![1]!
    const zhT = zhScript.match(/var T = (\{[\s\S]*?\})\n/u)?.[1]
    expect(zhT).toContain('刷新二维码')
    expect(zhT).toContain('使用 {method} 扫码登录')
  })

  it('页面脚本只把已校验的 PNG data URL 经 esc() 拼进 img src', () => {
    const script = loginScript()
    // 唯一允许进入 innerHTML 的服务端内容：校验过的 data URL，且仍走属性转义。
    expect(script).toContain(`qrFrame.innerHTML = '<img class="qr-img" alt="QR" src="' + esc(data.qr_png) + '">'`)
    // 服务端字段不得以裸插值进入 innerHTML（例如 data.qr_png 直接拼）。
    expect(script).not.toContain("innerHTML = data.qr_png")
    expect(script).not.toContain('qrFrame.innerHTML = data.qr_png')
    // 二维码形态的页面侧判据：前缀 + base64 字符集 + 长度上限。
    expect(script).toContain("var prefix = 'data:image/png;base64,'")
    expect(script).toContain('value.length > 200000')
    // 轮询必须固定 2s（设计文档 §4.3/§7）。
    expect(script).toContain('}, 2000)')
    // 扫码路径不开浏览器窗口、不写深链。
    expect(extractFunction(script, 'async function startQr()')).not.toContain('window.open')
    expect(extractFunction(script, 'function startQrPoll(generation)')).not.toContain('window.open')
  })
})

// ---------------------------------------------------------------------------
// 第二半：宿主本地路由（真实 auth-gate.apply）
// ---------------------------------------------------------------------------

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

/** 让 `guard()` 放行的最小伪造头；`withCookie` = 真页面持有的 dsh-auth cookie。 */
function fakeReq(method: string, url: string, body?: string, withCookie = false): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: {
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...(withCookie ? { cookie: 'dsh-auth-127.0.0.1:3080=v1.signature' } : {}),
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  } as unknown as IncomingMessage
}

interface ResCapture {
  code: number
  body: any
}

function fakeRes(): { res: ServerResponse, read: () => ResCapture } {
  let code = 0
  let body: unknown
  const res = {
    writeHead: (value: number) => { code = value },
    end: (chunk?: string | Buffer) => {
      body = chunk === undefined ? undefined : JSON.parse(chunk.toString())
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ code, body }) }
}

interface HostHarness {
  call: (path: string, req: IncomingMessage) => Promise<ResCapture>
  setSession: ReturnType<typeof vi.fn>
  warns: string[]
}

/**
 * 装一个真实的 auth-gate（未登录）+ 默认的打桩 fetch。
 *
 * 默认桩不产生任何真实出网；具体用例用 {@link stubGateway} 覆盖成按 URL 应答，
 * 并记录宿主实际发往网关的请求 —— "QR 代理把什么发给了服务端"本身就是安全判据
 * （server/method/flow_id）。
 * @param current - 已登录会话（缺省 null = 未登录；QR 登录发生在登录页）。
 * @returns 本地路由调用面与会话观察面。
 */
function hostHarness(current: Session | null = null): HostHarness {
  const routes = new Map<string, Route['handler']>()
  const setSession = vi.fn()
  const warns: string[] = []
  const fence = {
    requestRejection: (req: { headers: Record<string, unknown> }) =>
      (req.headers['cookie'] === undefined ? (401 as const) : undefined),
  }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    provide: () => {},
    get: (name: string) => (name === 'connection' ? fence : undefined),
    logger: { info: vi.fn(), warn: (message: string) => { warns.push(String(message)) }, error: vi.fn() },
    zeokeelSession: {
      isRestored: () => true,
      isLoggedIn: () => current !== null,
      getSession: () => current,
      setSession,
      clear: vi.fn(),
    },
    webServer: {
      tapIndex: () => () => {},
      register: (route: Route) => { routes.set(route.path, route.handler); return () => {} },
    },
  }
  applyAuthGate(ctx as never, {} as Config)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))

  return {
    setSession,
    warns,
    call: async (path: string, req: IncomingMessage) => {
      const handler = routes.get(path)
      if (handler === undefined) throw new Error(`no route ${path}`)
      const { res, read } = fakeRes()
      await handler(req, res)
      return read()
    },
  }
}

/** 一条合法的 start 响应体。 */
const START_BODY = { flow_id: FLOW_ID, qr_png: PNG, expires_in: 300 }

/** 打桩一个按序应答的网关 fetch；返回出站记录。 */
function stubGateway(
  respond: (url: string, init?: { method?: string, body?: string }) => { status: number, body: unknown },
): Array<{ url: string, method: string, body: string }> {
  const calls: Array<{ url: string, method: string, body: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string, body?: string }) => {
    const url = String(input)
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: typeof init?.body === 'string' ? init.body : '' })
    const { status, body } = respond(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

describe('宿主路由：/api/zeokeel/auth/qr/start', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('转发到服务端 /api/client/v2/auth/<method>/qr/start 并只回 {flow_id, qr_png, expires_in}', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({ status: 200, body: START_BODY }))
    const { code, body } = await h.call('/api/zeokeel/auth/qr/start', fakeReq(
      'POST', '/api/zeokeel/auth/qr/start',
      '{"server":"https://harness.example/","method":"wecom"}', true,
    ))
    expect(code).toBe(200)
    expect(body).toEqual(START_BODY)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://harness.example/api/client/v2/auth/wecom/qr/start')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toBe('{}')
  })

  it('非 PNG / 超长 / 畸形 qr_png 一律 502，且不回显服务端内容', async () => {
    const hostileBodies = [
      { flow_id: FLOW_ID, qr_png: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+', expires_in: 300 },
      { flow_id: FLOW_ID, qr_png: '<img src=x onerror=alert(1)>', expires_in: 300 },
      { flow_id: FLOW_ID, qr_png: `data:image/png;base64,${'A'.repeat(200_001)}`, expires_in: 300 },
      { flow_id: FLOW_ID, qr_png: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', expires_in: 300 },
      { flow_id: 'not hex!', qr_png: PNG, expires_in: 300 },
      { flow_id: FLOW_ID, expires_in: 300 },
    ]
    for (const hostile of hostileBodies) {
      const h = hostHarness()
      stubGateway(() => ({ status: 200, body: hostile }))
      const { code, body } = await h.call('/api/zeokeel/auth/qr/start', fakeReq(
        'POST', '/api/zeokeel/auth/qr/start',
        '{"server":"https://harness.example","method":"wecom"}', true,
      ))
      expect(code, JSON.stringify(hostile).slice(0, 60)).toBe(502)
      expect(JSON.stringify(body)).not.toContain('svg')
      expect(JSON.stringify(body)).not.toContain('onerror')
      expect(h.warns.join(' ')).toContain('malformed QR start payload')
      vi.unstubAllGlobals()
    }
  })

  it('只接受 wecom/dingtalk：其他 method 不转发、400', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({ status: 200, body: START_BODY }))
    for (const method of ['oidc', 'openid', '../admin', '']) {
      const { code } = await h.call('/api/zeokeel/auth/qr/start', fakeReq(
        'POST', '/api/zeokeel/auth/qr/start',
        JSON.stringify({ server: 'https://harness.example', method }), true,
      ))
      expect(code, method).toBe(400)
    }
    expect(calls).toEqual([])
  })

  it('没有持有性证明（伪造 Origin 的本地进程）→ 403 且零出站', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({ status: 200, body: START_BODY }))
    const { code, body } = await h.call('/api/zeokeel/auth/qr/start', fakeReq(
      'POST', '/api/zeokeel/auth/qr/start',
      '{"server":"https://harness.example","method":"wecom"}',
    ))
    expect(code).toBe(403)
    expect(body.error).toBe('browser session proof required')
    expect(calls).toEqual([])
  })

  it('server 地址不合规（http 非回环 / file:）→ 400 且零出站', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({ status: 200, body: START_BODY }))
    for (const server of ['http://harness.example', 'file:///etc/passwd', 'https://']) {
      const { code } = await h.call('/api/zeokeel/auth/qr/start', fakeReq(
        'POST', '/api/zeokeel/auth/qr/start',
        JSON.stringify({ server, method: 'wecom' }), true,
      ))
      expect(code, server).toBe(400)
    }
    expect(calls).toEqual([])
  })

  it('服务端 404（未配置/禁用）与 429（限流）保留状态码，其余网关失败 502', async () => {
    for (const [status, expected] of [[404, 404], [429, 429], [500, 502]] as const) {
      const h = hostHarness()
      stubGateway(() => ({ status, body: { error: { code: `HTTP_${status}`, message: `upstream ${status}` } } }))
      const { code } = await h.call('/api/zeokeel/auth/qr/start', fakeReq(
        'POST', '/api/zeokeel/auth/qr/start',
        '{"server":"https://harness.example","method":"dingtalk"}', true,
      ))
      expect(code, String(status)).toBe(expected)
      vi.unstubAllGlobals()
    }
  })

  it('非 POST → 405', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({ status: 200, body: START_BODY }))
    const { code } = await h.call('/api/zeokeel/auth/qr/start', fakeReq('GET', '/api/zeokeel/auth/qr/start', undefined, true))
    expect(code).toBe(405)
    expect(calls).toEqual([])
  })
})

describe('宿主路由：/api/zeokeel/auth/qr/poll', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /** 一条 poll 请求（真页面持 cookie）。 */
  const pollReq = (server = 'https://harness.example', method = 'wecom', flowId = FLOW_ID): IncomingMessage =>
    fakeReq('GET', `/api/zeokeel/auth/qr/poll?server=${encodeURIComponent(server)}&method=${method}&flow_id=${flowId}`, undefined, true)

  it('done → 用服务端 user 构造 Session 并 setSession，回 {status:"done"}（token 不进返回体）', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({
      status: 200,
      body: {
        status: 'done',
        token: 'tok-once',
        user: { username: 'zhangsan', display_name: '张三', role: 'user', source: 'external', password_changeable: false },
        must_change_password: false,
      },
    }))
    const { code, body } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
    expect(code).toBe(200)
    expect(body).toEqual({ status: 'done' })
    expect(JSON.stringify(body)).not.toContain('tok-once')
    expect(calls[0]!.url).toBe(`https://harness.example/api/client/v2/auth/wecom/qr/poll?flow_id=${FLOW_ID}`)
    expect(h.setSession).toHaveBeenCalledTimes(1)
    expect(h.setSession).toHaveBeenCalledWith({
      serverURL: 'https://harness.example',
      username: 'zhangsan',
      token: 'tok-once',
      role: 'user',
      source: 'external',
      passwordChangeable: false,
      displayName: '张三',
      provider: 'wecom',
    })
  })

  it('done + must_change_password → 会话带 mustChangePassword（索引渲染据此进改密页）', async () => {
    const h = hostHarness()
    stubGateway(() => ({
      status: 200,
      body: {
        status: 'done',
        token: 'tok-once',
        user: { username: 'lisi', role: 'user', source: 'external', password_changeable: false },
        must_change_password: true,
      },
    }))
    const { code } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
    expect(code).toBe(200)
    expect(h.setSession).toHaveBeenCalledWith(expect.objectContaining({ username: 'lisi', mustChangePassword: true }))
  })

  it('已登录到另一台服务端时 done → 409 拒绝静默换服务端（与 login/FIX-18 同判定）', async () => {
    const current: Session = { serverURL: 'https://other.example', username: 'alice', token: 'tok-current' }
    const h = hostHarness(current)
    stubGateway(() => ({
      status: 200,
      body: {
        status: 'done',
        token: 'tok-should-not-leak',
        user: { username: 'eve', role: 'user', source: 'external', password_changeable: false },
      },
    }))
    const { code, body } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
    expect(code).toBe(409)
    expect(body).toEqual({
      error: 'already signed in to another server',
      hint: 'sign out before switching servers',
    })
    // 会话一个字节都不许换；done 里那枚 token 也不许出现在响应/日志里。
    expect(h.setSession).not.toHaveBeenCalled()
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('tok-should-not-leak')
    expect(serialized).not.toContain('tok-current')
    expect(h.warns.join(' ')).toContain('refused a server switch while signed in (qr poll)')
  })

  it('同一服务端上换账号仍放行（改密/换人是合法动作；尾斜杠书写变体不算换服务端）', async () => {
    const current: Session = { serverURL: 'https://harness.example', username: 'alice', token: 'tok-current' }
    const h = hostHarness(current)
    stubGateway(() => ({
      status: 200,
      body: {
        status: 'done',
        token: 'tok-once',
        user: { username: 'zhangsan', role: 'user', source: 'external', password_changeable: false },
      },
    }))
    // 服务端地址带尾斜杠：归一后仍是同一台，不得误判成"换服务端"。
    const { code, body } = await h.call('/api/zeokeel/auth/qr/poll', pollReq('https://harness.example/'))
    expect(code).toBe(200)
    expect(body).toEqual({ status: 'done' })
    expect(h.setSession).toHaveBeenCalledTimes(1)
    expect(h.setSession).toHaveBeenCalledWith(expect.objectContaining({
      serverURL: 'https://harness.example',
      username: 'zhangsan',
      token: 'tok-once',
    }))
  })

  it('pending 不建会话，原样回 pending', async () => {
    const h = hostHarness()
    stubGateway(() => ({ status: 200, body: { status: 'pending' } }))
    const { code, body } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
    expect(code).toBe(200)
    expect(body).toEqual({ status: 'pending' })
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('failed 只透出可读 message 与白名单 code，不建会话', async () => {
    const h = hostHarness()
    stubGateway(() => ({ status: 200, body: { status: 'failed', error: { code: 'AUTH_FAILED', message: '账号已禁用' } } }))
    const { code, body } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
    expect(code).toBe(200)
    // AUTH_FAILED 不在 RBAC 身份解析白名单内 ⇒ code 丢弃，只留 message。
    expect(body).toEqual({ status: 'failed', message: '账号已禁用', code: '' })
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('failed 透传白名单内的稳定 code；白名单外 / 非字符串一律丢弃', async () => {
    const h = hostHarness()
    stubGateway(() => ({ status: 200, body: { status: 'failed', error: { code: 'IDENTITY_NOT_BOUND', message: '未绑定员工身份' } } }))
    const ok = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
    expect(ok.code).toBe(200)
    expect(ok.body).toEqual({ status: 'failed', message: '未绑定员工身份', code: 'IDENTITY_NOT_BOUND' })

    for (const rawCode of ['IDENTITY_NOPE', 'AUTH_FAILED', 123, null, { code: 'IDENTITY_DISABLED' }]) {
      stubGateway(() => ({ status: 200, body: { status: 'failed', error: { code: rawCode, message: '兜底' } } }))
      const { body } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
      expect(body).toEqual({ status: 'failed', message: '兜底', code: '' })
    }
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('expired 原样透传', async () => {
    const h = hostHarness()
    stubGateway(() => ({ status: 200, body: { status: 'expired' } }))
    const { code, body } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
    expect(code).toBe(200)
    expect(body).toEqual({ status: 'expired' })
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('done 但缺 token / 缺 username → 502 且不建会话（服务端坏载荷不得变成半条会话）', async () => {
    const payloads = [
      { status: 'done', user: { username: 'zhangsan' } },
      { status: 'done', token: 'tok-once', user: {} },
      { status: 'done', token: 'tok-once' },
      { status: 'weird' },
      null,
    ]
    for (const payload of payloads) {
      const h = hostHarness()
      stubGateway(() => ({ status: 200, body: payload }))
      const { code } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
      expect(code, JSON.stringify(payload)).toBe(502)
      expect(h.setSession).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    }
  })

  it('没有持有性证明 → 403 且零出站', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({ status: 200, body: { status: 'pending' } }))
    const { code, body } = await h.call('/api/zeokeel/auth/qr/poll', fakeReq(
      'GET', `/api/zeokeel/auth/qr/poll?server=${encodeURIComponent('https://harness.example')}&method=wecom&flow_id=${FLOW_ID}`,
    ))
    expect(code).toBe(403)
    expect(body.error).toBe('browser session proof required')
    expect(calls).toEqual([])
  })

  it('malformed flow_id / 未知 method / 不安全 server → 400 且零出站', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({ status: 200, body: { status: 'pending' } }))
    const cases = [
      pollReq('https://harness.example', 'wecom', 'a/b'),
      pollReq('https://harness.example', 'wecom', ''),
      pollReq('https://harness.example', 'oidc', FLOW_ID),
      pollReq('http://harness.example', 'wecom', FLOW_ID),
    ]
    for (const req of cases) {
      const { code } = await h.call('/api/zeokeel/auth/qr/poll', req)
      expect(code, String(req.url)).toBe(400)
    }
    expect(calls).toEqual([])
  })

  it('网关侧 404（flow 已消费）保留 404，页面据此按过期处理', async () => {
    const h = hostHarness()
    stubGateway(() => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: '流程不存在或已失效' } } }))
    const { code } = await h.call('/api/zeokeel/auth/qr/poll', pollReq())
    expect(code).toBe(404)
  })

  it('非 GET → 405', async () => {
    const h = hostHarness()
    const calls = stubGateway(() => ({ status: 200, body: { status: 'pending' } }))
    const { code } = await h.call('/api/zeokeel/auth/qr/poll', fakeReq(
      'POST', `/api/zeokeel/auth/qr/poll?server=${encodeURIComponent('https://harness.example')}&method=wecom&flow_id=${FLOW_ID}`,
      '{}', true,
    ))
    expect(code).toBe(405)
    expect(calls).toEqual([])
  })
})
