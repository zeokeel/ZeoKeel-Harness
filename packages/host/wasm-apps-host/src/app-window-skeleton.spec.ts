/**
 * 骨架页的渲染判据（U-01，2026-10-22 生产级评审）。
 *
 * 这一层钉的是**页面内容**：标题来自应用名、主题适配在（暗色不闪白）、语言标记跟随
 * 宿主、应用名被转义。适配器侧另有行为判据（`electron-adapter.spec.ts` 的"第一次
 * `loadURL` 目标是骨架"）—— 缺任一侧都会让"骨架接线正确但页面是空白的"逃过门禁。
 *
 * 变异验证：
 *  · 把 `loadingSkeletonTitle` 换成硬编码串 ⇒ 第一条红；
 *  · 删掉 `prefers-color-scheme` 媒体查询 ⇒ 第二条红；
 *  · 删掉 `escapeHtmlText` ⇒ 第四条红。
 */
import { describe, expect, it } from 'vitest'
import { renderAppWindowSkeletonPage, htmlLangOf } from './app-window-skeleton.ts'

/** 解码 `data:text/html` URL 的正文（判据只读这一份）。 */
function htmlOf(url: string): string {
  expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
  return decodeURIComponent(url)
}

describe('应用窗口骨架页（U-01）', () => {
  it('标题带上应用名、第二行解释"首次打开可能较慢"', () => {
    const html = htmlOf(renderAppWindowSkeletonPage({ locale: 'zh', appLabel: '记事本' }))
    expect(html).toContain('正在打开 记事本…')
    expect(html).toContain('首次打开可能需要几秒钟')
    // 稳定标记：适配器/失败页/测试都靠它区分"骨架"与"失败页"。
    expect(html).toContain('id="zeokeel-loading-skeleton"')
    // 骨架不需要脚本（应用资源未就绪时也一定能渲染）。
    expect(html).not.toContain('<script')
  })

  it('跟随主题（暗色不闪白）与 reduced-motion', () => {
    const html = htmlOf(renderAppWindowSkeletonPage({ locale: 'zh', appLabel: 'Notes' }))
    expect(html).toContain('color-scheme:light dark')
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).toContain('#151517')
    expect(html).toContain('prefers-reduced-motion: reduce')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })

  it('页面语言按宿主语言求值（英文界面不声明 zh-CN）', () => {
    expect(htmlLangOf('zh')).toBe('zh-CN')
    expect(htmlLangOf('en')).toBe('en')
    expect(htmlOf(renderAppWindowSkeletonPage({ locale: 'en', appLabel: 'Notes' })))
      .toContain('lang="en"')
    expect(htmlOf(renderAppWindowSkeletonPage({ locale: 'en', appLabel: 'Notes' })))
      .toContain('Opening Notes…')
  })

  it('应用名被转义（作者可控的字符串不得打断页面结构）', () => {
    const html = htmlOf(renderAppWindowSkeletonPage({
      locale: 'en',
      appLabel: '<img src=x onerror=alert(1)> & "quoted"',
    }))
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;quoted&quot;')
  })
})
