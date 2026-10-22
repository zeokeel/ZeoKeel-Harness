// @vitest-environment jsdom
/**
 * U-02（终端用户评审 2026-10-23，P1）：**作者的首版待审应用**在应用中心里的表现。
 *
 * 两条判据，一条服务端一条客户端，这里钉客户端这一半（真挂载 + 真 DOM + 真 fetch，
 * 不启动 Electron）：
 *
 *  1. **看得到**：服务端对归属人下发首版行（`first_release*` 字段，见
 *     `server/internal/wasmapp/api/first_release_catalog_test.go`）之后，这一行必须
 *     渲染出"状态 + 尚未上线 + 为什么打不开"，并且：
 *       · 打开按钮**禁用**（没有可交付版本，点开必然失败）；
 *       · **不渲染分享链接**（同事点开只会得到"应用不存在"）；
 *       · 「发新版」**可点**（被拒/撤回后重发是唯一出路）；
 *       · 被拒行显示**理由**。
 *  2. **撤得回**：待审行上有直接的「撤回这一版」，二次确认后 POST
 *     `…/releases/<version>/withdraw`，且成功后按**服务端确认的** `withdrawn`
 *     更新行状态（不乐观更新）。
 *
 * 另加一组发布成功块的判据（同一缺陷的另一半）：首版待审时**不得**承诺
 * "线上仍是旧版本"，也**不得**给出分享深链；有旧版本时保持既有语义。
 *
 * ---- 变异验证（删哪行 ⇒ 哪条红；实跑记录见本轮汇报）----
 *   - `parseCatalogReport` 不解析 `first_release` ⇒ 「目录行」两条红（行退化成
 *     "已下架"、撤回按钮不渲染）；
 *   - 行内 `openable` 去掉 `firstRelease === undefined` ⇒ 打开按钮不再 disabled ⇒ 红；
 *   - 行内复制链接的 `firstRelease === undefined` 去掉 ⇒ 首版行出现分享链接 ⇒ 红；
 *   - 行内撤回按钮删掉（或判据换成 `item.enabled`）⇒ 「撤回」用例红；
 *   - `handleWithdrawVersion` 不按服务端 `withdrawn` 更新行 ⇒ 撤回后仍显示"待审核" ⇒ 红；
 *   - `PublishSuccessBlock` 的 `liveVersion === ''` 分支删掉 ⇒ 首版成功块重新写
 *     "线上仍是旧版本"并给链接 ⇒ 三条成功块用例红；
 *   - `shareable` 改回无条件 true ⇒ 首版成功块出现 `published-share` ⇒ 红。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppCenterPanel } from './AppCenterPanel.tsx'
import { PublishForm } from './PublishForm.tsx'
import { APP_CHANNEL_PATH, type AppChannel } from './channel-seam.ts'
import { APP_AI_IDENTITY_PATH } from './app-ai.ts'
import { HOST_PROOF_PATH, setHostProofToken } from './host-proof.ts'
import { PUBLISH_PATH } from './publish-app.ts'
import { setActiveLocale } from './locales.ts'

const APP_SCHEME = 'zeokeel-app'
const OFFICIAL_CHANNEL: AppChannel = { appOriginScheme: APP_SCHEME, deepLinkScheme: 'zeokeel', productName: 'ZeoKeel' }

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

interface Call { url: string, init: RequestInit }

let container: HTMLDivElement
let root: Root
let calls: Call[]

/**
 * 装一个受控的全局 fetch。基础设施路由（本机持有性证明 / 渠道参数 / 身份）默认答掉，
 * 其余交给 `respond`。
 */
function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const init_ = init ?? {}
    calls.push({ url, init: init_ })
    if (url === HOST_PROOF_PATH) {
      return jsonResponse(200, { proof: 'host-proof-test', expires_at: Date.now() + 5 * 60_000 })
    }
    if (url === APP_CHANNEL_PATH) return jsonResponse(200, OFFICIAL_CHANNEL)
    if (url === APP_AI_IDENTITY_PATH) {
      return jsonResponse(200, { loggedIn: true, username: 'alice', serverURL: 'https://harness.example' })
    }
    return await respond(url, init_)
  }))
}

const businessCalls = (): Call[] =>
  calls.filter(call => ![HOST_PROOF_PATH, APP_CHANNEL_PATH, APP_AI_IDENTITY_PATH].includes(call.url))

