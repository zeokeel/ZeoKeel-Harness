/**
 * `TabEventBus` 消费语义（2026-10-23 C2）。审计的反证清单要求这几条先有单测，
 * `expect` 回执再接线：
 * 1. arm 必须在动作**之前**（后 arm 只能靠缓冲命中）；
 * 2. consume-once：事件绝不会被两个 waiter 各拿一次；
 * 3. FIFO：同 kind 的等待者按顺序拿事件；
 * 4. cancel-on-every-path：超时/取消后 waiter 必须消失（不能吃掉下一次事件）；
 * 5. 缓冲有界且 drain 只取一次；
 * 6. 多标签隔离：两个 bus 互不可见；
 * 7. dispose 拒绝所有 waiter。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { TabEventBus, TAB_EVENT_BUFFER_LIMIT } from '../src/events.ts'
import { BrowserError } from '../src/errors.ts'

afterEach(() => { vi.useRealTimers() })

describe('TabEventBus: arm before the action', () => {
  it('an armed waiter consumes the event pushed afterwards', async () => {
    const bus = new TabEventBus()
    const armed = bus.arm('popup', 1_000)
    bus.push('popup', { tab: 7, url: 'https://b.example' })
    await expect(armed.promise).resolves.toMatchObject({ kind: 'popup', payload: { tab: 7 } })
    expect(bus.waiterCount()).toBe(0)
    bus.dispose()
  })

  it('arming AFTER the event still sees it through the buffer (consume-once)', async () => {
    const bus = new TabEventBus()
    bus.push('download', { id: 3 })
    const armed = bus.arm('download', 1_000)
    await expect(armed.promise).resolves.toMatchObject({ payload: { id: 3 } })
    // The buffered event was consumed, so a second arm times out instead.
    vi.useFakeTimers()
    const second = bus.arm('download', 100)
    vi.advanceTimersByTime(150)
    await expect(second.promise).rejects.toMatchObject({ code: 'timeout' })
    bus.dispose()
  })
})

describe('TabEventBus: strict arm for `expect` (no pre-arm events)', () => {
  it('consumeBuffered:false ignores an event that arrived before the arm', async () => {
    const bus = new TabEventBus()
    vi.useFakeTimers()
    bus.push('popup', { tab: 'stale' })
    const armed = bus.arm('popup', 100, { consumeBuffered: false })
    bus.push('popup', { tab: 'from-action' })
    await expect(armed.promise).resolves.toMatchObject({ payload: { tab: 'from-action' } })
    // The stale event is still buffered for whoever drains it (receipt/preExisting).
    expect(bus.drain('popup')[0]?.payload).toEqual({ tab: 'stale' })
    bus.dispose()
  })

  it('the default arm still satisfies from the buffer (wait_for semantics)', async () => {
    const bus = new TabEventBus()
    bus.push('download', { id: 1 })
    const armed = bus.arm('download', 100)
    await expect(armed.promise).resolves.toMatchObject({ payload: { id: 1 } })
    bus.dispose()
  })
})

describe('TabEventBus: timer hygiene and edges', () => {
  it('clears the timer on settle, cancel and timeout', async () => {
    vi.useFakeTimers()
    const bus = new TabEventBus()
    const settled = bus.arm('popup', 1_000)
    bus.push('popup', { tab: 1 })
    await settled.promise
    expect(vi.getTimerCount()).toBe(0)
    const cancelled = bus.arm('popup', 1_000)
    cancelled.cancel()
    // A cancel REJECTS the arm promise: it must be observed or it becomes an
    // unhandled rejection (CI exit 1 — the P0 this test caused).
    await expect(cancelled.promise).rejects.toMatchObject({ code: 'interrupted' })
    expect(vi.getTimerCount()).toBe(0)
    const timedOut = bus.arm('dialog', 50)
    vi.advanceTimersByTime(60)
    await expect(timedOut.promise).rejects.toMatchObject({ code: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
    bus.dispose()
  })

  it('a disposed bus ignores pushes instead of growing forever', () => {
    const bus = new TabEventBus(2)
    bus.dispose()
    bus.push('popup', { tab: 1 })
    expect(bus.size).toBe(0)
  })

  it('clamps a non-positive timeout to 1ms instead of hanging forever', async () => {
    vi.useFakeTimers()
    const bus = new TabEventBus()
    const armed = bus.arm('dialog', 0)
    vi.advanceTimersByTime(2)
    await expect(armed.promise).rejects.toMatchObject({ code: 'timeout' })
    bus.dispose()
  })
})

describe('TabEventBus: consume-once and FIFO', () => {
  it('one event wakes exactly one waiter', async () => {
    const bus = new TabEventBus()
    const first = bus.arm('popup', 1_000)
    const second = bus.arm('popup', 1_000)
    bus.push('popup', { tab: 1 })
    await expect(first.promise).resolves.toMatchObject({ payload: { tab: 1 } })
    expect(bus.waiterCount('popup')).toBe(1)
    bus.push('popup', { tab: 2 })
    await expect(second.promise).resolves.toMatchObject({ payload: { tab: 2 } })
    bus.dispose()
  })

  it('waiters are served in arm order', async () => {
    const bus = new TabEventBus()
    const order: string[] = []
    const first = bus.arm('dialog', 1_000)
    const second = bus.arm('dialog', 1_000)
    void first.promise.then(() => order.push('first'))
    void second.promise.then(() => order.push('second'))
    bus.push('dialog', { message: 'a' })
    bus.push('dialog', { message: 'b' })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['first', 'second'])
    bus.dispose()
  })

  it('a different kind never satisfies a waiter', async () => {
    const bus = new TabEventBus()
    vi.useFakeTimers()
    const armed = bus.arm('file-chooser', 50)
    bus.push('popup', { tab: 1 })
    vi.advanceTimersByTime(60)
    await expect(armed.promise).rejects.toMatchObject({ code: 'timeout' })
    // The popup is still buffered for its own consumer.
    expect(bus.drain('popup')).toHaveLength(1)
    bus.dispose()
  })
})

describe('TabEventBus: cancel-on-every-path', () => {
  it('timeout removes the waiter so the next event is not eaten', async () => {
    const bus = new TabEventBus()
    vi.useFakeTimers()
    const armed = bus.arm('popup', 100)
    vi.advanceTimersByTime(150)
    await expect(armed.promise).rejects.toBeInstanceOf(BrowserError)
    expect(bus.waiterCount('popup')).toBe(0)
    // A later event must buffer, not vanish into the dead waiter.
    bus.push('popup', { tab: 9 })
    expect(bus.drain('popup')[0]?.payload).toEqual({ tab: 9 })
    bus.dispose()
  })

  it('explicit cancel is idempotent and settles with interrupted', async () => {
    const bus = new TabEventBus()
    const armed = bus.arm('dialog', 1_000)
    armed.cancel()
    armed.cancel()
    await expect(armed.promise).rejects.toMatchObject({ code: 'interrupted' })
    expect(bus.waiterCount()).toBe(0)
    bus.dispose()
  })
})

describe('TabEventBus: bounded buffer + drain', () => {
  it('drops the oldest event past the cap and counts it', () => {
    const bus = new TabEventBus(3)
    for (let index = 0; index < 5; index += 1) bus.push('download', { id: index })
    expect(bus.size).toBe(3)
    expect(bus.dropped).toBe(2)
    const drained = bus.drain('download')
    expect(drained.map(event => (event.payload as { id: number }).id)).toEqual([2, 3, 4])
    // drain is take-once.
    expect(bus.drain('download')).toEqual([])
    bus.dispose()
  })

  it('drain with no kind returns everything and clears', () => {
    const bus = new TabEventBus()
    bus.push('popup', { tab: 1 })
    bus.push('dialog', { message: 'm' })
    expect(bus.drain()).toHaveLength(2)
    expect(bus.size).toBe(0)
    bus.dispose()
  })

  it('the default cap is the documented constant', () => {
    const bus = new TabEventBus()
    for (let index = 0; index <= TAB_EVENT_BUFFER_LIMIT; index += 1) bus.push('download', { id: index })
    expect(bus.size).toBe(TAB_EVENT_BUFFER_LIMIT)
    expect(bus.dropped).toBe(1)
    bus.dispose()
  })
})

describe('TabEventBus: isolation + dispose', () => {
  it('two buses never share events (per-tab isolation)', async () => {
    const a = new TabEventBus()
    const b = new TabEventBus()
    const armedA = a.arm('popup', 1_000)
    b.push('popup', { tab: 'b' })
    a.push('popup', { tab: 'a' })
    await expect(armedA.promise).resolves.toMatchObject({ payload: { tab: 'a' } })
    expect(b.drain('popup')[0]?.payload).toEqual({ tab: 'b' })
    a.dispose()
    b.dispose()
  })

  it('dispose rejects every waiter and refuses new arms', async () => {
    const bus = new TabEventBus()
    const armed = bus.arm('dialog', 1_000)
    bus.dispose()
    await expect(armed.promise).rejects.toMatchObject({ code: 'interrupted' })
    const late = bus.arm('dialog', 1_000)
    await expect(late.promise).rejects.toMatchObject({ code: 'interrupted' })
  })
})
