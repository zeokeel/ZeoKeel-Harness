/**
 * 应用窗口的**崩溃 / 加载失败恢复**（R16B-19；形态照 shell 窗口的
 * `reloadOrShowCrashFallback`，见 `desktop/src/electron-runtime.ts`）。
 *
 * ## 修前的缺陷（第十六轮审计泳道 B，P1）
 *
 * 应用窗口此前只在建窗时挂 `page-title-updated`，唯一的加载处理是
 * `loadURL().catch(reportLoadFailure)`（落到 `<userData>/logs` 里一行）。渲染进程
 * 崩了或首次加载失败 ⇒ **永久空白窗口**：没有错误面、没有重试、没有自动重载；
 * 模型面还把 `crashed` 硬编码成 `false` ⇒ 用户与 AI 都看不到它坏了。
 *
 * ## 冻结形态（**不要**简化掉其中任何一条）
 *
 *  - **单飞**：两个事件源（`render-process-gone` / `did-fail-load`）共用
 *    {@link AppWindowRecovery.fail} 一个入口；恢复进行中到达的事件**加入同一个
 *    Promise**，不再发起第二次导航。真机上渲染进程崩溃会**同时**派发进程级与导航级
 *    两个事件，没有单飞时两次 `loadURL` 并发，错误页与 reload 谁后完成谁说了算。
 *  - **至多自动重载一次**：`idle → retrying → reloaded|failed`。第一次故障自动重载
 *    （回到用户原来所在的路径），之后一律只显示失败页。为什么不"每次故障都重载"：
 *    一个必然崩溃的应用会变成 reload↔crash 的死循环（shell 的旧实现踩过：错误页
 *    渲染完又被 `did-finish-load` 拉回应用，无限循环）。
 *  - **失败页 + 手动重试按钮**：按钮用 `location.href=<重试目标>` 显式导航（**不是**
 *    自动回跳 —— 那正是上面那个死循环的成因）。
 *  - **重试目标在重载之前捕获**：并发事件不得改变本轮的重试目标。
 *
 * ## 为什么是独立模块（而不是塞进 `electron-adapter.ts`）
 *
 * 与 `windows.ts` 同一个理由：这台状态机是**容易写错又难验证**的那一半（单飞、
 * 额度、重试目标、失败页），把它与 Electron 隔开就能在纯 Node 下逐条钉住
 * （`app-window-recovery.spec.ts`）。`electron-adapter.ts` 只负责把原生事件喂进来。
 *
 * @module @zeokeel/dsh-wasm-apps-host/app-window-recovery
 */

import { appWindowDiagnosticCopy, type AppWindowDiagnosticCopy, type AppWindowFailureCopy } from './app-window-copy.ts'
import { escapeHtmlText } from './html-escape.ts'

/** 应用窗口的故障种类（两个事件源；`crashed` 与恢复路径共用同一个判据）。 */
export type AppWindowFailureKind =
  /** 渲染进程消失（`webContents` 的 `render-process-gone`）。 */
  | 'render-process-gone'
  /** 顶层文档加载失败（`did-fail-load` 且 `isMainFrame === true`、`errorCode !== -3`）。 */
  | 'did-fail-load'

/** 一次故障（诊断面与状态面共用）。 */
export interface AppWindowFailure {
  kind: AppWindowFailureKind
  /** 崩溃原因（`details.reason`）或加载错误描述（`<code>: <description>`）。 */
  reason: string
}

/**
 * 恢复状态机的相位。
 *
 * `idle` 是唯一允许自动重载的相位；一旦离开就**永不回来**（每个窗口一生一次）。
 * 这是有意的：自动重载的第二次机会只在"这是第一次故障"时有意义，而复位相位会让
 * 必然崩溃的应用陷入 reload↔crash 死循环。
 */
export type AppWindowRecoveryPhase = 'idle' | 'retrying' | 'reloaded' | 'failed'

/**
 * 恢复动作要的原生面（**故意只有这三项**：本模块不 import Electron）。
 *
 * 实现方（适配器）负责把"想要的 URL"记住：失败页显示期间 `webContents.getURL()`
 * 是 `data:` 文档，不能拿它当重试目标（否则第二次失败页的按钮会是禁用的）。
 */
