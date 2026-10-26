/**
 * 能力中心客户端**核心判据**（F-38，2026-10-26 盘点）。
 *
 * 现场：`planCardAction` / `mergeItems` / `itemsForTab` / 端点拼装 / 覆盖确认这几条
 * 纯函数的安全与语义一直只有 `packages/host/enterprise/tests/` 的跨包用例在钉 ——
 * 它们的归属包是 `@zeokeel/dsh-capability-center`，却没有任何本包直跑用例。后果是
 * 改本包的人只跑 `yarn workspace … check` 时**看不到**这些判据（包内 `test` 只跑
 * 插件入口/字典/版本比较），移动或简化判据时回归可能恰好落在没跑的那个包里。
 *
 * 本文件把核心矩阵直接钉在归属包（不放宽任何一条断言）：
 *   - `mergeItems`：多版本归并 / 跨源权威序 / 到达顺序无关 / 已完成安装推导 /
 *     归属归一化 / 下架合并 / **F-33 批准集与本地版本分离**；
 *   - `itemsForTab` + `isOwnUploadItem`：四分段与作者面证据；
 *   - `planCardAction`：本机内置 / 已转交 / 已下架 / 符号链接 / 上传进度 / 商店行
 *     六档（含"绝不给假按钮"的准入条件）；
 *   - 端点拼装：market/org/agent（含 F-30 渠道提示）/ 本机内置卸载；
 *   - 覆盖确认三档措辞与 `?overwrite=1` / `?ownership=unknown` 契约；
 *   - `uploadFailureText` 的错误码分档（F-32）与 `readFailureEnvelope` 两种信封；
 *   - `uploadPreviewText`：上传前"将发布版本"的本地化文案（F-32）。
 *
 * enterprise 侧的跨包契约用例保持原样（两份都跑，不互相替代）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  applySectionRows,
  capabilitySourceBadgeKey,
  confirmStripAction,
  confirmStripText,
  hasUpdateFor,
  installChannelHint,
  installEndpoint,
  installNeedsConfirm,
  installRequestUrl,
  isDelistedItem,
  isOwnUploadItem,
  isTransferredItem,
  itemsForTab,
  latestApprovedVersionByName,
  localRemoveEndpoint,
  mergeItems,
  needsOverwriteConfirm,
  overwriteConfirmReason,
  planCardAction,
  planCardActionForTab,
  readFailureEnvelope,
  tabCounts,
  uninstallEndpoint,
  uninstallRequestUrl,
  uploadActionLabelKey,
  uploadFailureText,
  uploadPreviewText,
  versionInstallSupported,
  withOverwrite,
  type CapabilityItem,
} from '../src/client/CapabilityCenterPanel.tsx'
import { en, setActiveLocale, t, zh } from '../src/client/locales.ts'

afterEach(() => { setActiveLocale('zh') })

/** 一条目录行（服务端归并面形状；`installed*` 由宿主按磁盘补齐）。 */
function catalogRow(extra: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    kind: 'skill', source: 'market', name: 'codeql', displayName: 'CodeQL',
    version: '1.2.0', description: '目录说明', author: 'alice', status: 'approved',
    versions: ['1.0.0', '1.2.0'], installed: false, official: false, downloads: 3,
    calls: 1, score: 10, isOwner: false, ...extra,
  }
}

/** 一条本机扫盘行（宿主 `localRows` 形状：**不带 installed**、版本来自 provenance）。 */
function localRow(extra: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    kind: 'skill', source: 'local', name: 'codeql', displayName: 'codeql',
    version: '1.0.0', description: '', author: '', versions: [], isLocal: true,
    installedOrigin: 'store', originChannel: 'market', originAppId: 'codeql',
    dirty: false, localOwnership: 'mine', ...extra,
  }
}

