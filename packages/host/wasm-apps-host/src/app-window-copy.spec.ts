/**
 * 应用窗口 chrome 文案的逐字断言（接缝 J12）。
 *
 * 这些串是设计总纲 §7.2/§19 Q3/Q9/Q12/Q15 冻结文案的落地形态：客户端包里各有一份
 * （应用中心/分享/空态），两侧**不共享模块**（跨 bundle import 在 tsdown 打包后会指向
 * 不存在的路径），所以每侧都必须有**独立**断言 —— 任一侧被改写，本用例必红。
 *
 * 变异验证：把 `frozenAppTitle` 改成"应用不存在" ⇒ 必红（两档文案必须可区分）。
 */
import { describe, expect, it } from 'vitest'
import {
  appWindowDiagnosticCopy,
  backAction,
  dismissNoticeAction,
  downloadStartedNotice,
  externalLinkNotice,
  frozenAppHint,
  frozenAppTitle,
  loadingSkeletonHint,
  loadingSkeletonTitle,
  missingAppTitle,
  onboardingCard,
  reloadAction,
  retiredAppTitle,
  retryAction,
  signInAgainAction,
  updateAvailableBanner,
  versionUnverifiedBanner,
} from './app-window-copy.ts'

describe('应用窗口 chrome 文案（J12：设计总纲为唯一真源）', () => {
  it('外链提示条与下载反馈按 §19 Q9 的冻结口径给出', () => {
    expect(externalLinkNotice('zh', 'example.com')).toBe('已在浏览器窗口中打开 example.com')
    expect(externalLinkNotice('en', 'example.com')).toBe('Opened example.com in the browser window')
    expect(downloadStartedNotice('zh')).toBe('已开始下载，进度见浏览器窗口')
    expect(downloadStartedNotice('en')).toBe('Download started — see the browser window for progress')
  })

  /**
   * F-06（2026-10-22 审计）：应用窗口此前没有刷新/返回 —— 右键菜单的两项文案。
   * 这两条进的是**应用窗口自己的菜单**，所以归本包（与 chrome 其余文案同源）。
   */
  it('F-06：应用窗口菜单的「刷新 / 返回」按宿主语言给', () => {
    expect(reloadAction('zh')).toBe('刷新')
    expect(reloadAction('en')).toBe('Reload')
    expect(backAction('zh')).toBe('返回')
    expect(backAction('en')).toBe('Back')
  })

  it('骨架屏文案带上应用名（先开窗骨架屏 → 校验回来再加载，§19 Q12）', () => {
    expect(loadingSkeletonTitle('zh', '记事本')).toBe('正在打开 记事本…')
    expect(loadingSkeletonTitle('en', 'Notes')).toBe('Opening Notes…')
    // U-01：第二行解释"慢是正常的"，不编造进度。
    expect(loadingSkeletonHint('zh')).toContain('几秒')
    expect(loadingSkeletonHint('en')).toContain('few seconds')
  })

  /**
   * U-03 / U-10（2026-10-22 评审）：失败页的「复制诊断」与版本更新提示。
   * 四条诊断文案缺一条都会让页面出现"点了没反应/不知道复制成功没"。
   */
  it('U-03：诊断文案四条齐全且中英可辨；U-06：更新提示可关、与软闸门横幅不同', () => {
    const diag = appWindowDiagnosticCopy('zh')
    expect(diag.copy).toBe('复制诊断')
    expect(diag.copied).toBe('已复制')
    expect(diag.copyFailed).toContain('手动')
    expect(diag.heading).toBe('诊断信息')
    expect(appWindowDiagnosticCopy('en').copy).toBe('Copy diagnostics')
    expect(updateAvailableBanner('zh')).toContain('新版本')
    expect(updateAvailableBanner('en')).toContain('new version')
    // "确认不了版本"与"确认有新版本"是两件事，文案不得混用。
    expect(updateAvailableBanner('zh')).not.toBe(versionUnverifiedBanner('zh'))
    expect(dismissNoticeAction('zh')).toBe('关闭')
    expect(dismissNoticeAction('en')).toBe('Dismiss')
  })

  it('冻结 / 下架 / 不存在三档必须彼此可辨（§19 Q3：不说"应用不存在"）', () => {
    const frozen = frozenAppTitle('zh')
    expect(frozen).toBe('应用已被管理员停用')
    expect(frozenAppTitle('en')).toBe('This app has been disabled by an administrator')
    expect(retiredAppTitle('zh')).toBe('应用已下架')
    expect(missingAppTitle('zh')).toBe('应用不存在')
    expect(new Set([frozen, retiredAppTitle('zh'), missingAppTitle('zh')]).size).toBe(3)
    expect(frozenAppHint('zh')).toContain('管理员')
    expect(frozenAppHint('en')).toContain('administrator')
  })

  it('软闸门横幅与重试/重登动作与 §5.1b/§7.6 一致', () => {
    expect(versionUnverifiedBanner('zh')).toContain('无法确认最新版本')
    expect(versionUnverifiedBanner('en')).toContain('latest version')
    expect(retryAction('zh')).toBe('重试')
    expect(signInAgainAction('zh')).toBe('重新登录')
    expect(signInAgainAction('en')).toBe('Sign in again')
  })

  it('一次性引导卡三条齐全（§19 Q15），中英各自完整', () => {
    const zh = onboardingCard('zh')
    expect(zh).toHaveLength(3)
    expect(zh.map(item => item.title)).toEqual(['什么是应用', '怎么让 AI 做一个', '怎么分享'])
    for (const item of zh) expect(item.body.length).toBeGreaterThan(0)
    const en = onboardingCard('en')
    expect(en).toHaveLength(3)
    expect(en.every(item => item.title !== '' && item.body !== '')).toBe(true)
    // 语言**按调用**解析（同一进程内切换无需重新 apply）——本仓已记录两次模块级冻结的 bug。
    expect(onboardingCard('en')[0]?.title).not.toBe(zh[0]?.title)
  })
})
