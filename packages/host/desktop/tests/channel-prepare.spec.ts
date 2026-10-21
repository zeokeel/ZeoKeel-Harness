/**
 * `prepareChannelPackaging()`：渠道客户端打包前的**唯一**就位入口。
 *
 * 这一组用例锁的是 2026-09-10 那次"整条客户端白标链是断的"的回归面：
 *   - 渠道包必须随包带上自己的 `build/channel.json`（否则客户端回落厂商名）；
 *   - 图标必须按渠道派生（否则渠道包带官方 app 图标/托盘图标出厂）；
 *   - 官方渠道必须清掉上一次渠道构建留下的 `build/channel.json`（残留会反过来
 *     把客户品牌染进官方包）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  prepareChannelPackaging as prepareChannelPackagingReal,
  resolveSpeechModelPayloadAction,
  type ChannelPrepareOptions,
} from '../scripts/channel-prepare.ts'
import type { SpeechModelPayloadDeps, BundledRuntimesPayloadDeps } from '../scripts/channel-prepare.ts'

/**
 * 载荷读写的**替身**：所有用例都经 {@link prepareChannelPackaging} 注入它。
 *
 * 2026-09-29 起"随包语音模型"对**所有渠道默认开启**，真实现会联网拉 230MiB ——
 * 单测既不能依赖公网也不能花这个时间。替身只记录调用（并可按需产出/清掉目录），
 * 真实的下载与校验由 `fetch-speech-model.mjs` 自己的实测与 afterPack 门禁负责。
 */
function speechModelStub(): SpeechModelPayloadDeps & { materialized: string[], cleared: string[] } {
  const materialized: string[] = []
  const cleared: string[] = []
  return {
    materialized,
    cleared,
    materializeSpeechModel: async (options) => {
      materialized.push(options?.out ?? '')
      return { out: options?.out ?? '', status: [] }
    },
    removeSpeechModel: (out) => {
      cleared.push(out ?? '')
      rmSync(out ?? '', { recursive: true, force: true })
    },
  }
}

/**
 * 随包 agent 运行时（node/pnpm/python）的载荷替身（2026-10-08 起**所有渠道默认随包**）。
 *
 * 同语音模型：真实现要联网拉三套运行时（展开 ~240MiB），单测不能依赖公网也不该花这个
 * 时间。替身只记录调用与参数；真实的下载/校验/解包由 `fetch-bundled-runtimes.mjs`
 * 自己的实测与 afterPack 门禁（`assertBundledRuntimesPackaged`）负责。
 */
function runtimesStub(): BundledRuntimesPayloadDeps & { materialized: { out?: string, target?: string }[] } {
  const materialized: { out?: string, target?: string }[] = []
  return {
    materialized,
    materializeBundledRuntimes: async (options) => {
      materialized.push(options ?? {})
      return {
        out: options?.out ?? '',
        target: options?.target ?? 'linux-x64',
        manifest: { versions: { node: '0.0.0-probe', pnpm: '0.0.0-probe', python: '0.0.0-probe' } },
      }
    },
  }
}

/** 打包准备（测试入口）：自动注入两个载荷替身。 */
function prepareChannelPackaging(options: ChannelPrepareOptions = {}) {
  return prepareChannelPackagingReal({ speechModel: speechModelStub(), runtimes: runtimesStub(), ...options })
}
import { SPEECH_MODEL_PAYLOAD_DIR } from '../scripts/verify-packaged-runtime.ts'
import { generateTrayIcons } from '../scripts/generate-tray-icons.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..', '..', '..')
const officialLogo = join(repoRoot, 'brands', 'official', 'logo.svg')
const officialIcon = join(repoRoot, 'brands', 'official', 'app-icon.png')

/** 文件内容的 sha256（比对"是否同一份素材"）。 */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 一次性的临时目录。 */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 造一个临时渠道仓：`<root>/channels/<id>/{channel.json,logo.svg,app-icon.png}`。
 * @param options - 渠道 id、channel.json 内容与素材开关。
 * @returns 仓库根目录。
 */
