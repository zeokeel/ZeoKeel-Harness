import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  applySectionRows,
  avatarColor,
  capabilitySourceBadgeKey,
  compareVersions,
  hasUpdateFor,
  installEndpoint,
  installNeedsConfirm,
  installRequestUrl,
  isDelistedItem,
  itemsForTab,
  isOwnUploadItem,
  latestApprovedVersionByName,
  localRemoveEndpoint,
  mergeItems,
  nameTakenError,
  needsOverwriteConfirm,
  overwriteConfirmReason,
  planCardAction,
  planCardActionForTab,
  planSectionCards,
  skeletonKeys,
  sortItems,
  tabCounts,
  showsMarketReviewHint,
  uninstallEndpoint,
  uninstallRequestUrl,
  uploadActionLabelKey,
  versionInstallSupported,
  withOverwrite,
  confirmStripAction,
  confirmStripText,
  type CapabilityItem,
  type SectionCard,
  cardChips,
  cardStatusDots,
  cardStatusChip,
  CapabilityDetailDialog,
} from '../../capability-center/src/client/CapabilityCenterPanel.tsx'
import { builtinCardsForTab, builtinSkillsInstallOutcome, planBuiltinCards } from '../../capability-center/src/client/BuiltinSkillsStrip.tsx'
import { en, setActiveLocale, t, zh } from '../../capability-center/src/client/locales.ts'

afterEach(() => { setActiveLocale('zh') })

describe('compareVersions', () => {
  it('compares numerically (1.9.0 < 1.10.0)', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
  })
  it('treats a trailing alphabetic run as prerelease (rc < release)', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc1')).toBe(1)
  })
  it('handles equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v2', 'v2')).toBe(0)
  })
  it('falls back to byte order for non-semver inputs', () => {
    expect(compareVersions('abc!', 'abcd')).toBe(-1)
    expect(compareVersions('', '1.0')).toBe(-1)
  })
})

describe('latestApprovedVersionByName', () => {
  const rows: CapabilityItem[] = [
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.2.0', description: '', author: 'a', status: 'approved', versions: ['1.2.0'] },
    { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '2.0.0-rc1', description: '', author: 'a', status: 'pending', versions: [] },
  ]
  it('returns the numerically-highest approved version; ignores pending', () => {
    expect(latestApprovedVersionByName(rows, 'skill', 'codeql')).toBe('1.2.0')
  })
  it('returns undefined when no approved rows', () => {
    expect(latestApprovedVersionByName(rows, 'skill', 'missing')).toBeUndefined()
  })
})

describe('hasUpdateFor', () => {
  it('true when approved latest > installed version', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.0.0', '1.2.0'], installed: true, installedVersion: '1.0.0' }
    expect(hasUpdateFor(item)).toBe(true)
  })
  it('false when installed version is the latest', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.2.0'], installed: true, installedVersion: '1.2.0' }
    expect(hasUpdateFor(item)).toBe(false)
  })
  it('false when not installed', () => {
    const item: CapabilityItem = { kind: 'skill', source: 'org', name: 'x', displayName: '', version: '1.2.0', description: '', author: '', status: 'approved', versions: ['1.2.0'], installed: false }
    expect(hasUpdateFor(item)).toBe(false)
  })
})