describe('mergeItems：多版本归并与跨源权威序', () => {
  it('同名同 kind 归并为一卡，展示最高 approved 版本，versions 升序', () => {
    const merged = mergeItems([
      catalogRow({ version: '1.0.0', versions: ['1.0.0'] }),
      catalogRow({ version: '1.10.0', versions: ['1.10.0'] }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.version).toBe('1.10.0')
    expect(merged[0]!.versions).toEqual(['1.0.0', '1.10.0'])
  })

  it('技能与智能体允许同名（复合键，不互相吞并）', () => {
    const merged = mergeItems([catalogRow(), catalogRow({ kind: 'agent' })])
    expect(merged.map(row => row.kind).sort()).toEqual(['agent', 'skill'])
  })

  it('权威序 市场 > 组织 > 本机：展示来源与标题不随到达顺序变化', () => {
    const rows = [
      catalogRow({ source: 'org', displayName: '代码审查', description: '组织版' }),
      catalogRow({ source: 'market', displayName: '', description: '市场版' }),
      localRow({ displayName: 'codeql' }),
    ]
    const forward = mergeItems(rows)
    const backward = mergeItems([...rows].reverse())
    expect(forward).toEqual(backward)
    expect(forward).toHaveLength(1)
    expect(forward[0]!.source).toBe('market')
    // 标题取更"新"的非空值（组织行的中文标题不被市场的同名标题盖掉）。
    expect(forward[0]!.displayName).toBe('代码审查')
  })

  it('存在本机行 ⇒ installed；provenance 字段只认本机行（A6/N1）', () => {
    const merged = mergeItems([
      catalogRow(),
      localRow({ originChannel: 'plugin', originAppId: 'codeql', localOwnership: undefined }),
    ])
    expect(merged[0]!.installed).toBe(true)
    expect(merged[0]!.originChannel).toBe('plugin')
    // 归属判据缺省归一成 unknown（证明不了 ≠ 我的，R6-B-1）。
    expect(merged[0]!.localOwnership).toBe('unknown')
  })

  it('下架是 App 级事实：任一行说下架就是下架（false 优先）', () => {
    const merged = mergeItems([catalogRow(), catalogRow({ delisted: true })])
    expect(merged[0]!.delisted).toBe(true)
  })

  it('F-33：本机草稿版本**不得**混进批准集，但仍是卡片的展示版本', () => {
    const merged = mergeItems([
      // 作者面：服务端还没有任何 approved 版本（这名字是本机草稿）。
      localRow({ version: '0.9.0', name: 'draft', displayName: 'draft' }),
    ])
    expect(merged[0]!.versions).toEqual([])
    expect(merged[0]!.localVersion).toBe('0.9.0')
    // 没有批准版本时，展示版本回落到本机版本（作者要看得见自己写的是哪版）。
    expect(merged[0]!.version).toBe('0.9.0')
  })

  it('F-33：有 approved 时批准集只含 approved，草稿版本单独在 localVersion', () => {
    const merged = mergeItems([
      catalogRow({ name: 'mine', version: '1.2.0', versions: ['1.0.0', '1.2.0'] }),
      localRow({ name: 'mine', version: '1.3.0-rc1' }),
    ])
    expect(merged[0]!.versions).toEqual(['1.0.0', '1.2.0'])
    expect(merged[0]!.version).toBe('1.2.0')
    expect(merged[0]!.localVersion).toBe('1.3.0-rc1')
    // hasUpdateFor 的基准只能读批准集（否则会把本地草稿当成可升级目标）。
    expect(merged[0]!.versions).not.toContain('1.3.0-rc1')
  })

  it('F-33：pending 版本不进批准集，但卡片展示 pending 版本（作者面）', () => {
    const pending: CapabilityItem = {
      ...catalogRow({ name: 'mine', version: '2.0.0', status: 'pending', versions: [] }),
      isOwner: true,
    }
    const merged = mergeItems([pending])
    expect(merged[0]!.versions).toEqual([])
    expect(merged[0]!.version).toBe('2.0.0')
    expect(merged[0]!.status).toBe('pending')
  })
})

describe('itemsForTab / isOwnUploadItem：四分段与作者面证据', () => {
  const rows = [
    { kind: 'skill' as const, name: 'draft', source: 'local', installed: false, originChannel: undefined as string | undefined },
    { kind: 'skill' as const, name: 'installed-store', source: 'org', installed: true },
    { kind: 'skill' as const, name: 'market-only', source: 'market', installed: false },
    { kind: 'skill' as const, name: 'my-pending', source: 'market', installed: false, isOwner: true },
  ]

  it('all / installed / market / own / 兼容 mine', () => {
    expect(itemsForTab(rows, 'all').map(i => i.name).sort()).toEqual(['draft', 'installed-store', 'market-only', 'my-pending'])
    expect(itemsForTab(rows, 'installed').map(i => i.name)).toEqual(['installed-store'])
    expect(itemsForTab(rows, 'market').map(i => i.name).sort()).toEqual(['installed-store', 'market-only', 'my-pending'])
    expect(itemsForTab(rows, 'own').map(i => i.name).sort()).toEqual(['draft', 'my-pending'])
    // 历史调用面（2026-08-25 定案）语义不变：本机创作 + 已安装来源条目。
    expect(itemsForTab(rows, 'mine').map(i => i.name).sort()).toEqual(['draft', 'installed-store'])
  })

  it('isOwnUploadItem：作者行/本机草稿命中，商店装来的本机行不命中', () => {
    expect(isOwnUploadItem({ source: 'market', isOwner: true })).toBe(true)
    expect(isOwnUploadItem({ source: 'local' })).toBe(true)
    expect(isOwnUploadItem({ source: 'local', originChannel: 'org' })).toBe(false)
    expect(isOwnUploadItem({ source: 'local', originChannel: 'org', uploadStatus: 'rejected' })).toBe(true)
    expect(isOwnUploadItem({ source: 'market', isOwner: false })).toBe(false)
  })

  it('tabCounts 按归并行计数（同一 kind:name 只算一次）', () => {
    const counts = tabCounts(mergeItems([catalogRow({ installed: true }), localRow()]))
    expect(counts).toMatchObject({ all: 1, installed: 1, market: 1 })
  })
})

describe('applySectionRows：并发取数的归约与到达顺序无关', () => {
  const MARKET = [catalogRow({ name: 'market-a' }), catalogRow({ name: 'codeql', installed: true, installedVersion: '1.0.0', installedOrigin: 'store' })]
  const MINE = [catalogRow({ name: 'codeql', installed: true, installedVersion: '1.0.0', installedOrigin: 'store' }), localRow()]

  it('market 先到与 mine 先到归并后逐字相同（原始数组允许重复，归并层唯一负责去重）', () => {
    const marketFirst = mergeItems(applySectionRows(applySectionRows([], 'market', MARKET), 'mine', MINE))
    const mineFirst = mergeItems(applySectionRows(applySectionRows([], 'mine', MINE), 'market', MARKET))
    expect(marketFirst).toEqual(mineFirst)
    expect(marketFirst.map(row => row.name).sort()).toEqual(['codeql', 'market-a'])
  })

  it('own 分区只替换上一次 own 行，不碰市场/本机行', () => {
    const market = applySectionRows([], 'market', MARKET)
    const mine = applySectionRows(market, 'mine', MINE)
    const own = applySectionRows(mine, 'own', [catalogRow({ name: 'own-a', isOwner: true, status: 'pending' })])
    expect(own.filter(i => i.section === 'own').map(i => i.name)).toEqual(['own-a'])
    const refreshed = applySectionRows(own, 'own', [catalogRow({ name: 'own-b', isOwner: true })])
    expect(refreshed.filter(i => i.section === 'own').map(i => i.name)).toEqual(['own-b'])
    // 市场/本机行都还在。
    expect(refreshed.some(i => i.name === 'market-a')).toBe(true)
    expect(refreshed.some(i => i.source === 'local' && i.name === 'codeql')).toBe(true)
  })
})

describe('端点拼装（含 F-30 智能体渠道提示）', () => {
  const base: CapabilityItem = catalogRow()

  it('市场技能走 /skills；组织共享技能带版本；agents 同一条代理', () => {
    expect(installEndpoint({ ...base, source: 'market' }, '1.0.0')).toBe('/api/zeokeel/skills/codeql/install')
    expect(installEndpoint({ ...base, source: 'org' }, '1.2.0')).toBe('/api/zeokeel/shared-skills/codeql/1.2.0/install')
    expect(uninstallEndpoint({ ...base, source: 'market' }, '1.0.0')).toBe('/api/zeokeel/skills/codeql/uninstall')
    expect(uninstallEndpoint({ ...base, source: 'org' }, '1.0.0')).toBe('/api/zeokeel/shared-skills/codeql/1.0.0/uninstall')
  })

  it('F-30：智能体安装带 ?channel=（市场/组织），技能端点不受影响', () => {
    const agent: CapabilityItem = { ...base, kind: 'agent', name: 'writer' }
    expect(installChannelHint(agent)).toBe('market')
    expect(installEndpoint(agent, '1.0.0')).toBe('/api/zeokeel/agent-presets/writer/install?channel=market')
    expect(installEndpoint({ ...agent, source: 'org' }, '1.0.0')).toBe('/api/zeokeel/agent-presets/writer/install?channel=org')
    // 本机行不该走安装 → 不带提示（宿主按历史行为记 org）。
    expect(installChannelHint({ ...agent, source: 'local' })).toBeUndefined()
    expect(installChannelHint({ ...base, kind: 'skill' })).toBeUndefined()
    expect(installEndpoint({ ...base, source: 'market' }, '1.0.0')).not.toContain('channel=')
  })

  it('本机内置（builtin/plugin）卸载走专属端点，其余来源不给', () => {
    const localBase: CapabilityItem = { ...base, source: 'local', installedOrigin: 'store' }
    expect(localRemoveEndpoint({ ...localBase, originChannel: 'builtin' })).toBe('/api/zeokeel/skills/builtin/codeql/uninstall')
    expect(localRemoveEndpoint({ ...localBase, originChannel: 'plugin' })).toBe('/api/zeokeel/skills/codeql/uninstall')
    expect(localRemoveEndpoint({ ...localBase, originChannel: 'market' })).toBeUndefined()
    expect(uninstallEndpoint({ ...localBase, originChannel: 'builtin' }, '1.0.0')).toBe('/api/zeokeel/skills/builtin/codeql/uninstall')
  })

  it('versionInstallSupported：只有组织共享技能的端点接受指定版本', () => {
    expect(versionInstallSupported({ ...base, source: 'org' })).toBe(true)
    expect(versionInstallSupported({ ...base, source: 'market' })).toBe(false)
    expect(versionInstallSupported({ ...base, kind: 'agent', source: 'org' })).toBe(false)
  })
})

describe('planCardAction：页脚动作矩阵（含准入条件）', () => {
  it('本机内置技能 ⇒ 卸载（带 localContent 判定）', () => {
    const item: CapabilityItem = { ...catalogRow(), source: 'local', originChannel: 'builtin', installedOrigin: 'store' }
    expect(planCardAction(item)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/zeokeel/skills/builtin/codeql/uninstall',
      localContent: false,
    })
  })

  it('已转交（is_owner:false + 有上传记录）⇒ 只报状态，不给上传', () => {
    const mine: CapabilityItem = { ...localRow(), uploadStatus: 'rejected', isOwner: false, installedOrigin: 'local' }
    expect(isTransferredItem(mine)).toBe(true)
    expect(planCardAction(mine)).toEqual({ kind: 'transferred' })
    // 对照：归属还在自己名下 ⇒ 重新上传。
    expect(planCardAction({ ...mine, isOwner: true })).toEqual({ kind: 'reupload' })
  })

  it('已下架：能证明归属 ⇒ 卸载本机那一份；证明不了 ⇒ 不给删除动作', () => {
    const mine: CapabilityItem = { ...localRow(), installed: true, delisted: true, installedOrigin: 'local', localOwnership: 'mine' }
    expect(planCardAction(mine)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/zeokeel/shared-skills/codeql/1.0.0/uninstall',
      localContent: true,
    })
    // `localOwnership='unknown'`（同机别的账号装的商店内容）⇒ 推断判据不成立。
    // 注意：权威字段 `delisted:true` 的行仍是下架（判据第 1 条先命中），这里必须用
    // **没有**该字段的本机行来验推断判据（R6-B-1 的现场形态）。
    const inferred: CapabilityItem = {
      ...localRow(), installed: true, installedOrigin: 'store', originChannel: 'market',
      localOwnership: 'unknown',
    }
    expect(isDelistedItem(inferred)).toBe(false)
    expect(planCardAction(inferred).kind).toBe('upload')
    // 目录行的下架：已装 ⇒ 卸载；未装 ⇒ 只报状态（假安装按钮不给）。
    const catalog: CapabilityItem = { ...catalogRow(), delisted: true, installed: true, installedOrigin: 'store' }
    expect(planCardAction(catalog)).toEqual({
      kind: 'uninstall',
      endpoint: '/api/zeokeel/skills/codeql/uninstall',
      localContent: false,
    })
    expect(planCardAction({ ...catalog, installed: false, installedVersion: undefined })).toEqual({ kind: 'delisted' })
  })

  it('符号链接 ⇒ 只报事实（上传入口有意拒收）', () => {
    const item: CapabilityItem = { ...localRow(), originSymlink: true, installedOrigin: 'local' }
    expect(planCardAction(item)).toEqual({ kind: 'linked' })
  })

  it('本机上传进度：rejected ⇒ 重新上传；pending/approved ⇒ 状态', () => {
    const item: CapabilityItem = { ...localRow(), installedOrigin: 'local' }
    expect(planCardAction({ ...item, uploadStatus: 'rejected' })).toEqual({ kind: 'reupload' })
    expect(planCardAction({ ...item, uploadStatus: 'pending' })).toEqual({ kind: 'review', status: 'pending' })
    expect(planCardAction({ ...item, uploadStatus: 'approved' })).toEqual({ kind: 'review', status: 'approved' })
    expect(planCardAction(item)).toEqual({ kind: 'upload' })
  })

  it('商店行：未装 ⇒ 安装；归属人且已装 ⇒ 上传新版；非归属人有新版 ⇒ 更新；否则卸载', () => {
    expect(planCardAction({ ...catalogRow(), installed: false })).toEqual({ kind: 'install' })
    expect(planCardAction(catalogRow({ installed: true, installedVersion: '1.0.0', installedOrigin: 'store', isOwner: true })))
      .toEqual({ kind: 'upload' })
    expect(planCardAction(catalogRow({ installed: true, installedVersion: '1.0.0', installedOrigin: 'store', isOwner: false })))
      .toEqual({ kind: 'update', version: '1.2.0' })
    expect(planCardAction(catalogRow({ installed: true, installedVersion: '1.2.0', installedOrigin: 'store', isOwner: false })))
      .toEqual({ kind: 'uninstall', endpoint: '/api/zeokeel/skills/codeql/uninstall', localContent: false })
  })

  it('官方行不出上传，但有新版时仍可更新（F-09 不回退）', () => {
    const official = catalogRow({ installed: true, installedVersion: '1.0.0', installedOrigin: 'store', isOwner: true, official: true })
    expect(planCardAction(official)).toEqual({ kind: 'update', version: '1.2.0' })
  })

  it('分段收窄：我上传里 pending/rejected 且无本机副本 ⇒ 只报状态', () => {
    const pending: CapabilityItem = catalogRow({ name: 'new', status: 'pending', versions: [], installed: false, isOwner: true })
    expect(planCardActionForTab(pending, 'own')).toEqual({ kind: 'review', status: 'pending' })
    expect(planCardActionForTab({ ...pending, status: 'rejected' }, 'own')).toEqual({ kind: 'review', status: 'rejected' })
    expect(planCardActionForTab(pending, 'all')).toEqual({ kind: 'review', status: 'pending' })
    expect(planCardActionForTab(pending, 'market')).toEqual({ kind: 'install' })
  })

  it('上传按钮文案分档：本机行「上传共享」/ 商店行「上传新版」', () => {
    expect(uploadActionLabelKey({ source: 'local' })).toBe('capability.upload')
    expect(uploadActionLabelKey({ source: 'market' })).toBe('capability.uploadNew')
    expect(t(uploadActionLabelKey({ source: 'org' }))).toBe('上传新版')
  })
})

