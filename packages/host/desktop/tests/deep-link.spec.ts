/** Strict `zeokeel://` deep-link gate (audit 2026-09-08 P2-62). */
import { describe, expect, it } from 'vitest'
import { parseDesktopDeepLink } from '../src/deep-link.ts'

describe('parseDesktopDeepLink', () => {
  it('accepts the allow-listed auth callback forms', () => {
    expect(parseDesktopDeepLink('zeokeel://auth?token=t&server=https%3A%2F%2Fgw.example.com')).toEqual({
      action: 'auth',
      url: 'zeokeel://auth?token=t&server=https%3A%2F%2Fgw.example.com',
    })
    // Path-only spellings parse to the same action.
    expect(parseDesktopDeepLink('zeokeel:/auth?token=t')?.action).toBe('auth')
    expect(parseDesktopDeepLink('zeokeel:///auth?token=t')?.action).toBe('auth')
    expect(parseDesktopDeepLink('ZEOKEEL://AUTH?token=t')?.action).toBe('auth')
  })

  it('rejects unknown actions, wrong schemes and malformed input', () => {
    for (const raw of [
      'zeokeel://evil?token=t',
      'zeokeel://auth.evil.example?token=t',
      'https://auth?token=t',
      'zeokeel:',
      'zeokeel://',
      'not a url',
      '',
      'x'.repeat(5000),
    ]) {
      expect(parseDesktopDeepLink(raw), raw).toBeNull()
    }
    expect(parseDesktopDeepLink(undefined)).toBeNull()
    expect(parseDesktopDeepLink(42)).toBeNull()
    expect(parseDesktopDeepLink({ toString: () => 'zeokeel://auth?token=t' })).toBeNull()
  })

  it('drops extra path segments and query values it does not understand', () => {
    // The action stays allow-listed; the enterprise parser still validates the
    // token/server fields it needs.
    expect(parseDesktopDeepLink('zeokeel://auth/cb?token=t')?.action).toBe('auth')
  })

  it('accepts the app share link and keeps the app id for the host consumer', () => {
    // 2026-09-19 契约 §4.5：可分享形态 = `<scheme>://app/<app_id>`。闸门只判
    // action；app_id 的合法性由 `@zeokeel/dsh-wasm-apps-host` 的第二道严格
    // 解析负责（未知 app_id 由平台 404 + 可读错误页呈现）。
    expect(parseDesktopDeepLink('zeokeel://app/my-notes')).toEqual({
      action: 'app',
      url: 'zeokeel://app/my-notes',
    })
    expect(parseDesktopDeepLink('zeokeel:/app/my-notes')?.action).toBe('app')
    expect(parseDesktopDeepLink('acmeai://app/my-notes', 'acmeai')?.action).toBe('app')
    // 渠道 scheme 仍然严格：别的安装的 scheme 一律丢弃。
    expect(parseDesktopDeepLink('acmeai://app/my-notes')).toBeNull()
  })
})
