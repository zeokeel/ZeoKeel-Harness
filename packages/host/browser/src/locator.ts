/**
 * Locator grammar for element targets (2026-10-23 capability unlock, C13).
 *
 * Before this module an element target was either a snapshot number or a raw
 * CSS selector — the model had to guess a selector or take a snapshot first.
 * The grammar adds the locator forms every other browser tool has:
 *
 * | form | meaning |
 * | --- | --- |
 * | `12` / `@12` / `ref=12` | snapshot element number (anchored to the last snapshot) |
 * | `css=#main > a` / bare selector | CSS selector (first match, unchanged semantics) |
 * | `text=Sign in` | element whose visible text contains it (normalized, case-insensitive) |
 * | `text="Sign in"` | exact, case-sensitive visible text |
 * | `role=button` | accessibility role |
 * | `role=button[name="Sign in"]` / `[name*="Sign"]` | role + accessible name (exact / substring) |
 * | `loc=role:button[name="Sign in"]` | Playwright-ish spelling of the same |
 * | `loc=href:/checkout` | link whose href contains the value |
 * | `xpath=//button[1]` | XPath |
 *
 * Non-CSS forms resolve through one page probe and must match **exactly one**
 * element: zero matches and multiple matches both fail loud with the candidate
 * list, instead of silently acting on the first one. CSS keeps its existing
 * first-match semantics (changing that would break every stored selector).
 *
 * The module is pure (parsing + probe text); execution lives in
 * `BrowserRuntime.resolveTargetSelector`.
 *
 * @module @zeokeel/dsh-browser
 */

import { browserError } from './errors.ts'

/** One parsed target: the snapshot index form or a resolvable locator. */
export type TargetSpec =
  | { readonly kind: 'index', readonly index: number }
  | { readonly kind: 'css', readonly selector: string }
  | { readonly kind: 'text', readonly text: string, readonly exact: boolean }
  | { readonly kind: 'role', readonly role: string, readonly name: string | undefined, readonly nameExact: boolean }
  | { readonly kind: 'href', readonly needle: string }
  | { readonly kind: 'xpath', readonly expression: string }

/** Strip one pair of matching quotes; returns `[value, wasQuoted]`. */
function unquote(raw: string): [string, boolean] {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'") && last === first) return [value.slice(1, -1), true]
  }
  return [value, false]
}

