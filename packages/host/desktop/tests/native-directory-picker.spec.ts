import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { adoptElectronDirectoryChooser } from '../src/native-directory-picker.ts'

/**
 * 一个只实现 `ctx.inject` + 注入 scope 两样东西的最小宿主替身；macOS 接管逻辑
 * 只用这两样（真实 cordis 会在 `directoryPicker` 就绪后回调）。
 */
function fakeHost(capability: DirectoryPickerCapability) {
  const disposers: Array<() => void> = []
  const deps: string[][] = []
  const ctx = {
    inject: (injected: string[], callback: (scope: unknown) => void) => {
      deps.push(injected)
      callback({
        directoryPicker: { capability: () => capability },
        effect: (register: () => unknown) => {
          const dispose = register()
          if (typeof dispose === 'function') disposers.push(dispose as () => void)
          return dispose
        },
      })
    },
  }
  return { ctx: ctx as unknown as Context, disposers, deps }
}

/** 上游 native 实现替身：默认返回固定路径，便于断言「有没有被换掉」。 */
function nativeCapability(): {
  kind: 'native'
  pick: ReturnType<typeof vi.fn<(signal: AbortSignal) => Promise<string | null>>>
} {
  return {
    kind: 'native',
    pick: vi.fn(async (_signal: AbortSignal): Promise<string | null> => '/upstream'),
  }
}

describe('macOS Electron directory chooser adoption', () => {
  it('replaces the native pick with the desktop chooser', async () => {
    const capability = nativeCapability()
    const host = fakeHost(capability)
    const choose = vi.fn(async () => '/Users/example/Work')

    adoptElectronDirectoryChooser(host.ctx, choose)

    expect(host.deps).toEqual([['directoryPicker']])
    await expect(capability.pick(new AbortController().signal)).resolves.toBe('/Users/example/Work')
    expect(choose).toHaveBeenCalledOnce()
  })

  it('does not open a chooser for an already-aborted caller', async () => {
    const capability = nativeCapability()
    const host = fakeHost(capability)
    const choose = vi.fn(async () => '/Users/example/Work')
    adoptElectronDirectoryChooser(host.ctx, choose)
    const controller = new AbortController()
    controller.abort()

    await expect(capability.pick(controller.signal)).rejects.toThrow('aborted')
    expect(choose).not.toHaveBeenCalled()
  })

  it('leaves a browse backend untouched', () => {
    const capability: DirectoryPickerCapability = {
      kind: 'browse',
      list: async () => ({ path: '/', home: '/', crumbs: [], entries: [], truncated: false }),
      createDirectory: async () => '/',
    }
    const host = fakeHost(capability)
    const choose = vi.fn(async () => '/Users/example/Work')

    adoptElectronDirectoryChooser(host.ctx, choose)

    expect(host.disposers).toHaveLength(0)
    expect(capability.kind).toBe('browse')
  })

  it('restores the upstream pick when the composition is disposed', () => {
    const upstream = async (_signal: AbortSignal): Promise<string | null> => '/upstream'
    const capability = { kind: 'native' as const, pick: upstream }
    const host = fakeHost(capability)
    adoptElectronDirectoryChooser(host.ctx, async () => '/Users/example/Work')

    expect(host.disposers).toHaveLength(1)
    host.disposers[0]!()

    expect(capability.pick).toBe(upstream)
  })

  it('does not clobber a picker another owner installed later', () => {
    const capability = {
      kind: 'native' as const,
      pick: (async (_signal: AbortSignal): Promise<string | null> => '/upstream') as (
        signal: AbortSignal,
      ) => Promise<string | null>,
    }
    const host = fakeHost(capability)
    adoptElectronDirectoryChooser(host.ctx, async () => '/Users/example/Work')
    const later = async (_signal: AbortSignal): Promise<string | null> => '/later'
    capability.pick = later

    host.disposers[0]!()

    expect(capability.pick).toBe(later)
  })
})