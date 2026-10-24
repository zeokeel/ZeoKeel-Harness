import { describe, expect, it } from 'vitest'
import {
  EVAL_HELPERS,
  MAX_EVAL_PROGRAM,
  MAX_EVAL_RESULT_BYTES,
  maskEvalResult,
  serializeEvalResult,
  validateEvalExpression,
  wrapEvalExpression,
} from '../src/eval-policy.ts'
import { BrowserError } from '../src/errors.ts'

/** Assert that a program is rejected with the 'eval-policy' error code. */
function expectEvalPolicyError(expression: string): void {
  let thrown: unknown
  try {
    validateEvalExpression(expression)
  } catch (e) {
    thrown = e
  }
  expect(thrown, `expected eval-policy rejection for: ${expression}`).toBeInstanceOf(BrowserError)
  expect((thrown as BrowserError).code).toBe('eval-policy')
}

describe('validateEvalExpression: accepted programs (2026-10-23 capability unlock)', () => {
  it.each([
    // plain reads
    '1 + 1',
    'window.__NEXT_DATA__',
    `readText('#a')`,
    `JSON.parse('{}')`,
    'getComputedStyle(document.body).width',
    `localStorage.getItem('t')`,
    `('a' + 'b').toUpperCase()`,
    '(x => x * 2)(21)',
    // statements / declarations / assignments — the old policy refused these
    'const a = 1; a + 1',
    'let x = 0; for (let i = 0; i < 3; i++) x += i; x',
    'if (document.title) { 1 } else { 2 }',
    'try { JSON.parse("x") } catch (e) { "bad" }',
    'const rows = [3, 1, 2]; rows.sort(); rows',
    'const xs = []; xs.push(1); xs.push(2); xs',
    'function twice(n) { return n * 2 } twice(21)',
    'return 42',
    // ordinary page work
    `document.querySelector('a').click()`,
    `document.querySelector('input').focus()`,
    `document.querySelector('#x').scrollIntoView()`,
    `document.querySelector('form').submit()`,
    `window.open('https://example.com')`,
    `alert(1)`,
    `x = 1`,
    `document.body.innerHTML = 'x'`,
    `Object.defineProperty(window, 'x', { value: 1 })`,
    `setTimeout(() => 1, 10)`,
    `window.close()`,
    // constructors (old policy refused every `new`)
    'new Date()',
    'new Map()',
    'new XMLHttpRequest()',
    'new WebSocket("wss://example.com")',
  ])('accepts %s', (expression) => {
    expect(() => validateEvalExpression(expression)).not.toThrow()
  })

  it('accepts declarations without initializers and for-of/for-in heads (2026-10-23 audit P0 regression)', () => {
    for (const program of [
      'let x; x = 1',
      'var x; x = 2',
      'for (const el of document.querySelectorAll("a")) el.textContent',
      'for (let k in obj) k',
      'for (var i of [1]) i',
    ]) {
      expect(() => validateEvalExpression(program), program).not.toThrow()
    }
  })

  it('accepts dynamic call targets (no more deny-by-default)', () => {
    for (const expression of [`window[key]('x')`, `(0, fetch)('https://example.com')`, `[fetch][0]('x')`, `(true ? fetch : fetch)('x')`]) {
      expect(() => validateEvalExpression(expression)).not.toThrow()
    }
  })

  it('accepts network-outbound APIs (product decision 2026-09-08)', () => {
    for (const expression of [
      `fetch('https://example.com')`,
      `fetch('https://example.com', { method: 'POST', body: 'x' })`,
      `navigator.sendBeacon('https://example.com', 'x')`,
      `fetch('https://example.com').then(r => r.text())`,
      `window.postMessage('x', '*')`,
    ]) {
      expect(() => validateEvalExpression(expression)).not.toThrow()
    }
  })
})

