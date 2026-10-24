/**
 * Per-tab event bus for "arm → act → receipt" (2026-10-23 C2).
 *
 * The page can produce events *after* an action (a dialog, a popup, a download,
 * a file chooser). The runtime arms a one-shot waiter **before** the action and
 * consumes the event afterwards, so a receipt never races the action.
 *
 * Semantics, pinned by tests (audit's counter-proof list):
 * - **consume-once**: the first waiter for a kind takes the next matching event;
 *   an event is never delivered twice.
 * - **FIFO waiters**: two waiters on one kind get events in arrival order.
 * - **cancel-on-every-path**: `cancel()` and the timeout both remove the waiter,
 *   so a failed/timed-out action cannot leave a waiter behind to eat the next
 *   event (`expect` relies on this in a `finally`).
 * - **buffered leftovers**: events no waiter wanted are buffered (bounded); the
 *   tool drains them into its receipt, and a later `wait_for` can still take one.
 * - **isolation**: one bus per tab; A's waiter can never consume B's event.
 *
 * Pure module (no Electron/CDP imports) so it is unit-testable with fake timers.
 *
 * @module @zeokeel/dsh-browser
 */

import { browserError } from './errors.ts'

/** Event kinds a tool can arm for / drain. */
export type BrowserEventKind = 'dialog' | 'popup' | 'download' | 'file-chooser'

/** One buffered/settled event. The payload is deliberately loose here: the
 * runtime owns the per-kind shapes and projects them into receipts. */
export interface BrowserBusEvent {
  readonly kind: BrowserEventKind
  readonly payload: unknown
  /** Monotonic sequence (diagnostics + receipt ordering). */
  readonly seq: number
  /** When the event was produced (epoch ms). */
  readonly at: number
}

interface Waiter {
  readonly kind: BrowserEventKind
  readonly resolve: (event: BrowserBusEvent) => void
  readonly reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
}

/** Bounded buffer: a hostile page must not grow it without limit. */
export const TAB_EVENT_BUFFER_LIMIT = 50

/**
 * One arm handle. `cancel()` is idempotent and safe after settlement.
 *
 * Rejection trap: both `cancel()` and the timeout REJECT this promise. A caller
 * that cancels inside `finally` and never awaits must attach
 * `void armed.promise.catch(() => {})`, otherwise Node reports an unhandled
 * rejection (Electron log noise / noisy test runs).
 */
export interface ArmedEvent {
  readonly promise: Promise<BrowserBusEvent>
  /** Remove the waiter (rejects the promise with an `interrupted` BrowserError). */
  cancel(): void
}

/** Per-tab event bus. */
export class TabEventBus {
  private seq = 0
  private readonly buffer: BrowserBusEvent[] = []
  private readonly waiters: Waiter[] = []
  private disposed = false
  /** Events dropped because the buffer was full (diagnostics only). */
  dropped = 0

  /**
   * @param limit - buffered-event cap for this bus.
   */
  constructor(private readonly limit: number = TAB_EVENT_BUFFER_LIMIT) {}

  /**
   * Arm a one-shot waiter for `kind` BEFORE the action.
   * @param kind - event kind to wait for.
   * @param timeoutMs - reject with `timeout` after this long.
   * @returns the promise plus a cancel handle.
   */
  arm(kind: BrowserEventKind, timeoutMs: number, options: { consumeBuffered?: boolean } = {}): ArmedEvent {
    // Timeout must be positive: 0/negative would mean "never times out", which is
    // not a supported semantic (a caller wanting no timeout passes a big number).
    const effectiveTimeout = Math.max(1, Math.floor(timeoutMs))
    if (this.disposed) {
      return { promise: Promise.reject(browserError('interrupted', 'browser: event bus disposed')), cancel: () => {} }
    }
    // `consumeBuffered: false` is the strict mode used by `expect`: an event that
    // happened BEFORE this arm must not fake a receipt for the action about to
    // run (audit M2 P2-1). `wait_for` keeps the default (already happened = met).
    const consumeBuffered = options.consumeBuffered !== false
    let waiter!: Waiter
    const promise = new Promise<BrowserBusEvent>((resolve, reject) => {
      waiter = { kind, resolve, reject, timer: undefined, settled: false }
    })
    // A leftover buffered event of this kind satisfies the arm immediately —
    // arming after the fact must still see the event (consume-once).
    const bufferedIndex = consumeBuffered ? this.buffer.findIndex(event => event.kind === kind) : -1
    if (bufferedIndex >= 0) {
      const [event] = this.buffer.splice(bufferedIndex, 1)
      waiter.settled = true
      waiter.resolve(event!)
      return { promise, cancel: () => { /* already settled */ } }
    }
    waiter.timer = setTimeout(() => {
      this.settleWaiter(waiter, () => waiter.reject(browserError('timeout', `browser: no ${kind} event within ${String(effectiveTimeout)}ms`)))
    }, effectiveTimeout)
    this.waiters.push(waiter)
    return {
      promise,
      cancel: () => {
        this.settleWaiter(waiter, () => waiter.reject(browserError('interrupted', `browser: ${kind} waiter cancelled`)))
      },
    }
  }

  /** Publish one event: wake the oldest matching waiter, else buffer it. */
  push(kind: BrowserEventKind, payload: unknown, at: number = Date.now()): BrowserBusEvent {
    const event: BrowserBusEvent = { kind, payload, seq: this.seq += 1, at }
    if (this.disposed) return event
    const waiter = this.waiters.find(candidate => candidate.kind === kind && !candidate.settled)
    if (waiter !== undefined) {
      this.settleWaiter(waiter, () => waiter.resolve(event))
      return event
    }
    this.buffer.push(event)
    if (this.buffer.length > this.limit) {
      this.buffer.shift()
      this.dropped += 1
    }
    return event
  }

  /** Remove and return buffered events (optionally one kind only). */
  drain(kind?: BrowserEventKind): BrowserBusEvent[] {
    if (kind === undefined) return this.buffer.splice(0)
    const taken: BrowserBusEvent[] = []
    for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
      if (this.buffer[index]!.kind !== kind) continue
      taken.unshift(this.buffer.splice(index, 1)[0]!)
    }
    return taken
  }

  /** Buffered events currently held (diagnostics/tests). */
  get size(): number { return this.buffer.length }

  /** Waiter count for one kind (diagnostics/tests). */
  waiterCount(kind?: BrowserEventKind): number {
    return kind === undefined ? this.waiters.length : this.waiters.filter(waiter => waiter.kind === kind).length
  }

  /** Dispose the bus: reject every waiter, drop the buffer. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) {
      this.settleWaiter(waiter, () => waiter.reject(browserError('interrupted', 'browser: event bus disposed')))
    }
    this.buffer.length = 0
  }

  private settleWaiter(waiter: Waiter, settle: () => void): void {
    if (waiter.settled) return
    waiter.settled = true
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer)
      waiter.timer = undefined
    }
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
    settle()
  }
}
