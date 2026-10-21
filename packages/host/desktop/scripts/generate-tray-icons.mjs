/**
 * Derive native tray bitmaps from the repository brand folder (single authority).
 *
 * Source: brands/official/logo.svg — the white rounded tile (rx=180, fill #FFFFFF)
 * carrying the **full-color gradient mark** (1 circle + 6 paths filled by the six
 * `linearGradient` defs), exactly as the repo authority. Nothing is invented or
 * simplified here: both outputs are rendered from that one SVG.
 *
 * 两种形状，因为两个平台消费位图的方式根本不同（2026-09-16 修复）：
 *
 *   - **Windows/Linux 位图**（`tray-icon-blue*`）：原样绘制，所以保留完整品牌图形
 *     —— 方块 + **完整 mark**（circle + 6 paths + 渐变，一个形状都不省）；
 *     方块色换成**品牌强调色**（取值规则见 {@link resolveTintColor}）。
 *   - **macOS 模板图**（`tray-iconTemplate*`）：系统**只拿 alpha 通道当遮罩**，
 *     再按当前外观填成黑/白（Electron 文档：模板图由 black + clear 组成）。
 *     所以模板图必须是 **mark-only、背景透明**：早先直接拿整块方块去当模板图，
 *     方块满画布不透明 ⇒ 菜单栏里只剩一个实心方块，mark 永远不可能显示
 *     （2026-09-16 真机现象：暗色菜单栏里一个白色方块）。
 *
 * 两者的几何都来自同一份品牌 SVG（模板图只是**去掉方块**那一层，并把 mark
 * 规整成黑色），不引入任何新画法。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { isDirectInvocation } from './direct-invocation.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(packageRoot, '..', '..', '..')
const brandRoot = join(repoRoot, 'brands', 'official')
const buildRoot = join(packageRoot, 'build')

/**
 * 强调色兜底（方块是纯白/纯黑底板、且品牌配置没声明 accent 时用它）。
 *
 * 与 `brands/official/brand.json` 的 `assets.accent` 一致：官方路径从 brand.json
 * 取到同一个值，这个常量只是"配置缺失"时的最后一级。
 */
const FALLBACK_ACCENT = '#2563eb'

/**
 * 纯白/纯黑是**底板**（日间/夜间），不是品牌色。
 *
 * 官方 logo 的日间底板就是纯白：把白方块原样画进托盘 = 在浅色菜单栏/任务栏上
 * 看不见的图标，所以这两种中性色永远不当作强调色。
 */
const NEUTRAL_TILE_COLORS = new Set(['#FFFFFF', '#000000'])

/** 强调色合法形态（只认平坦十六进制；渠道/品牌配置里的非法值一律当作"没配置"）。 */
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u

/** 方块 `<rect>` 的标记：`(1)` 是它的平坦填充色。 */
const TILE_RECT_PATTERN = /<rect\b[^>]*\bfill="(#[0-9A-Fa-f]{6})"[^>]*(?:\/>|>\s*<\/rect>)/u

/**
 * 取源 SVG 里**托盘方块**那个 `<rect>`：元素标记 + 它的填充色。
 *
 * 为什么不能硬要求某个具体颜色（2026-09-11 实测踩到）：Windows/Linux 位图是把
 * **方块色替换成强调色**渲染出来的，真正的前提只是"方块用一个平坦的十六进制色"。
 * 早先实现把这个颜色写死成 `#000000`，于是**渠道用自己的品牌色画 logo 时直接打包
 * 失败**（报错只说"必须用 #000000"，看不出是托盘派生的限制）；2026-10-21 官方
 * 品牌换成**白底 + 全彩 mark** 之后，这个硬性假设连官方源都不成立。
 * 现在按方块自身的颜色替换（强调色取值见 {@link resolveTintColor}）。
 * macOS 模板图（{@link renderTemplateIcon}）则要**整块删掉**这个元素。
 * @param {string} source - logo SVG 源文本。
 * @returns {{ markup: string, color: string } | undefined} 方块标记与形如 `#006AFF`
 * 的颜色；没有平坦方块时为 undefined。
 */
function tileRect(source) {
  const match = TILE_RECT_PATTERN.exec(source)
  if (match === null) return undefined
  return { markup: match[0], color: match[1] }
}

