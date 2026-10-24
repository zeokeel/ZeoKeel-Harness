/**
 * Safe embedding of values into page-side JavaScript strings.
 *
 * CodeQL's `js/bad-code-sanitization` is right about one thing: `JSON.stringify`
 * alone is not enough when the result is pasted into code that is later executed
 * (a `</script>` or a lone U+2028 can terminate the string in some hosts). The
 * selectors we embed come from tool arguments, so every literal goes through the
 * same escape map before it is interpolated.
 * @module @zeokeel/dsh-browser
 */

const charMap: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

/**
 * Escape the characters that can break out of a JS string literal.
 * @param text - the already serialized text.
 * @returns text safe to interpolate between quotes.
 */
export function escapeUnsafeChars(text: string): string {
  return text.replace(/[<>\b\f\n\r\t\0\u2028\u2029]/g, (x) => charMap[x] ?? x)
}

/**
 * Serialize a value as a page-side JS literal (JSON + escape pass).
 * @param value - the value to embed.
 * @returns a literal that is safe inside generated page code.
 */
export function jsonForPage(value: unknown): string {
  return escapeUnsafeChars(JSON.stringify(value))
}
