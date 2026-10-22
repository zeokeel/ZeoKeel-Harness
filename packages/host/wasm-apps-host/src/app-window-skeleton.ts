/**
 * 应用窗口的**骨架 / 加载页**（U-01，2026-10-22 生产级评审）。
 *
 * ## 修前的缺陷（证据：`electron-adapter.ts` 的 `show: true` + `backgroundColor`）
 *
 * 点「打开」后按钮变「正在打开…」，随后弹出一个**纯白窗口**：窗口确实开了，但窗里
 * 没有任何文档 —— 应用文档要等平台 `/open` 往返 + 冷启动编译 + 首次资源加载（工程
 * 上限 75 s），这段时间用户看到的是白屏，无法区分"在加载"与"卡死/坏了"；暗色主题下
 * 还会先闪一整屏白光（窗口 `backgroundColor` 写死白色）。
 *
 * ## 修法（为什么是 `data:text/html` 而不是应用侧页面）
 *
 * 建窗后**第一件事**是把这个骨架页 `loadURL` 进去（`electron-adapter.ts` 的
 * `showLoadingSkeleton`），应用文档就绪后再换成真实应用。骨架页必须是**独立文档**：
 * 它出现在"应用资源一个都还没加载"的时刻，不能依赖应用 origin（那正是要等的东西）。
 *
 * ## 约束（逐条都是判据）
 *
 *  - **文案复用 `app-window-copy.ts`**：标题是 `loadingSkeletonTitle`（把应用名带上），
 *    第二行是 `loadingSkeletonHint` —— 骨架页不另立一套文案真源。
 *  - **跟随系统/应用主题**：`color-scheme: light dark` + `prefers-color-scheme` 媒体查询。
 *    桌面壳设了 `nativeTheme.themeSource`，独立文档只能靠媒体查询跟随（窗口底色的白色
 *    闪烁另由适配器按当前主题设 `backgroundColor` 消除）。
 *  - **无脚本**：骨架页不需要任何 JS（没有进度可上报），一张纯 CSS 的静态页在应用
 *    资源不可用时也一定能渲染。
 *  - **尊重 reduced motion**：旋转动画在 `prefers-reduced-motion: reduce` 下停掉
 *    （前庭敏感用户不该被一个转圈逼着看几十秒）。
 *
 * @module @zeokeel/dsh-wasm-apps-host/app-window-skeleton
 */

import { loadingSkeletonHint, loadingSkeletonTitle } from './app-window-copy.ts'
import { escapeHtmlText } from './html-escape.ts'
import type { HostLocale } from './locale.ts'

/** 骨架页的渲染输入。 */
export interface AppWindowSkeletonOptions {
  /** 宿主语言（**按调用**解析：语言可以在窗口打开后改变）。 */
  locale: HostLocale
  /** 应用名（窗口标题里 `<应用名> · <产品名>` 的前半段）。 */
  appLabel: string
}

/**
 * 页面 `<html lang>` 的取值（`zh` → `zh-CN`）。
 *
 * U-09（同轮评审的 P3）：失败页此前把 `lang="zh-CN"` 写死，英文界面下读屏会按中文发音。
 * 骨架页与失败页共用这一条口径。
 * @param locale - 宿主语言。
 * @returns BCP 47 语言标记。
 */
export function htmlLangOf(locale: HostLocale): string {
  return locale === 'en' ? 'en' : 'zh-CN'
}

/**
 * 渲染骨架页（完整 `data:text/html` URL）。
 *
 * 形态：居中一张卡片（转圈 + 标题 + 一行解释），背景与文字跟随 light/dark。
 * @param options - 语言与应用名。
 * @returns 可直接交给 `win.loadURL(...)` 的 URL。
 */
export function renderAppWindowSkeletonPage(options: AppWindowSkeletonOptions): string {
  const title = loadingSkeletonTitle(options.locale, options.appLabel)
  const hint = loadingSkeletonHint(options.locale)
  const html = `<!DOCTYPE html><html lang="${htmlLangOf(options.locale)}"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtmlText(title)}</title><style>
:root{color-scheme:light dark}
html,body{height:100%}
body{margin:0;display:flex;align-items:center;justify-content:center;background:#f5f6f8;color:#1a1d24;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:440px;padding:32px;text-align:center}
.spinner{width:28px;height:28px;border-radius:50%;border:3px solid rgba(37,99,235,.25);border-top-color:#2563eb;animation:zeokeel-spin 900ms linear infinite}
h1{margin:0;font-size:17px;font-weight:600;line-height:1.4;word-break:break-word}
p{margin:0;font-size:13px;line-height:1.6;color:#616267}
@keyframes zeokeel-spin{to{transform:rotate(360deg)}}
@media (prefers-color-scheme: dark){
body{background:#151517;color:#f9fafb}
p{color:#9ca3af}
.spinner{border-color:rgba(96,165,250,.25);border-top-color:#60a5fa}
}
@media (prefers-reduced-motion: reduce){
.spinner{animation:none}
}
</style></head><body><main id="zeokeel-loading-skeleton" class="card" role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div><h1>${escapeHtmlText(title)}</h1><p>${escapeHtmlText(hint)}</p></main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