async function channelRepo(options: {
  channelId: string
  channel: unknown
  withAssets?: boolean
}): Promise<string> {
  const root = tempDir('dsh-channel-prepare-')
  const dir = join(root, 'channels', options.channelId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'channel.json'),
    typeof options.channel === 'string' ? options.channel : JSON.stringify(options.channel),
  )
  if (options.withAssets !== false) {
    // 渠道 logo：官方几何 + 一个额外节点（合法但**与官方不同**，用来证明图标
    // 确实是按渠道素材派生的）。
    const logo = readFileSync(officialLogo, 'utf8').replace(
      '</svg>',
      '<circle cx="200" cy="200" r="60" fill="#000000"/></svg>',
    )
    writeFileSync(join(dir, 'logo.svg'), logo)
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 12, g: 34, b: 156, alpha: 1 } } })
      .toColourspace('rgb16')
      .withMetadata({ icc: 'srgb' })
      .png()
      .toFile(join(dir, 'app-icon.png'))
  }
  return root
}

/**
 * 一个字段齐全的品牌渠道配置。
 *
 * `assets.logo` 是**品牌渠道必填**（2026-09-26 审计 Z3-3）：随包内联
 * （channel-build.ts 的 inlineChannelAssets）与打包期派生（托盘位图 / 随包 favicon）
 * 都以它为准，不声明时包里没有 logo_inline ⇒ 服务端不可达时登录页回落厂商 mark。
 * `logo.svg` 也必须是这个名字 —— 打包侧只按 `CHANNEL_ASSET_FILES.logo` 取素材。
 */
function brandChannel(channelId: string): Record<string, unknown> {
  return {
    schema: 1,
    channel_id: channelId,
    identity: { display_name: 'Example Brand', short_name: 'Example' },
    assets: { logo: 'logo.svg' },
    desktop: {
      product_name: 'Example Brand',
      slug: 'Example-Brand',
      app_id: 'com.example.brand',
      deep_link_scheme: 'examplebrand',
      app_origin_scheme: 'examplebrand-app',
    },
  }
}

/** 一个公共渠道（beta）配置：品牌就是厂商自己的，素材回落官方是**正当**的。 */
function publicChannel(channelId: string): Record<string, unknown> {
  return {
    schema: 1,
    channel_id: channelId,
    identity: { display_name: 'ZeoKeel Harness', short_name: 'ZeoKeel' },
    desktop: { home_dir: '.zeokeel-harness', app_origin_scheme: 'zeokeel-app' },
  }
}

describe('speech model payload staging', () => {
  // 2026-09-29 用户定案：**所有渠道默认随包**（含 official/beta）—— 装上客户端语音就能用，
  // 零网络、零下载；只有渠道显式写 `desktop.speech_bundle_model: false` 才关闭（回到下载）。
  it('材料化 is the default for every channel (no flag needed)', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand') })
    const appDir = tempDir('dsh-app-')
    const speechModel = speechModelStub()
    await prepareChannelPackagingReal({
      env: { DSH_BUILD_CHANNEL: 'example-brand' },
      repoRoot: repo,
      appDir,
      speechModel,
      runtimes: runtimesStub(),
    })
    expect(speechModel.materialized).toEqual([join(appDir, SPEECH_MODEL_PAYLOAD_DIR)])
    expect(speechModel.cleared).toEqual([])
  })

  it('clears a stale payload only when the channel opts out explicitly', async () => {
    // 显式关闭 = 产物不带模型。残留必须清掉：客户端只看载荷在不在，而
    // electron-builder 的 extraResources 会把它照单打进产物（"官方包悄悄带上模型"）。
    const base = brandChannel('example-brand')
    const channel = { ...base, desktop: { ...(base.desktop as Record<string, unknown>), speech_bundle_model: false } }
    const repo = await channelRepo({ channelId: 'example-brand', channel })
    const appDir = tempDir('dsh-app-')
    const payload = join(appDir, SPEECH_MODEL_PAYLOAD_DIR)
    mkdirSync(payload, { recursive: true })
    writeFileSync(join(payload, 'manifest.json'), '{}\n')
    writeFileSync(join(payload, 'stale.onnx'), 'x')
    const speechModel = speechModelStub()
    await prepareChannelPackagingReal({
      env: { DSH_BUILD_CHANNEL: 'example-brand' },
      repoRoot: repo,
      appDir,
      speechModel,
      runtimes: runtimesStub(),
    })
    expect(speechModel.cleared).toEqual([payload])
    expect(existsSync(payload)).toBe(false)
  })

  it('decides materialize vs clear from the channel flag alone (default = materialize)', () => {
    // 决策是纯函数：`materialize` 那半要联网拉 230MiB，真判据是 afterPack 在**真产物**上的
    // 断言（`assertBundledSpeechModelPackaged`）与 `fetch-speech-model.mjs` 自己的实测。
    const base = { channelId: 'example-brand' } as Parameters<typeof resolveSpeechModelPayloadAction>[0]
    expect(resolveSpeechModelPayloadAction({ ...base, speechBundleModel: true })).toBe('materialize')
    expect(resolveSpeechModelPayloadAction({ ...base, speechBundleModel: false })).toBe('clear')
  })
})