export interface AppWindowRecoveryHost {
  /** 窗口是否已销毁（销毁后一切恢复动作都是 no-op）。 */
  isDestroyed(): boolean
  /**
   * 重试目标：当前（或最近一次请求的）**应用文档** URL。
   * @returns URL；没有任何可用目标时返回 `''`（失败页的按钮随之禁用）。
   */
  currentUrl(): string
  /**
   * 原生导航（失败即 reject）。
   *
   * **语义是"照做"，不是"应用加载成功了"**：失败页也经它加载。宿主的"窗口好了"
   * 只能经 {@link AppWindowRecovery.loaded} 报告（判据是"应用文档加载成功"，
   * 失败页那个 `data:` 文档不算）。
   */
  load(url: string): Promise<void>
}

/** {@link createAppWindowRecovery} 的构造参数。 */
export interface AppWindowRecoveryOptions {
  /** 原生面（建窗时由适配器提供）。 */
  host: AppWindowRecoveryHost
  /** 失败页文案（**按调用**求值：语言可在运行中改变）。 */
  copy: () => AppWindowFailureCopy
  /**
   * 崩溃状态变化的出口（`true` = 坏了、`false` = 好了）。模型面 `crashed` 的
   * **唯一真源**；缺席 ⇒ 只有恢复路径，没有状态上报（旧宿主）。
   */
  onCrashStateChange?: ((crashed: boolean) => void) | undefined
  /** 诊断出口（缺省丢弃）。 */
  warn?: ((message: string) => void) | undefined
  /**
   * 失败页上的诊断块（U-03，2026-10-22 评审）。
   *
   * **按调用**求值（窗口能活很久，app/URL/版本都可能变）。缺席 ⇒ 页面不渲染诊断块
   * （纯逻辑单测不需要它；生产适配器总是给）。
   */
  diagnostics?: (() => AppWindowFailureDiagnostics) | undefined
  /** 失败页的页面语言（`<html lang>`；U-09）。缺席 ⇒ `zh-CN`。 */
  pageLang?: (() => string) | undefined
}

/** 失败页诊断块的输入（U-03：用户截图之外的最小可定位集合）。 */
export interface AppWindowFailureDiagnostics {
  /** 应用 id。 */
  appId?: string
  /** 出错/重试目标的 URL。 */
  url?: string
  /** 客户端版本（`app.getVersion()`）。 */
  clientVersion?: string
}

/** {@link AppWindowRecovery.fail} 的选项。 */
export interface AppWindowFailOptions {
  /**
   * 是否允许"自动重载一次"。
   *
   * `false` = **应用加载仍在飞**的故障（加载看门狗超时）：这时 `host.load` 的那次
   * 导航还没有 settle，再发一次同目标导航只会叠一个并发加载，而不是"再给一次机会"。
   * 缺省 `true`（崩溃/明确失败走原有的一次自动重载）。
   */
  retry?: boolean
}

/** 恢复状态机。 */
export interface AppWindowRecovery {
  /**
   * 报告一次故障（**两个事件源的唯一入口**）。
   * @param failure - 故障种类与原因。
   * @param flags - 恢复策略（缺省允许一次自动重载；看门狗超时传 `{ retry: false }`）。
   * @returns 本轮恢复结束时 settle 的 promise（并发调用返回**同一个** promise）。
   */
  fail(failure: AppWindowFailure, flags?: AppWindowFailOptions): Promise<void>
  /**
   * 报告"一次应用文档加载成功"（建窗/聚焦导航，或用户在失败页点了重试）。
   *
   * 与 {@link AppWindowRecovery.fail} 相对：它是"窗口真的好了"的唯一判据。失败页
   * 自己加载完成**不算**（那是 `data:` 文档，不表示应用好了）。
   */
  loaded(): void
  /** 当前是否处于"坏了"的状态（模型面 `crashed` 的取值）。 */
  crashed(): boolean
  /** 当前相位（诊断/测试用）。 */
  phase(): AppWindowRecoveryPhase
  /** 最近一次故障（诊断用；没有故障过 ⇒ undefined）。 */
  lastFailure(): AppWindowFailure | undefined
}

/**
 * 构造一台恢复状态机。
 * @param options - 原生面、文案与诊断出口。
 * @returns 状态机（每个原生窗口一台）。
 */
