/**
 * 菜单背板探针的 **Electron 侧**（由 `menu-backing-computed-probe.mjs` 启动，不要手工跑）。
 *
 * 只做三件事：在**透明窗口**里加载探针页 → 量背板/菜单的几何与计算样式 →
 * `capturePage()` 读菜单里一个空白点的 alpha（见 probe 头的机制说明）。
 */
import { app, BrowserWindow } from 'electron'

const page = process.env.PROBE_PAGE
const mode = process.env.PROBE_MODE ?? 'fix'

app.commandLine.appendSwitch('no-sandbox')

app.on('ready', async () => {
  try {
    const win = new BrowserWindow({
      width: 900,
      height: 600,
      frame: false,
      show: true,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { contextIsolation: true, sandbox: false },
    })
    await win.loadFile(page)
    await new Promise(resolve => setTimeout(resolve, 700))
    const measured = await win.webContents.executeJavaScript(`(() => {
      const menu = document.querySelector('[data-menu-material]')
      const backing = document.querySelector('[data-menu-backing]')
      if (menu === null || backing === null) return { error: 'missing menu or backing' }
      const mr = menu.getBoundingClientRect()
      const br = backing.getBoundingClientRect()
      const cs = getComputedStyle(backing)
      return {
        mode: ${JSON.stringify(mode)},
        menu: [mr.left, mr.top, mr.width, mr.height],
        backing: [br.left, br.top, br.width, br.height],
        display: cs.display,
        background: cs.backgroundColor,
        // 菜单下半部是空白（文字只在上半部）：无背板时这里只剩材质的 alpha。
        sample: { x: Math.round(mr.left + mr.width / 2), y: Math.round(mr.top + mr.height * 0.8) },
        // 菜单之外：透明窗口前提的对照点。
        outside: { x: 700, y: 500 },
      }
    })()`)
    if (measured?.error !== undefined) throw new Error(measured.error)
    const image = await win.webContents.capturePage()
    const size = image.getSize()
    const bitmap = image.getBitmap()
    const scaleX = size.width / 900
    const scaleY = size.height / 600
    const read = (point) => {
      const px = Math.min(size.width - 1, Math.max(0, Math.round(point.x * scaleX)))
      const py = Math.min(size.height - 1, Math.max(0, Math.round(point.y * scaleY)))
      const at = (py * size.width + px) * 4 // BGRA
      return { x: px, y: py, b: bitmap[at], g: bitmap[at + 1], r: bitmap[at + 2], a: bitmap[at + 3] }
    }
    const pixel = read(measured.sample)
    const outside = read(measured.outside)
    process.stdout.write(`PROBE_RESULT ${JSON.stringify({ ...measured, image: [size.width, size.height], pixel, outside })}\n`)
  } catch (error) {
    process.stdout.write(`PROBE_ERROR ${String(error?.stack ?? error)}\n`)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
