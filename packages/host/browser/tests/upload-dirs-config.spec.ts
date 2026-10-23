/**
 * Deployment config for upload dirs (2026-10-23 A11): the operator-facing Config
 * must carry the list (default empty) so the runtime option is reachable.
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('Config.uploadDirs', () => {
  it('defaults to an empty list and accepts configured directories', () => {
    const empty = Config({}) as { uploadDirs: string[] }
    expect(empty.uploadDirs).toEqual([])
    const configured = Config({ uploadDirs: ['/tmp/vetted'] }) as { uploadDirs: string[] }
    expect(configured.uploadDirs).toEqual(['/tmp/vetted'])
  })
})