export function createAppWindowRecovery(options: AppWindowRecoveryOptions): AppWindowRecovery {
  const warn = options.warn ?? ((): void => {})
  let phase: AppWindowRecoveryPhase = 'idle'
  /** 正在跑的恢复（单飞：并发事件加入它）。 */
  let pending: Promise<void> | undefined
  let crashed = false
  let last: AppWindowFailure | undefined

  /** 状态翻转的唯一出口（去重：同值不重复上报，避免噪声与无谓的注册表写入）。 */
  const setCrashed = (value: boolean): void => {
    if (crashed === value) return
    crashed = value
    options.onCrashStateChange?.(value)
  }

  /** 一轮恢复：第一次自动重载，之后一律失败页。 */
  const recover = async (): Promise<void> => {
    try {
      if (phase === 'idle') {
        phase = 'retrying'
        // **重试目标在重载之前捕获**：并发事件（同一 tick 的第二个事件源）不得改变
        // 本轮的目标；失败页显示的也是这一个值。
        const retryTarget = options.host.currentUrl()
        if (retryTarget !== '') {
          try {
            await options.host.load(retryTarget)
            phase = 'reloaded'
            // 重载成功 ⇒ 窗口真的好了（这一次加载本身就是"应用文档加载成功"）。
            setCrashed(false)
            return
          } catch (cause) {
            warn(`zeokeel-wasm-apps-host: the automatic reload of an application window did not complete (${cause instanceof Error ? cause.message : String(cause)})`)
          }
        } else {
          warn('zeokeel-wasm-apps-host: an application window failed before it had a document URL; showing the failure page without a reload target')
        }
      }
      // 走到这里只有两种可能：自动重载失败，或重试额度已用尽（`phase !== 'idle'`）。
      // 两者都只给失败页 —— 且**必须在这里**置相位：放在 `if` 里的话，第二次故障
      // 会把相位留在 `reloaded`，状态机就再也走不到终态了。
      phase = 'failed'
      await showFailurePage()
    } finally {
      // 同步解除单飞（不放在 `Promise.finally` 之外的地方）：`finally` 恰好覆盖
      // "本轮已定下导航"的语义 —— 之后到达的事件属于**新的一轮**，而新的一轮因为
      // `phase !== 'idle'` 只会显示失败页。
      pending = undefined
    }
  }

  /** 加载失败页（`data:text/html` 独立文档）。 */
  const showFailurePage = async (): Promise<void> => {
    if (options.host.isDestroyed()) return
    const retryTarget = options.host.currentUrl()
    let diagnostics: AppWindowFailureDiagnostics | undefined
    try {
      diagnostics = options.diagnostics?.()
    } catch (cause) {
      // 诊断块是"附加信息"，取不到不影响页面本身（绝不能让它挡住失败页）。
      warn(`zeokeel-wasm-apps-host: collecting application window diagnostics failed (${cause instanceof Error ? cause.message : String(cause)})`)
    }
    try {
      const pageLang = options.pageLang?.()
      await options.host.load(renderAppWindowFailurePage({
        copy: options.copy(),
        retryTarget,
        // 诊断块的按钮/标题也要跟随页面语言（否则英文界面上出现一块中文按钮）。
        diagnosticCopy: appWindowDiagnosticCopy(pageLang === 'en' ? 'en' : 'zh'),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        ...(pageLang === undefined ? {} : { lang: pageLang }),
        ...(last === undefined ? {} : { failure: last }),
      }))
    } catch (cause) {
      // 连失败页都加载不出来：只能留一条诊断（窗口已经是空白，没有别的出口）。
      warn(`zeokeel-wasm-apps-host: the application window failure page failed to load (${cause instanceof Error ? cause.message : String(cause)})`)
    }
  }

  return {
    async fail(failure, flags) {
      last = failure
      // 状态先翻转：即使恢复立刻失败，模型面也必须已经知道"它坏了"。
      setCrashed(true)
      if (options.host.isDestroyed()) return
      if (pending !== undefined) {
        warn(`zeokeel-wasm-apps-host: an application window failure arrived while recovery was in flight; joining it instead of navigating again (${failure.kind})`)
        return await pending
      }
      // 看门狗超时（U-01）：应用加载还在飞，自动重载只会叠一次同目标导航 ⇒ 直接给
      // 失败页。相位在这里就置终态，后续到达的崩溃事件走"额度已用尽"分支。
      if (flags?.retry === false) {
        phase = 'failed'
        const settled = showFailurePage()
        pending = settled
        try {
          return await settled
        } finally {
          pending = undefined
        }
      }
      const settled = recover()
      pending = settled
      return await settled
    },
    loaded() {
      setCrashed(false)
    },
    crashed: () => crashed,
    phase: () => phase,
    lastFailure: () => last,
  }
}