async function mountPanel(): Promise<void> {
  await act(async () => {
    root.render(<AppCenterPanel onClose={() => {}} />)
  })
}

async function click(selector: string): Promise<void> {
  const element = container.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`missing element: ${selector}`)
  await act(async () => { element.click() })
}

async function type(selector: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (element === null) throw new Error(`missing element: ${selector}`)
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 选一个文件（jsdom 没有 `Blob.prototype.arrayBuffer`，给一个最小 File 替身）。 */
async function pickFile(selector: string, name: string, bytes: Uint8Array): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(selector)
  if (input === null) throw new Error(`missing element: ${selector}`)
  const file = { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } as unknown as File
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

/** 目录行（服务端 `catalog` 的字段子集）。首版行的形状由服务端 `read.go` 决定。 */
const FIRST_RELEASE_PENDING = {
  app_id: 'u02-first',
  title: '值班交接小工具',
  description: '把值班交接记录整理成一张卡片',
  responsible: 'alice',
  access: 'login',
  // 首版行没有可交付版本 ⇒ 服务端下发 enabled=false（"能不能用"的对外口径）。
  enabled: false,
  frozen: false,
  current_version: '',
  is_owner: true,
  first_release: true,
  first_release_status: 'pending',
  first_release_version: '1.0.0',
  purpose: '值班交接',
  whitelist: [],
}

const FIRST_RELEASE_REJECTED = {
  ...FIRST_RELEASE_PENDING,
  app_id: 'u02-rejected',
  title: '会议纪要台',
  first_release_status: 'rejected',
  first_release_version: '1.1.0',
  first_release_reason: '首版请补充数据来源说明',
}

const OWNER_LIVE_ROW = {
  app_id: 'roster-own',
  title: '我的排班表',
  description: '本周排班',
  responsible: 'alice',
  access: 'login',
  enabled: true,
  frozen: false,
  current_version: '3.0.0',
  is_owner: true,
}

const NORMAL_ROW = {
  app_id: 'roster',
  title: '排班表',
  description: '本周排班',
  responsible: 'bob',
  access: 'login',
  enabled: true,
  frozen: false,
  current_version: '3.0.0',
  is_owner: false,
}

/** 版本历史响应（撤回成功后行内会刷新它）。 */
const RELEASES_AFTER_WITHDRAW = {
  app_id: 'u02-first',
  current_version: '',
  review_required: true,
  releases: [
    { version: '1.0.0', status: 'withdrawn', reason: '', created_at: '2026-10-23T00:00:00Z', current: false, checksum: 'abc', size: 0, bytes_released: true },
  ],
}

beforeEach(() => {
  setActiveLocale('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = []
  setHostProofToken(null)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 目录行卡片的查询器（按标题）。 */
function cardOf(title: string): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>('.zeokeel-app-center-card')]
    .find(node => node.textContent?.includes(title) === true)
  if (card === undefined) throw new Error(`missing card: ${title}`)
  return card
}

describe('U-02：首版待审/被拒的目录行（归属人可见、打不开、撤得回）', () => {
  it('待审行：标出状态与"尚未上线"、禁用打开、不给分享链接，但「发新版」与「撤回」可点', async () => {
    stubFetch(() => jsonResponse(200, { apps: [FIRST_RELEASE_PENDING] }))
    await mountPanel()

    const card = cardOf('值班交接小工具')
    // ① 状态与服务端事实同源：pending ⇒ 待审核（不翻译成"已下架"）。
    expect(card.querySelector('[data-role="first-release-status"]')!.getAttribute('data-status')).toBe('pending')
    expect(card.querySelector('[data-role="first-release-status"]')!.textContent).toContain('待审核')
    expect(card.querySelector('[data-role="first-release-badge"]')!.textContent).toContain('尚未上线')
    // ② 不再冒充"已下架"（应用从来没有上过线）。
    expect(card.querySelector('[data-role="app-disabled"]')).toBeNull()
    // ③ 说清"为什么打不开"。
    expect(card.querySelector('[data-role="first-release-hint"]')!.textContent).toContain('审核')

    // ④ 打开按钮禁用（没有可交付版本，点开必然 404）。
    const open = card.querySelector<HTMLButtonElement>('.zeokeel-app-center-open')!
    expect(open.disabled).toBe(true)

    // ⑤ **不给分享链接**：线上没有任何版本，同事点开只会得到"应用不存在"。
    expect(card.querySelector('[data-action="copy-link"]')).toBeNull()

    // ⑥ 「发新版」可点（被拒/撤回后重发是唯一出路；不能因为 enabled=false 就禁用）。
    const publishNew = card.querySelector<HTMLButtonElement>('.zeokeel-app-center-publish-new')!
    expect(publishNew.disabled).toBe(false)

    // ⑦ 「撤回这一版」在行上，且带着服务端下发的版本号。
    const withdraw = card.querySelector<HTMLButtonElement>('[data-action="withdraw-first-release"]')
    expect(withdraw).not.toBeNull()
    expect(withdraw!.disabled).toBe(false)

    // ⑧ 首版行没有"上下架/冻结"这类对它无意义的动作。
    expect(card.querySelector('[data-action="take-offline"]')).toBeNull()
    expect(card.querySelector('[data-action="bring-online"]')).toBeNull()
    expect(card.querySelector('[data-action="freeze"]')).toBeNull()
  })

  it('撤回：行内二次确认 → POST …/releases/<version>/withdraw → 按服务端 withdrawn 更新行', async () => {
    stubFetch((url) => {
      if (url.endsWith('/releases/1.0.0/withdraw')) {
        return jsonResponse(200, { app_id: 'u02-first', version: '1.0.0', status: 'withdrawn', changed: true, note: '版本号永久占用' })
      }
      if (url.endsWith('/u02-first/releases')) return jsonResponse(200, RELEASES_AFTER_WITHDRAW)
      if (url.endsWith('/u02-first/deployments')) {
        return jsonResponse(200, { app_id: 'u02-first', current_version: '', deployments: [] })
      }
      return jsonResponse(200, { apps: [FIRST_RELEASE_PENDING] })
    })
    await mountPanel()

    await click('[data-action="withdraw-first-release"]')
    // 二次确认块出现（不可逆动作：字节释放、版本号永久占用）。
    const confirm = container.querySelector('[data-role="confirm-withdraw-first-release"]')
    expect(confirm).not.toBeNull()
    expect(confirm!.textContent).toContain('永久占用')
    // 未确认之前**不得**发请求（误点不能直接撤回）。
    expect(businessCalls().some(call => call.url.includes('/withdraw'))).toBe(false)

    await click('[data-action="confirm-withdraw-first-release"]')

    const withdrawCalls = businessCalls().filter(call => call.url.includes('/withdraw'))
    expect(withdrawCalls).toHaveLength(1)
    expect(withdrawCalls[0]!.url).toBe('/api/zeokeel/apps/wasm/u02-first/releases/1.0.0/withdraw')
    expect(withdrawCalls[0]!.init.method).toBe('POST')

    // 行状态改成服务端确认的 `withdrawn`（不是乐观更新、也不是仍显示"待审核"）。
    const card = cardOf('值班交接小工具')
    expect(card.querySelector('[data-role="first-release-status"]')!.getAttribute('data-status')).toBe('withdrawn')
    expect(card.querySelector('[data-role="first-release-hint"]')!.textContent).toContain('撤回')
    // 撤回后不再有撤回按钮（已经是终态）。
    expect(card.querySelector('[data-action="withdraw-first-release"]')).toBeNull()
    // 仍然打不开、仍然没有分享链接。
    expect(card.querySelector<HTMLButtonElement>('.zeokeel-app-center-open')!.disabled).toBe(true)
    expect(card.querySelector('[data-action="copy-link"]')).toBeNull()
  })

  it('被拒行：显示被拒理由与"升版本号重发"的出路（理由不展开版本历史也看得到）', async () => {
    stubFetch(() => jsonResponse(200, { apps: [FIRST_RELEASE_REJECTED] }))
    await mountPanel()

    const card = cardOf('会议纪要台')
    expect(card.querySelector('[data-role="first-release-status"]')!.getAttribute('data-status')).toBe('rejected')
    expect(card.querySelector('[data-role="first-release-status"]')!.textContent).toContain('已拒绝')
    expect(card.querySelector('[data-role="first-release-reason"]')!.textContent).toContain('首版请补充数据来源说明')
    expect(card.querySelector('[data-role="first-release-hint"]')!.textContent).toContain('更高的版本号')
    // 被拒不是待审 ⇒ 没有撤回（终态，服务端会 409）。
    expect(card.querySelector('[data-action="withdraw-first-release"]')).toBeNull()
    // 但「发新版」可点（这是唯一出路）。
    expect(card.querySelector<HTMLButtonElement>('.zeokeel-app-center-publish-new')!.disabled).toBe(false)
  })

  /**
   * U-05（同属"文案与真实行为不一致"）：下架/删除**同时**会清掉该应用 origin 的
   * 浏览器存储（宿主 `clearAppStorage` → `session.clearStorageData({origin})`），
   * 而文案只说"应用数据保留" —— 读者会顺带以为应用里的本地数据也还在。
   */
  it('U-05：下架确认文案同时说清"服务端数据保留"与"浏览器本地存储会被清理"', async () => {
    stubFetch(() => jsonResponse(200, { apps: [OWNER_LIVE_ROW] }))
    await mountPanel()

    await click('[data-action="take-offline"]')
    const confirm = container.querySelector('[data-role="confirm-take-offline"]')
    expect(confirm).not.toBeNull()
    const copy = confirm!.textContent ?? ''
    // ① 服务端数据确实保留（这句话是对的，不能一起删掉）。
    expect(copy).toContain('服务端数据保留')
    // ② 同一次动作会清浏览器存储 —— 必须说出来。
    expect(copy).toContain('浏览器本地存储')
    expect(copy).toContain('localStorage')
    // ③ 且不能说成"数据全都保留"（旧文案的误导形态）。
    expect(copy).not.toContain('应用数据保留、链接不变，之后可以随时重新上架。')
  })

  /**
   * 防御性判据（M8 变异实测暴露出来的那一条）：**"没有可交付版本"不能靠 `enabled`
   * 的宽窄来解释**。
   *
   * 当前服务端对首版行下发 `enabled=false`，于是"打开按钮禁用"有两个理由同时成立；
   * 只删掉客户端的 `firstRelease === undefined` 这一条，断言仍然绿 —— 那不是判据，
   * 那是巧合。这里把服务端那一侧的事实单独钉住：即使以后服务端把首版行下发成
   * `enabled=true`（判据漂移/字段语义变化），客户端仍然不能放行打开。
   */
  it('即使首版行被下发成 enabled=true（判据漂移），打开按钮仍然禁用', async () => {
    stubFetch(() => jsonResponse(200, { apps: [{ ...FIRST_RELEASE_PENDING, enabled: true }] }))
    await mountPanel()

    const card = cardOf('值班交接小工具')
    expect(card.querySelector('[data-role="first-release-status"]')).not.toBeNull()
    expect(card.querySelector<HTMLButtonElement>('.zeokeel-app-center-open')!.disabled).toBe(true)
    // 同一条纪律也适用于分享：没有版本就没有可分享的链接。
    expect(card.querySelector('[data-action="copy-link"]')).toBeNull()
  })

  /**
   * 目录空态口径（同一缺陷的边角）：`catalogEmptyState` 的「全部已下架」一档不得把
   * 首版行算进去 —— 那些应用**从来没有上过线**，"去上架就能恢复"是对它们的错误指路。
   */
  it('目录里只有首版行时，不走「这些应用都已下架」那一档（行照常渲染）', async () => {
    stubFetch(() => jsonResponse(200, { apps: [FIRST_RELEASE_PENDING] }))
    await mountPanel()

    expect(container.querySelector('[data-role="catalog-all-disabled"]')).toBeNull()
    expect(container.querySelectorAll('.zeokeel-app-center-card')).toHaveLength(1)
    expect(container.textContent).not.toContain('都已下架')
  })

  it('正常应用的行不受影响：可打开、有分享链接、没有首版徽标', async () => {
    stubFetch(() => jsonResponse(200, { apps: [NORMAL_ROW] }))
    await mountPanel()

    const card = cardOf('排班表')
    expect(card.querySelector('[data-role="first-release-status"]')).toBeNull()
    expect(card.querySelector('[data-role="first-release-badge"]')).toBeNull()
    expect(card.querySelector<HTMLButtonElement>('.zeokeel-app-center-open')!.disabled).toBe(false)
    expect(card.querySelector('[data-action="copy-link"]')).not.toBeNull()
  })
})

/**
 * 发布成功块（U-02 的另一半）：首版待审时**不得**承诺"线上仍是旧版本"、**不得**
 * 给出分享深链；有旧版本时保持既有语义（链接照旧可分享）。
 *
 * 判据来自服务端下发的 `release.current_version`（`publish.go`）：首版待审 = 空串。
 */
describe('U-02：发布成功块（首版待审不承诺旧版本、不给分享链接）', () => {
  const FILLED = { appId: 'u02-first', version: '1.0.0', title: '值班交接', purpose: '值班交接', owner: 'alice', sensitivity: 'internal' } as const

  /** 挂发布表单、填好必填项并提交；`release` 是服务端 201 体的那一段。 */
  async function submitPublish(release: Record<string, unknown>, reviewRequired: boolean): Promise<HTMLElement> {
    stubFetch((url) => {
      if (url === PUBLISH_PATH) {
        return jsonResponse(201, {
          app: { app_id: 'u02-first', title: '值班交接', enabled: true, version: '1.0.0' },
          release: { id: 1, version: '1.0.0', status: 'pending', current: false, checksum: 'abc', size: 8, ...release },
          review_required: reviewRequired,
        })
      }
      return jsonResponse(200, { apps: [] })
    })
    await act(async () => {
      root.render(<PublishForm onClose={() => {}} onPublished={() => {}} />)
    })
    await pickFile('.zeokeel-app-center-file', 'u02-first.wasm', new Uint8Array([0, 97, 115, 109]))
    await type('.zeokeel-app-center-app-id', FILLED.appId)
    await type('.zeokeel-app-center-version', FILLED.version)
    await type('.zeokeel-app-center-title', FILLED.title)
    await type('.zeokeel-app-center-purpose', FILLED.purpose)
    await type('.zeokeel-app-center-owner', FILLED.owner)
    await type('.zeokeel-app-center-data-sensitivity', FILLED.sensitivity)
    await click('.zeokeel-app-center-submit')
    const success = container.querySelector<HTMLElement>('[data-role="publish-success"]')
    expect(success).not.toBeNull()
    return success!
  }

  it('首版待审（current_version 为空）：说"首版待审核、通过后才上线"，且**没有**分享链接', async () => {
    const success = await submitPublish({ current_version: '' }, true)
    const status = success.querySelector('[data-role="published-status"]')!
    expect(status.getAttribute('data-first-release')).toBe('true')
    expect(status.textContent).toContain('首版')
    expect(status.textContent).toContain('审核')
    // 线上没有任何版本 —— 这句话不许再出现。
    expect(status.textContent).not.toContain('旧版本')
    expect(success.textContent).not.toContain('旧版本')
    // 分享深链：一条同事必然打不开的链接，一节都不渲染。
    expect(success.querySelector('[data-role="published-share"]')).toBeNull()
    expect(success.textContent).not.toContain('zeokeel://app/u02-first')
    // 出路：回列表在「我发布的」里看状态/理由/撤回。
    expect(success.querySelector('[data-role="published-first-release-hint"]')!.textContent).toContain('我发布的')
  })

  it('有旧版本待审（current_version=1.0.0）：保持既有语义，分享链接照旧', async () => {
    const success = await submitPublish({ current_version: '1.0.0' }, true)
    const status = success.querySelector('[data-role="published-status"]')!
    expect(status.getAttribute('data-first-release')).toBe('false')
    expect(status.textContent).toContain('旧版本')
    expect(success.querySelector('[data-role="published-share"]')!.textContent).toContain('zeokeel://app/u02-first')
    expect(success.querySelector('[data-role="published-first-release-hint"]')).toBeNull()
  })

  it('服务端没下发 current_version（旧服务端）：既不断言旧版本、也不给分享链接', async () => {
    const success = await submitPublish({}, true)
    const status = success.querySelector('[data-role="published-status"]')!
    // 不知道就别说 —— 不承诺"线上仍是旧版本"，也不声称"这是首版"。
    expect(status.textContent).not.toContain('旧版本')
    expect(status.getAttribute('data-first-release')).toBe('false')
    expect(status.textContent).toContain('审核')
    expect(success.querySelector('[data-role="published-share"]')).toBeNull()
  })

  it('已生效（回归）：仍是"已生效"且给出分享深链', async () => {
    const success = await submitPublish({ status: 'approved', current: true, current_version: '1.0.0' }, false)
    const status = success.querySelector('[data-role="published-status"]')!
    expect(status.textContent).toContain('已生效')
    expect(status.getAttribute('data-first-release')).toBe('false')
    expect(success.querySelector('[data-role="published-share"]')!.textContent).toContain('zeokeel://app/u02-first')
  })
})