describe('validateEvalExpression: destructive surfaces stay refused', () => {
  it.each([
    // navigation
    `location.assign('https://example.com')`,
    `location.replace('https://example.com')`,
    `location.reload()`,
    `location.href = 'https://example.com'`,
    `window.location = 'https://example.com'`,
    `document.location.href = 'https://example.com'`,
    `location['assign']('https://example.com')`,
    `location['re' + 'place']('https://example.com')`,
    // history
    `history.pushState(null, '', '/x')`,
    `history.replaceState(null, '', '/x')`,
    `history.back()`,
    `history.forward()`,
    `history.go(-1)`,
    // document destruction
    `document.write('<h1>x</h1>')`,
    `document.writeln('x')`,
    `document.open()`,
    `document.close()`,
    `document['wr' + 'ite']('x')`,
    // page state the user owns
    `document.cookie = 'a=1'`,
    `cookieStore.set('a', 'b')`,
    `cookieStore.delete('a')`,
    `document['coo' + 'kie'] = 'a=1'`,
    `localStorage.setItem('a', 'b')`,
    `sessionStorage.setItem('a', 'b')`,
    `localStorage.removeItem('a')`,
    `sessionStorage.clear()`,
    `localStorage['set' + 'Item']('a', 'b')`,
    `localStorage.foo = 'x'`,
    // code execution
    `eval('1')`,
    `Function('return 1')()`,
    `new Function('return 1')`,
  ])('rejects %s', (expression) => {
    expectEvalPolicyError(expression)
  })

  it('rejects a destructive target reached through Reflect.apply', () => {
    expectEvalPolicyError(`Reflect.apply(localStorage['set'+'Item'], localStorage, ['k','v'])`)
    expectEvalPolicyError('Reflect.apply(document.write, document, ["x"])')
  })

  // 2026-10-23 batch 1 audit P0: the static walk must also see the indirect shapes.
  it('rejects bare location/history assignment (the unforgeable window setter)', () => {
    expectEvalPolicyError("location = '/x'")
    expectEvalPolicyError("history = null")
  })

  it('rejects call/apply/bind wrappers over a destructive member', () => {
    expectEvalPolicyError(`localStorage.setItem.call(localStorage, 'k', 'v')`)
    expectEvalPolicyError(`history.pushState.apply(history, [null, '', '/x'])`)
    expectEvalPolicyError(`document.write.bind(document)`)
    expectEvalPolicyError(`location.assign.bind(location)`)
  })

  it('rejects member-name code execution and constructor escapes', () => {
    expectEvalPolicyError(`window.eval('1')`)
    expectEvalPolicyError(`window['Function']('return 1')()`)
    expectEvalPolicyError(`[].constructor.constructor('return 1')()`)
  })

  it('rejects reflection/assign smuggling of a destructive host', () => {
    expectEvalPolicyError(`Object.assign(location, { href: 'https://example.com' })`)
    expectEvalPolicyError(`Object.defineProperty(localStorage, 'x', { value: 1 })`)
    expectEvalPolicyError(`Reflect.set(localStorage, 'k', 'v')`)
    expectEvalPolicyError(`Reflect.deleteProperty(history, 'state')`)
    expectEvalPolicyError(`Reflect.get(window, 'location').assign('https://example.com')`)
  })

  it('rejects a dynamically named member of a destructive host', () => {
    expectEvalPolicyError(`document[m]('x')`)
    expectEvalPolicyError(`localStorage[m]('k', 'v')`)
    expectEvalPolicyError(`document[m] = 'x'`)
  })

  it('rejects aliases bound to a destructive global (2026-10-23 batch1-fix audit P0-1)', () => {
    expectEvalPolicyError("const l = location; l.assign('https://example.com')")
    expectEvalPolicyError("const l = location; l.href = '#x'")
    expectEvalPolicyError("const h = history; h.go(-1)")
    expectEvalPolicyError("const s = localStorage; s.zzz = 'v'")
    expectEvalPolicyError("const s = localStorage; Object.assign(s, { a: 1 })")
    expectEvalPolicyError("const s = localStorage; Reflect.set(s, 'k', 'v')")
  })

  it('rejects document aliases for document writes (const d = document)', () => {
    expectEvalPolicyError("const d = document; d.cookie = 'a=1'")
    expectEvalPolicyError("const d = document; d.write('<h1>x</h1>')")
    expectEvalPolicyError("const d = document; d.defaultView.location.assign('https://example.com')")
    expect(() => validateEvalExpression('const d = document; d.querySelector("a").click()')).not.toThrow()
  })

  it('rejects a location setter fetched through a window alias', () => {
    expectEvalPolicyError("const w = window; Object.getOwnPropertyDescriptor(w, 'location').set.call(w, '#x')")
    expectEvalPolicyError("const d = document; d.defaultView.location.assign('https://example.com')")
  })

  it('rejects a location setter fetched through the property descriptor', () => {
    expectEvalPolicyError("Object.getOwnPropertyDescriptor(window, 'location').set.call(window, '#x')")
    expectEvalPolicyError("Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').set.call(document, 'a=1')")
  })

  it('does not mistake data fields named location/history for the globals', () => {
    expect(() => validateEvalExpression('r.location = { lat: 1, lng: 2 }; r')).not.toThrow()
    expect(() => validateEvalExpression('s.history = []')).not.toThrow()
    expect(() => validateEvalExpression('cfg.location.href')).not.toThrow()
    expect(() => validateEvalExpression('cfg.location.href = "/x"')).not.toThrow()
    expect(() => validateEvalExpression('o.location.assign = 2')).not.toThrow()
  })

  it('accepts harmless reflection', () => {
    expect(() => validateEvalExpression('Reflect.apply(Math.max, null, [1, 2, 3])')).not.toThrow()
    expect(() => validateEvalExpression('Reflect.get(obj, "title")')).not.toThrow()
    expect(() => validateEvalExpression('Reflect.construct(Date, [])')).not.toThrow()
  })

  it('documents the accepted AST-invisible alias honestly (runtime shim is the enforcement)', () => {
    // A reference a PAGE captured before the call (`window.__preboundWrite`) is
    // invisible to the static walk; only the page-side shim closes it (see
    // tests/eval-block-shim.spec.ts). The AST-visible spellings — `.bind(...)`,
    // aliasing `location` — are refused above.
    expect(() => validateEvalExpression(`window.__preboundWrite('x')`)).not.toThrow()
  })
})

