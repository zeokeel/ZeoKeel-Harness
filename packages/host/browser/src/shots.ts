/**
 * Screenshot capture for the embedded browser: `capturePage` → downscale to a
 * bounded width → JPEG base64. Screenshots are returned to the model and
 * never persisted (audit keeps op log text only).
 * @module @zeokeel/dsh-browser
 */

import type { NativeWebContents } from './electron-adapter.ts'

/** Default screenshot max width (CSS pixels). */
const SCREENSHOT_MAX_WIDTH = 1280
/** Default JPEG quality (0-100). */
const SCREENSHOT_QUALITY = 70
/** Smallest clip scale accepted by CDP (below this the image is useless). */
const SCREENSHOT_MIN_SCALE = 0.05

/** Clamp a requested quality into the 1..100 range Electron/CDP accept. */
function clampQuality(quality: number): number {
  return Math.max(1, Math.min(100, quality))
}

/** The CDP `send` shape this module needs (the runtime's tab session). */
export type CdpSend = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

/**
 * Capture the visible page and return a JPEG data URL. The image is downscaled
 * when wider than `maxWidth`; `quality` trades bytes against fidelity (both
 * owned by the deployment, not the model).
 */
export async function captureScreenshot(
  webContents: NativeWebContents,
  maxWidth = SCREENSHOT_MAX_WIDTH,
  quality = SCREENSHOT_QUALITY,
): Promise<string> {
  if (webContents.isDestroyed()) throw new Error('browser: tab was destroyed')
  const image = await webContents.capturePage()
  // An empty capture (hidden window / background tab / zero-sized view) must
  // fail loudly instead of returning a 0-byte data URL the model reads as a
  // blank page (P2-31).
  if (image === undefined || image === null) {
    throw new Error('browser: screenshot failed — the page produced no image (is the tab visible?)')
  }
  const { width, height } = image.getSize()
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`browser: screenshot failed — empty image (${width}x${height})`)
  }
  const clampedQuality = clampQuality(quality)
  let out = image
  if (width > maxWidth) {
    out = image.resize({ width: Math.max(1, maxWidth), quality: 'good' })
  }
  const buffer = out.toJPEG(clampedQuality)
  if (buffer.length === 0) {
    throw new Error('browser: screenshot failed — encoder returned an empty image')
  }
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}

/** Output cap for one screenshot (2026-10-23 C12/B5). */
export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024

/** Optional capture shape (full page / clip / format). */
export interface ScreenshotOptions {
  fullPage?: boolean
  clip?: { x: number; y: number, width: number, height: number }
  format?: 'jpeg' | 'png'
  quality?: number
}

/** `Page.getLayoutMetrics` subset this module reads. */
export interface LayoutMetrics {
  contentSize?: { x?: number, y?: number, width?: number, height?: number }
  cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
}

/**
 * Capture through CDP's **renderer-side** path (`fromSurface: false`).
 *
 * Why this exists (2026-09-12, real-device report): the browser window is
 * created hidden on purpose (2026-09-08 product decision — agent paths must
 * never pop it to the front), and a hidden window has **no viz surface**, so
 * `webContents.capturePage()` fails with `Current display surface not available
 * for capture / UnknownVizError`. `Page.captureScreenshot` with
 * `fromSurface: false` composites the frame in the renderer instead of reading
 * the browser-side surface, which is how headless capture works.
 *
 * Downscaling is preserved without Electron: the clip `scale` is derived from
 * the CSS layout viewport, so the payload stays at `maxWidth` like the
 * `capturePage` path does.
 *
 * @param send - the tab's CDP sender.
 * @param maxWidth - the same bound `captureScreenshot` enforces.
 * @param quality - JPEG quality (clamped to 1..100).
 * @returns a JPEG data URL.
 * @throws when the renderer returns no image.
 */
export async function captureScreenshotViaCdp(
  send: CdpSend,
  maxWidth = SCREENSHOT_MAX_WIDTH,
  quality = SCREENSHOT_QUALITY,
  options: ScreenshotOptions = {},
): Promise<string> {
  const metrics = await send<LayoutMetrics>('Page.getLayoutMetrics')
  const viewport = metrics?.cssLayoutViewport
  const content = metrics?.contentSize
  const width = typeof viewport?.clientWidth === 'number' ? viewport.clientWidth : 0
  const height = typeof viewport?.clientHeight === 'number' ? viewport.clientHeight : 0
  const boundedWidth = Math.max(1, maxWidth)
  const format = options.format === 'png' ? 'png' : 'jpeg'
  const qualityValue = clampQuality(options.quality ?? quality)
  const params: Record<string, unknown> = { format, fromSurface: false }
  if (format === 'jpeg') params['quality'] = qualityValue
  const targetWidth = options.clip?.width ?? (options.fullPage === true
    ? (typeof content?.width === 'number' && content.width > 0 ? content.width : width)
    : width)
  const targetHeight = options.clip?.height ?? (options.fullPage === true
    ? (typeof content?.height === 'number' && content.height > 0 ? content.height : height)
    : height)
  if (options.fullPage === true && (typeof content?.width !== 'number' || typeof content?.height !== 'number' || content.width <= 0 || content.height <= 0)) {
    // Without a content box a "full page" request can only produce the viewport;
    // fail so the caller can report fullPage:false instead of lying.
    throw new Error('browser: full-page capture needs the page content size, which this renderer did not report')
  }
  if (options.clip !== undefined) {
    // Clamp the clip into the content box (a page can report nonsense sizes).
    const contentWidth = typeof content?.width === 'number' && content.width > 0 ? content.width : targetWidth
    const contentHeight = typeof content?.height === 'number' && content.height > 0 ? content.height : targetHeight
    const x = Math.max(0, Math.min(options.clip.x, contentWidth - 1))
    const y = Math.max(0, Math.min(options.clip.y, contentHeight - 1))
    const clipWidth = Math.max(1, Math.min(options.clip.width, contentWidth - x))
    const clipHeight = Math.max(1, Math.min(options.clip.height, contentHeight - y))
    params['clip'] = { x, y, width: clipWidth, height: clipHeight, scale: Math.max(SCREENSHOT_MIN_SCALE, Math.min(1, boundedWidth / Math.max(1, clipWidth))) }
  } else if (options.fullPage === true) {
    params['captureBeyondViewport'] = true
    params['clip'] = { x: 0, y: 0, width: Math.max(1, targetWidth), height: Math.max(1, targetHeight), scale: Math.max(SCREENSHOT_MIN_SCALE, Math.min(1, boundedWidth / Math.max(1, targetWidth))) }
  } else if (width > boundedWidth && height > 0) {
    params['clip'] = { x: 0, y: 0, width, height, scale: Math.max(SCREENSHOT_MIN_SCALE, boundedWidth / width) }
  }
  const result = await send<{ data?: string }>('Page.captureScreenshot', params)
  const data = result?.data
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('browser: screenshot failed — the renderer returned no image')
  }
  return `data:image/${format};base64,${data}`
}