describe('installEndpoint / uninstallEndpoint (来源路由 bug 回归)', () => {
  const base: CapabilityItem = { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'], installed: false }

  it('market skill installs via /api/zeokeel/skills (gateway marketplace), NOT shared-skills', () => {
    const market = { ...base, source: 'market' as const }
    expect(installEndpoint(market, '1.0.0')).toBe('/api/zeokeel/skills/codeql/install')
    // 回归:57aeffecbb 曾把所有技能路由到 shared-skills → 网关 404 gateway error。
    expect(installEndpoint(market, '1.0.0')).not.toContain('shared-skills')
  })

  it('org shared skill installs via /api/zeokeel/shared-skills with version', () => {
    expect(installEndpoint(base, '1.2.0')).toBe('/api/zeokeel/shared-skills/codeql/1.2.0/install')
  })

  it('market skill uninstalls via /api/zeokeel/skills (matched install route)', () => {
    const market = { ...base, source: 'market' as const }
    expect(uninstallEndpoint(market, '1.0.0')).toBe('/api/zeokeel/skills/codeql/uninstall')
    expect(uninstallEndpoint(base, '1.0.0')).toBe('/api/zeokeel/shared-skills/codeql/1.0.0/uninstall')
  })

  it('agent install/uninstall route via /api/zeokeel/agent-presets', () => {
    const agent: CapabilityItem = { ...base, kind: 'agent', name: 'creative-writer', source: 'org' }
    expect(installEndpoint(agent, '1.0.0')).toBe('/api/zeokeel/agent-presets/creative-writer/install')
    expect(uninstallEndpoint(agent, '1.0.0')).toBe('/api/zeokeel/agent-presets/creative-writer/uninstall')
  })

  it('安装端点不带 query：宿主不读 ?force=1（R2-SK-5），覆盖确认是纯客户端交互', () => {
    // 曾经的形态：确认后把 `?force=1` 拼进 URL —— 而宿主按 pathname 分发（auth-gate），
    // 谁都没读它。变异：把 `?force=1` 加回端点 ⇒ 本断言必红。
    expect(installEndpoint(base, '1.0.0')).toBe('/api/zeokeel/shared-skills/codeql/1.0.0/install')
    expect(installEndpoint(base, '1.0.0')).not.toContain('?')
    const market: CapabilityItem = { ...base, source: 'market' }
    expect(installEndpoint(market, '1.0.0')).toBe('/api/zeokeel/skills/codeql/install')
    expect(installEndpoint(market, '1.0.0')).not.toContain('?')
  })
})

describe('mergeItems', () => {
  it('collapses same kind+name into one card with highest approved version', () => {
    const rows: CapabilityItem[] = [
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.10.0', description: '', author: 'a', status: 'approved', versions: ['1.10.0'] },
    ]
    const merged = mergeItems(rows)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.version).toBe('1.10.0')
    expect(merged[0]!.versions).toEqual(['1.0.0', '1.10.0'])
  })
  it('keeps skill and agent separate when names collide', () => {
    const rows: CapabilityItem[] = [
      { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
      { kind: 'agent', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: 'a', status: 'approved', versions: ['1.0.0'] },
    ]
    const merged = mergeItems(rows)
    expect(merged).toHaveLength(2)
    expect(merged.map(m => m.kind).sort()).toEqual(['agent', 'skill'])
  })
})

describe('avatarColor', () => {
  it('returns a stable color token for any non-empty name', () => {
    // 必须是**会随主题翻转**的 alias token（2026-09-16 审计）：此前钉的是
    // `var(--dsw-static-…` 开头，而那一族名字在上游并不存在（静态色板是三位刻度），
    // 实际生效的始终是内层 alias —— 断言外层名字等于把"永远走 fallback"钉成预期。
    const color = avatarColor('code-review')
    expect(color).toMatch(/^var\(--dsw-alias-/u)
    expect(avatarColor('code-review')).toBe(avatarColor('code-review'))
  })
  it('handles the empty name (fallback first color)', () => {
    expect(avatarColor('')).toBe('var(--dsw-alias-brand-primary)')
  })
})

describe('mergeItems cross-source merge (market/org 合并 bug 修复)', () => {
  it('keeps market as the display source when the same name exists in org', () => {
    const items = [
      { kind: 'skill', source: 'market', name: 'code-review', version: '1.0.0', status: 'approved', versions: ['1.0.0'], displayName: 'code-review', description: '代码审查' },
      { kind: 'skill', source: 'org', name: 'code-review', version: '2.0.0', status: 'approved', versions: ['2.0.0'], displayName: '代码审查', description: '组织版代码审查' },
    ] as never
    const merged = mergeItems(items)
    expect(merged.length).toBe(1)
    const row = merged[0]
    expect(row.source).toBe('market') // 市场优先
    expect(row.version).toBe('2.0.0') // approved 最高版本
    expect(row.displayName).toBe('代码审查') // 非空标题保留(不被 market 同名值覆盖)
    expect(row.description).toBe('组织版代码审查') // 非空描述保留(较新)
    expect(row.versions).toEqual(['1.0.0', '2.0.0'])
  })

  it('preserves org-only rows untouched', () => {
    const items = [
      { kind: 'agent', source: 'org', name: 'creative-writer', version: '1.0.0', status: 'pending', versions: [], displayName: '妙笔文案', description: '' },
    ] as never
    const merged = mergeItems(items)
    expect(merged.length).toBe(1)
    expect(merged[0].source).toBe('org')
    expect(merged[0].displayName).toBe('妙笔文案')
  })

  it('does not let a market-only same-name row shadow the org title when market has none', () => {
    const items = [
      { kind: 'skill', source: 'org', name: 'x', version: '1.0.0', status: 'approved', versions: ['1.0.0'], displayName: '中文标题', description: '描述' },
      { kind: 'skill', source: 'org', name: 'x', version: '1.1.0', status: 'approved', versions: ['1.1.0'], displayName: '', description: '' },
    ] as never
    const merged = mergeItems(items)
    expect(merged[0].displayName).toBe('中文标题')
    expect(merged[0].version).toBe('1.1.0')
  })
})

describe('0059 official & score fields', () => {
  const base: CapabilityItem = {
    kind: 'skill', source: 'market', name: 'official-skill', displayName: '', version: '1.0.0',
    description: '', author: '', status: 'approved', versions: ['1.0.0'], installed: false,
  }
  it('types permit official/downloads/calls/score', () => {
    const item: CapabilityItem = { ...base, official: true, downloads: 10, calls: 5, score: 25 }
    expect(item.official).toBe(true)
    expect(item.score).toBe(25)
  })
  it('quality no longer permits official value (retired to official attr)', () => {
    // 编译期保证: quality 只接受 '' | 'featured'
    const item: CapabilityItem = { ...base, quality: 'featured' }
    expect(item.quality).toBe('featured')
  })
})

describe('itemsForTab（卡片唯一位置，2026-08-25 定案 / 2026-09-15 抽成纯函数）', () => {
  const rows = [
    { kind: 'skill' as const, name: 'local-draft', source: 'local', installed: false },
    { kind: 'skill' as const, name: 'org-shared', source: 'org', installed: false },
    { kind: 'skill' as const, name: 'org-installed', source: 'org', installed: true },
    { kind: 'skill' as const, name: 'market-skill', source: 'market', installed: false },
  ]

  it('「市场」只放来源条目（本地创作不重复出现）', () => {
    expect(itemsForTab(rows, 'market').map(i => i.name)).toEqual(['org-shared', 'org-installed', 'market-skill'])
  })

  it('「我的」放本地创作 + 已安装的来源条目（本地卡只管上传，安装动作在来源卡）', () => {
    expect(itemsForTab(rows, 'mine').map(i => i.name)).toEqual(['local-draft', 'org-installed'])
  })
})

describe('nameTakenError（上传预检撞同名，2026-09-16 i18n）', () => {
  // 此前这句是组件里的**硬编码中文**——同文件已用 t() 74 次，只有它漏网，
  // 英文界面下整句是中文。渲染测试抓不到（组件根本没渲染这句），所以这里
  // 断言"切语言后文案跟着变"。
  it('zh：占用名出现在文案里，且是中文原文', () => {
    expect(nameTakenError('妙笔文案'))
      .toBe('名称已被占用:「妙笔文案」已存在于能力中心,请更换名称或联系管理员')
  })

  it('en：同一句走英文，且不含中文', () => {
    setActiveLocale('en')
    const message = nameTakenError('Acme Writer')
    expect(message).toContain('Acme Writer')
    expect(message).toBe('Name already taken: "Acme Writer" already exists in the Capability Hub. Choose another name or contact your administrator.')
    expect(message).not.toMatch(/[\u4e00-\u9fff]/u)
  })

  it('每次调用都取当前语言（不是模块级常量）', () => {
    expect(nameTakenError('x')).toContain('名称已被占用')
    setActiveLocale('en')
    expect(nameTakenError('x')).toContain('Name already taken')
    setActiveLocale('zh')
    expect(nameTakenError('x')).toContain('名称已被占用')
  })
})

// ---------------------------------------------------------------------------
// R2-SK-6：「我的」里同一个技能只能出一张卡（内置更新卡 vs 本机同名普通卡）
// ---------------------------------------------------------------------------
//
// 现场：R1-pm-8 修好"已装 + 清单有新版 ⇒ 出更新卡"之后，本机技能库里那张同名普通卡
// （provenance=builtin 的本地卡）仍在 rows 里，而面板直接 `[...builtinCards, ...rows]`
// 拼接 ⇒ 同一个技能显示两张卡：一张 `[更新到 v1.1.0]`，另一张页脚是误导性的 `[上传]`。
//
// 判据是**数量**（同名卡恰好 1 张），不是"存在某种卡"。变异验证：去掉
// planSectionCards 里的过滤（回到两数组直接拼接）⇒ 前两条必红。

describe('R2-SK-6 内置卡与本机卡去重（数量断言）', () => {
  const localSkill = (name: string, version: string, originChannel?: string): CapabilityItem => ({
    kind: 'skill', source: 'local', name, displayName: name, version, description: '',
    author: 'ZeoKeel', versions: [version], installed: true, installedVersion: version,
    ...(originChannel === undefined ? {} : { originChannel }),
  })
  /** 与面板真实输入同形：清单 1.1.0 + 本机 1.0.0 ⇒ 出「更新到 v1.1.0」卡。 */
describe('内置技能的分区归属（2026-09-20 用户口径）', () => {
  const card = (name: string, action: 'install' | 'update') => ({
    skill: { name, version: '2.0.0' },
    action,
    endpoint: `/api/zeokeel/skills/builtin/${name}/install`,
    installed: action === 'update',
    state: 'action' as const,
    failure: null,
  })

  it('未装的进「市场」，已装待更新的进「我的」', () => {
    const cards = [card('app-builder', 'install'), card('other-skill', 'update')]
    expect(builtinCardsForTab(cards, 'market').map(c => c.skill.name)).toEqual(['app-builder'])
    expect(builtinCardsForTab(cards, 'mine').map(c => c.skill.name)).toEqual(['other-skill'])
  })

  it('未装的内置技能**不得**出现在「我的」（用户报的现象：默认没装却在「我的」里）', () => {
    const cards = [card('app-builder', 'install')]
    expect(builtinCardsForTab(cards, 'mine')).toEqual([])
  })

  it('两个分区合起来恰好是全部卡片（不重不漏 —— 分流写成两个独立判断就会漏卡）', () => {
    const cards = [card('a', 'install'), card('b', 'update'), card('c', 'install')]
    const union = [...builtinCardsForTab(cards, 'mine'), ...builtinCardsForTab(cards, 'market')]
    expect(union.map(c => c.skill.name).sort()).toEqual(['a', 'b', 'c'])
  })
})

  const updateCards = () => planBuiltinCards({
    rows: [{ name: 'app-builder', version: '1.1.0' }],
    installedNames: new Set(['app-builder']),
    installedVersions: { 'app-builder': '1.0.0' },
    query: '',
    kindFilter: 'all',
  })
  const nameOf = (c: SectionCard): string => (c.type === 'builtin' ? c.card.skill.name : c.item.name)

  it('可更新时：内置更新卡吞掉同名本机卡，同名卡恰好 1 张', () => {
    const rows = mergeItems(itemsForTab([
      localSkill('app-builder', '1.0.0', 'builtin'),
      localSkill('codeql', '1.0.0'),
    ], 'mine'))
    const cards = planSectionCards({ rows, builtinCards: updateCards() })
    // 数量断言：两张本机卡 + 一张内置更新卡 ⇒ 去重后恰好 2 张（app-builder 只留内置那张）。
    expect(cards).toHaveLength(2)
    expect(cards.filter(c => nameOf(c) === 'app-builder')).toHaveLength(1)
    const appBuilder = cards.find(c => nameOf(c) === 'app-builder')
    expect(appBuilder?.type).toBe('builtin')
    expect(appBuilder?.type === 'builtin' ? appBuilder.card.action : '').toBe('update')
    // 其它技能不受影响。
    expect(cards.filter(c => nameOf(c) === 'codeql')).toHaveLength(1)
  })

  it('没有内置卡时，本机卡照常渲染（去重不得吃掉唯一那张）', () => {
    const rows = mergeItems(itemsForTab([localSkill('app-builder', '1.0.0', 'builtin')], 'mine'))
    const cards = planSectionCards({ rows, builtinCards: [] })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.type).toBe('item')
  })

  it('只吞同名**技能**：同名智能体不受影响（复合键语义，技能与 agent 允许同名）', () => {
    const agent: CapabilityItem = { ...localSkill('app-builder', '1.0.0'), kind: 'agent' }
    const cards = planSectionCards({ rows: [agent], builtinCards: updateCards() })
    expect(cards).toHaveLength(2)
    expect(cards.filter(c => c.type === 'item')).toHaveLength(1)
  })
})


/**
 * 独立复审 2026-09-23 **A6（PARTIAL）** + **N1（P2）**：「我的」卡片的来源字段
 * 与卡片形态必须只取决于**已合并后的单一数据源**，不取决于两次并发取数的到达顺序。
 *
 * 现场（审计 §5.18 实测）：
 *  - 面板 mount 时并发发 `/api/zeokeel/capabilities?source=market` 与 `?source=local`
 *    （后者内部还要打 3 次上游 + 扫盘），谁先回来不定；
 *  - **market-first**：同名商店行先入 Map ⇒ `mergeItems` 用它打底 ⇒ 本机行独有的
 *    `originChannel` 被吞 ⇒ **「随客户端内置」徽章与本机卸载入口都渲染不出来**（A6）；
 *  - **mine-first**：本机行打底但 `installed` 被商店行的 `source` 覆写、`installed`
 *    本身没被带上 ⇒ 已装技能渲染成「安装」。
 *
 * 用例直接驱动**真实的归约函数**（applySectionRows → itemsForTab → mergeItems →
 * capabilitySourceBadgeKey / planCardAction），两种到达顺序各跑一遍：
 *  - 变异验证：把 mergeItems 退回"先到的行说了算"⇒ 第 1 条（逐字相等）必红；
 *    只丢"本机行的 originChannel/installedOrigin 优先"⇒ 第 2 条必红；
 *    只丢"存在本机行即 installed"⇒ 第 3 条必红。
 */
describe('A6/N1 本机行与同名商店行的归并（只依赖合并结果，不依赖到达顺序）', () => {
  /** `?source=market` 的目录行：host 已按磁盘状态补 installed/installedOrigin/installedVersion。 */
  const catalogRow = (name: string, version: string, installedVersion: string): CapabilityItem => ({
    kind: 'skill', source: 'market', name, displayName: name, version, description: '目录说明',
    author: 'someone', status: 'approved', versions: [version], installed: true,
    installedVersion, installedOrigin: 'store', official: false, downloads: 3, calls: 1, score: 10,
    isOwner: false,
  })
  /** `?source=local` 的本机行（扫盘得到）：**不带 installed**，来源字段来自磁盘 provenance。 */
  const localRow = (name: string, version: string, originChannel?: string): CapabilityItem => ({
    kind: 'skill', source: 'local', name, displayName: name, runtimeName: name, version,
    description: '本机说明', author: '', versions: [], isLocal: true, installedOrigin: 'store',
    ...originChannel === undefined ? {} : { originChannel, originAppId: name, dirty: false },
  })

  /** 两次取数的载荷（同一份服务端目录行会同时出现在两个分支里）。 */
  const MARKET: CapabilityItem[] = [catalogRow('app-builder', '1.0.0', '1.0.0'), catalogRow('codeql', '1.2.0', '1.0.0')]
  const LOCAL: CapabilityItem[] = [
    catalogRow('app-builder', '1.0.0', '1.0.0'),
    catalogRow('codeql', '1.2.0', '1.0.0'),
    localRow('app-builder', '1.0.0', 'plugin'),
    localRow('my-draft', '1.0.0'),
  ]
  const EMPTY: CapabilityItem[] = []

  /** market 先到（常见）：mine 的归约会把商店行留着，本机行追加在后。 */
  const marketFirst = (): CapabilityItem[] =>
    mergeItems(itemsForTab(applySectionRows(applySectionRows(EMPTY, 'market', MARKET), 'mine', LOCAL), 'mine'))
  /** mine 先到：market 的归约会先清掉非本机行，商店行由 market 那一发补上。 */
  const mineFirst = (): CapabilityItem[] =>
    mergeItems(itemsForTab(applySectionRows(applySectionRows(EMPTY, 'mine', LOCAL), 'market', MARKET), 'mine'))

  const pick = (rows: CapabilityItem[], name: string): CapabilityItem => {
    const found = rows.find(row => row.name === name)
    expect(found, `${name} 必须出现在「我的」`).toBeDefined()
    return found!
  }

  it('两种到达顺序给出逐字相同的卡片数据（N1 的根因面）', () => {
    expect(mineFirst()).toEqual(marketFirst())
    // 三种卡（内置技能 / 商店已装 / 本机创作）都在，且各只有一张。
    expect(marketFirst().map(row => row.name).sort()).toEqual(['app-builder', 'codeql', 'my-draft'])
  })

  it('同名商店行存在时仍带 provenance ⇒ 「随客户端内置」徽章 + 卸载按钮都渲染得出（A6 验收点）', () => {
    for (const merged of [marketFirst(), mineFirst()]) {
      const item = pick(merged, 'app-builder')
      expect(item.installed).toBe(true)
      expect(item.originChannel).toBe('plugin')
      expect(capabilitySourceBadgeKey(item, 'mine')).toBe('capability.sourcePlugin')
      expect(planCardAction(item)).toEqual({
        kind: 'uninstall',
        endpoint: '/api/zeokeel/skills/app-builder/uninstall',
        localContent: false,
      })
      // 卸载端点也不是市场那一条（market 分支会拼 /api/zeokeel/skills/:name/uninstall，
      // 恰好同路径；这里钉的是 localRemoveEndpoint 认得它 —— 徽章与入口同源）。
      expect(localRemoveEndpoint(item)).toBe('/api/zeokeel/skills/app-builder/uninstall')
    }
  })

  it('已装的商店行不再随到达顺序退化成「安装」（N1 的第二形态）', () => {
    for (const merged of [marketFirst(), mineFirst()]) {
      const item = pick(merged, 'codeql')
      expect(item.installed).toBe(true)
      expect(item.installedVersion).toBe('1.0.0')
      expect(planCardAction(item)).toEqual({ kind: 'update', version: '1.2.0' })
    }
  })

  it('本机创作（无同名商店行）照常出「上传」，不被归并改写成商店卡', () => {
    for (const merged of [marketFirst(), mineFirst()]) {
      const item = pick(merged, 'my-draft')
      expect(item.source).toBe('local')
      expect(capabilitySourceBadgeKey(item, 'mine')).toBe('capability.sourceLocal')
      expect(planCardAction(item)).toEqual({ kind: 'upload' })
    }
  })

  it('归并结果与输入顺序无关：同一组行正序/倒序归并逐字相同', () => {
    const rows = [...MARKET, ...LOCAL]
    expect(mergeItems([...rows].reverse())).toEqual(mergeItems(rows))
  })
})

// ---------------------------------------------------------------------------
// 独立审计 2026-09-23 A2/A3/A6/A11/A15 —— 覆盖确认与"按版本安装"的纯判据
// ---------------------------------------------------------------------------

describe('A15 覆盖确认判据（needsOverwriteConfirm）', () => {
  const base: CapabilityItem = {
    kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.2.0',
    description: '', author: '', versions: ['1.2.0'], installed: true,
  }

  it('商店来源（store）⇒ 直接更新/重装，不打扰用户', () => {
    expect(needsOverwriteConfirm({ ...base, installedOrigin: 'store' })).toBe(false)
  })

  it('本机自制 / 来源不明（缺 installedOrigin 的历史载荷）⇒ 必须确认', () => {
    expect(needsOverwriteConfirm({ ...base, installedOrigin: 'local' })).toBe(true)
    expect(needsOverwriteConfirm(base)).toBe(true)
  })

  it('未安装 ⇒ 不涉及覆盖', () => {
    expect(needsOverwriteConfirm({ ...base, installed: false, installedOrigin: undefined })).toBe(false)
  })

  /* R4-B-3（第四轮审计）：`dirty` 也必须参与同一份判据。 */
  it('商店来源但**已被本地修改**（dirty）⇒ 与"本机自制"同档，必须先确认', () => {
    expect(needsOverwriteConfirm({ ...base, installedOrigin: 'store', dirty: true })).toBe(true)
    expect(installNeedsConfirm({ ...base, installedOrigin: 'store', dirty: true })).toBe(true)
    // 用户点过确认条之后不再重复问（否则自锁成死循环）。
    expect(installNeedsConfirm({ ...base, installedOrigin: 'store', dirty: true }, { overwrite: true })).toBe(false)
    // 未改过的商店内容不受影响（同渠道更新仍是一次点击直达）。
    expect(needsOverwriteConfirm({ ...base, installedOrigin: 'store', dirty: false })).toBe(false)
  })

  it('确认条的措辞按三档分派：自制 / 已本地修改 / 换渠道', () => {
    expect(overwriteConfirmReason({ ...base, installedOrigin: 'local' })).toBe('local')
    expect(overwriteConfirmReason({ ...base, installedOrigin: 'store', dirty: true })).toBe('dirty')
    expect(overwriteConfirmReason({ ...base, installedOrigin: 'store', dirty: false })).toBe('store')
    // 文案本身必须点明后果（走字典，切语言跟着变）。
    setActiveLocale('zh')
    expect(confirmStripText({ name: 'foo', localConflict: true, reason: 'dirty' })).toContain('已被本地修改')
    expect(confirmStripAction({ name: 'foo', localConflict: true, reason: 'dirty' })).toBe('仍要更新')
    setActiveLocale('en')
    expect(confirmStripText({ name: 'foo', localConflict: true, reason: 'dirty' })).toContain('local modifications')
    // 历史调用（只给 localConflict、没有 reason）按旧口径回落，不得变成"商店"档。
    setActiveLocale('zh')
    expect(confirmStripText({ name: 'foo', localConflict: true })).toContain('自制')
    expect(confirmStripAction({ name: 'foo', localConflict: true })).toBe('仍要覆盖')
  })
})

describe('覆盖标记只由"用户已确认"产生（withOverwrite，A2/A3 两端契约）', () => {
  it('installRequestUrl 是唯一的 URL 拼装入口：确认前不带、确认后才带 overwrite', () => {
    const store: CapabilityItem = { kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.2.0', description: '', author: '', versions: ['1.2.0'], installed: true, installedOrigin: 'store' }
    const local: CapabilityItem = { ...store, installedOrigin: 'local' }
    // 商店来源的正常更新：不需要确认 ⇒ 不带标记。
    expect(installRequestUrl(store)).toBe('/api/zeokeel/skills/foo/install')
    // 本机自制同名：未确认不带、确认后才带（面板与宿主两端契约）。
    expect(installRequestUrl(local)).toBe('/api/zeokeel/skills/foo/install')
    expect(installRequestUrl(local, { overwrite: true })).toBe('/api/zeokeel/skills/foo/install?overwrite=1')
    // 用户在详情弹层点选的版本必须跟着走（A11：确认后重放的是同一发）。
    expect(installRequestUrl({ ...local, kind: 'skill', source: 'org' }, { overwrite: true, version: '1.0.0' }))
      .toBe('/api/zeokeel/shared-skills/foo/1.0.0/install?overwrite=1')
  })

  it('installNeedsConfirm 是"确认条可达"的唯一判定入口（A15）', () => {
    const base: CapabilityItem = { kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.2.0', description: '', author: '', versions: ['1.2.0'], installed: true }
    expect(installNeedsConfirm({ ...base, installedOrigin: 'store' })).toBe(false)
    expect(installNeedsConfirm({ ...base, installedOrigin: 'local' })).toBe(true)
    // 用户在确认条上点过之后就不再要确认（否则会自锁成死循环）。
    expect(installNeedsConfirm({ ...base, installedOrigin: 'local' }, { overwrite: true })).toBe(false)
  })

  it('未确认时端点保持无 query（历史死参数 ?force=1 不得回来）', () => {
    const url = installEndpoint({ kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.0.0', description: '', author: '', versions: [], installed: false }, '1.0.0')
    expect(withOverwrite(url, false)).toBe('/api/zeokeel/skills/foo/install')
    expect(withOverwrite(url, false)).not.toContain('?')
  })

  it('确认后带上宿主真的会读的 ?overwrite=1', () => {
    expect(withOverwrite('/api/zeokeel/skills/foo/install', true)).toBe('/api/zeokeel/skills/foo/install?overwrite=1')
    expect(withOverwrite('/api/zeokeel/skills/foo/uninstall', true)).toBe('/api/zeokeel/skills/foo/uninstall?overwrite=1')
    expect(withOverwrite('/api/zeokeel/shared-skills/foo/1.0.0/install', true)).toContain('overwrite=1')
  })

  it('N2：智能体（agent-presets）走同一个标记 —— 宿主侧路由真的读它', () => {
    const agent: CapabilityItem = {
      kind: 'agent', source: 'org', name: 'creative-writer', displayName: '', version: '2.0.0',
      description: '', author: '', versions: ['1.0.0', '2.0.0'], installed: true,
      installedVersion: '1.0.0', installedOrigin: 'store',
    }
    // 商店来源：面板「更新智能体」直接发请求（不带标记）；宿主允许商店来源覆盖。
    expect(planCardAction(agent)).toEqual({ kind: 'update', version: '2.0.0' })
    expect(installNeedsConfirm(agent)).toBe(false)
    expect(installRequestUrl(agent)).toBe('/api/zeokeel/agent-presets/creative-writer/install')
    // 本机自制同名：先出确认条，确认后才把标记交给宿主（否则宿主 409 LOCAL_CONTENT）。
    const local: CapabilityItem = { ...agent, installedOrigin: 'local' }
    expect(installNeedsConfirm(local)).toBe(true)
    expect(installRequestUrl(local)).toBe('/api/zeokeel/agent-presets/creative-writer/install')
    expect(installRequestUrl(local, { overwrite: true })).toBe('/api/zeokeel/agent-presets/creative-writer/install?overwrite=1')
  })
})

describe('A11 「按版本安装」只在端点真的接受版本时出现', () => {
  const base: CapabilityItem = { kind: 'skill', source: 'org', name: 'codeql', displayName: '', version: '1.0.0', description: '', author: '', versions: ['1.0.0', '1.2.0'], installed: false }

  it('组织共享技能（端点带版本）⇒ 支持', () => {
    expect(versionInstallSupported(base)).toBe(true)
  })

  it('市场技能（归档端点只按最高 approved 取）⇒ 不支持按版本安装', () => {
    expect(versionInstallSupported({ ...base, source: 'market' })).toBe(false)
  })

  it('智能体（端点不带版本）⇒ 不支持', () => {
    expect(versionInstallSupported({ ...base, kind: 'agent' })).toBe(false)
  })
})

describe('A6 + 跨泳道契约 S2 本机内置技能的卸载端点', () => {
  const base: CapabilityItem = { kind: 'skill', source: 'local', name: 'app-builder', displayName: '', version: '2.5.0', description: '', author: '', versions: [], isLocal: true, installedOrigin: 'store' }

  it('builtin ⇒ 新增的内置技能卸载路由', () => {
    const item = { ...base, originChannel: 'builtin' }
    expect(localRemoveEndpoint(item)).toBe('/api/zeokeel/skills/builtin/app-builder/uninstall')
    expect(uninstallEndpoint(item, '2.5.0')).toBe('/api/zeokeel/skills/builtin/app-builder/uninstall')
  })

  it('plugin（随客户端内置）⇒ 纯本地删除端点，绝不走市场端点', () => {
    const item = { ...base, originChannel: 'plugin' }
    expect(localRemoveEndpoint(item)).toBe('/api/zeokeel/skills/app-builder/uninstall')
    expect(uninstallEndpoint(item, '2.5.0')).toBe('/api/zeokeel/skills/app-builder/uninstall')
  })

  it('自制 / 市场 / 组织来源 ⇒ 不给本机内置的卸载入口（沿用既有规则）', () => {
    expect(localRemoveEndpoint(base)).toBeUndefined()
    expect(localRemoveEndpoint({ ...base, originChannel: 'market' })).toBeUndefined()
    expect(localRemoveEndpoint({ ...base, kind: 'agent', originChannel: 'plugin' })).toBeUndefined()
  })
})


/**
 * 接线判据（渲染层无法当纯函数测的四条链路）。
 *
 * 本仓既有先例：渲染层里"某个回调传了什么"只能靠读源码钉住（`wasm-app-open-route-parity`
 * 读 main.ts、`sandbox-acl-grant-hint` 读产物）。这里钉的正是审计 A2/A3/A11/A15 的
 * 现场 —— 旧实现里"更新按钮硬编码 force"这一行是死代码的来源，而它不会被任何
 * 纯函数用例抓到。
 */
describe('A2/A3/A11/A15 接线判据（源码级）', () => {
  const source = readFileSync(fileURLToPath(new URL('../../capability-center/src/client/CapabilityCenterPanel.tsx', import.meta.url)), 'utf8')

  it('更新按钮不再硬编码覆盖确认（确认条才是唯一的覆盖来源）', () => {
    // 旧实现把「更新」的 onClick 写成 `install(item, { overwrite: true })`（硬编码 force）
    // ⇒ 确认条永远是死代码。「该不该出更新」现在由 planCardAction 判（纯判据），
    // 「要不要先确认」由 install() 自己问 installNeedsConfirm（A15 那组用例钉住）。
    const installed: CapabilityItem = {
      kind: 'skill', source: 'market', name: 'foo', displayName: '', version: '1.2.0',
      description: '', author: '', versions: ['1.1.0', '1.2.0'], installed: true,
      installedVersion: '1.1.0', installedOrigin: 'local',
    }
    expect(planCardAction(installed)).toEqual({ kind: 'update', version: '1.2.0' })
    const update = /plan\.kind === 'update' \? \(([\s\S]*?): plan\.kind === 'reupload'/u.exec(source)
    expect(update, '更新按钮的渲染分支必须存在').not.toBeNull()
    // 更新路径必须走 install() 自己的来源判定：**不传任何选项**（旧实现传了 force）。
    expect(update![1]).toContain('onClick={() => { void install(item) }}')
    expect(update![1]).not.toMatch(/install\(item, \{/u)
    // 页脚只认 planCardAction 给的 kind，不再自己写 `needUpdate ? … : …` 的分支。
    expect(source).not.toContain('const needUpdate = hasUpdateFor(item)')
  })

  it('确认条是唯一的"用户已确认"出口，重放的是同一发安装', () => {
    // 2026-10-26 起确认条由 `renderConfirmStrip()` 产出（列表视图与详情整页视图**共用**
    // 同一个出口 —— 详情里的历史版本安装也会撞上本机同名内容）。
    const strip = /const renderConfirmStrip = \(\): React\.ReactNode => installConfirm === null \? null : \(([\s\S]*?)\n  \)/u.exec(source)
    expect(strip, '确认条必须存在').not.toBeNull()
    // 唯一的放行点：点「覆盖安装 / 仍要覆盖」才 run(true)（= 才带 ?overwrite=1）。
    expect(strip![1]).toContain('void pending.run(true)')
    // 措辞按档位分派（R4-B-3 起有三档：自制 / 已本地修改 / 换渠道），走同一对纯函数。
    expect(strip![1]).toContain('{confirmStripText(installConfirm)}')
    expect(strip![1]).toContain('{confirmStripAction(installConfirm)}')
    // 两个视图都必须渲染它（否则详情里的确认停在不可见状态）。
    const usages = source.match(/\{renderConfirmStrip\(\)\}/gu) ?? []
    expect(usages.length).toBeGreaterThanOrEqual(2)
    // 真正发请求的 performInstall 经 installRequestUrl（唯一 URL 拼装入口）。
    const perform = /const performInstall = async \([\s\S]*?\n  \}/u.exec(source)
    expect(perform, 'performInstall 必须存在').not.toBeNull()
    expect(perform![0]).toContain('const url = installRequestUrl(item, opts)')
    // 闸门：install() 先问 installNeedsConfirm，再交给 performInstall。
    const installBody = /const install = async \([\s\S]*?\n  \}/u.exec(source)
    expect(installBody![0]).toContain('if (installNeedsConfirm(item, opts))')
    expect(installBody![0]).toContain('await performInstall(item, opts)')
    // 409（宿主说目标是本机内容）必须回到确认条，而不是当成失败。
    expect(perform![0]).toContain('localConflict: true')
  })

  it('A11：安装成功后按响应里的真实版本记账，拿不到就留空并重载', () => {
    expect(source).toContain('const appliedVersion = typeof data.version === \'string\' && data.version !== \'\' ? data.version : undefined')
    expect(source).toContain('installedVersion: appliedVersion')
    expect(source).toContain('if (appliedVersion === undefined) loadAll()')
  })

  it('A3：卸载的第二段（用户已确认）才带 overwrite', () => {
    // C2-1（2026-10 审计）起卸载的 URL 也收口到**唯一拼装入口**（与 installRequestUrl
    // 对称）：`uninstallRequestUrl(item, { overwrite: true })`。判据因此钉这两跳而不是
    // 某一行的字符串形态：① 第一次点击只出确认条、不发请求；② 确认后那一发才带
    // `overwrite: true`（并且带上 C2-1 的归属提示 —— 归属证明不了时宿主不写机器级墓碑）。
    const uninstallBody = /const uninstall = async \([\s\S]*?\n  \}/u.exec(source)
    expect(uninstallBody, 'uninstall() 必须存在').not.toBeNull()
    expect(uninstallBody![0]).toContain('if (uninstallConfirmKey !== key) { setUninstallConfirmKey(key); return }')
    expect(uninstallBody![0]).toContain('fetch(uninstallRequestUrl(item, { overwrite: true }), { method: \'POST\' })')
    // 归属提示只在"证明不了"时出现（逐字钉住纯函数行为，见 C2-1 那条用例）。
    expect(uninstallRequestUrl(
      {
        kind: 'skill', source: 'local', name: 'x', displayName: 'x', version: '1.0.0', description: '', author: '',
        versions: [], installedOrigin: 'store', originChannel: 'plugin', localOwnership: 'unknown',
      },
      { overwrite: true },
    )).toBe('/api/zeokeel/skills/x/uninstall?overwrite=1&ownership=unknown')
  })

  it('内置技能入口卡的安装/更新也走同一条确认条（否则「更新到 vX」绕过确认被宿主 409）', () => {
    expect(source).toContain('const activateBuiltinCard = (card: BuiltinCard): void => {')
    expect(source).toContain('await builtin.install(card.skill, overwrite)')
    // 两处按钮都必须经 activateBuiltinCard，不得直接调 builtin.install(skill)。
    expect(source).not.toContain('builtin.install(skill)')
    // 确认条只有一处调用 run(true)。
    expect(source).toContain('void pending.run(true)')
  })

  /* R4-B-5（第四轮审计）：内置卡的 409 必须有第二段确认路径。 */
  it('内置卡遇 409 时回到同一条确认条（而不是只贴一句拒绝文案 + 死「重试」）', () => {
    // 判据（纯函数）：409 ⇒ conflict（不是 failed）。
    expect(builtinSkillsInstallOutcome(409, false)).toBe('conflict')
    expect(builtinSkillsInstallOutcome(200, true)).toBe('ok')
    expect(builtinSkillsInstallOutcome(422, false)).toBe('failed')
    // hook 必须真的用它（否则 409 又变成"贴文案 + 重试"）。
    const strip = readFileSync(fileURLToPath(new URL('../../capability-center/src/client/BuiltinSkillsStrip.tsx', import.meta.url)), 'utf8')
    expect(strip).toContain('const outcome = builtinSkillsInstallOutcome(res.status, res.ok)')
    expect(strip).toContain("if (outcome === 'conflict')")
    // 面板：conflict 一律经同一条确认条（与普通卡的 409 回落同形），不得自己造第二套。
    expect(source).toContain("if (result === 'conflict') ask('store')")
    // 内置卡的本机同名判据与普通卡同源（needsOverwriteConfirm，含 dirty）。
    expect(source).toContain('needsOverwriteConfirm({ ...local, installed: true })')
  })
})

/**
 * 审计 C-03（P2）：详情弹层的按版本按钮必须接**站级闸**。
 *
 * 缺陷：`install()` 第一行对"有动作在飞"是静默 `return`，而弹层里的按版本按钮只收到
 * own-key 的 `busy` ⇒ A 卡安装在飞时打开 B 卡详情，按钮是启用态，点下去不发请求、
 * 不改状态、不报错（死按钮）。修法＝把 `inFlight` 传进弹层并置灰 + 说明原因。
 *
 * **为什么是源码级守卫**：本包的测试环境是 node（没有 jsdom / react-dom），跑不了
 * 真实挂载；行为级复现与验证由审计探针
 * `temp/audit-2026-09-23/probes/client/version-button-silent-swallow.spec.tsx` 承担
 * （jsdom + react，修前红 / 修后绿）。本守卫只钉"接线没被拆掉"，与同文件其它
 * 源码级用例（A3/A11/内置卡入口）同一形态。
 *
 * ---- 变异验证 ----
 *   - 弹层按钮改回 `disabled={busy}` ⇒ 第一条红；
 *   - 调用点去掉 `blocked={inFlight}` ⇒ 第二条红；
 *   - 去掉 `title` 说明 ⇒ 第三条红。
 */
describe('C-03：详情弹层的动作按钮必须与 install() 的站级闸同源', () => {
  const source = readFileSync(fileURLToPath(new URL('../../capability-center/src/client/CapabilityCenterPanel.tsx', import.meta.url)), 'utf8')

  it('弹层里的按版本按钮同时吃 own-key busy 与站级 blocked', () => {
    expect(source).toContain('disabled={busy || blocked}')
  })

  it('调用点把站级 inFlight 传进弹层', () => {
    expect(source).toContain('blocked={inFlight}')
    // 弹层的 props 里必须有这一项（否则传了也不生效）。
    expect(source).toContain('blocked: boolean')
  })

  it('禁用时给出原因文案（不能是"点了没反应"）', () => {
    expect(source).toContain("title={blocked && !busy ? t('capability.busyHint') : undefined}")
    // 文案必须走字典（locales-hygiene 会同时钉 zh/en 与引用点）。
    const locales = readFileSync(fileURLToPath(new URL('../../capability-center/src/client/locales.ts', import.meta.url)), 'utf8')
    expect(locales).toContain("'capability.busyHint'")
  })
})

// ---------------------------------------------------------------------------
// task-4：商店行 + 归属人 + 已安装 ⇒ 页脚出「上传新版」（上架后仍能发新版）
// ---------------------------------------------------------------------------
//
// 【契约来源】服务端本轮定案：非管理员对**任意渠道**（market / org）的、自己归属的
// App 发新版本 ⇒ 服务端收下为 pending（市场渠道同样需要管理员审核后生效）；非归属人
// ⇒ 409 NAME_TAKEN；官方行 / 已下架 / 已转交 ⇒ 各自的拒绝码。作者面（`?source=own`）
// 本轮起也下发 market 渠道的 own 行（含 pending/rejected 与下架行），行上 `source`
// 按渠道（market/org）下发并带 `is_owner` / `delisted`。
//
// 【根因（本次要钉住的退化路径）】`mergeItems` 的权威序是 market > org > 本机：
// 技能一上架，卡片就从本机行变成商店行，而修前的 `planCardAction` 只在
// `source === 'local'` 给「上传」⇒ 作者上架后再也没有上传入口，`upload()` 里的
// `isOwner` 预检成了死代码。
//
// 【边界（不得为了变绿放宽）】下架 / 官方 / 非归属人三档**不出**上传；`mergeItems`
// 的权威序本次不动（本组最后一条用例钉住它）。
describe('task-4 商店行 + 归属人 + 已安装 ⇒ 「上传新版」', () => {
  /**
   * `?source=own` 下发的目录行（作者自己那一行）：`installed` / `installedVersion`
   * 由宿主按磁盘状态补齐（与本文件 A6/N1 那组同形）。
   */
  const ownerRow = (
    source: 'market' | 'org',
    name: string,
    extra: Partial<CapabilityItem> = {},
    kind: 'skill' | 'agent' = 'skill',
  ): CapabilityItem => ({
    kind,
    source,
    name,
    displayName: name,
    version: '1.0.0',
    description: '目录说明',
    author: 'me',
    status: 'approved',
    versions: ['1.0.0'],
    installed: true,
    installedVersion: '1.0.0',
    installedOrigin: 'store',
    official: false,
    isOwner: true,
    ...extra,
  })

  /** 本机行（扫盘）：`?source=local` 的载荷里也会带同一批目录行（A6/N1 的现场）。 */
  const diskRow = (source: 'market' | 'org', name: string, kind: 'skill' | 'agent' = 'skill'): CapabilityItem => ({
    kind,
    source: 'local',
    name,
    displayName: name,
    ...kind === 'skill' ? { runtimeName: name } : {},
    version: '1.0.0',
    description: '本机说明',
    author: '',
    versions: [],
    isLocal: true,
    installedOrigin: 'store',
    originChannel: source,
    originAppId: name,
    dirty: false,
  })

  /**
   * **两种到达顺序**（与 A6/N1 同一条归约链
   * `applySectionRows → itemsForTab → mergeItems`）：
   *  - market 行先到：目录那一发先入列表，本机那一发随后补齐磁盘字段；
   *  - 本机行先到：`?source=local` 的载荷先到，目录那一发随后到达。
   * 两次结果必须逐字相同，且都能判出同一个页脚动作。
   */
  const bothOrders = (catalog: CapabilityItem[], disk: CapabilityItem[]): CapabilityItem[] => {
    const marketFirst = mergeItems(itemsForTab(applySectionRows(applySectionRows([], 'market', catalog), 'mine', disk), 'mine'))
    const mineFirst = mergeItems(itemsForTab(applySectionRows(applySectionRows([], 'mine', disk), 'market', catalog), 'mine'))
    expect(mineFirst, '两种到达顺序的卡片数据必须逐字相同').toEqual(marketFirst)
    return marketFirst
  }

  it('market 商店行 + isOwner:true + 已装 ⇒ 两种到达顺序都给「上传」（根因回归）', () => {
    const rows = bothOrders(
      [ownerRow('market', 'owned-skill')],
      [ownerRow('market', 'owned-skill'), diskRow('market', 'owned-skill')],
    )
    expect(rows).toHaveLength(1)
    const item = rows[0]!
    expect(item.source, '归并后的展示来源仍是市场（权威序不动）').toBe('market')
    expect(item.isOwner).toBe(true)
    expect(item.installed).toBe(true)
    // 修前：这里退化成一整档「卸载」⇒ 作者上架后再也发不了新版。
    expect(planCardAction(item)).toEqual({ kind: 'upload' })
    // 页脚文案由唯一判定函数分档：商店行是「上传新版」，不是本机行的「上传共享」。
    expect(uploadActionLabelKey(item)).toBe('capability.uploadNew')
  })

  it('本机那一发只带磁盘行（不带目录副本）⇒ 两种到达顺序仍都给「上传」', () => {
    // `?source=local` 的载荷是否捎带目录行是实现细节；`installed` 由归并层按
    // "存在本机行" 补上（mergeItems），归属与 source 由目录那一发给 —— 两者都要齐。
    const rows = bothOrders([ownerRow('market', 'owned-skill')], [diskRow('market', 'owned-skill')])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source).toBe('market')
    expect(rows[0]!.installed).toBe(true)
    expect(rows[0]!.isOwner).toBe(true)
    expect(planCardAction(rows[0]!)).toEqual({ kind: 'upload' })
  })

  it('作者面的待审行（status:pending）⇒ 徽章照旧说「审核中」，页脚仍给「上传新版」', () => {
    // 服务端本轮起在作者面下发 market 渠道的 own 行（含 pending）—— 作者必须能看到
    // 待审状态（徽章来自归并后的 status），同时仍能继续发新版本（契约没有"待审中
    // 不许再传"这一档；真被服务端拒时由既有失败文案兜底）。
    const pending = ownerRow('market', 'owned-skill', { status: 'pending' })
    const merged = mergeItems([pending])
    expect(merged[0]!.status).toBe('pending')
    expect(planCardAction(merged[0]!)).toEqual({ kind: 'upload' })
  })

  it('org 渠道商店行 + 归属人 + 已装 ⇒ 同样给「上传」', () => {
    const rows = bothOrders(
      [ownerRow('org', 'org-owned')],
      [ownerRow('org', 'org-owned'), diskRow('org', 'org-owned')],
    )
    expect(rows[0]!.source).toBe('org')
    expect(planCardAction(rows[0]!)).toEqual({ kind: 'upload' })
  })

  it('智能体（kind:agent）同构：商店行 + 归属人 + 已装 ⇒ 同样给「上传」', () => {
    // 服务端契约对"任意渠道 / 两种 kind"一视同仁；客户端判据不得只认 skill。
    expect(planCardAction(ownerRow('org', 'my-agent', {}, 'agent'))).toEqual({ kind: 'upload' })
    expect(planCardAction(ownerRow('market', 'my-agent', {}, 'agent'))).toEqual({ kind: 'upload' })
  })

  it('非归属人（is_owner:false）⇒ 不出上传：卸载 / 安装 / 更新到 vX 三档照旧', () => {
    // 契约：非归属人发新版 ⇒ 409 NAME_TAKEN ⇒ 这里给「上传」就是假入口。
    const installedNotOwner = ownerRow('market', 'theirs', { isOwner: false })
    expect(planCardAction(installedNotOwner)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/zeokeel/skills/theirs/uninstall',
      localContent: false,
    })
    // 未安装 ⇒ 仍是「安装」。
    expect(planCardAction({ ...installedNotOwner, installed: false, installedVersion: undefined })).toEqual({ kind: 'install' })
    // 有新版且非归属人 ⇒ 仍是「更新到 vX」（回归）。
    const hasNewer = ownerRow('market', 'theirs', {
      isOwner: false, version: '2.0.0', versions: ['2.0.0'], installedVersion: '1.0.0',
    })
    expect(planCardAction(hasNewer)).toEqual({ kind: 'update', version: '2.0.0' })
    // 未下发 `is_owner`（旧服务端）≠ 归属人：宁可不出入口，也不能给假的。
    expect(planCardAction({ ...installedNotOwner, isOwner: undefined }).kind).toBe('uninstall')
  })

  it('下架行（delisted:true）⇒ 不出上传（本机有一份 ⇒ 卸载；没有 ⇒ 只报状态）', () => {
    const delisted = ownerRow('market', 'gone', { delisted: true })
    expect(isDelistedItem(delisted)).toBe(true)
    expect(planCardAction(delisted)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/zeokeel/skills/gone/uninstall',
      localContent: false,
    })
    expect(planCardAction(delisted).kind).not.toBe('upload')
    // 未安装的下架行：只报状态，不给任何假按钮（既有 R5-B-1 口径）。
    expect(planCardAction({ ...delisted, installed: false, installedVersion: undefined })).toEqual({ kind: 'delisted' })
  })

  it('官方行（official:true）⇒ 不出上传（客户端证明不了管理员，与「更新」置灰同口径）', () => {
    const official = ownerRow('market', 'official-skill', { official: true })
    const plan = planCardAction(official)
    expect(plan.kind).not.toBe('upload')
    expect(plan).toEqual({
      kind: 'uninstall',
      endpoint: '/api/zeokeel/skills/official-skill/uninstall',
      localContent: false,
    })
    // 官方行有新版时照旧是「更新到 vX」（渲染层对 official 置灰）—— 既有口径不因本改动放宽。
    const officialUpdate = ownerRow('market', 'official-skill', {
      official: true, version: '2.0.0', versions: ['2.0.0'], installedVersion: '1.0.0',
    })
    expect(planCardAction(officialUpdate)).toEqual({ kind: 'update', version: '2.0.0' })
  })

  it('未安装的商店行（即使是归属人）⇒ 仍是「安装」（回归）', () => {
    const row = ownerRow('market', 'owned-skill', { installed: false, installedVersion: undefined })
    expect(planCardAction(row)).toEqual({ kind: 'install' })
    expect(uploadActionLabelKey(row)).toBe('capability.uploadNew')
  })

  it('归属人 + 已装 + 目录里有更高版本 ⇒ 仍给「上传」（取舍：发新版优先于装新版）', () => {
    // 取舍依据：契约里「更新到 vX」这一档只对**非归属人**成立；归属人的卡片承载的是
    // "发新版本"。若先给「更新」，作者在目录已有他的更高版本时又会失去上传入口 ——
    // 正是本改动的根因形态。装新版仍可从详情弹层的版本列表走（A11 的既有入口）。
    const row = ownerRow('market', 'owned-skill', {
      version: '2.0.0', versions: ['2.0.0'], installedVersion: '1.0.0',
    })
    expect(hasUpdateFor(row)).toBe(true)
    expect(planCardAction(row)).toEqual({ kind: 'upload' })
  })

  it('未改动权威序：同一名字在 market/org/本机都有行时，归并结果仍是市场行（两种顺序）', () => {
    const rows = bothOrders(
      [ownerRow('org', 'same-name'), ownerRow('market', 'same-name')],
      [diskRow('market', 'same-name')],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source).toBe('market')
    expect(rows[0]!.isOwner).toBe(true)
    expect(planCardAction(rows[0]!)).toEqual({ kind: 'upload' })
  })

  it('上传按钮文案分档：本机行「上传共享」/ 商店行「上传新版」', () => {
    expect(uploadActionLabelKey({ source: 'local' })).toBe('capability.upload')
    expect(uploadActionLabelKey({ source: 'market' })).toBe('capability.uploadNew')
    expect(uploadActionLabelKey({ source: 'org' })).toBe('capability.uploadNew')
    setActiveLocale('zh')
    expect(t(uploadActionLabelKey({ source: 'market' }))).toBe('上传新版')
    // local 行文案逐字不变（既有产品动作「上传共享」）。
    expect(t(uploadActionLabelKey({ source: 'local' }))).toBe('上传共享')
    setActiveLocale('en')
    const enLabel = t(uploadActionLabelKey({ source: 'market' }))
    expect(enLabel).not.toMatch(/[\u4e00-\u9fff]/u)
    expect(enLabel).not.toBe(t(uploadActionLabelKey({ source: 'local' })))
  })

  it('审核提示只出现在「market 商店行 + 归属人」的卡片上', () => {
    const marketOwner = ownerRow('market', 'owned-skill')
    expect(showsMarketReviewHint(marketOwner)).toBe(true)
    // 组织渠道由本组织管理员审（不是市场审核）⇒ 不提示。
    expect(showsMarketReviewHint(ownerRow('org', 'org-owned'))).toBe(false)
    // 非归属人 / 官方 / 下架 / 未装 ⇒ 根本没有「上传新版」入口 ⇒ 不提示
    //（否则会出现"卡片说要审核、页脚却没有上传按钮"的自相矛盾，与 R5-B-1/B-2 同形）。
    expect(showsMarketReviewHint({ ...marketOwner, isOwner: false })).toBe(false)
    expect(showsMarketReviewHint({ ...marketOwner, official: true })).toBe(false)
    expect(showsMarketReviewHint({ ...marketOwner, delisted: true })).toBe(false)
    expect(showsMarketReviewHint({ ...marketOwner, installed: false })).toBe(false)
    // 本机行不是商店行。
    expect(showsMarketReviewHint({ ...marketOwner, source: 'local' })).toBe(false)
    // 文案走字典，两种语言都说得清"审核"这件事。
    setActiveLocale('zh')
    expect(t('capability.marketReviewHint')).toContain('审核')
    setActiveLocale('en')
    expect(t('capability.marketReviewHint')).toContain('review')
  })

  it('渲染层真的接上了（文案分档 + 审核提示，源码级；本包没有 jsdom）', () => {
    const panel = readFileSync(fileURLToPath(new URL('../../capability-center/src/client/CapabilityCenterPanel.tsx', import.meta.url)), 'utf8')
    // 上传按钮文案由唯一判定函数决定（不在 JSX 里另写一遍三元）。
    expect(panel).toContain('{t(uploadActionLabelKey(item))}')
    // 审核提示：带 data-role（探针/断言都能定位），文案走字典。
    expect(panel).toContain('data-role="card-market-review-hint"')
    expect(panel).toContain("{t('capability.marketReviewHint')}")
    // 字典两份都在（locales-hygiene 另钉键集一致 / 无死键 / en 无 CJK）。
    expect(zh['capability.uploadNew']).toBe('上传新版')
    expect(zh['capability.marketReviewHint']).toContain('管理员审核')
    expect(en['capability.uploadNew'].trim()).not.toBe('')
    expect(en['capability.marketReviewHint']).toContain('review')
  })
})

// ---------------------------------------------------------------------------
// 2026-10-26 能力中心现代化重构（盘点 F-07/F-08/F-09/F-10/F-11 + 设计定案）
// ---------------------------------------------------------------------------
//
// 本组把**新判据**钉在纯函数上（本包没有 jsdom）：四分段归属、我上传的证据链、
// 排序、卡片最多两个 Chip、其余状态只做小状态点、页脚动作的分段收窄、6 张骨架卡。
// 渲染接线用源码级断言（与同文件既有 A2/A3/A11/A15 组同一形态），因为"卡片里有没有
// 大段状态说明""官方更新按钮还禁不禁用"这类退化只有读渲染层才抓得到。

describe('四分段与"我上传"证据链（F-08）', () => {
  const rows = [
    { kind: 'skill' as const, name: 'draft', source: 'local', installed: false, originChannel: undefined as string | undefined },
    { kind: 'skill' as const, name: 'installed-store', source: 'org', installed: true, originChannel: undefined as string | undefined },
    { kind: 'skill' as const, name: 'market-only', source: 'market', installed: false, originChannel: undefined as string | undefined },
    { kind: 'skill' as const, name: 'my-pending', source: 'market', installed: false, isOwner: true },
  ]

  it('all = 全部；installed 只看磁盘；market 排除本机行', () => {
    expect(itemsForTab(rows, 'all').map(i => i.name).sort()).toEqual(['draft', 'installed-store', 'market-only', 'my-pending'])
    expect(itemsForTab(rows, 'installed').map(i => i.name)).toEqual(['installed-store'])
    expect(itemsForTab(rows, 'market').map(i => i.name).sort()).toEqual(['installed-store', 'market-only', 'my-pending'])
  })

  it('own = 作者面（isOwner:true 即使没有本机副本）+ 本机草稿；商店装来的本机行不算', () => {
    expect(itemsForTab(rows, 'own').map(i => i.name).sort()).toEqual(['draft', 'my-pending'])
    // 旧调用面（'mine'）逐字保留：本机创作 + 已安装来源条目。
    expect(itemsForTab(rows, 'mine').map(i => i.name).sort()).toEqual(['draft', 'installed-store'])
  })

  it('isOwnUploadItem：作者行 / 草稿 命中；商店来源的本机行与目录行不命中', () => {
    expect(isOwnUploadItem({ source: 'market', isOwner: true })).toBe(true)
    expect(isOwnUploadItem({ source: 'local' })).toBe(true)
    expect(isOwnUploadItem({ source: 'local', originChannel: 'market' })).toBe(false)
    // 上传记录还在的本机行仍算（作者自己传过）
    expect(isOwnUploadItem({ source: 'local', originChannel: 'market', uploadStatus: 'rejected' })).toBe(true)
    expect(isOwnUploadItem({ source: 'market', isOwner: false })).toBe(false)
  })

  it('tabCounts 按分段的可见行数计数（同 kind:name 只算一次）', () => {
    const merged = mergeItems([
      { kind: 'skill', source: 'market', name: 'x', version: '1.0.0', displayName: '', description: '', author: '', versions: ['1.0.0'], status: 'approved' },
      { kind: 'skill', source: 'local', name: 'x', version: '1.0.0', displayName: '', description: '', author: '', versions: [], isLocal: true },
    ])
    const counts = tabCounts(merged)
    expect(counts.all).toBe(1)
    expect(counts.installed).toBe(1) // 存在本机行 ⇒ 已装
    expect(counts.market).toBe(1)
  })
})

describe('排序 / 视图 / 骨架（设计定案）', () => {
  const base = (name: string, version: string, extra: Partial<CapabilityItem> = {}): CapabilityItem => ({
    kind: 'skill', source: 'market', name, displayName: name, version, description: '', author: '',
    versions: [version], status: 'approved', installed: false, ...extra,
  })

  it('downloads 降序；name 升序；updated 时间戳优先、缺省按版本降序兜底', () => {
    const items = [
      base('b', '1.0.0', { downloads: 5 }),
      base('a', '2.0.0', { downloads: 50 }),
      base('c', '1.5.0', { updatedAt: '2026-10-26T00:00:00.000Z' }),
    ]
    expect(sortItems(items, 'downloads').map(i => i.name)).toEqual(['a', 'b', 'c'])
    expect(sortItems(items, 'name').map(i => i.name)).toEqual(['a', 'b', 'c'])
    // updated：有 updatedAt 的行排最前；其余按版本号降序（不编造时间）。
    expect(sortItems(items, 'updated').map(i => i.name)).toEqual(['c', 'a', 'b'])
  })

  it('骨架是 6 张卡（不是一句「加载中…」）', () => {
    expect(skeletonKeys()).toHaveLength(6)
    expect(skeletonKeys(0)).toEqual([])
    expect(skeletonKeys()).toEqual(skeletonKeys())
  })
})

describe('卡片信息密度（最多两个 Chip + 小状态点）', () => {
  const base: CapabilityItem = {
    kind: 'skill', source: 'market', name: 'x', displayName: 'X 技能', version: '1.0.0',
    description: 'd', author: 'a', versions: ['1.0.0'], status: 'approved', installed: true,
    installedOrigin: 'store', downloads: 0,
  }

  it('官方 + 状态：恰好两个；官方在最前', () => {
    const chips = cardChips({ ...base, official: true, status: 'pending' }, 'all')
    expect(chips).toHaveLength(2)
    expect(chips[0]!.key).toBe('capability.official')
    expect(chips[1]!.key).toBe('capability.pending')
  })

  it('没有官方/状态时用来源徽章；任何情况都不超过两个', () => {
    const chips = cardChips({ ...base, originChannel: 'org', dirty: true, originServer: 'other', originSymlink: true }, 'installed')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.key).toBe('capability.sourceOrg')
    for (const tab of ['all', 'installed', 'own', 'market'] as const) {
      expect(cardChips({ ...base, official: true, delisted: true }, tab).length).toBeLessThanOrEqual(2)
    }
  })

  it('「我上传」里 approved 显示「已共享」，草稿显示「未上传」', () => {
    expect(cardStatusChip({ ...base, status: 'approved' }, 'own')?.key).toBe('capability.approved')
    expect(cardStatusChip({ ...base, source: 'local', status: undefined, uploadStatus: undefined }, 'own')?.key).toBe('capability.draftNotUploaded')
    // 下架优先于一切状态（作者面必须看到管控结果）。
    expect(cardStatusChip({ ...base, delisted: true }, 'own')?.key).toBe('capability.delisted')
  })

  it('其余状态只做小状态点（最多两个），已安装分段不重复报"已安装"', () => {
    const dots = cardStatusDots({ ...base, dirty: true, originServer: 'other', originSymlink: true }, 'all')
    expect(dots).toHaveLength(2)
    expect(dots.map(d => d.key)).toEqual(['capability.dirty', 'capability.originOtherServer'])
    expect(cardStatusDots(base, 'installed').map(d => d.key)).toEqual([])
    expect(cardStatusDots(base, 'all').map(d => d.key)).toContain('capability.installed')
  })
})

describe('页脚动作的分段收窄（我上传里未通过的版本不给假「安装」）', () => {
  const pending: CapabilityItem = {
    kind: 'skill', source: 'market', name: 'new-skill', displayName: '新技能', version: '1.0.0',
    description: '', author: '', versions: ['1.0.0'], status: 'pending', installed: false, isOwner: true,
  }
  it('pending/rejected 且无本机副本 ⇒ 只报状态；其它分段照旧给「安装」', () => {
    expect(planCardActionForTab(pending, 'own')).toEqual({ kind: 'review', status: 'pending' })
    expect(planCardActionForTab({ ...pending, status: 'rejected' }, 'own')).toEqual({ kind: 'review', status: 'rejected' })
    // 「全部」同样渲染作者面行（own 分区）⇒ 也不能给注定失败的「安装」。
    expect(planCardActionForTab(pending, 'all')).toEqual({ kind: 'review', status: 'pending' })
    expect(planCardActionForTab({ ...pending, status: 'rejected' }, 'all')).toEqual({ kind: 'review', status: 'rejected' })
    // 「市场」不渲染未通过版本（服务端目录面不列），判据保持 planCardAction 原样。
    expect(planCardActionForTab(pending, 'market')).toEqual({ kind: 'install' })
  })
  it('其它动作逐字沿用 planCardAction（不因分段改变）', () => {
    const installed: CapabilityItem = { ...pending, status: 'approved', installed: true, installedVersion: '1.0.0', installedOrigin: 'store' }
    expect(planCardActionForTab(installed, 'own')).toEqual(planCardAction(installed))
    expect(planCardActionForTab(installed, 'installed')).toEqual(planCardAction(installed))
  })
})

describe('渲染接线（源码级）：现代化设计 + F-07/F-09/F-10/F-11', () => {
  const source = readFileSync(fileURLToPath(new URL('../../capability-center/src/client/CapabilityCenterPanel.tsx', import.meta.url)), 'utf8')

  it('默认分段是「全部」，四个分段的文案键都在工具条里', () => {
    expect(source).toContain("useState<SourceTab>('all')")
    for (const key of ['capability.tabAll', 'capability.tabInstalled', 'capability.tabOwn', 'capability.tabMarket']) {
      expect(source, key).toContain(`t('${key}')`)
    }
    // 工具条 = PanelPage 的 toolbar（不是内容区顶部的手写一行）。
    expect(source).toMatch(/toolbar=\{resolvedDetail === null \? \(/u)
  })

  it('排序（最近更新/名称/下载）、视图切换（网格/列表）、结果计数都在工具条里', () => {
    for (const key of ['capability.sortUpdated', 'capability.sortName', 'capability.sortDownloads', 'capability.viewGrid', 'capability.viewList', 'capability.resultCount']) {
      // 带参数的键（resultCount）在调用点后面还有 `, { … }`，所以只钉 `t('key'` 前缀。
      expect(source, key).toContain(`t('${key}'`)
    }
    expect(source).toContain('setSort(')
    expect(source).toContain('setView(')
    expect(source).toContain('data-role="capability-result-count"')
  })

  it('加载态是 6 张骨架卡：不再有「加载中…」一句', () => {
    expect(source).toContain('renderSkeleton()')
    expect(source).toContain('skeletonKeys()')
    expect(source).not.toContain("t('capability.loading')")
  })

  it('卡片里不再放大段状态说明（下架/转交/审核提示只在详情视图）', () => {
    const card = /const renderCard = \(item: CapabilityItem\): React\.ReactNode => \{([\s\S]*?)\n  \}/u.exec(source)
    expect(card, 'renderCard 必须存在').not.toBeNull()
    for (const key of ['capability.delistedHint', 'capability.transferredHint', 'capability.marketReviewHint']) {
      expect(card![1], `卡片里不得出现 ${key}`).not.toContain(key)
    }
    // 详情里必须有（否则状态说明整个消失）。
    expect(source).toContain('data-role="card-delisted-reason"')
    expect(source).toContain('data-role="card-transferred-reason"')
    expect(source).toContain('data-role="card-market-review-hint"')
    // 页脚只有「一个 primary 动作 + 一个 ghost 详情」：详情按钮是 ghost + 文案。
    expect(card![1]).toContain('renderDetailButton(')
    expect(source).toContain("variant=\"ghost\"")
  })

  it('卡片 key 稳定为 kind:name（多版本不产生重复卡）', () => {
    expect(source).toContain('const key = `${item.kind}:${item.name}`')
    expect(source).toContain('data-key={key}')
    // 归并仍由 mergeItems 唯一负责（planSectionCards 去重内置卡）。
    expect(source).toContain('mergeItems(items)')
  })

  it('详情是面板内整页子视图：面板不再渲染弹层，但兼容导出仍在', () => {
    expect(source).not.toMatch(/<CapabilityDetailDialog/u)
    expect(source).toContain('data-role="capability-detail"')
    expect(source).toContain('onClick={() => { setDetail(')
    expect(typeof CapabilityDetailDialog).toBe('function')
  })

  it('F-07 卸载成功后立即从列表移除并重载（不再只翻 installed 后回弹）', () => {
    const uninstall = /const uninstall = async \([\s\S]*?\n  \}/u.exec(source)
    expect(uninstall).not.toBeNull()
    expect(uninstall![0]).toContain("i.source === 'local'")
    expect(uninstall![0]).toContain('loadAll()')
  })

  it('F-09 官方行有新版时更新按钮不再被禁用', () => {
    const update = /plan\.kind === 'update' \? \(([\s\S]*?): plan\.kind === 'reupload'/u.exec(source)
    expect(update, '更新分支必须存在').not.toBeNull()
    expect(update![1]).not.toContain('item.official')
    expect(source).not.toContain("t('capability.officialLocked')")
  })

  it('F-10 409 只有 LOCAL_CONTENT 进确认条，其它 409 走错误文案', () => {
    const perform = /const performInstall = async \([\s\S]*?\n  \}/u.exec(source)
    expect(perform).not.toBeNull()
    expect(perform![0]).toContain("code === '' || code === 'LOCAL_CONTENT'")
    expect(perform![0]).toContain('uploadFailureText({')
    // 确认条的措辞档位不能再默认成「本机自制」。
    expect(perform![0]).toContain('needsOverwriteConfirm(item) ? overwriteConfirmReason(item) : \'store\'')
  })

  it('F-08/F-11 「我上传」走 own 通道，且轮询会刷新 own（审核态不粘滞）', () => {
    expect(source).toContain("fetchCapabilityRows('own')")
    expect(source).toContain("loadSection('own'")
    expect(source).toMatch(/refresh\('own', 'own'\)/u)
  })
})
