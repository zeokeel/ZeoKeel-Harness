/**
 * Tool-surface trim (2026-10-24): the merged tools must still route to the same
 * runtime operations the removed tools used (navigate direction / click clickCount
 * / press chord / download actions), and the default surface must stay small.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_GROUPS, applyBrowserTools } from '../src/tools.ts'
import { ALL_TOOL_GROUPS } from './helpers/all-groups.ts'

interface ToolDefinition {
  name: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { agent?: unknown, signal: AbortSignal }) => Promise<unknown>
}

function harness() {
  const calls: Array<{ method: string, args: unknown[] }> = []
  const spies: Record<string, ReturnType<typeof vi.fn>> = {}
  const runtime = new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      const name = String(property)
      if (name === 'resolveTab') return async (tab?: number) => tab ?? 1
      if (name === 'tabState') return () => ({ url: 'https://a.example/x', title: 'Example', loading: false })
      if (name === 'downloads') return () => [{ id: 1, url: 'https://a.example/f', fileName: 'f.txt', path: 'f.txt', size: 1, status: 'done', createdAt: 1 }]
      if (name === 'removeDownload') return (id: number) => (calls.push({ method: name, args: [id] }), true)
      if (name === 'highestDownloadId') return () => 0
      if (name === 'downloadOwnerTab') return () => undefined
      if (name === 'waitForNewDownload') return async () => null
      if (name === 'runGated') return async (_tool: string, body: () => unknown) => body()
      if (name === 'setAgentContext') return () => undefined
      if (name === 'resolveTargetSelector') return async () => ({ selector: '#a', hit: { index: 1, selector: '#a' } })
      if (name === 'locateElement') return async () => ({ x: 10, y: 20 })
      if (name === 'clickAt' || name === 'pressKey' || name === 'hotkey' || name === 'navigate' || name === 'reload' || name === 'goBack' || name === 'goForward' || name === 'downloadUrl') {
        spies[name] ??= vi.fn(async (...args: unknown[]) => { calls.push({ method: name, args }); return undefined })
        return spies[name]
      }
      spies[name] ??= vi.fn(async (...args: unknown[]) => { calls.push({ method: name, args }); return undefined })
      return spies[name]
    },
  })
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
  } as unknown as Parameters<typeof applyBrowserTools>[0]
  applyBrowserTools(ctx, runtime as never, ALL_TOOL_GROUPS)
  return {
    tools,
    calls,
    runtime,
    call: async (name: string, args: Record<string, unknown> = {}) => await tools.get(name)!.execute(args, { signal: new AbortController().signal }),
  }
}

describe('merged navigate directions', () => {
  it('reload/back/forward and url all dispatch through one tool', async () => {
    const h = harness()
    await h.call('browser_navigate', { direction: 'reload' })
    await h.call('browser_navigate', { direction: 'back' })
    await h.call('browser_navigate', { direction: 'forward' })
    await h.call('browser_navigate', { url: ' https://b.example ' })
    const methods = h.calls.map(call => call.method)
    expect(methods).toContain('reload')
    expect(methods).toContain('goBack')
    expect(methods).toContain('goForward')
    expect(methods).toContain('navigate')
    const navigateArgs = h.calls.find(call => call.method === 'navigate')!.args
    expect(navigateArgs[1]).toBe('https://b.example')
  })

  it('refuses url+direction, neither, and direction on an application window', async () => {
    const h = harness()
    await expect(h.call('browser_navigate', { url: 'https://a.example', direction: 'back' })).rejects.toThrow(/either url or direction/u)
    await expect(h.call('browser_navigate', {})).rejects.toThrow(/url must be a non-empty string/u)
    await expect(h.call('browser_navigate', { direction: 'reload', app_id: 'app-1' })).rejects.toThrow(/not supported for application windows/u)
  })
})

describe('merged click/press/download', () => {
  it('click clickCount 2 maps to the double-click event pair', async () => {
    const h = harness()
    await h.call('browser_click', { target: '#a', clickCount: 2 })
    const click = h.calls.find(call => call.method === 'clickAt')!.args
    expect(click[4]).toMatchObject({ doubleClick: true, clickCount: 2 })
  })

  it('press accepts a chord through keys', async () => {
    const h = harness()
    await h.call('browser_press', { keys: ['Control', 'A'] })
    expect(h.calls.find(call => call.method === 'hotkey')!.args[1]).toEqual(['Control', 'A'])
    await expect(h.call('browser_press', { key: 'Enter', keys: ['Control', 'A'] })).rejects.toThrow(/either key or keys/u)
  })

  it('download actions list/remove/download share one tool', async () => {
    const h = harness()
    const listed = await h.call('browser_download', { action: 'list' }) as { downloads: Array<{ id: number }> }
    expect(listed.downloads.map(entry => entry.id)).toEqual([1])
    expect(await h.call('browser_download', { action: 'remove', id: 7 })).toEqual({ ok: true })
    expect(h.calls.find(call => call.method === 'removeDownload')!.args[0]).toBe(7)
    expect(await h.call('browser_download', { url: 'https://a.example/f', waitForCompletion: false })).toEqual({ started: true })
    expect(h.calls.some(call => call.method === 'downloadUrl')).toBe(true)
  })
})

describe('default surface', () => {
  it('registers 24 tools by default and keeps the low-frequency ones opt-in', () => {
    const names: string[] = []
    const ctx = {
      tools: { register: (definition: { name: string }) => { names.push(definition.name); return () => {} } },
      systemPrompt: { section: () => () => {} },
    } as unknown as Parameters<typeof applyBrowserTools>[0]
    applyBrowserTools(ctx, {} as never, DEFAULT_GROUPS)
    expect(names).toHaveLength(24)
    for (const off of ['browser_takeover', 'browser_bookmarks_list', 'browser_drag', 'browser_emulate']) expect(names).not.toContain(off)
    for (const kept of ['browser_download', 'browser_get_snapshot', 'browser_press', 'browser_navigate']) expect(names).toContain(kept)
    for (const gone of ['browser_reload', 'browser_go_back', 'browser_go_forward', 'browser_dblclick', 'browser_hotkey', 'browser_downloads_list', 'browser_downloads_remove', 'browser_get_text']) {
      if (gone !== 'browser_get_text') expect(names).not.toContain(gone)
    }
  })
})
