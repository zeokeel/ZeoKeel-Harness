/**
 * Programming-mode bridge for `browser_run` (2026-10-23).
 *
 * The script runs in an isolated ptc runtime process and sees ONLY the frozen
 * `browser` object built here: every helper is a thin call to the same runtime
 * method the corresponding TOOL uses, so budgets, the user gate, the credential
 * window, redaction and the op log stay on one code path. Nothing here touches
 * CDP, cookies, the file system or `process`.
 * @module @zeokeel/dsh-browser
 */

/** Helper name → existing tool name (audit R4: explicit whitelist, ⊆ tools). */
export const PROGRAM_HELPERS = {
  open: 'browser_open',
  closeTab: 'browser_close_tab',
  tabs: 'browser_list_tabs',
  switchTab: 'browser_switch_tab',
  navigate: 'browser_navigate',
  back: 'browser_go_back',
  forward: 'browser_go_forward',
  reload: 'browser_reload',
  snapshot: 'browser_get_snapshot',
  text: 'browser_get_text',
  screenshot: 'browser_screenshot',
  click: 'browser_click',
  dblclick: 'browser_dblclick',
  hover: 'browser_hover',
  drag: 'browser_drag',
  type: 'browser_type',
  select: 'browser_select',
  press: 'browser_press',
  hotkey: 'browser_hotkey',
  scroll: 'browser_scroll',
  waitFor: 'browser_wait_for',
  eval: 'browser_eval',
  fileChooser: 'browser_file_chooser',
  download: 'browser_download',
  downloads: 'browser_downloads_list',
  fetch: 'browser_fetch',
  emulate: 'browser_emulate',
  clipboard: 'browser_clipboard',
  history: 'browser_history_search',
  bookmarks: 'browser_bookmarks_list',
} as const

/**
 * Names that must NEVER appear as helpers (audit R4/R7): credential handling,
 * control transfer, session data, cookie jars and anything CDP-shaped.
 */
export const PROGRAM_FORBIDDEN_HELPERS: readonly string[] = [
  'takeover', 'fillCredentials', 'credentialsList', 'clearData', 'cookies',
  'cookie', 'rawCdp', 'cdp', 'require', 'process', 'fs', 'net', 'dialog',
]

/** One helper call budget: the remaining script deadline plus a call cap. */
export interface ProgramBridgeOptions {
  /** Absolute deadline of the whole script (epoch ms). */
  readonly deadlineAt: number
  /** Maximum number of helper calls, failures included (audit ③). */
  readonly maxCalls: number
  /** Tool-level abort. */
  readonly signal?: AbortSignal
  /** Called once per helper invocation (success or failure). */
  readonly onCall?: (helper: string, tool: string) => void
}

/** Result of a completed program run. */
export interface ProgramResult {
  readonly result: unknown
  readonly console: string
  readonly helperCalls: number
}

/** What the tool needs from an injected ptc runtime (fake in tests). */
export interface ProgramRuntime {
  execute(program: string, bridge: Readonly<Record<string, unknown>>, options?: { signal?: AbortSignal }): Promise<{ result: unknown, console?: string }>
}

/**
 * Build the frozen bridge object handed to the script.
 * @param invoke - calls the runtime method behind a tool (one `agentRun` per call).
 * @param options - deadline/call-cap/abort.
 * @returns the frozen `browser` object plus counters.
 */
export function createProgramBridge(
  invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  options: ProgramBridgeOptions,
): { browser: Readonly<Record<string, (...args: never[]) => Promise<unknown>>>, readonly calls: number, pending: Set<Promise<unknown>> } {
  const state = { calls: 0, pending: new Set<Promise<unknown>>() }
  const browser: Record<string, (...args: never[]) => Promise<unknown>> = {}
  for (const [helper, tool] of Object.entries(PROGRAM_HELPERS)) {
    browser[helper] = (async (...args: unknown[]) => {
      // The counter runs BEFORE the guard so failed calls count too (audit ③).
      state.calls += 1
      if (state.calls > options.maxCalls) throw new Error(`browser_run: helper call limit (${String(options.maxCalls)}) exceeded`)
      const remaining = options.deadlineAt - Date.now()
      if (remaining <= 0) throw new Error('browser_run: the script deadline has passed')
      options.signal?.throwIfAborted()
      options.onCall?.(helper, tool)
      const call = invoke(tool, (args[0] ?? {}) as Record<string, unknown>)
      state.pending.add(call)
      try {
        return await call
      } finally {
        state.pending.delete(call)
      }
    }) as never
  }
  return { browser: Object.freeze(browser), get calls(): number { return state.calls }, pending: state.pending }
}

/** JSON-safe projection of a program result (256 KiB cap, never invalid JSON). */
export function truncateProgramResult(value: unknown, maxBytes = 256 * 1024): { value: unknown, truncated: boolean } {
  let text: string
  try {
    text = JSON.stringify(value ?? null)
  } catch {
    throw new Error('browser_run: the program result is not serializable — return a JSON value')
  }
  if (text === undefined) return { value: null, truncated: false }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { value: JSON.parse(text) as unknown, truncated: false }
  // Cut on a UTF-8 boundary and keep the value JSON-valid (a string), never a
  // half-encoded document (audit P3: UTF-16 length is not bytes).
  let cut = text
  while (Buffer.byteLength(cut, 'utf8') > maxBytes && cut.length > 0) cut = cut.slice(0, -1)
  return { value: cut, truncated: true }
}

/**
 * Redact program console output line by line with a cumulative byte cap
 * (audit P2-2: the console used to be flattened into "[object Object]").
 * @param consoleText - raw console text from the runtime.
 * @param redact - text redactor.
 * @param maxBytes - cumulative cap.
 */
export function redactProgramConsole(consoleText: string, redact: (text: string) => string, maxBytes = 64 * 1024): string {
  const lines: string[] = []
  let used = 0
  for (const line of consoleText.split('\n')) {
    const redacted = redact(line)
    const bytes = Buffer.byteLength(redacted, 'utf8') + 1
    if (used + bytes > maxBytes) { lines.push('… (console output truncated)'); break }
    lines.push(redacted)
    used += bytes
  }
  return lines.join('\n')
}
