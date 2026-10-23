/**
 * Deployment config for upload dirs (2026-10-23 A11): the operator-facing Config
 * must carry the list (default empty) so the runtime option is reachable.
 */
import { describe, expect, it } from 'vitest'
import { Config, runtimeOptionsForConfig, uploadDirsForRuntime } from '../src/index.ts'
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
})
