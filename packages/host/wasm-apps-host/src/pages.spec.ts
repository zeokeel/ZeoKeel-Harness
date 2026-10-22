/**
 * 宿主渲染页面（`pages.ts`）的**动作槽与提示条**（F-04，2026-10-22 审计）。
 *
 * 缺陷形态：会话过期页只有 `title + message`，页面壳结构上**没有按钮位** ——
 * 用户按页面唯一的指示（"请重新登录"）去做，却发现没有入口，只能自己关窗回主窗口；
 * 而 `app-window-copy.ts` 的 `retryAction` / `signInAgainAction` 两条文案**零消费方**。
 *
 * 判据（行为级：渲染出来的 HTML 里真的可点、且文案来自那份词典）：
 *  ① 给了 `retryHref`/`signInHref` ⇒ 页面里出现两个 `<a>`，文字与词典逐字一致，
 *    href 原样（重试 = 同一次请求的 URL；重新登录 = 客户端登录页）；
 *  ② 拿不到登录页地址 ⇒ **不**渲染那个按钮（渲染一个点了没反应的按钮比不渲染更糟）；
 *  ③ 提示条（`version-unverified`）独立于 `message` 渲染，且带 `role="status"`；
 *  ④ 一切插值都转义（URL/文案进属性前必须转义 —— 文案可能来自服务端信封）。
 *
 * 变异验证：把 `actions` 从页面壳里删掉 ⇒ ①②红；把 `notice` 当普通 message 拼进去
 * ⇒ ③红；不转义 href ⇒ ④红。
 */
import { describe, expect, it } from 'vitest'
import { retryAction, signInAgainAction, versionUnverifiedBanner } from './app-window-copy.ts'
import { appErrorPage, sessionExpiredPage, signInRequiredPage } from './pages.ts'

describe('F-04：宿主页面有可点的动作槽（重试 / 重新登录）', () => {
  it('会话过期页：两个动作都渲染，文案来自 app-window-copy，href 原样', () => {
    const html = sessionExpiredPage('zh', {
      retryHref: 'zeokeel-app://demo/notes?tab=2',
      signInHref: 'http://127.0.0.1:41234/login',
    })
    // ① 文案真源是 `app-window-copy.ts`（不许在页面里另写一份）。
    expect(html).toContain(retryAction('zh'))
    expect(html).toContain(signInAgainAction('zh'))
    // ② 两个都是真正可点的链接（页面无脚本 ⇒ 交互只能是导航）。
    expect(html).toContain('href="zeokeel-app://demo/notes?tab=2"')
    expect(html).toContain('href="http://127.0.0.1:41234/login"')
    expect(html.match(/<a class="action/g)?.length).toBe(2)
    // ③ 英文界面拿到的是英文动作文案（按调用解析，不冻结）。
    const en = sessionExpiredPage('en', { retryHref: 'zeokeel-app://demo/', signInHref: 'http://127.0.0.1:1/login' })
    expect(en).toContain(retryAction('en'))
    expect(en).toContain(signInAgainAction('en'))
  })

  it('拿不到登录页地址 ⇒ 不渲染「重新登录」（不造一个点了没反应的按钮）', () => {
    const html = sessionExpiredPage('zh', { retryHref: 'zeokeel-app://demo/' })
    expect(html).toContain(retryAction('zh'))
    // 只看**链接**（正文里本来就有"请重新登录"这句话，它是说明不是按钮）。
    expect(html).not.toContain(`>${signInAgainAction('zh')}</a>`)
    expect(html.match(/<a class="action/g)?.length).toBe(1)
    // 连重试目标都没有（极端形态）⇒ 整个动作区不出现。
    expect(sessionExpiredPage('zh')).not.toContain('class="actions"')
  })

  it('未登录页同样能自救（重试 + 重新登录）', () => {
    const html = signInRequiredPage('zh', { retryHref: 'zeokeel-app://demo/', signInHref: 'http://127.0.0.1:41234/login' })
    expect(html).toContain(retryAction('zh'))
    expect(html).toContain(signInAgainAction('zh'))
  })

  it('提示条（version-unverified）独立渲染且带 role="status"', () => {
    const banner = versionUnverifiedBanner('zh')
    const html = appErrorPage('zh', {
      title: '无法打开这个应用',
      message: '正文说明',
      notice: banner,
    })
    expect(html).toContain(banner)
    expect(html).toContain('class="notice" role="status"')
    // 不是把提示条当正文拼进去：两段各自独立出现。
    expect(html).toContain('正文说明')
    // 没有提示条 ⇒ 不渲染空壳（避免一行空白横幅）。
    expect(appErrorPage('zh', { title: 't', message: 'm' })).not.toContain('class="notice"')
  })

  it('一切插值都转义（href/文案来自不可信输入）', () => {
    const html = sessionExpiredPage('zh', {
      retryHref: 'zeokeel-app://demo/"><script>alert(1)</script>',
      signInHref: 'http://127.0.0.1:41234/login?a=1&b=2',
    })
    expect(html).not.toContain('"><script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    expect(html).toContain('a=1&amp;b=2')
  })
})
