/**
 * Safe embedding of values into page-side JavaScript strings.
 *
 * `JSON.stringify` alone is not enough when the result is pasted into code that
 * is later executed (a `</script>` or a lone U+2028 can terminate the string in
 * some hosts). This module builds the literal with an **allowlist**: printable
 * ASCII except quote/backslash is emitted verbatim, everything else is escaped,
 * so no input character can close the string or open a new statement.
 * @module @zeokeel/dsh-browser
 */

/** Printable ASCII minus `"` `\` `/` `<` `>`: safe inside a quoted literal. */
const SAFE = /^[\x20-\x21\x23-\x2E\x30-\x3B\x3D\x3F-\x5B\x5D-\x7E]$/u

/** Explicit escapes for characters a host may interpret as markup. */
const explicit: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
}

/**
 * Build a safe JS string literal from a value.
 * @param value - the value to embed.
 * @returns a double-quoted literal that cannot break out of its string.
 */
export function jsonForPage(value: unknown): string {
  const text = String(value)
  let out = '"'
  for (const char of text) {
    if (SAFE.test(char)) {
      out += char
    } else if (explicit[char] !== undefined) {
      out += explicit[char]
    } else if (char.length > 1 || (char.codePointAt(0) ?? 0) > 0xffff) {
      // Astral character: emit its two UTF-16 code units so the literal stays ASCII.
      for (let index = 0; index < char.length; index += 1) {
        out += `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`
      }
    } else {
      out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
    }
  }
  return out + '"'
}