/** {@link renderAppWindowFailurePage} 的输入。 */
export interface AppWindowFailurePageOptions {
  /** 文案（调用方已按当前语言解析）。 */
  copy: AppWindowFailureCopy
  /** 重试目标（`''` ⇒ 按钮禁用）。 */
  retryTarget: string
  /** 诊断块（U-03；缺席 ⇒ 不渲染）。 */
  diagnostics?: AppWindowFailureDiagnostics
  /** 最近一次故障（诊断摘要；缺席 ⇒ 摘要只写状态）。 */
  failure?: AppWindowFailure
  /** `<html lang>`（U-09；缺省 `zh-CN`）。 */
  lang?: string
  /** 诊断块的本地化文案（缺省中文；生产由适配器按宿主语言给）。 */
  diagnosticCopy?: AppWindowDiagnosticCopy
}

/**
 * 把 URL 嵌进内联 `<script>`：JSON 转义 + 中和 `<`，于是带 `</script>` 的页面
 * URL 也无法逃出脚本块（与 shell 的 `inlineScriptUrl` 同一口径）。
 * @param url - 重试目标。
 * @returns 可安全嵌入 JS 字面量。
 */
function inlineScriptUrl(url: string): string {
  return JSON.stringify(url).replace(/</gu, '\\u003c')
}

/**
 * 诊断块的可复制文本（U-03）。
 *
 * 形态刻意是"一行一个 `key: value`"：用户截图/粘贴到工单里时，运维不需要理解 JSON
 * 就能对上 app_id 与 URL；空字段**整行不出现**（不写 `undefined`，也不写空值占位）。
 * @param options - 诊断输入（app/URL/版本/故障）。
 * @returns 多行纯文本（可能为空串）。
 */
export function formatAppWindowDiagnostics(options: {
  diagnostics?: AppWindowFailureDiagnostics
  failure?: AppWindowFailure
  now?: Date
} = {}): string {
  const lines: string[] = []
  const appId = options.diagnostics?.appId
  if (typeof appId === 'string' && appId !== '') lines.push(`app_id: ${appId}`)
  const url = options.diagnostics?.url
  if (typeof url === 'string' && url !== '') lines.push(`url: ${url}`)
  const failure = options.failure
  if (failure !== undefined) lines.push(`error: ${failure.kind} (${failure.reason})`)
  const clientVersion = options.diagnostics?.clientVersion
  if (typeof clientVersion === 'string' && clientVersion !== '') lines.push(`client: ${clientVersion}`)
  // 只有时间戳的诊断块对排障没有价值，却会占掉失败页的一半版面（也让"页面里为什么
  // 多了一块"在没有诊断来源时无法解释）。没有任何可用字段 ⇒ 不渲染诊断块。
  if (lines.length === 0) return ''
  lines.push(`time: ${(options.now ?? new Date()).toISOString()}`)
  return lines.join('\n')
}

/**
 * 「复制诊断」的脚本（U-03 / U-10）。
 *
 * 为什么要在页面里做而不是走 IPC：这是 `data:text/html` 独立文档，没有 preload、
 * 没有宿主桥；`navigator.clipboard` 在非安全上下文里可能不存在或被拒绝，所以必须有
 * `textarea + execCommand('copy')` 的回退。两条路径都要把结果**反馈给用户**
 * （`aria-live` 的反馈行），否则"点了没反应"就是新的缺陷。
 * @param copy - 本地化的诊断文案。
 * @returns 可安全内嵌的脚本（未知文本一律 JSON 序列化，页面内容不参与拼接）。
 */
export function appWindowDiagnosticsScript(copy: AppWindowDiagnosticCopy): string {
  return `(function(){
  var button=document.getElementById('copy-diag');
  var state=document.getElementById('copy-state');
  var block=document.getElementById('diagnostics');
  if(!button||!state||!block) return;
  var OK=${JSON.stringify(copy.copied)};
  var FAILED=${JSON.stringify(copy.copyFailed)};
  function done(ok){ try{ state.textContent=ok?OK:FAILED }catch(e){} }
  function fallback(){
    try{
      var area=document.createElement('textarea');
      area.value=block.textContent||'';
      area.setAttribute('readonly','');
      area.style.cssText='position:fixed;left:-9999px;top:0';
      document.body.appendChild(area);
      area.select();
      var ok=false;
      try{ ok=document.execCommand&&document.execCommand('copy')===true }catch(e){ ok=false }
      document.body.removeChild(area);
      done(ok);
    }catch(e){ done(false) }
  }
  button.addEventListener('click',function(){
    try{
      var text=block.textContent||'';
      if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){
        navigator.clipboard.writeText(text).then(function(){ done(true) },function(){ fallback() });
        return;
      }
      fallback();
    }catch(e){ fallback() }
  });
})()`
}

