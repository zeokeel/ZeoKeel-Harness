import { describe, expect, it } from 'vitest'
import { locatorProbe, parseTargetSpec } from '../src/locator.ts'
import { BrowserError } from '../src/errors.ts'

/** Assert a malformed target is rejected with the 'policy' code. */
function expectPolicyError(raw: string): void {
  let thrown: unknown
  try {
    parseTargetSpec(raw)
  } catch (error) {
    thrown = error
  }
  expect(thrown, `expected policy rejection for ${JSON.stringify(raw)}`).toBeInstanceOf(BrowserError)
  expect((thrown as BrowserError).code).toBe('policy')
}

describe('parseTargetSpec: accepted forms', () => {
  it('snapshot index spellings', () => {
    expect(parseTargetSpec('12')).toEqual({ kind: 'css', selector: '12' })
    expect(parseTargetSpec('@12')).toEqual({ kind: 'index', index: 12 })
    expect(parseTargetSpec('ref=3')).toEqual({ kind: 'index', index: 3 })
    expect(parseTargetSpec('  @7  ')).toEqual({ kind: 'index', index: 7 })
  })

  it('css spellings (bare and prefixed)', () => {
    expect(parseTargetSpec('#main > a')).toEqual({ kind: 'css', selector: '#main > a' })
    expect(parseTargetSpec('css=.btn-primary')).toEqual({ kind: 'css', selector: '.btn-primary' })
    expect(parseTargetSpec('loc=css:a[href]')).toEqual({ kind: 'css', selector: 'a[href]' })
    // A bare "12" stays a CSS selector (an id); only @/ref= select the snapshot.
    expect(parseTargetSpec('input[name="email"]')).toEqual({ kind: 'css', selector: 'input[name="email"]' })
  })

  it('text spellings (quoted = exact, unquoted = normalized substring)', () => {
    expect(parseTargetSpec('text=Sign in')).toEqual({ kind: 'text', text: 'Sign in', exact: false })
    expect(parseTargetSpec('text="Sign in"')).toEqual({ kind: 'text', text: 'Sign in', exact: true })
    expect(parseTargetSpec("text='Sign in'")).toEqual({ kind: 'text', text: 'Sign in', exact: true })
    expect(parseTargetSpec('text=  Save  ')).toEqual({ kind: 'text', text: 'Save', exact: false })
    // A quote only counts when it wraps the whole value.
    expect(parseTargetSpec('text=Save "draft"')).toEqual({ kind: 'text', text: 'Save "draft"', exact: false })
  })

  it('role spellings (with and without an accessible name)', () => {
    expect(parseTargetSpec('role=button')).toEqual({ kind: 'role', role: 'button', name: undefined, nameExact: true })
    expect(parseTargetSpec('role=button[name="Sign in"]')).toEqual({ kind: 'role', role: 'button', name: 'Sign in', nameExact: true })
    expect(parseTargetSpec('role=button[name*="Sign"]')).toEqual({ kind: 'role', role: 'button', name: 'Sign', nameExact: false })
    expect(parseTargetSpec('loc=role:link[name="Docs"]')).toEqual({ kind: 'role', role: 'link', name: 'Docs', nameExact: true })
    expect(parseTargetSpec('role=checkbox[name=Remember]')).toEqual({ kind: 'role', role: 'checkbox', name: 'Remember', nameExact: false })
  })

  it('href and xpath spellings', () => {
    expect(parseTargetSpec('loc=href:/checkout')).toEqual({ kind: 'href', needle: '/checkout' })
    expect(parseTargetSpec('loc=href:"/checkout?x=1"')).toEqual({ kind: 'href', needle: '/checkout?x=1' })
    expect(parseTargetSpec('xpath=//button[1]')).toEqual({ kind: 'xpath', expression: '//button[1]' })
  })
})

describe('parseTargetSpec: malformed targets fail loud', () => {
  it('rejects empty and nameless forms', () => {
    expectPolicyError('')
    expectPolicyError('   ')
    expectPolicyError('text=')
    expectPolicyError('text=""')
    expectPolicyError('role=')
    expectPolicyError('loc=')
    expectPolicyError('loc=href:')
    expectPolicyError('css=')
  })

  it('rejects unknown locator kinds and malformed role filters', () => {
    expectPolicyError('loc=foo:bar')
    expectPolicyError('role=button[name]')
    expectPolicyError('role=button[wrong="x"]')
  })

  it('rejects a zero or negative ref', () => {
    expectPolicyError('@0')
    expectPolicyError('ref=0')
  })
})

describe('locatorProbe', () => {
  it('embeds the parsed spec as JSON and returns a self-contained expression', () => {
    const probe = locatorProbe({ kind: 'text', text: 'Sign "in"', exact: true })
    expect(probe.startsWith('(() => {')).toBe(true)
    expect(probe).toContain('"kind":"text"')
    expect(probe).toContain('Sign \\"in\\"')
    // No template placeholder may survive into the page.
    expect(probe).not.toContain('__SPEC__')
  })

  it('supports role and xpath probes', () => {
    expect(locatorProbe({ kind: 'role', role: 'button', name: 'Sign in', nameExact: true })).toContain('"kind":"role"')
    expect(locatorProbe({ kind: 'xpath', expression: '//a' })).toContain('"kind":"xpath"')
  })

  it('refuses css/index (they never need a probe)', () => {
    expect(() => locatorProbe({ kind: 'css', selector: '#a' })).toThrow(/locatorProbe/u)
    expect(() => locatorProbe({ kind: 'index', index: 1 })).toThrow(/locatorProbe/u)
  })
})

describe('shadow-piercing selectors（2026-10-23 C16 P2）', () => {
  it('keeps a bare >>> selector as CSS (resolved by the action, not the probe)', () => {
    expect(parseTargetSpec('#host >>> button')).toEqual({ kind: 'css', selector: '#host >>> button' })
    expect(parseTargetSpec('css=my-card >>> button')).toEqual({ kind: 'css', selector: 'my-card >>> button' })
  })
})
