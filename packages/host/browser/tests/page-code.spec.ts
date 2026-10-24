/**
 * Page-literal escaping (2026-10-24, CodeQL js/bad-code-sanitization follow-up):
 * selectors are embedded into page scripts, so the serialized literal must not be
 * able to terminate its string or smuggle a script terminator.
 */
import { describe, expect, it } from 'vitest'
import { escapeUnsafeChars, jsonForPage } from '../src/page-code.ts'

describe('page literals', () => {
  it('escapes script terminators, quotes-adjacent control chars and U+2028/9', () => {
    expect(escapeUnsafeChars('</script>')).toBe('\\u003C/script\\u003E')
    expect(escapeUnsafeChars('a\nb\tc')).toBe('a\\nb\\tc')
    expect(escapeUnsafeChars('x\u2028y\u2029z')).toBe('x\\u2028y\\u2029z')
    expect(escapeUnsafeChars('plain selectors stay readable')).toBe('plain selectors stay readable')
  })

  it('serializes a selector to a safe JS literal', () => {
    expect(jsonForPage('#a')).toBe(JSON.stringify('#a'))
    const literal = jsonForPage('div[title="</script>"]')
    expect(literal).not.toContain('</script>')
    expect(literal.startsWith('"')).toBe(true)
    expect(JSON.parse(literal.replace(/\\u003C/g, '<').replace(/\\u003E/g, '>'))).toBe('div[title="</script>"]')
  })
})
