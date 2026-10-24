/**
 * Page-literal escaping (2026-10-24, CodeQL js/bad-code-sanitization follow-up):
 * selectors are embedded into page scripts, so the serialized literal must not be
 * able to terminate its string or smuggle a script terminator.
 */
import { describe, expect, it } from 'vitest'
import { jsonForPage } from '../src/page-code.ts'

describe('page literals', () => {
  it('escapes terminators, quotes, backslashes and line separators', () => {
    expect(jsonForPage('</script>')).toBe('"\\u003C\\u002Fscript\\u003E"')
    expect(jsonForPage('a"b')).toBe('"a\\u0022b"')
    expect(jsonForPage('a\\b')).toBe('"a\\u005cb"')
    expect(jsonForPage('a\nb')).toBe('"a\\u000ab"')
    expect(jsonForPage('x\u2028y')).toBe('"x\\u2028y"')
    expect(jsonForPage('plain selectors stay readable')).toBe('"plain selectors stay readable"')
    expect(jsonForPage('#a.b > c')).toBe('"#a.b \\u003E c"')
  })

  it('round-trips arbitrary values through a JS literal parse', () => {
    for (const value of ['#a', 'div[title="</script>"]', 'a\\b', 'x\u2028y', '${danger}', '`tick`']) {
      // JSON.parse accepts the literal; JSON is a subset of JS literal syntax here.
      expect(JSON.parse(jsonForPage(value))).toBe(value)
    }
  })
})
