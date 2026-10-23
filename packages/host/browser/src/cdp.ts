/**
 * Minimal CDP client over Electron's per-webContents Debugger. The embedded
 * browser drives every tab through `webContents.debugger` (the built-in CDP
 * channel), so no extra runtime dependency is needed. This module owns the
 * wire protocol only: attach/detach, `sendCommand`, and event fan-out.
 * @module @zeokeel/dsh-browser
 */

import { browserError } from './errors.ts'

/**
 * The Electron Debugger surface this adapter needs. Type-only import keeps
 * the module loadable under plain Node (unit tests inject a mock).
 */
export interface CdpTransport {
  isAttached(): boolean
  attach(protocolVersion: string): void
  detach(): void
  /** Send one command. `sessionId` addresses a flat (out-of-process iframe)
   * session obtained through `Target.setAutoAttach({flatten:true})` — Electron's
   * `Debugger.sendCommand(method, params, sessionId)` passes it through, and a
   * mock transport that ignores the third argument simply never sees OOPIFs
   * (the runtime then fails loud instead of guessing). */
  sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): unknown
  removeListener(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId?: string) => void): unknown
}

/**
 * Default per-command timeout. A wedged/crashed renderer must never hold the
 * global browser mutex forever — before 2026-09-08 a single never-settling
 * `sendCommand` left every later browser_* call hanging (audit P0-4).
 */
const CDP_CALL_TIMEOUT_MS = 30_000

export interface CdpSessionOptions {
  /**
   * Per-command timeout in ms (default CDP_CALL_TIMEOUT_MS).
   *
   * A provider function is evaluated for EVERY command: the runtime needs the
   * budget to shrink with what is left of the current tool deadline, so a hung
   * renderer is abandoned before the upstream timeout-policy replaces the tool's
   * own diagnosis with a generic `tool call timed out` (R4-B-15).
   */
  timeoutMs?: number | (() => number)
  /**
   * Per-command veto, evaluated before every `send` (2026-10-23 C1 choke point).
   * The runtime uses it to fail every page command fast while a dialog blocks the
   * tab — one place instead of one guard per call site. Throw to refuse.
   */
  beforeCommand?: (method: string) => void
}

/** One established CDP session over a transport. */
export class CdpSession {
  private readonly listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
  private readonly messageListener: (event: unknown, method: string, params: unknown, sessionId?: string) => void
  private closed = false
  /** Aborts every in-flight command of this session (2026-10-23 M1 audit: a
   * blocked renderer must not delay the dialog answer behind a 10s CDP budget). */
  private pending = new AbortController()

  constructor(
    private readonly transport: CdpTransport,
    private readonly options: CdpSessionOptions = {},
  ) {
    this.messageListener = (_event, method, params, sessionId) => {
      const set = this.listeners.get(method)
      if (set === undefined) return
      for (const handler of [...set]) {
        try {
          handler(params, sessionId)
        } catch {
          // A listener must never break the CDP fan-out.
        }
      }
    }
  }

  /** Attach with the stable protocol version, failing loudly on double attach. */
  async attach(): Promise<void> {
    if (this.transport.isAttached()) throw new Error('browser: CDP already attached')
    this.transport.attach('1.3')
    this.transport.on('message', this.messageListener)
    this.closed = false
  }

  /**
   * Send one CDP command; rejects when the session is closed, the command
   * fails, the per-call timeout elapses, or `signal` aborts. A timeout/abort
   * rejects locally — the transport promise is abandoned, so a wedged renderer
   * can never keep the caller (and the global browser mutex) waiting forever.
   */
  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    callOptions: { timeoutMs?: number; signal?: AbortSignal; sessionId?: string } = {},
  ): Promise<T> {
    if (this.closed) throw new Error(`browser: CDP session closed (${method})`)
    this.options.beforeCommand?.(method)
    const configured = callOptions.timeoutMs ?? this.options.timeoutMs
    const timeoutMs = typeof configured === 'function' ? configured() : configured ?? CDP_CALL_TIMEOUT_MS
    // Capture the abort channel BEFORE the command is sent: an event handler may
    // call `abortPending()` synchronously from inside `sendCommand`, which swaps
    // the controller — reading it afterwards would pick up the fresh (unaborted)
    // signal and the command would never be aborted (audit M2 P2-1).
    const signal = callOptions.signal === undefined
      ? this.pending.signal
      : AbortSignal.any([callOptions.signal, this.pending.signal])
    const wire = callOptions.sessionId === undefined
      ? this.transport.sendCommand(method, params)
      : this.transport.sendCommand(method, params, callOptions.sessionId)
    return await withTimeout(wire, timeoutMs, method, signal) as T
  }

  /**
   * Abort every command currently in flight on this session (the next `send`
   * starts with a fresh controller). Used when the page blocks on a dialog: the
   * command that triggered it would otherwise hold the caller (and the global
   * mutex) until its CDP budget runs out.
   * @param reason - abort reason passed to the in-flight waits.
   */
  abortPending(reason?: unknown): void {
    this.pending.abort(reason)
    this.pending = new AbortController()
  }

  /** Subscribe to one CDP method; returns a disposer. `sessionId` (second
   * argument) is the flat session the event came from, or `undefined` for the
   * page session — required to keep per-session state apart (R-4: an OOPIF's
   * default-world contexts only exist in that OOPIF's own session). */
  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  /** Detach idempotently and clear all subscriptions. */
  detach(): void {
    if (this.closed) return
    this.closed = true
    this.pending.abort(new Error('browser: CDP detached'))
    this.listeners.clear()
    this.transport.removeListener('message', this.messageListener)
    if (this.transport.isAttached()) {
      try {
        this.transport.detach()
      } catch {
        // Detach races with a destroyed webContents; nothing to clean up.
      }
    }
  }
}

/** Race a transport promise against a timeout and an optional abort signal. */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  method: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => finish(() => reject(browserError('interrupted', `browser: ${method} aborted`)))
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      settle()
    }
    timer = setTimeout(
      () => finish(() => reject(browserError('timeout', `browser: ${method} did not respond within ${timeoutMs}ms`))),
      Math.max(1, timeoutMs),
    )
    timer.unref?.()
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}