/**
 * 读品牌配置里声明的强调色（`assets.accent`）。
 *
 * 官方/渠道两侧**同一个键名**：官方是 `brands/official/brand.json`，渠道是
 * `channels/<id>/channel.json`（`assets.accent` 是渠道包的模板键）。文件不存在、
 * 不是 JSON、或取值不是 `#RRGGBB` 时返回 undefined —— 配色缺失不该让打包失败，
 * 交给下一级兜底。
 * @param {string} file - 品牌配置 JSON 路径。
 * @returns {Promise<string | undefined>} 强调色；读不到/不合法时为 undefined。
 */
async function readBrandAccent(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const accent = parsed && typeof parsed === 'object' ? parsed.assets?.accent : undefined
    return typeof accent === 'string' && HEX_COLOR_PATTERN.test(accent) ? accent : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析 Windows/Linux 位图里方块要替换成的**强调色**。
 *
 * 为什么不再固定黑（2026-10-21）：替换方块色的初衷是"让托盘方块成为品牌色"。
 * 品牌换成**白底 + 全彩 mark** 之后，固定替换成 `#000000` 只会得到一个黑块 +
 * 彩色 mark（夜间观感，且与日间白底品牌不对称）。取值顺序：
 *
 *   1. **渠道构建**：源 logo 在 `channels/<id>/`，渠道包把主题色声明在
 *      `channel.json` 的 `assets.accent`（渠道包的模板键）——
 *      **渠道目录不需要 brand.json**，官方渠道那种目录形状不适用于渠道包；
 *   2. **官方构建**（以及 `brands/<channel-id>/` 形态的品牌目录）：
 *      `brand.json` 的 `assets.accent`（官方 = `#2563eb`）；
 *   3. 两处都没有配置（渠道素材被单独拷到临时目录、裸 SVG 夹具）：用方块**自身**
 *      的填充色 —— 前提是它不是纯白/纯黑。纯白/纯黑是**底板**而不是品牌色，
 *      用它派生会把白底原样画进托盘（浅色托盘上等于看不见），所以跳过；
 *   4. 兜底 {@link FALLBACK_ACCENT}（`#2563eb`）。
 *
 * 每一级都只接受 `#RRGGBB`；非法取值按"没配置"处理。这样渠道构建在**没有**
 * brand.json 的目录里也能工作，官方构建则自动跟随 brand.json 的 accent。
 * @param {string} sourcePath - logo SVG 路径（其目录即品牌/渠道目录）。
 * @param {string} tileColor - 方块自身的填充色（{@link tileRect} 的结果）。
 * @returns {Promise<string>} 替换方块用的强调色。
 */
async function resolveTintColor(sourcePath, tileColor) {
  const brandDir = dirname(sourcePath)
  const channelAccent = await readBrandAccent(join(brandDir, 'channel.json'))
  if (channelAccent !== undefined) return channelAccent
  const brandAccent = await readBrandAccent(join(brandDir, 'brand.json'))
  if (brandAccent !== undefined) return brandAccent
  return NEUTRAL_TILE_COLORS.has(tileColor.toUpperCase()) ? FALLBACK_ACCENT : tileColor
}

/** @typedef {{ file: string, size: number, color?: string, template?: boolean }} TrayVariant */

/**
 * 默认托盘变体表。
 *
 * `color` 只是**每个变体自己的覆盖**（保留给调用方显式指定）；缺省时非模板位图的
 * 方块色取品牌强调色（{@link resolveTintColor}），模板图恒为字面黑。
 * @type {TrayVariant[]}
 */
const DEFAULT_VARIANTS = [
  // macOS：模板图 = 只有**完整 mark**（背景透明、颜色规整成黑），见文件头注释。
  // 模板图的黑色由 renderTemplateIcon 的像素归零保证，`color` 在这里不参与渲染。
  { file: 'tray-iconTemplate.png', size: 16, template: true },
  { file: 'tray-iconTemplate@2x.png', size: 32, template: true },
  // Windows/Linux：完整品牌图形（方块 + mark），原样绘制；方块色 = 品牌强调色。
  { file: 'tray-icon-blue.png', size: 16 },
  { file: 'tray-icon-blue@1.25x.png', size: 20 },
  { file: 'tray-icon-blue@1.5x.png', size: 24 },
  { file: 'tray-icon-blue@2x.png', size: 32 },
]

/**
 * 渲染一张 macOS 模板图：**只有完整 mark**、背景透明、颜色规整成黑。
 *
 * 为什么必须去掉方块（2026-09-16 真机 P1）：`nativeImage.setTemplateImage(true)`
 * 之后 AppKit 只用 **alpha 通道当遮罩**、RGB 一律忽略，所以"整块不透明的方块 +
 * mark"在菜单栏里画出来就是一个实心方块（暗色菜单栏上是白方块），mark 消失。
 * 模板图规范是 black + clear：这里把方块那一层删掉，剩下的**完整 mark**
 * （circle + 6 paths + 渐变）强制写成黑色；不简化任何形状。
 * @param {string} source - logo SVG 源文本。
 * @param {string} tileMarkup - 底板 `<rect>` 的原始标记（整块删除）。
 * @param {number} size - 输出边长（像素）。
 * @param {string} outputPath - 输出文件路径。
 */
async function renderTemplateIcon(source, tileMarkup, size, outputPath) {
  // 只删**底板那一层**：mark 的几何、坐标、相对大小全部保持不变。
  const glyph = source.replace(tileMarkup, '')
  const { data, info } = await sharp(Buffer.from(glyph))
    .resize({ width: size, height: size, fit: 'contain' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let opaque = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) opaque += 1
    // 模板图规范是"黑 + 透明"：颜色信息对系统无意义，写字面黑避免别的渲染路径
    // 按亮度解释它（品牌 mark 的渐变/彩色填充全都会被压成黑）。
    data[i] = 0
    data[i + 1] = 0
    data[i + 2] = 0
  }
  if (opaque === 0) {
    throw new Error(
      'generate-tray-icons: the logo draws nothing outside its tile — a macOS template '
      + 'bitmap would be fully transparent (an invisible menu bar icon). Draw the brand mark '
      + 'in logo.svg or ship a mark-only logo.',
    )
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(outputPath)
}

/**
 * 渲染一张 Windows/Linux 位图：完整品牌图形（方块 + mark），只把**方块自身**的
 * 填充色换成强调色。
 *
 * 只替换方块那一个 `fill`，而不是对源文本 `replaceAll(方块色, 强调色)`：渠道 logo
 * 的 mark 完全可能与方块同色（同色系品牌图形），全局替换会把 mark 一起染掉。
 * 几何、渐变、透明度一个字节都不动，mark 的每个形状都保留。
 * @param {string} source - logo SVG 源文本。
 * @param {{ markup: string, color: string }} tile - 方块标记与它的填充色。
 * @param {string} tint - 方块要换成的强调色。
 * @param {number} size - 输出边长（像素）。
 * @param {string} outputPath - 输出文件路径。
 */
async function renderTintedIcon(source, tile, tint, size, outputPath) {
  const tinted = source.replace(tile.markup, tile.markup.replace(tile.color, tint))
  await sharp(Buffer.from(tinted))
    .resize({ width: size, height: size, fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toFile(outputPath)
}

/**
 * Render all tray bitmaps from the authoritative brand SVG.
 * @param {{ source?: string, buildRoot?: string, variants?: TrayVariant[] }} [options]
 * @returns {Promise<string[]>} rendered filenames.
 */
export async function generateTrayIcons(options = {}) {
  const sourcePath = options.source ?? join(brandRoot, 'logo.svg')
  const outputRoot = options.buildRoot ?? buildRoot
  const variants = options.variants ?? DEFAULT_VARIANTS

  const source = await readFile(sourcePath, 'utf8')
  const tile = tileRect(source)
  if (tile === undefined || /<style\b/iu.test(source)) {
    throw new Error(
      'generate-tray-icons: source must draw the tile as <rect fill="#RRGGBB"> with inline attributes (no <style>)',
    )
  }

  // 非模板位图的方块色：品牌强调色（官方 brand.json / 渠道 channel.json 的
  // assets.accent）；变体自带 `color` 时以它为准。
  const tint = await resolveTintColor(sourcePath, tile.color)

  const rendered = []
  await Promise.all(variants.map(async ({ file, size, color, template }) => {
    const outputPath = join(outputRoot, file)
    if (template === true) {
      await renderTemplateIcon(source, tile.markup, size, outputPath)
      rendered.push(file)
      return
    }
    // 方块色 → 强调色（显式 color 覆盖 > 品牌 accent，见 resolveTintColor）。
    await renderTintedIcon(source, tile, color ?? tint, size, outputPath)
    rendered.push(file)
  }))
  return rendered
}

if (isDirectInvocation(import.meta)) {
  await generateTrayIcons()
  console.log('generate-tray-icons: rendered tray bitmaps from brands/official/logo.svg')
}