describe('prepareChannelPackaging', () => {
  it('渠道构建:按渠道派生图标,并把随包 channel.json 就位', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand') })
    const appDir = tempDir('dsh-app-')

    const context = await prepareChannelPackaging({
      env: { DSH_BUILD_CHANNEL: 'example-brand' },
      repoRoot: repo,
      appDir,
    })

    expect(context.channelId).toBe('example-brand')
    // 1) 随包渠道配置：运行期 desktop-channel.ts 读的就是它。
    const staged = JSON.parse(readFileSync(join(appDir, 'channel.json'), 'utf8')) as { channel_id: string }
    expect(staged.channel_id).toBe('example-brand')
    // 2) app 图标来自**渠道素材**（不是 brands/official）。
    expect(sha256(join(appDir, 'app-icon.png'))).toBe(sha256(join(repo, 'channels', 'example-brand', 'app-icon.png')))
    expect(sha256(join(appDir, 'app-icon.png'))).not.toBe(sha256(officialIcon))
    // 3) 托盘位图按渠道 logo 重新派生（与单独渲染同一份 logo 的结果逐字节一致）。
    const expected = tempDir('dsh-tray-')
    await generateTrayIcons({ source: join(repo, 'channels', 'example-brand', 'logo.svg'), buildRoot: expected })
    for (const name of ['tray-iconTemplate.png', 'tray-icon-blue.png', 'tray-icon-blue@2x.png']) {
      expect(sha256(join(appDir, name))).toBe(sha256(join(expected, name)))
    }
    // 4) 渠道没给的素材逐文件回落官方。
    expect(existsSync(join(appDir, 'assistedMessages.yml'))).toBe(true)
  })

  it('官方几何始终落盘为 web-brand/official.svg(渠道 logo 被拒时的兜底,P1-12)', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand') })
    const appDir = tempDir('dsh-app-')

    await prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir })

    // 随包的 favicon 是**渠道**几何。
    const favicon = join(appDir, 'web-brand', 'favicon.svg')
    expect(sha256(favicon)).toBe(sha256(join(repo, 'channels', 'example-brand', 'logo.svg')))
    // 兜底那份必须是**官方**几何,且落在 build/(唯一随包分发的品牌目录)。
    // 运行时候选链最后一级(src/index.ts 的 officialLogoPath)读的就是它:
    // 渠道 logo 带脚本特征/损坏时,标签页应当回落**官方 mark**而不是上游厂商图形。
    const fallback = join(appDir, 'web-brand', 'official.svg')
    expect(existsSync(fallback)).toBe(true)
    expect(sha256(fallback)).toBe(sha256(officialLogo))
  })

  it('官方构建:清掉上一次渠道构建残留的 channel.json,图标回到官方', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand') })
    const appDir = tempDir('dsh-app-')

    await prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir })
    expect(existsSync(join(appDir, 'channel.json'))).toBe(true)

    const context = await prepareChannelPackaging({ env: {}, repoRoot: repo, appDir })

    expect(context.channelId).toBe('official')
    expect(existsSync(join(appDir, 'channel.json'))).toBe(false)
    expect(sha256(join(appDir, 'app-icon.png'))).toBe(sha256(officialIcon))
  })

  it('渠道包的 channel_id 与目录名不一致时 fail-loud,且不产出任何素材', async () => {
    const repo = await channelRepo({
      channelId: 'example-brand',
      channel: { ...brandChannel('example-brand'), channel_id: 'someone-else' },
    })
    const appDir = tempDir('dsh-app-')

    await expect(
      prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir }),
    ).rejects.toThrow(/channel_id/u)
    // 校验在派生素材之前：失败时连图标都不该写出来。
    expect(existsSync(join(appDir, 'channel.json'))).toBe(false)
    expect(existsSync(join(appDir, 'app-icon.png'))).toBe(false)
  })

  it('渠道包非法 JSON 直接失败（不静默回落官方）', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: '{ not json' })
    const appDir = tempDir('dsh-app-')

    await expect(
      prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir }),
    ).rejects.toThrow(/JSON/u)
  })

  // 2026-09-26 审计 Z3-3：**这一条原本是缺陷编码**。旧预期是「品牌渠道缺 logo.svg
  // ⇒ 图标回落 brands/official（不是构建失败）」，而"静默回落官方"正是那次审计的
  // P1：交付物（安装器/Dock/任务栏图标、服务端不可达时的登录页 mark）带**厂商品牌**，
  // 而白标门禁（verify-channel-package.ts）用同一个 prepareBrandAssets 重派生再比对
  // ⇒ 两边都回落官方 ⇒ 恒等 ⇒ 结构性咬不到。现在品牌渠道缺素材一律抛错。
  it('品牌渠道缺 logo.svg 时 fail-loud（不得静默回落官方素材）', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand'), withAssets: false })
    // 只补 app-icon，logo 留给回落逻辑 —— 旧实现会在这里静默用官方 logo。
    copyFileSync(officialIcon, join(repo, 'channels', 'example-brand', 'app-icon.png'))
    const appDir = tempDir('dsh-app-')

    await expect(
      prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir }),
    ).rejects.toThrow(/logo\.svg/u)
    // 失败必须发生在写出任何素材之前：半成品 build/ 会被后续打包当成"已派生"。
    expect(existsSync(join(appDir, 'app-icon.png'))).toBe(false)
    expect(existsSync(join(appDir, 'tray-icon-blue.png'))).toBe(false)
  })

  it('品牌渠道缺 app-icon.png 时 fail-loud（否则安装器/Dock/任务栏是厂商图标）', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand'), withAssets: false })
    // 只补 logo，app-icon 留给回落逻辑。
    copyFileSync(officialLogo, join(repo, 'channels', 'example-brand', 'logo.svg'))
    const appDir = tempDir('dsh-app-')

    await expect(
      prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir }),
    ).rejects.toThrow(/app-icon\.png/u)
    expect(existsSync(join(appDir, 'tray-icon-blue.png'))).toBe(false)
  })

  it('品牌渠道没声明 assets.logo 时 fail-loud（否则包里没有 logo_inline，登录页回落厂商 mark）', async () => {
    const repo = await channelRepo({
      channelId: 'example-brand',
      channel: { ...brandChannel('example-brand'), assets: {} },
    })
    const appDir = tempDir('dsh-app-')

    await expect(
      prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir }),
    ).rejects.toThrow(/assets\.logo/u)
  })

  it('公共渠道（beta）缺素材仍然回落 brands/official，且回落被显式登记（不是静默）', async () => {
    // 反向对照：判据按**渠道来源**分档，不是"文件在不在" —— beta 是厂商自己的
    // 预发布渠道（真实渠道仓里的 channels/beta 也没有 app-icon.png），回落官方
    // 是预期行为，必须继续绿，但要走一条可检索的登记日志。
    const repo = await channelRepo({ channelId: 'beta', channel: publicChannel('beta'), withAssets: false })
    const appDir = tempDir('dsh-app-')
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      await prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'beta' }, repoRoot: repo, appDir })
    } finally {
      console.warn = originalWarn
    }

    const official = tempDir('dsh-official-tray-')
    await generateTrayIcons({ source: officialLogo, buildRoot: official })
    expect(sha256(join(appDir, 'tray-icon-blue.png'))).toBe(sha256(join(official, 'tray-icon-blue.png')))
    expect(sha256(join(appDir, 'app-icon.png'))).toBe(sha256(officialIcon))
    expect(warnings.join('\n')).toMatch(/回落官方.*已登记/u)
  })
})