describe('validateEvalExpression: structure and length bounds', () => {
  it('rejects an empty program', () => {
    expectEvalPolicyError('')
    expectEvalPolicyError('   ')
  })

  it('rejects a program longer than the max length', () => {
    expectEvalPolicyError('a'.repeat(MAX_EVAL_PROGRAM + 1))
  })

  it('accepts a program at the limit that parses', () => {
    expect(() => validateEvalExpression(`'${'a'.repeat(MAX_EVAL_PROGRAM - 2)}'`)).not.toThrow()
  })

  it('rejects a syntax error with a message that names the parse failure', () => {
    expectEvalPolicyError('function (')
  })
})

describe('wrapEvalExpression', () => {
  it('wraps the program in an async IIFE (top-level await support)', () => {
    const wrapped = wrapEvalExpression('readText("#a") + 1')
    expect(wrapped.startsWith('(async () => {')).toBe(true)
    expect(wrapped.endsWith('})()')).toBe(true)
    expect(wrapped).toContain('return (readText("#a") + 1);')
  })

  it('defines all read-only helpers (prefixed and aliased)', () => {
    const wrapped = wrapEvalExpression('1')
    for (const helper of EVAL_HELPERS) {
      expect(wrapped).toContain(helper)
    }
    expect(wrapped).toContain('__readText')
    expect(wrapped).toContain('__readAttr')
    expect(wrapped).toContain('__readJson')
    expect(wrapped).toContain('__readVar')
  })

  it('produces executable code for a pure expression', async () => {
    const wrapped = wrapEvalExpression('21 * 2')
    // eslint-disable-next-line no-new-func
    await expect(new Function(`return ${wrapped}`)()).resolves.toBe(42)
  })

  it('returns the value of the LAST expression of a multi-statement program', async () => {
    const wrapped = wrapEvalExpression('const a = 2; const b = 3; a * b')
    // eslint-disable-next-line no-new-func
    await expect(new Function(`return ${wrapped}`)()).resolves.toBe(6)
  })

  it('supports an explicit return and top-level await', async () => {
    // eslint-disable-next-line no-new-func
    const withReturn = new Function(`return ${wrapEvalExpression('return 7')}`)
    await expect(withReturn()).resolves.toBe(7)
    // eslint-disable-next-line no-new-func
    const withAwait = new Function(`return ${wrapEvalExpression('await Promise.resolve(9)')}`)
    await expect(withAwait()).resolves.toBe(9)
  })
})