/** Parse a `role=<role>[name="…"]` body (also used after `loc=role:`). */
function parseRoleSpec(body: string): TargetSpec {
  const match = /^([A-Za-z][\w-]*)\s*(?:\[\s*name\s*(\*=|=)\s*("[^"]*"|'[^']*'|[^\]]+?)\s*\])?\s*$/u.exec(body)
  if (match === null) {
    throw browserError('policy', `browser: invalid role locator ${JSON.stringify(body)} — expected role=button or role=button[name="Sign in"]`)
  }
  const [, role, operator, rawName] = match
  if (role === undefined) throw browserError('policy', 'browser: role locator needs a role name')
  let name: string | undefined
  let nameExact = true
  if (rawName !== undefined) {
    const [value, quoted] = unquote(rawName)
    name = value
    nameExact = operator === '=' && quoted ? true : operator === '=' ? false : false
    // Unquoted `name=Sign in` is treated as a normalized substring (the same
    // convention as `text=` unquoted); quoted `name="Sign in"` is exact.
    if (operator === '=' && !quoted) nameExact = false
  }
  return { kind: 'role', role, name, nameExact }
}

/**
 * Parse one model-supplied target string.
 * @param raw - the target as written by the model.
 * @returns the parsed spec (CSS is the fallback for bare strings).
 * @throws BrowserError 'policy' for a malformed locator.
 */
export function parseTargetSpec(raw: string): TargetSpec {
  const trimmed = raw.trim()
  if (trimmed === '') throw browserError('policy', 'browser: target must not be empty')

  const index = /^(?:@|ref=)(\d+)$/u.exec(trimmed)
  if (index !== null) {
    const value = Number(index[1])
    if (!Number.isSafeInteger(value) || value < 1) throw browserError('policy', `browser: invalid snapshot ref ${JSON.stringify(trimmed)}`)
    return { kind: 'index', index: value }
  }

  if (trimmed.startsWith('xpath=')) return { kind: 'xpath', expression: trimmed.slice('xpath='.length).trim() }
  if (trimmed.startsWith('text=')) {
    const [text, quoted] = unquote(trimmed.slice('text='.length))
    if (text === '') throw browserError('policy', 'browser: text locator must not be empty')
    return { kind: 'text', text, exact: quoted }
  }
  if (trimmed.startsWith('role=')) return parseRoleSpec(trimmed.slice('role='.length))
  if (trimmed.startsWith('loc=')) {
    const body = trimmed.slice('loc='.length)
    if (body.startsWith('css:')) return { kind: 'css', selector: body.slice('css:'.length) }
    if (body.startsWith('role:')) return parseRoleSpec(body.slice('role:'.length))
    if (body.startsWith('href:')) {
      const needle = unquote(body.slice('href:'.length))[0]
      if (needle === '') throw browserError('policy', 'browser: href locator must not be empty')
      return { kind: 'href', needle }
    }
    throw browserError('policy', `browser: unsupported locator ${JSON.stringify(trimmed)} — use loc=css:, loc=role: or loc=href:`)
  }
  if (trimmed.startsWith('css=')) {
    const selector = trimmed.slice('css='.length)
    if (selector.trim() === '') throw browserError('policy', 'browser: css locator must not be empty')
    return { kind: 'css', selector }
  }
  return { kind: 'css', selector: trimmed }
}

/** Page-side probe: resolve one locator to a unique element and its selector. */
const LOCATOR_PROBE = `(() => {
  const spec = __SPEC__;
  const norm = (value) => String(value === undefined || value === null ? '' : value).replace(/\\s+/g, ' ').trim();
  const lower = (value) => norm(value).toLowerCase();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);
  const unique = (el, selector) => {
    try { const all = document.querySelectorAll(selector); return all.length === 1 && all[0] === el } catch (e) { return false }
  };
  const selectorFor = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) { const direct = '#' + CSS.escape(el.id); if (unique(el, direct)) return direct }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.id) {
        const direct = '#' + CSS.escape(node.id);
        if (unique(node, direct)) { parts.unshift(direct); break }
      }
      const tag = node.tagName.toLowerCase();
      let nth = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) nth += 1 }
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      const parent = node.parentElement;
      if (!parent) break;
      node = parent;
    }
    const selector = parts.join(' > ');
    // A selector that does not resolve to THIS element is unusable: acting on it
    // would click whatever it does resolve to (audit P1-1, shadow DOM case).
    return unique(el, selector) ? selector : null;
  };
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    const role = el.getAttribute('role') || '';
    const text = norm(el.innerText || el.textContent || '').slice(0, 80);
    return [el.tagName.toLowerCase(), el.id ? '#' + el.id : '', role ? '[' + role + ']' : '', text].filter(Boolean).join(' ');
  };
  const HOLE_ROLES = { button: ['button'], link: ['a'], textbox: ['input', 'textarea'], checkbox: ['input'], radio: ['input'], combobox: ['select'], option: ['option'], listitem: ['li'], image: ['img'], heading: ['h1','h2','h3','h4','h5','h6'] };
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.split(/\\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'li') return 'listitem';
    if (tag === 'img') return 'image';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    return '';
  };
  const accessibleName = (el) => {
    const label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title'));
    if (label) return norm(label);
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((id) => { const node = document.getElementById(id); return node ? norm(node.innerText || node.textContent) : '' }).filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }
    return norm(el.innerText || el.textContent || '');
  };
  const all = [];
  const walk = (root) => {
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      if (SKIP.has(el.tagName)) continue;
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  let matched = [];
  if (spec.kind === 'xpath') {
    try {
      const snapshot = document.evaluate(spec.expression, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < snapshot.snapshotLength; i += 1) { const node = snapshot.snapshotItem(i); if (node && node.nodeType === 1) matched.push(node) }
    } catch (e) { return JSON.stringify({ count: 0, error: 'xpath failed: ' + String(e && e.message ? e.message : e) }) }
  } else if (spec.kind === 'text') {
    const needle = spec.exact ? spec.text : lower(spec.text);
    const hits = all.filter((el) => {
      const text = spec.exact ? norm(el.innerText || el.textContent || '') : lower(el.innerText || el.textContent || '');
      return spec.exact ? text === needle : text.includes(needle);
    });
    // Prefer the deepest matches: a matching <body> that contains a matching
    // <button> means the model meant the button.
    matched = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  } else if (spec.kind === 'role') {
    const wanted = lower(spec.role);
    matched = all.filter((el) => {
      // Role matching is case-insensitive on both sides (DOM role tokens are
      // lower-case by convention, but pages write role="BUTTON").
      if (lower(roleOf(el)) !== wanted) return false;
      if (spec.name === undefined) return true;
      const name = lower(accessibleName(el));
      const needle = lower(spec.name);
      return spec.nameExact ? name === needle : name.includes(needle);
    });
  } else if (spec.kind === 'href') {
    const needle = lower(spec.needle);
    matched = all.filter((el) => el.tagName === 'A' && lower(el.getAttribute('href') || '').includes(needle));
  }
  return JSON.stringify({
    count: matched.length,
    selector: matched.length === 1 ? selectorFor(matched[0]) : null,
    candidates: matched.slice(0, 3).map(describe),
  });
})()`

/**
 * Build the page-side probe expression for one parsed locator.
 * @param spec - a non-CSS locator.
 * @returns a self-contained expression returning JSON text.
 */
export function locatorProbe(spec: TargetSpec): string {
  if (spec.kind === 'index' || spec.kind === 'css') {
    throw new Error('browser: locatorProbe only resolves text/role/href/xpath targets')
  }
  // A function replacer is required: a string replacement would expand
  // `$&` / `$'` / `` $` `` inside the model's own text.
  return LOCATOR_PROBE.replace('__SPEC__', () => JSON.stringify(spec))
}