/**
 * 权威 logo 里的**平坦方块** `<rect ... fill="#RRGGBB" ...>`（与生成器同一判据形态）。
 *
 * 测试不写死任何旧几何/旧颜色：方块色与强调色都从 `brands/official/logo.svg` /
 * `brands/official/brand.json` 派生（2026-10-21 品牌换成白底 + 全彩 mark 后，
 * 任何"官方方块必须是黑色"的硬编码都会立刻失效）。
 */
const TILE_RECT = /<rect\b[^>]*\bfill="(#[0-9A-Fa-f]{6})"[^>]*\/>/u

/** 权威 logo 的几何，只改方块填充色（渠道 logo 必须由它派生，夹具同样遵守）。 */
function officialLogoWithTile(fill: string): string {
  const source = readFileSync(officialLogo, 'utf8')
  const tile = TILE_RECT.exec(source)
  if (tile === null) throw new Error('brands/official/logo.svg: 找不到平坦方块 <rect>')
  return source.replace(tile[0], tile[0].replace(tile[1]!, fill))
}

/** `brands/official/brand.json` 声明的强调色（权威配置，不在测试里写死）。 */
function officialAccent(): string {
  const brand = JSON.parse(readFileSync(join(repoRoot, 'brands', 'official', 'brand.json'), 'utf8')) as
    { assets?: { accent?: string } }
  const accent = brand.assets?.accent
  if (typeof accent !== 'string') throw new Error('brands/official/brand.json 缺 assets.accent')
  return accent
}

