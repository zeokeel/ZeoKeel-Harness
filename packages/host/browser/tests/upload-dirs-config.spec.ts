/**
 * Deployment config for upload dirs (2026-10-23 A11): the operator-facing Config
 * must carry the list (default empty) so the runtime option is reachable.
 */
import { describe, expect, it } from 'vitest'
import { Config, createAttachmentStoreAdapter, createBrowserRuntimeFor, runtimeOptionsForConfig, uploadDirsForRuntime } from '../src/index.ts'
import { DEFAULT_GROUPS, applyBrowserTools } from '../src/tools.ts'
import { BrowserRuntime } from '../src/runtime.ts'

describe('Config.uploadDirs', () => {
  it('defaults to an empty list and accepts configured directories', () => {
    const empty = Config({}) as { uploadDirs: string[] }
    expect(empty.uploadDirs).toEqual([])
    const configured = Config({ uploadDirs: ['/tmp/vetted'] }) as { uploadDirs: string[] }
    expect(configured.uploadDirs).toEqual(['/tmp/vetted'])
  })

  it('turns parsed config into runtime options (absolute dirs only, deduped later)', () => {
    const parsed = Config({ uploadDirs: ['/tmp/vetted', '', '/', 'relative/dir'] }) as { uploadDirs: string[] }
    expect(uploadDirsForRuntime(parsed)).toEqual(['/tmp/vetted'])
  })

  it('the converted list survives into the runtime options', () => {
    const parsed = Config({ uploadDirs: ['/tmp/vetted', 'relative/dir'] }) as { uploadDirs: string[] }
    const runtime = new BrowserRuntime({} as never, { uploadDirs: uploadDirsForRuntime(parsed) } as never, undefined, 'persist:test-upload-dirs', {})
    expect(runtime.options.uploadDirs).toEqual(['/tmp/vetted'])
    runtime.dispose()
  })

  it('operator config reaches the runtime options end to end (Config -> options -> runtime)', () => {
    const parsed = Config({ uploadDirs: ['/tmp/vetted', 'relative/dir'], maxTabs: 7 }) as Record<string, unknown>
    const options = runtimeOptionsForConfig(parsed, undefined)
    const runtime = new BrowserRuntime({} as never, options as never, undefined, 'persist:test-config-fixture', {})
    expect(runtime.options.uploadDirs).toEqual(['/tmp/vetted'])
    expect(runtime.options.maxTabs).toBe(7)
    expect(String(runtime.options.downloadDir)).toContain('downloads')
    runtime.dispose()
  })

  it('attachment adapter turns base64 into an opaque reference', async () => {
    const saved: Array<{ bytes: number, mediaType: string, name?: string }> = []
    const adapter = createAttachmentStoreAdapter({
      saveImages: async (inputs) => {
        for (const input of inputs) saved.push({ bytes: input.data.length, mediaType: input.mediaType as unknown as string, ...(input.name === undefined ? {} : { name: input.name }) })
        return [{ attachmentId: 'abc123' }]
      },
    })
    const ref = await adapter.store('data:image/png;base64,QUJD', { fileName: 'shot.png', mimeType: 'image/png' })
    expect(ref).toBe('attachment:abc123')
    expect(ref).not.toContain('base64')
    expect(saved[0]).toMatchObject({ bytes: 3, mediaType: 'image/png', name: 'shot.png' })
  })

  it('attachment adapter rejects non-data-url payloads', async () => {
    const adapter = createAttachmentStoreAdapter({ saveImages: async () => [{ attachmentId: 'x' }] })
    const meta = { fileName: 'shot.png', mimeType: 'image/png' }
    await expect(adapter.store('https://a.example/x.png', meta)).rejects.toThrow(/base64 data URL/u)
    await expect(adapter.store('data:image/png,QUJD', meta)).rejects.toThrow(/base64 data URL/u)
    await expect(adapter.store('data:image/png;base64,', meta)).rejects.toThrow(/base64 data URL/u)
    await expect(adapter.store('data:image/png;base64,@@@', meta)).rejects.toThrow(/base64 data URL/u)
  })

  it('runtime factory (the apply path) carries config and fail-louds without a program runtime', async () => {
    const runtime = createBrowserRuntimeFor({} as never, Config({ uploadDirs: ['/tmp/vetted', 'relative/dir', '/'], maxTabs: 5 }) as never, '/tmp/userdata', { partition: 'persist:test-factory', deps: {} })
    // Distinguishing inputs: raw spread would keep relative/dir and '/', and the
    // downloads fallback would not be applied.
    expect(runtime.options.uploadDirs).toEqual(['/tmp/vetted'])
    expect(runtime.options.maxTabs).toBe(5)
    expect(String(runtime.options.downloadDir)).toContain('downloads')
    // Opt-in flag defaults to false through the same path.
    expect(runtime.options.programEnabled).toBe(false)
    // No programRuntime injected -> programming mode is unavailable (fail loud),
    // and the tool would not be registered (covered in the registration tests).
    await expect(runtime.runProgram('1')).rejects.toMatchObject({ code: 'policy' })
    runtime.dispose()
  })

  it('Config defaults keep programming mode off', () => {
    const options = runtimeOptionsForConfig(Config({}) as never, undefined) as Record<string, unknown>
    expect(options['programEnabled']).toBe(false)
    expect(options['uploadDirs']).toEqual([])
  })

  it('program mode needs the runtime AND the opt-in; missing attachments fail loud', async () => {
    const fakeProgram = { execute: async (_program: string, bridge: Readonly<Record<string, (...args: never[]) => Promise<unknown>>>) => {
      await (bridge['screenshot'] as unknown as (args: unknown) => Promise<unknown>)({})
      return { result: null }
    } }
    const enabled = createBrowserRuntimeFor({} as never, Config({ programEnabled: true }) as never, undefined, { partition: 'persist:test-program-on', deps: { programRuntime: fakeProgram } })
    expect(enabled.options.programEnabled).toBe(true)
    // No attachments injected -> the screenshot helper refuses with policy.
    const message = await enabled.runProgram('x').then(() => '', (error: unknown) => (error as Error).message)
    expect(message).toContain('attachment store')
    enabled.dispose()
  })

  it('assembly-level: programEnabled registers exactly one extra tool (browser_run)', () => {
    const namesFor = (config: Record<string, unknown>, deps: Record<string, unknown>): string[] => {
      const runtime = createBrowserRuntimeFor({} as never, Config(config) as never, undefined, { partition: 'persist:test-tools', deps })
      const names: string[] = []
      const ctx = {
        tools: { register: (definition: { name: string }) => { names.push(definition.name); return () => {} } },
        systemPrompt: { section: () => () => {} },
      }
      const groups = new Set([...DEFAULT_GROUPS, 'script'])
      applyBrowserTools(ctx as never, runtime, groups)
      runtime.dispose()
      return names
    }
    const withoutProgram = namesFor({}, {})
    const withProgram = namesFor({ programEnabled: true }, { programRuntime: { execute: async () => ({ result: null }) } })
    // Third form pins the OPT-IN gate itself: a runtime injected but the flag
    // false must NOT register the tool (removing the && gate turns this red).
    const runtimeButOff = namesFor({ programEnabled: false }, { programRuntime: { execute: async () => ({ result: null }) } })
    expect(withoutProgram).not.toContain('browser_run')
    expect(runtimeButOff).not.toContain('browser_run')
    expect(runtimeButOff).toHaveLength(withoutProgram.length)
    expect(withProgram).toContain('browser_run')
    expect(withProgram.length).toBe(withoutProgram.length + 1)
  })
})
