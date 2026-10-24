/**
 * `eval-policy` 的破坏面判定（2026-10-23 能力解锁后重写）。
 *
 * 旧口径（2026-09-15 审计）按「接收者感知 + 写 API 名字表」拒绝约 62 个名字，
 * 连纯数据操作（`sort`/`push`）与正常页面操作（`focus`/`click`）都拒，属于误杀；
 * 新口径放开普通 JS，只拒**页面破坏面**：导航、页面状态清除、代码执行重入。
 *
 * 本文件钉住三件事：
 * 1. **不受误杀**：纯数据/正常页面操作/构造器/动态调用都通过；
 * 2. **不受绕过**：常量拼接的属性名、`Reflect.apply` 走私、赋值/更新表达式三条路径
 *    都仍被拒；
 * 3. **诚实边界**：调用前捕获的别名（`document.write.bind`）是已知放行面 ——
 *    断言它"通过"，把边界写在测试里而不是只写在注释里。
 */
import { describe, expect, it } from 'vitest'
import { validateEvalExpression } from '../src/eval-policy.ts'
import { BrowserError } from '../src/errors.ts'

/** 断言程序被拒，并返回错误（便于断言文案）。 */
function rejection(expression: string): BrowserError {
  let thrown: unknown
  try {
    validateEvalExpression(expression)
  } catch (error) {
    thrown = error
  }
  expect(thrown, `expected a policy rejection for: ${expression}`).toBeInstanceOf(BrowserError)
  expect((thrown as BrowserError).code).toBe('eval-policy')
  return thrown as BrowserError
}

function accepted(expression: string): void {
  expect(() => validateEvalExpression(expression), expression).not.toThrow()
}

describe('不再误杀：普通 JS 与页面操作', () => {
  it('审计实测被误杀的三类现在通过（数据整形 / 原地数组方法 / 字符串替换）', () => {
    for (const expression of [
      `document.body.innerText.replace(/\\s+/g,' ')`,
      `[...document.querySelectorAll('a')].map(a => a.textContent).join('|')`,
      `[1,2,3].push(4)`,
      `[1].sort()`,
      `arr.fill(0)`,
      `arr.splice(0, 1)`,
      `x.replace(/a/g, 'b')`,
      `alias.replace('/evil')`,
    ]) accepted(expression)
  })

  it('正常页面动作与构造器通过', () => {
    for (const expression of [
      `document.querySelector('a').click()`,
      `document.querySelector('input').focus()`,
      `el.scrollIntoView()`,
      `document.querySelector('form').requestSubmit()`,
      `document.querySelector('form').reset()`,
      `document.querySelector('video').play()`,
      `window.open('https://example.com')`,
      `window.close()`,
      `new Date()`,
      `new Map([['a', 1]])`,
      `new XMLHttpRequest()`,
      `Reflect.construct(Date, [])`,
      `Object.defineProperty(window, 'x', { value: 1 })`,
      `Object.setPrototypeOf({}, null)`,
      `alert(1)`,
    ]) accepted(expression)
  })

  it('动态调用目标不再默认拒绝（没有"必须字面量 callee"的规则）', () => {
    for (const expression of [
      `window[key]('x')`,
      `(0, fetch)('https://example.com')`,
      `[fetch][0]('x')`,
      `(true ? fetch : fetch)('x')`,
    ]) accepted(expression)
  })

  it('普通读取不受影响', () => {
    for (const expression of [
      `localStorage.getItem('t')`,
      `JSON.parse('{}')`,
      `window.__NEXT_DATA__`,
      `({a:1})['a']`,
      `[1,2,3][0]`,
      `document.querySelectorAll('a').length`,
      `window['fetch']('https://example.com')`,
      `fetch('https://example.com')`,
      `(x => x * 2)(21)`,
    ]) accepted(expression)
  })
})

describe('仍被拒：页面破坏面', () => {
  it('导航（调用 / 赋值 / 常量拼接属性名 / Reflect 走私）', () => {
    for (const expression of [
      `location.assign('https://example.com')`,
      `location.replace('https://example.com')`,
      `location.reload()`,
      `location.href = 'https://example.com'`,
      `document.location.href = 'https://example.com'`,
      `location['re' + 'place']('https://example.com')`,
      `Reflect.apply(location.assign, location, ['https://example.com'])`,
      `history.pushState(null, '', '/x')`,
      `history.go(-1)`,
      `history.back()`,
    ]) rejection(expression)
  })

  it('页面状态清除（document 写 / cookie / storage）', () => {
    for (const expression of [
      `document.write('<h1>x</h1>')`,
      `document.writeln('x')`,
      `document.open()`,
      `document.close()`,
      `document['wr' + 'ite']('x')`,
      `document.cookie = 'a=1'`,
      `cookieStore.set('a', 'b')`,
      `document['coo' + 'kie'] = 'a=1'`,
      `localStorage.setItem('a', 'b')`,
      `sessionStorage.setItem('a', 'b')`,
      `localStorage.removeItem('a')`,
      `sessionStorage.clear()`,
      `localStorage['set' + 'Item']('a', 'b')`,
      `localStorage.foo = 'x'`,
      `Reflect.apply(localStorage['set'+'Item'], localStorage, ['k','v'])`,
    ]) rejection(expression)
  })

  it('代码执行重入（eval / Function / new Function）', () => {
    for (const expression of [`eval('1')`, `Function('return 1')()`, `new Function('return 1')`]) {
      rejection(expression)
    }
  })

  it('错误文案点名被拒的 API（模型可据此改写）', () => {
    expect(rejection(`localStorage.setItem('a','b')`).message).toMatch(/localStorage/u)
    expect(rejection(`location.assign('https://x')`).message).toMatch(/browser_navigate/u)
    expect(rejection(`document.write('x')`).message).toMatch(/document\.write/u)
  })
})

describe('已知边界（诚实钉住，不假装覆盖）', () => {
  it('AST 看不见的形态交页面侧 shim（见 eval-block-shim.spec.ts）', () => {
    // `.bind(...)` 已在 AST 层被拒；真正"看不见"的是页面在本次调用之前就捕获好的
    // 引用（`window.__preboundWrite`）—— 那由页面内 shim 兜住，测试见 shim 套件。
    accepted(`window.__preboundWrite('x')`)
  })
})
