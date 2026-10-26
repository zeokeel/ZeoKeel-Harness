import { describe, expect, it } from 'vitest'

import { compareVersions, dedupeLatestByName, displayNameOf, formatCount, serverTimeText, versionText } from './capability-display'

/**
 * P3 显示变量收口（2026-10-26）：三个管理页共用同一套回退/格式规则，
 * 这里钉住契约，避免页面各自再写一份 `display_name || name` 或版本文案。
 */
describe('capability-display', () => {
  it('展示名回退链：display_name → title → name，且 trim 空白', () => {
    expect(displayNameOf({ display_name: ' 中文名 ', name: 'slug' })).toBe('中文名')
    expect(displayNameOf({ display_name: '   ', title: '旧标题', name: 'slug' })).toBe('旧标题')
    expect(displayNameOf({ name: 'slug' })).toBe('slug')
    expect(displayNameOf({ display_name: '', title: '', name: 'slug' })).toBe('slug')
  })

  it('无版本统一显示「尚未发布」，而不是 — / 空 / 尚未发布版本三套文案', () => {
    expect(versionText('')).toBe('尚未发布')
    expect(versionText(undefined)).toBe('尚未发布')
    expect(versionText('  ')).toBe('尚未发布')
    expect(versionText('1.2.0')).toBe('v1.2.0')
  })

  it('下载/调用计数使用千分位，空值按 0', () => {
    expect(formatCount(12345)).toBe('12,345')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(undefined)).toBe('0')
  })

  it('版本比较与同名去重：保留最高版本（F-06）', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '2.0')).toBe(0)
    const rows = [
      { name: 'a', version: '1.0.0', title: 'old' },
      { name: 'a', version: '1.2.0', title: 'new' },
      { name: 'b', version: '2.0.0', title: 'b' },
    ]
    expect(dedupeLatestByName(rows)).toEqual([
      { name: 'a', version: '1.2.0', title: 'new' },
      { name: 'b', version: '2.0.0', title: 'b' },
    ])
  })

  it('审批时间：可解析则本地化，坏值原样返回且空值破折号', () => {
    expect(serverTimeText('')).toBe('—')
    expect(serverTimeText('not-a-date')).toBe('not-a-date')
    expect(serverTimeText('2026-10-26 10:00:00')).not.toBe('')
  })
})