describe('覆盖确认与 URL 契约（A2/A3/A15 + C2-1）', () => {
  const installed: CapabilityItem = catalogRow({ installed: true, installedVersion: '1.0.0', installedOrigin: 'store' })

  it('needsOverwriteConfirm：本机自制 / 已本地修改 ⇒ 确认；干净的商店内容 ⇒ 不确认', () => {
    expect(needsOverwriteConfirm({ ...installed, installedOrigin: 'local' })).toBe(true)
    expect(needsOverwriteConfirm({ ...installed, installedOrigin: 'store', dirty: true })).toBe(true)
    expect(needsOverwriteConfirm({ ...installed, installedOrigin: 'store', dirty: false })).toBe(false)
    expect(needsOverwriteConfirm({ ...installed, installed: false })).toBe(false)
    expect(installNeedsConfirm({ ...installed, installedOrigin: 'local' })).toBe(true)
    expect(installNeedsConfirm({ ...installed, installedOrigin: 'local' }, { overwrite: true })).toBe(false)
  })

  it('确认条措辞三档 + 历史调用回落到「自制」档', () => {
    expect(overwriteConfirmReason({ ...installed, installedOrigin: 'local' })).toBe('local')
    expect(overwriteConfirmReason({ ...installed, installedOrigin: 'store', dirty: true })).toBe('dirty')
    expect(overwriteConfirmReason({ ...installed, installedOrigin: 'store', dirty: false })).toBe('store')
    expect(confirmStripText({ name: 'x', localConflict: true, reason: 'dirty' })).toContain('本地修改')
    expect(confirmStripAction({ name: 'x', localConflict: true, reason: 'local' })).toBe('仍要覆盖')
    setActiveLocale('en')
    expect(confirmStripText({ name: 'x', localConflict: true, reason: 'dirty' })).toContain('local modifications')
  })

  it('installRequestUrl：overwrite 只在用户确认后出现，版本跟着那一发走', () => {
    const local: CapabilityItem = { ...installed, installedOrigin: 'local' }
    expect(installRequestUrl(local)).toBe('/api/zeokeel/skills/codeql/install')
    expect(installRequestUrl(local, { overwrite: true })).toBe('/api/zeokeel/skills/codeql/install?overwrite=1')
    expect(installRequestUrl({ ...local, kind: 'skill', source: 'org' }, { overwrite: true, version: '1.0.0' }))
      .toBe('/api/zeokeel/shared-skills/codeql/1.0.0/install?overwrite=1')
    expect(withOverwrite('/x', false)).toBe('/x')
    expect(withOverwrite('/x?channel=org', true)).toBe('/x?channel=org&overwrite=1')
  })

  it('uninstallRequestUrl：归属证明不了时带 ownership=unknown（C2-1）', () => {
    const item: CapabilityItem = { ...localRow(), originChannel: 'plugin', localOwnership: 'unknown' }
    expect(uninstallRequestUrl(item, { overwrite: true }))
      .toBe('/api/zeokeel/skills/codeql/uninstall?overwrite=1&ownership=unknown')
    expect(uninstallRequestUrl({ ...item, localOwnership: 'mine' }, { overwrite: true }))
      .toBe('/api/zeokeel/skills/codeql/uninstall?overwrite=1')
  })
})

