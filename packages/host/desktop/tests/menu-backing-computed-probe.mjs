/**
 * 菜单卡片"页面变透明"的**真实合成**判据（2026-10-18，2.8.2 正式版现场反馈）。
 *
 * 背景：上游 MenuSurface 的材质是
 *   background: var(--dsw-menu-surface-fill)   // 亮 .58 / 暗 .45
 *   backdrop-filter: var(--dsw-menu-backdrop-filter)
 * 而我们的窗口为原生材质让路（darwin transparent+vibrancy / win32
 * backgroundColor:#00000000+mica，左栏 surface 也 transparent）。**透明窗口的合成面上
 * 没有不透明像素时，Chromium 不再产出 backdrop-filter 模糊**：卡片只剩 .45 填充，
 * 下面的会话列表/桌面直接透上来 —— 用户说的"页面变透明"。
 *
 * 上游的兜底是 MenuSurface 额外 portal 的 `[data-menu-backing]`（bg-base 实底），
 * 但它的 CSS 只在 `html[data-platform='darwin']` 打开；我们的壳不打这个标记
 * （用的是 body 上的 data-dsh-desktop-mode / data-dsh-desktop-platform），于是
 * 兜底在**所有平台**都没生效。修复 = 在我们的高级外壳样式表里按 desktop 自己的
 * 模式标记打开同一个背板（见 src/client/styles.ts）。
 *
 * 本探针只做一件事：在**透明 BrowserWindow** 里放上游真的 MenuSurface 材质 + 我们的
 * 样式表，读菜单空白点的像素 alpha。
 *
 *   node packages/host/desktop/tests/menu-backing-computed-probe.mjs
 *   node packages/host/desktop/tests/menu-backing-computed-probe.mjs --mutate=hide-backing
 *
 * 判据：
 *   1. 透明窗口前提成立：菜单外的空白点 alpha < 255（否则这个探针没在测透明合成）；
 *   2. 修复态：背板 display:block、矩形与菜单逐像素对齐（≤1px）、底色 alpha=1，
 *      菜单空白点 alpha=255（实底）；
 *   3. 变异 `hide-backing`（删掉我们的规则）：菜单空白点 alpha < 255 —— 复现"透明页"，
 *      打印 DETECTED 并以 0 退出（证明判据有牙）；变异下若仍是 255，以 1 退出。
 * 没有 Xvfb 时自动套 xvfb-run。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const workspaceRoot = join(packageRoot, '..', '..', '..')
const PLATFORM_CSS = join(workspaceRoot, 'deepseek-harness', 'packages', 'client', 'ui-theme', 'src', 'styles', 'design-platform.css')
const SHADOW_CSS = join(workspaceRoot, 'deepseek-harness', 'packages', 'client', 'ui-theme', 'src', 'styles', 'gradient-shadow-text.css')
const MENU_CSS = join(packageRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'MenuSurface.module.css')
const APP_ENTRY = join(here, 'menu-backing-probe-app.mjs')

const SELECTOR = 'body[data-dsh-desktop-mode="advanced"] [data-menu-backing]'
const mutation = (process.argv.find(argument => argument.startsWith('--mutate=')) ?? '').slice('--mutate='.length)

/** 现场跑生产函数，拿到真正会被注入的那张样式表。 */
async function injectedStyles() {
  const style = { dataset: {}, textContent: '', remove() {} }
  const previous = globalThis.document
  globalThis.document = { createElement: () => style, head: { appendChild() {} } }
  try {
    const module = await import(new URL('../src/client/styles.ts', import.meta.url).href)
    module.installAdvancedStyles()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
  return style.textContent
}

/** 切出一条规则（选择器与 { 之间只允许空白）。 */
function ruleSpan(css, selector) {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`probe: missing rule ${selector}`)
  const open = css.indexOf('{', start + selector.length)
  if (open < 0 || !/^\s*$/u.test(css.slice(start + selector.length, open))) {
    throw new Error(`probe: ambiguous rule ${selector}`)
  }
  const close = css.indexOf('}', open)
  return [start, close + 1]
}

const MUTATIONS = {
  // 模拟"我们的壳没打这个标记 / 没有这条规则"的 2.8.2 生产形态。
  'hide-backing': css => {
    const [start, end] = ruleSpan(css, SELECTOR)
    return css.slice(0, start) + css.slice(end)
  },
}

/** 页面里的假会话标题（只在上半部，采样点选在菜单下半部空白处）。 */
const ROWS = ['会话标题一', '会话标题二', '会话标题三', '会话标题四', '会话标题五', '会话标题六']