/** 把一份 logo 写进一个**只有它自己**的临时目录（渠道目录没有 brand.json 的形态）。 */
function loneLogoDir(svg: string): string {
  const dir = tempDir('dsh-tray-src-')
  writeFileSync(join(dir, 'logo.svg'), svg)
  return dir
}

/**
 * 不透明像素（alpha=255）里出现最多的颜色 —— 即方块被替换成的强调色。
 *
 * 方块是平坦填充，占不透明面积的大头；mark 的渐变颜色分散，不会喧宾夺主。
 */
async function dominantOpaqueColor(path: string): Promise<string> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const counts = new Map<string, number>()
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] !== 255) continue
    const key = `#${[data[i]!, data[i + 1]!, data[i + 2]!]
      .map(value => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (top === undefined) throw new Error(`${path}: 没有完全不透明的像素`)
  return top[0]
}

/** 统计满足条件的不透明像素数（像素级判据用：证明 mark 还在、没被染掉）。 */
async function countOpaquePixels(
  path: string,
  predicate: (rgb: [number, number, number]) => boolean,
): Promise<number> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let count = 0
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] !== 255) continue
    if (predicate([data[i]!, data[i + 1]!, data[i + 2]!])) count += 1
  }
  return count
}

describe('generateTrayIcons', () => {
  /** 一份"渠道用自己的品牌色"的 logo：平坦 #006AFF 方块 + 白 mark。 */
  function brandColorLogo(color = '#006AFF'): string {
    const path = join(tempDir('dsh-tray-src-'), 'logo.svg')
    writeFileSync(path, `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">`
      + `<rect width="1254" height="1254" rx="180" fill="${color}"/>`
      + '<path d="M300 900 L500 300 L627 700 L754 300 L954 900 Z" fill="#FFFFFF"/></svg>')
    return path
  }

  it('渠道用自己的品牌色画 logo 也能派生托盘位图（不再硬要求某个具体底色）', async () => {
    // 2026-09-11 实测：托盘派生此前硬性要求源文件里出现 fill="#000000"，于是
    // "渠道 logo 用客户的品牌色"直接打包失败；2026-10-21 官方换成白底后，连官方源
    // 都不再是黑色 —— 派生前提只能是"方块用一个平坦十六进制色"。
    // 目录里没有任何品牌配置 ⇒ 非中性方块色**就是**强调色（不硬塞兜底的蓝）。
    const out = tempDir('dsh-tray-out-')
    await generateTrayIcons({ source: brandColorLogo(), buildRoot: out })

    const meta = await sharp(join(out, 'tray-icon-blue@2x.png')).metadata()
    expect(meta.width).toBe(32)
    const path = join(out, 'tray-icon-blue@2x.png')
    expect(await dominantOpaqueColor(path)).toBe('#006AFF')
    // 白 mark 仍在：全蓝 = mark 被吞掉/被方块色染掉。
    expect(await countOpaquePixels(path, ([r, g, b]) => r > 200 && g > 200 && b > 200)).toBeGreaterThan(0)
  })

  it('官方 logo 的 Windows/Linux 位图 = 只把方块色换成 brand.json 的强调色（mark 不动）', async () => {
    // 非模板产物的语义没变：完整品牌图形，唯一差异是**方块填充色**。期望值从
    // 权威 logo + brand.json **派生**（方块色来自 logo.svg 的平坦 <rect fill>，
    // 强调色来自 assets.accent），不写死路径/颜色。任何"顺手改 mark/几何/渐变"
    // 的实现都会在这里红。
    const source = readFileSync(officialLogo, 'utf8')
    const tile = TILE_RECT.exec(source)
    expect(tile).not.toBeNull()
    const accent = officialAccent()
    // 前提：官方日间底板是白色、强调色不是它 —— 否则下面的比对是恒等的、没有信息量。
    expect(accent.toUpperCase()).not.toBe(tile![1]!.toUpperCase())
    const tinted = source.replace(tile![0], tile![0].replace(tile![1]!, accent))

    const out = tempDir('dsh-tray-official-')
    await generateTrayIcons({ source: officialLogo, buildRoot: out })
    for (const [file, size] of [['tray-icon-blue.png', 16], ['tray-icon-blue@2x.png', 32]] as const) {
      const expected = await sharp(Buffer.from(tinted))
        .resize({ width: size, height: size, fit: 'contain' })
        .png({ compressionLevel: 9 })
        .toBuffer()
      expect(readFileSync(join(out, file)).equals(expected)).toBe(true)
    }
    // 像素面复核：方块确实是强调色（不是黑/白），且 mark 的渐变颜色也还在。
    const path = join(out, 'tray-icon-blue@2x.png')
    expect(await dominantOpaqueColor(path)).toBe(accent.toUpperCase())
    const accentRgb = [1, 3, 5].map(index => Number.parseInt(accent.slice(index, index + 2), 16)) as
      [number, number, number]
    expect(await countOpaquePixels(path, ([r, g, b]) =>
      Math.abs(r - accentRgb[0]) > 8 || Math.abs(g - accentRgb[1]) > 8 || Math.abs(b - accentRgb[2]) > 8,
    )).toBeGreaterThan(100)
  })

  it('macOS 模板图 = 完整 mark 的 alpha：背景透明、落墨处字面黑、形状一个不少', async () => {
    // 2026-09-16 真机 P1：模板图此前是"满画布不透明的方块 + mark"，而 AppKit 对
    // 模板图**只拿 alpha 通道当遮罩**（RGB 一律忽略）⇒ 菜单栏里只剩一个实心方块，
    // mark 永远画不出来。
    // 判据 1（形状完整）：alpha **逐像素等于**"权威 logo 去掉方块后的完整 mark"
    //   —— 任何"简化 mark / 换图形/少画一个形状"的实现都会在这里红。
    // 判据 2（模板规范）：背景必须 clear、落墨处必须字面黑。
    const source = readFileSync(officialLogo, 'utf8')
    const tile = TILE_RECT.exec(source)
    expect(tile).not.toBeNull()
    const markOnly = source.replace(tile![0], '')

    const out = tempDir('dsh-tray-template-')
    await generateTrayIcons({ source: officialLogo, buildRoot: out })

    for (const [file, size] of [['tray-iconTemplate.png', 16], ['tray-iconTemplate@2x.png', 32]] as const) {
      const { data, info } = await sharp(join(out, file))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const alpha: number[] = []
      let clear = 0
      let inked = 0
      let nonBlackInk = 0
      for (let i = 0; i < data.length; i += info.channels) {
        alpha.push(data[i + 3]!)
        if (data[i + 3] === 0) {
          clear += 1
          continue
        }
        inked += 1
        if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) nonBlackInk += 1
      }
      const expected = await sharp(Buffer.from(markOnly))
        .resize({ width: size, height: size, fit: 'contain' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const expectedAlpha: number[] = []
      for (let i = 0; i < expected.data.length; i += expected.info.channels) expectedAlpha.push(expected.data[i + 3]!)
      expect(alpha).toEqual(expectedAlpha)

      // 底板占满整张画布：留着它时 clear 恒为 0（16px 旧产物实测 0/256）。
      expect(clear / (info.width * info.height)).toBeGreaterThan(0.5)
      // 全透明 = 菜单栏里什么都没有。
      expect(inked).toBeGreaterThan(0)
      // 模板图规范是 black + clear；出现彩色/白色墨点说明又在当普通位图渲染。
      expect(nonBlackInk).toBe(0)
    }
  })

  it('强调色优先取渠道包 channel.json 的 assets.accent（渠道目录不需要 brand.json）', async () => {
    // 渠道构建的源 logo 在 channels/<id>/，品牌配置就是 channel.json 的
    // assets.accent（渠道包的模板键）；官方那种 brand.json 目录形状不适用于渠道。
    const dir = loneLogoDir(officialLogoWithTile('#FFFFFF'))
    writeFileSync(join(dir, 'channel.json'), JSON.stringify({ assets: { accent: '#106040' } }))
    const out = tempDir('dsh-tray-channel-accent-out-')
    await generateTrayIcons({ source: join(dir, 'logo.svg'), buildRoot: out })
    expect(await dominantOpaqueColor(join(out, 'tray-icon-blue@2x.png'))).toBe('#106040')
  })

  it('channel.json 的 accent 优先于同目录 brand.json（渠道覆盖 > 品牌目录）', async () => {
    const dir = loneLogoDir(officialLogoWithTile('#FFFFFF'))
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ assets: { accent: '#123456' } }))
    writeFileSync(join(dir, 'channel.json'), JSON.stringify({ assets: { accent: '#654321' } }))
    const out = tempDir('dsh-tray-accent-order-out-')
    await generateTrayIcons({ source: join(dir, 'logo.svg'), buildRoot: out })
    expect(await dominantOpaqueColor(join(out, 'tray-icon-blue@2x.png'))).toBe('#654321')
  })

  it('没有品牌配置时：彩色方块用自己的颜色，纯白/纯黑底板用兜底强调色', async () => {
    // 规则（见 generate-tray-icons.mjs 的 resolveTintColor）：纯白/纯黑是**底板**
    // （日间/夜间），不是品牌色 —— 拿它派生会把白底原样画进托盘（浅色托盘上等于
    // 看不见），所以这两种中性色落到兜底 #2563eb。
    const FALLBACK_ACCENT = '#2563EB'
    const coloredDir = loneLogoDir(officialLogoWithTile('#106040'))
    const coloredOut = tempDir('dsh-tray-tint-colored-out-')
    await generateTrayIcons({ source: join(coloredDir, 'logo.svg'), buildRoot: coloredOut })
    expect(await dominantOpaqueColor(join(coloredOut, 'tray-icon-blue@2x.png'))).toBe('#106040')

    for (const fill of ['#FFFFFF', '#000000'] as const) {
      const dir = loneLogoDir(officialLogoWithTile(fill))
      const out = tempDir('dsh-tray-tint-neutral-out-')
      await generateTrayIcons({ source: join(dir, 'logo.svg'), buildRoot: out })
      expect(await dominantOpaqueColor(join(out, 'tray-icon-blue@2x.png')), `${fill} 底板`).toBe(FALLBACK_ACCENT)
    }
  })

  it('非法 accent 取值按"没配置"处理（配色缺失不该让打包失败）', async () => {
    const dir = loneLogoDir(officialLogoWithTile('#FFFFFF'))
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ assets: { accent: 'blue' } }))
    writeFileSync(join(dir, 'channel.json'), JSON.stringify({ assets: { accent: null } }))
    const out = tempDir('dsh-tray-accent-invalid-out-')
    await generateTrayIcons({ source: join(dir, 'logo.svg'), buildRoot: out })
    expect(await dominantOpaqueColor(join(out, 'tray-icon-blue@2x.png'))).toBe('#2563EB')
  })

  it('方块之外没有任何 mark 的 logo 直接 fail-loud（否则模板图会全透明）', async () => {
    const tileOnly = join(tempDir('dsh-tray-tileonly-'), 'logo.svg')
    writeFileSync(tileOnly, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
      + '<rect width="24" height="24" rx="4" fill="#006AFF"/></svg>')
    await expect(generateTrayIcons({ source: tileOnly, buildRoot: tempDir('dsh-tray-tileonly-out-') }))
      .rejects.toThrow(/mark/iu)
  })

  it('没有平坦方块（渐变/样式表）时给出可读的失败', async () => {
    const gradient = join(tempDir('dsh-tray-bad-'), 'logo.svg')
    writeFileSync(gradient, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
      + '<defs><linearGradient id="g"><stop offset="0" stop-color="#006AFF"/></linearGradient></defs>'
      + '<rect width="24" height="24" fill="url(#g)"/></svg>')
    await expect(generateTrayIcons({ source: gradient, buildRoot: tempDir('dsh-tray-bad-out-') }))
      .rejects.toThrow(/flat|rect/iu)

    const styled = join(tempDir('dsh-tray-bad2-'), 'logo.svg')
    writeFileSync(styled, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><style>.t{fill:#000000}</style>'
      + '<rect class="t" width="24" height="24"/></svg>')
    await expect(generateTrayIcons({ source: styled, buildRoot: tempDir('dsh-tray-bad2-out-') }))
      .rejects.toThrow(/style/iu)
  })
})