describe('hasUpdateFor / latestApprovedVersionByName（数值比较器接线）', () => {
  it('approved 最高版本 > 已装版本才提示更新', () => {
    expect(hasUpdateFor(catalogRow({ installed: true, installedVersion: '1.0.0' }))).toBe(true)
    expect(hasUpdateFor(catalogRow({ installed: true, installedVersion: '1.2.0' }))).toBe(false)
    expect(hasUpdateFor(catalogRow({ installed: false }))).toBe(false)
    expect(latestApprovedVersionByName([catalogRow({ version: '1.0.0' }), catalogRow({ version: '1.10.0' })], 'skill', 'codeql'))
      .toBe('1.10.0')
  })
})

describe('错误文案映射（F-32 / R5-B-1）', () => {
  it('readFailureEnvelope：扁平与嵌套两种信封都读得出来', () => {
    expect(readFailureEnvelope({ error: 'x', code: 'NAME_TAKEN' })).toEqual({ code: 'NAME_TAKEN', message: 'x' })
    expect(readFailureEnvelope({ error: { code: 'APP_DELISTED', message: '已下架' } })).toEqual({ code: 'APP_DELISTED', message: '已下架' })
    expect(readFailureEnvelope(null)).toEqual({})
    expect(readFailureEnvelope({ error: 42 })).toEqual({})
  })

  it('APP_DELISTED ⇒ 下架冻结文案（R5-B-1 保持）', () => {
    expect(uploadFailureText({ code: 'APP_DELISTED', status: 409 })).toBe(zh['capability.delistedFrozen'])
  })

  it('VERSION_* / CONTENT_UNCHANGED ⇒ 本地化的「怎么修」', () => {
    const cases = [
      ['VERSION_NOT_INCREASING', 'capability.versionNotIncreasing'],
      ['VERSION_NOT_NEWER', 'capability.versionNotNewer'],
      ['VERSION_EXISTS', 'capability.versionExists'],
      ['VERSION_INVALID', 'capability.versionInvalid'],
      ['CONTENT_UNCHANGED', 'capability.contentUnchanged'],
    ] as const
    for (const [code, key] of cases) {
      expect(uploadFailureText({ code, status: 409 }), code).toBe(t(key))
      // 本地化文案不得把稳定码原样甩给用户。
      expect(t(key), code).not.toContain(code)
    }
    // 英文界面也本地化（不把码直接甩给用户）。
    setActiveLocale('en')
    for (const [code, key] of cases) {
      expect(uploadFailureText({ code, status: 409 }), code).toBe(en[key])
      expect(en[key]).not.toMatch(/[\u4e00-\u9fff]/u)
    }
  })

  it('未映射的码逐字沿用服务端 message；缺 message 回落 HTTP <status>', () => {
    expect(uploadFailureText({ code: 'PENDING_LIMIT', message: '待审上限已满', status: 429 })).toBe('待审上限已满')
    expect(uploadFailureText({ code: 'NAME_TAKEN', message: '名称已被占用，无法上传', status: 409 })).toBe('名称已被占用，无法上传')
    expect(uploadFailureText({ code: 'UPSTREAM', status: 502 })).toBe('HTTP 502')
    expect(uploadFailureText({ status: 409 })).toBe('HTTP 409')
    // 缺 code 不得按状态码推断成下架文案。
    expect(uploadFailureText({ status: 409, message: 'x' })).not.toBe(zh['capability.delistedFrozen'])
  })

  it('uploadPreviewText：有版本时正文与按钮都带版本；缺版本时如实说"未写版本号"', () => {
    const known = uploadPreviewText({ name: 'codeql', version: '1.3.0' })
    expect(known.text).toContain('codeql')
    expect(known.text).toContain('1.3.0')
    expect(known.action).toBe(t('capability.uploadPublish', { version: '1.3.0' }))
    const unknown = uploadPreviewText({ name: 'codeql' })
    expect(unknown.text).toBe(t('capability.uploadVersionUnknown', { name: 'codeql' }))
    setActiveLocale('en')
    expect(uploadPreviewText({ name: 'codeql', version: '2.0.0' }).text).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})

describe('来源徽章（六选一，市场/我的两套口径）', () => {
  it('市场分区用目录口径；已安装分区用磁盘 provenance 口径', () => {
    expect(capabilitySourceBadgeKey({ source: 'market', originChannel: undefined }, 'market')).toBe('capability.sourceMarket')
    expect(capabilitySourceBadgeKey({ source: 'org', originChannel: undefined }, 'market')).toBe('capability.sourceOrg')
    expect(capabilitySourceBadgeKey({ source: 'local' }, 'mine')).toBe('capability.sourceLocal')
    // 本机行永远是「自制」；来源徽章的 provenance 口径只对**归并后的商店行**生效
    // （A6 现场：market 行 + 本机 provenance=plugin ⇒ 「随客户端内置」）。
    expect(capabilitySourceBadgeKey({ source: 'market', originChannel: 'builtin' }, 'mine')).toBe('capability.sourceBuiltin')
    expect(capabilitySourceBadgeKey({ source: 'market', originChannel: 'plugin' }, 'mine')).toBe('capability.sourcePlugin')
    expect(capabilitySourceBadgeKey({ source: 'market', originChannel: 'org' }, 'mine')).toBe('capability.sourceOrg')
    expect(capabilitySourceBadgeKey({ source: 'market', originChannel: undefined }, 'mine')).toBe('capability.sourceOther')
  })
})