/**
 * 渲染失败页（`data:text/html` 独立文档）。
 *
 * 为什么不复用 `pages.ts` 的 `page()`：那套外壳是给**协议 handler 的响应**用的
 * （带 `<main>`/hints/detail 的说明页），而这里要的是"能自己点重试"的交互页 ——
 * 唯一需要脚本的地方，脚本的安全约束也不同（见 {@link inlineScriptUrl}）。
 *
 * `color-scheme: light dark` + `prefers-color-scheme`：桌面壳设了
 * `nativeTheme.themeSource`，独立文档只能靠媒体查询跟随应用内主题（否则暗色主题下
 * 会闪一整页刺眼白，shell 的失败页踩过）。
 *
 * U-03（2026-10-22 评审）：页面多了**诊断块 + 复制诊断**。用户在这张页面上能直接
 * 拿到 `app_id / URL / 错误 / 客户端版本`，不必去托盘菜单找"导出诊断信息"。
 * U-09：`<html lang>` 按页面语言求值（不再写死 `zh-CN`）。
 * @param options - 文案、重试目标、诊断与页面语言。
 * @returns 完整的 `data:text/html` URL。
 */
export function renderAppWindowFailurePage(options: AppWindowFailurePageOptions): string {
  const { copy, retryTarget } = options
  const diagnosticCopy = options.diagnosticCopy ?? appWindowDiagnosticCopy('zh')
  const diagnosticText = formatAppWindowDiagnostics({
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.failure === undefined ? {} : { failure: options.failure }),
  })
  const lang = options.lang === 'en' ? 'en' : options.lang === 'zh' ? 'zh-CN' : (options.lang ?? 'zh-CN')
  const retryScript = retryTarget === ''
    ? ''
    : `<script>document.getElementById('retry').addEventListener('click',function(){location.href=${inlineScriptUrl(retryTarget)}})</script>`
  const diagnostics = diagnosticText === ''
    ? ''
    : `<section class="diagnostics"><h2>${escapeHtmlText(diagnosticCopy.heading)}</h2><pre id="diagnostics">${escapeHtmlText(diagnosticText)}</pre><div class="diagnostics-actions"><button id="copy-diag" type="button" class="secondary">${escapeHtmlText(diagnosticCopy.copy)}</button><span id="copy-state" role="status" aria-live="polite"></span></div></section>`
  const diagnosticsScript = diagnostics === '' ? '' : `<script>${appWindowDiagnosticsScript(diagnosticCopy)}</script>`
  const html = `<!DOCTYPE html><html lang="${escapeHtmlText(lang)}"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtmlText(copy.heading)}</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;background:#f5f6f8;color-scheme:light dark}.card{text-align:center;max-width:520px;padding:32px;width:100%}h1{font-size:18px;color:#1a1d24}p{color:#616267;font-size:14px}button{margin-top:12px;padding:8px 18px;border:1px solid #2563eb;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}button.secondary{background:transparent;color:#2563eb}.diagnostics{margin-top:20px;text-align:left;border-top:1px solid rgba(128,128,128,.25);padding-top:12px}h2{font-size:12px;font-weight:600;color:#616267;margin:0 0 6px}#diagnostics{margin:0;padding:10px;border-radius:8px;background:rgba(128,128,128,.12);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;user-select:text}.diagnostics-actions{display:flex;align-items:center;gap:10px;margin-top:8px}#copy-state{font-size:12px;color:#616267}@media (prefers-color-scheme: dark){body{background:#151517}h1{color:#f9fafb}p,h2,#copy-state{color:#9ca3af}button.secondary{color:#60a5fa;border-color:#60a5fa}}</style></head><body><div class="card"><h1>${escapeHtmlText(copy.heading)}</h1><p>${escapeHtmlText(copy.body)}</p><button id="retry"${retryTarget === '' ? ' disabled' : ''}>${escapeHtmlText(copy.retry)}</button>${diagnostics}</div>${retryScript}${diagnosticsScript}</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