async function buildPage(styles) {
  const [tokens, shadow, menu] = await Promise.all([
    readFile(PLATFORM_CSS, 'utf8'),
    readFile(SHADOW_CSS, 'utf8'),
    readFile(MENU_CSS, 'utf8'),
  ])
  const guard = text => text.replace(/<\/style/giu, '<\\/style')
  const rows = ROWS.map(row => `<div>${row}</div>`).join('')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>${guard(tokens)}</style>
<style>${guard(shadow)}</style>
<style>${guard(menu)}</style>
<style>${guard(styles)}</style>
<style>
  html, body { margin: 0; height: 100%; }
  #behind { position: fixed; left: 8px; top: 130px; width: 300px; font: 22px/34px monospace; color: #d5d7db; }
  #probe-menu { position: fixed; top: 120px; left: 40px; width: 240px; height: 300px; --dsh-menu-anchor: --probe-menu; }
  #probe-menu .item { padding: 4px 10px; color: #f3f4f6; font: 14px/24px sans-serif; }
</style>
</head><body data-dsh-desktop-mode="advanced">
<div class="dshDesktopFrame" data-desktop-platform="linux">
  <aside class="dshDesktopSidebarSurface"><div class="dshDesktopUpstreamSidebar"><div id="behind">${rows}</div></div></aside>
</div>
<div id="probe-menu" data-menu-material="translucent" class="surface">
  <div class="material" aria-hidden="true"></div>
  <div class="item">分组方式</div><div class="item">按工作区</div><div class="item">排序方式</div>
</div>
<div data-menu-backing aria-hidden="true" class="backing" style="--dsh-menu-anchor: --probe-menu"></div>
</body></html>`
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('probe: timed out')) }, 60_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function alpha(value) {
  const text = String(value).trim().toLowerCase()
  if (text === 'transparent' || text === 'rgba(0, 0, 0, 0)') return 0
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{8})$/u.exec(text)
  if (hex !== null) return hex[1].length === 8 ? Number.parseInt(hex[1].slice(6), 16) / 255 : 1
  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/u.exec(text)
  if (fn !== null) return fn[4] === undefined ? 1 : Number(fn[4])
  throw new Error(`probe: unsupported color ${value}`)
}

async function main() {
  const require = createRequire(import.meta.url)
  const electron = require('electron')
  let styles = await injectedStyles()
  if (mutation !== '') {
    const edit = MUTATIONS[mutation]
    if (edit === undefined) throw new Error(`probe: unknown mutation ${mutation}`)
    styles = edit(styles)
  }
  const directory = await mkdtemp(join(tmpdir(), 'menu-backing-'))
  const page = join(directory, 'probe.html')
  await writeFile(page, await buildPage(styles))
  process.stdout.write(`probe page: ${page}\n`)

  const headless = process.env.DISPLAY === undefined || process.env.DISPLAY === ''
  // --no-sandbox 必须是**真实 argv**：root 下 Electron 在进入 JS 之前就 FATAL 了，
  // app.commandLine.appendSwitch 来不及。
  const [command, args] = headless
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', electron, APP_ENTRY, '--no-sandbox']]
    : [electron, [APP_ENTRY, '--no-sandbox']]
  const result = await run(command, args, {
    env: { ...process.env, PROBE_PAGE: page, PROBE_MODE: mutation === '' ? 'fix' : mutation },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = result.stdout.split('\n').find(entry => entry.startsWith('PROBE_RESULT '))
  if (line === undefined) {
    throw new Error(`probe: no result (exit ${result.code})\n${result.stdout}\n${result.stderr}`)
  }
  const measured = JSON.parse(line.slice('PROBE_RESULT '.length))
  const [menu, backing] = [measured.menu, measured.backing]
  const aligned = backing.every((value, index) => Math.abs(value - menu[index]) <= 1)
  const menuAlpha = measured.pixel.a
  const outsideAlpha = measured.outside?.a ?? null
  process.stdout.write(`${JSON.stringify({ ...measured, aligned }, null, 2)}\n`)

  const failures = []
  // 透明合成前提：菜单外必须仍是透出原生材质/桌面的透明像素（否则测的不是这条链路）。
  if (outsideAlpha !== null && outsideAlpha >= 255) failures.push('transparent-window: outside pixel is opaque')
  if (mutation === '') {
    if (measured.display !== 'block') failures.push(`fix: backing display=${measured.display}`)
    if (!aligned) failures.push('fix: backing is not aligned with the menu')
    if (alpha(measured.background) !== 1) failures.push(`fix: backing background ${measured.background} is not opaque`)
    if (menuAlpha !== 255) failures.push(`fix: menu pixel alpha=${menuAlpha}, expected 255 (opaque backing)`)
    if (failures.length > 0) {
      process.stderr.write(`FAIL ${failures.join(' | ')}\n`)
      process.exit(1)
    }
    process.stdout.write('PASS menu material is backed by an opaque surface in a transparent window\n')
    return
  }
  // 变异态：必须复现"透明页"（菜单空白点 alpha < 255）。否则判据没有牙。
  if (measured.display !== 'none') failures.push(`mutation: backing display=${measured.display}, expected none`)
  if (menuAlpha >= 255) failures.push(`mutation: menu pixel alpha=${menuAlpha}, expected < 255`)
  if (failures.length > 0) {
    process.stderr.write(`FAIL mutation did not reproduce the defect: ${failures.join(' | ')}\n`)
    process.exit(1)
  }
  process.stdout.write(`DETECTED mutation=${mutation}: menu pixel alpha=${menuAlpha} (see-through)\n`)
}

main().catch(error => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`)
  process.exit(1)
})