describe('serializeEvalResult: secret masking', () => {
  it('masks credential-keyed values and whole-string credentials', () => {
    expect(serializeEvalResult({ token: 'abc-token-123' })).toBe('{"token":"****"}')
    expect(serializeEvalResult({ secret: 'verysecret' })).toBe('{"secret":"****"}')
    expect(serializeEvalResult({ password: 'hunter2secret' })).toBe('{"password":"****"}')
    expect(serializeEvalResult('Bearer abc.def.ghi')).toBe('"****"')
    expect(serializeEvalResult({ apiKey: 'api_key_12345' })).toBe('{"apiKey":"****"}')
    expect(serializeEvalResult({ sessionId: 'session-id-xyz' })).toBe('{"sessionId":"****"}')
  })

  it('keeps short secret-looking strings (length < 6) unmasked', () => {
    expect(serializeEvalResult('token')).toBe('"token"')
    expect(serializeEvalResult({ code: 'token' })).toBe('{"code":"token"}')
  })

  it('keeps ordinary values unchanged', () => {
    expect(serializeEvalResult({ name: 'Alice', age: 1 })).toBe('{"name":"Alice","age":1}')
    expect(serializeEvalResult([1, 'two', null, true])).toBe('[1,"two",null,true]')
    expect(serializeEvalResult(undefined)).toBe('null')
  })

  it('masks a secret-shaped string longer than the per-string cap', () => {
    const cookie = 'SID=OPAQUESECRETVALUE; theme=dark; pad=' + 'y'.repeat(4200)
    expect(serializeEvalResult(cookie)).toBe('"****"')
    // The per-string cap was raised to 32 KiB (2026-10-23), so a 4 KB body is no
    // longer truncated at all — the secret inside it is still masked in place.
    const longToken = 'prefix ' + 'y'.repeat(4200) + ' token=super-secret-value'
    const longOut = serializeEvalResult(longToken)
    expect(longOut).not.toContain('super-secret-value')
    expect(longOut).toContain('token=****')
    // A body past the per-string cap is still cut (with the ellipsis marker).
    const giant = 'plain text '.repeat(4000) + ' token=super-secret-value'
    const giantOut = serializeEvalResult(giant)
    expect(giantOut).not.toContain('super-secret-value')
    expect(giantOut.endsWith('…"')).toBe(true)
    const shortToken = serializeEvalResult('prefix token=super-secret-value')
    expect(shortToken).not.toContain('super-secret-value')
    expect(shortToken).toContain('token=****')
  })
})

describe('serializeEvalResult: size / depth / key caps (raised 2026-10-23)', () => {
  it('truncates oversized results with an ellipsis', () => {
    const big = Array.from({ length: 512 }, (_, i) => `value-${i}-` + 'x'.repeat(200))
    const out = serializeEvalResult(big)
    expect(out.length).toBe(MAX_EVAL_RESULT_BYTES + 1)
    expect(out.endsWith('…')).toBe(true)
    // A typical data extraction (200 rows) now fits without truncation.
    const rows = Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${i}`, href: `/p/${i}` }))
    expect(serializeEvalResult(rows).endsWith('…')).toBe(false)
  })

  it('caps result depth at MAX_EVAL_RESULT_DEPTH (now 12)', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: 1 } } } } } } } } } } } } }
    expect(serializeEvalResult(deep)).toContain('[depth-limit]')
    expect(() => JSON.parse(serializeEvalResult(deep))).not.toThrow()
  })

  it('maskEvalResult returns [depth-limit] beyond the cap directly', () => {
    expect(maskEvalResult('x', 13)).toBe('[depth-limit]')
    expect(maskEvalResult('x', 12)).toBe('x')
  })

  it('truncates objects with more than 512 keys and marks the tail', () => {
    const big = Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`k${i}`, i]))
    const parsed = JSON.parse(serializeEvalResult(big)) as Record<string, unknown>
    expect(parsed['…']).toBe('[truncated]')
    expect(Object.keys(parsed).length).toBe(513) // 512 keys + marker
  })

  it('serializes an array of 512 items without truncating it', () => {
    const parsed = JSON.parse(serializeEvalResult(Array.from({ length: 512 }, (_, i) => i))) as unknown[]
    expect(parsed).toHaveLength(512)
    expect(parsed).not.toContain('[truncated]')
  })

  it('returns "[unserializable]" for BigInt values', () => {
    expect(serializeEvalResult({ a: 1n })).toBe('"[unserializable]"')
  })

  it('handles circular references without throwing (depth-bounded output)', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const out = serializeEvalResult(circular)
    expect(out).toContain('[depth-limit]')
    expect(typeof out).toBe('string')
  })

  it('never throws on big inputs', () => {
    const big = {
      rows: Array.from({ length: 1000 }, (_, i) => ({ i, name: `row-${i}`, tags: ['a', 'b'] })),
      nested: { meta: { createdAt: Date.now(), actor: 'ai' } },
    }
    expect(() => serializeEvalResult(big)).not.toThrow()
    expect(serializeEvalResult(big)).toBeTruthy()
  })
})
