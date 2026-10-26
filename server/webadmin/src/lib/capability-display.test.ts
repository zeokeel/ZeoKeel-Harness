import { describe, expect, it } from 'vitest'

import {
  builtinSourceLabel,
  compareVersions,
  dedupeLatestByName,
  delistConfirmText,
  displayNameOf,
  formatCount,
  serverTimeText,
  SOURCE_LABEL,
  STATUS_LABEL,
  versionText,
} from './capability-display'

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

/**
 * F-21 / F-50（2026-10-26）：术语与确认文案的**唯一真源**。
 *
 * - 来源/状态文案必须与客户端 locales 逐字对齐（组织/市场/平台内置；
 *   审核中/已共享/未通过），否则同一状态在员工端与管理端两种叫法；
 * - 下架确认必须写明「可恢复、不是删除」，与「删除版本」「释放名称」区分开。
 */
describe('capability-display · 术语与确认文案（F-21 / F-50）', () => {
  it('来源文案与客户端对齐：组织 / 市场 / 平台内置', () => {
    expect(SOURCE_LABEL.org).toBe('组织')
    expect(SOURCE_LABEL.market).toBe('市场')
    expect(SOURCE_LABEL.builtin).toBe('平台内置')
  })

  it('状态文案与客户端对齐：审核中 / 已共享 / 未通过（不改服务端枚举）', () => {
    expect(STATUS_LABEL.pending).toBe('审核中')
    expect(STATUS_LABEL.approved).toBe('已共享')
    expect(STATUS_LABEL.rejected).toBe('未通过')
  })

  it('内置来源：枚举 builtin 显示为「平台内置」，未知值原样兜底', () => {
    expect(builtinSourceLabel('builtin')).toBe('平台内置')
    expect(builtinSourceLabel('')).toBe('')
    expect(builtinSourceLabel(undefined)).toBe('')
    expect(builtinSourceLabel('image')).toBe('image')
  })

  it('下架确认：写明可恢复、不是删除，并指向删除版本/释放名称的边界', () => {
    const text = delistConfirmText('数据提取')
    expect(text).toContain('下架「数据提取」')
    expect(text).toContain('可恢复')
    expect(text).toContain('重新上架')
    expect(text).toContain('下架不是删除')
    expect(text).toContain('删除版本不可恢复')
    expect(text).toContain('释放名称')
  })
})
