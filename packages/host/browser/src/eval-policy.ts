/**
 * `browser_eval` guardrail (v4 §7.3-9): `browser_eval` accepts exactly ONE
 * expression, validated as an AST on the host side before execution.
 *
 * IMPORTANT (2026-09-08 product decision): this validator is a **heuristic
 * misuse guardrail, NOT a security boundary**. The AI is allowed to operate
 * every part of the browser (fetch/XHR/WebSocket and arbitrary JS included);
 * the rules below only keep a single call legible and refuse obvious
 * hand-fumble side effects. They are bypassable by design (e.g. `.constructor`)
 * and no isolation guarantee rests on them.
 *
 * Validation rules:
 * - the expression must parse as `Expression` (no statements, declarations,
 *   assignments — program rejected);
 * - forbidden node kinds: Assignment/Update, Variable/Function/Class
 *   declarations, `new`, `await`/`yield`, `Function`/`eval` calls,
 *   `with`, Super, TaggedTemplate, Import/Export;
 * - forbidden writes/side-effect APIs (called or member-accessed):
 *   setItem (storage), document.write, form submit, window.open, alerts,
 *   print, history/replaceState, location assignment, cookie assignment,
 *   DOM mutation, page-state mutation, media/presentation side effects.
 *   Network-outbound APIs (fetch/XMLHttpRequest/WebSocket/EventSource/
 *   sendBeacon) are NOT forbidden (2026-09-08 product decision).
 * - the matched NAME alone is not the verdict for a handful of names whose
 *   meaning depends on the RECEIVER (2026-09-15 audit, both directions):
 *   `String.prototype.replace` is a pure function while `location.replace` is a
 *   navigation, and `Array.prototype.sort/fill/push/…` only mutate page state
 *   when the receiver is page state rather than a value this expression built.
 *   Pure receivers are allowed; everything unprovable stays refused.
 * - reflection is checked as well (2026-09-15 audit): `Reflect.construct` is the
 *   `new` operator under another name (always refused) and `Reflect.apply` is
 *   judged against the function object it is handed, so a write API reached
 *   through it is refused exactly like a direct call. Computed member names made
 *   of concatenated string literals (`localStorage['set'+'Item']`) are folded
 *   before that judgement instead of reading as "dynamic, therefore data".
 * - a whitelist of read helper globals is injected into the executed
 *   expression (readText/readAttr/readJson/readVar) and must not be shadowed.
 *
 * Result post-processing (execution side): JSON-serialize with size/depth
 * caps + secret masking. The mask step lives in this module for tests.
 * @module @zeokeel/dsh-browser
 */

import acorn from './vendor/acorn.cjs'
import { browserError } from './errors.ts'
import { SECRET_VALUE } from './sensitive.ts'
// EV-1：片段级 `key=value` 打码复用 store 的唯一实现（词表与 URL/摘要面同源）。
// R24 N2：内容出口走 `content` 档（整键判定），否则页面正文里 `?keyword=` 会被
// URL 面的子串词表抹掉。
import { maskCredentialUrlsInText, maskSensitiveContentText } from './store.ts'

/** Max program length accepted by `browser_eval` (host-side bound). */
export const MAX_EVAL_PROGRAM = 65_536

/** Program bound, kept under the old name for import compatibility. */
export const MAX_EVAL_EXPRESSION = MAX_EVAL_PROGRAM

/** Max serialized result length (2026-10-23 capability unlock: was 8 KiB). */
export const MAX_EVAL_RESULT_BYTES = 64 * 1024

/** Max result JSON depth (was 6). */
const MAX_EVAL_RESULT_DEPTH = 12

/** Max array items serialized from one result (was 64). */
const MAX_RESULT_ARRAY_ITEMS = 512

/** Max object keys serialized from one result (was 128). */
const MAX_RESULT_OBJECT_KEYS = 512

/** Per-string cap inside a result, applied before the total cap (was 4 KiB). */
const MAX_RESULT_STRING_CHARS = 32 * 1024

/** Read-only helper globals injected into the eval scope. */
export const EVAL_HELPERS = ['readText', 'readAttr', 'readJson', 'readVar'] as const

/**
 * Destructive surfaces `browser_eval` still refuses (2026-10-23 capability unlock).
 *
 * The previous policy banned ~62 API names plus every statement, assignment,
 * declaration and `new` — it refused ordinary work (`sort`, `new Date()`,
 * `el.focus()`, multi-statement data shaping) while a page-held alias could walk
 * around it anyway. The contract now is: a page can run any JavaScript, so the
 * model may too, EXCEPT the acts that (a) navigate the tab behind the
 * tool-level navigation policy's back, (b) wipe page state the user owns, or
 * (c) re-enter code execution.
 *
 * Page-authored network calls (fetch/XHR/WebSocket/EventSource) stay allowed:
 * that is the 2026-09-08 product decision, and refusing the API never stopped
 * exfiltration (the credential window is the real channel close).
 *
 * This remains a misuse heuristic, NOT a security boundary: an alias captured
 * before the call (`const w = document.write.bind(document)`) is invisible to a
 * static walk. The enforcing boundaries are the credential window, the
 * `will-navigate`/`will-redirect`/`will-frame-navigate` gate and value-level
 * redaction.
 */
const NAV_RECEIVERS = new Set(['location'])
const HISTORY_RECEIVERS = new Set(['history'])
const STORAGE_RECEIVERS = new Set(['localstorage', 'sessionstorage'])
const DOCUMENT_RECEIVERS = new Set(['document'])
/** Cookie Store API: `cookieStore.set/delete` writes the same state as document.cookie. */
const COOKIE_STORE_RECEIVERS = new Set(['cookiestore'])
const DOCUMENT_WRITES = new Set(['write', 'writeln', 'open', 'close'])
const NAV_CALLS = new Set(['assign', 'replace', 'reload'])
const HISTORY_CALLS = new Set(['pushstate', 'replacestate', 'go', 'back', 'forward'])
const STORAGE_CALLS = new Set(['setitem', 'removeitem', 'clear'])
const CODE_EXECUTION_NAMES = new Set(['eval', 'Function'])
/** Receivers whose `location`/`history` member is the real global (not user data). */
const GLOBAL_ROOTS = new Set(['window', 'globalthis', 'self', 'top', 'parent', 'frames', 'this', 'document', 'location', 'history', 'localstorage', 'sessionstorage'])
/** Wrapper methods whose receiver is the function they are invoked on. */
const CALL_WRAPPERS = new Set(['call', 'apply', 'bind'])
/** Object/Reflect helpers whose first argument may be a destructive host. */
const DESTRUCTIVE_TARGET_CALLS = new Set(['assign', 'defineproperty', 'defineproperties', 'setprototypeof'])
/** Global-ish roots used by `Reflect.get(globalThis, 'location')` smuggling. */
const REFLECT_GLOBAL_READS = new Set(['location', 'history', 'document', 'localstorage', 'sessionstorage', 'cookie'])

interface AnyNode {
  type: string
  [key: string]: unknown
}

/** Marker thrown by the credential-tab egress shim (see {@link wrapEvalExpression}). */
export const EVAL_EGRESS_BLOCKED_MARKER = 'ZEOKEEL_EVAL_EGRESS_BLOCKED'

/** Network-write surfaces the credential-tab `denyEgress` shim disables. */
const EGRESS_APIS = new Set([
  'fetch', 'xmlhttprequest', 'sendbeacon', 'websocket', 'eventsource', 'worker',
  'sharedworker', 'importscripts', 'serviceworker', 'rtcpeerconnection', 'rtcdatachannel',
])

/** Every fixed name this program mentions (identifiers, member names and
 * string-literal computed access), lower-cased. */
function mentionedNames(node: AnyNode): Set<string> {
  const names = new Set<string>()
  const stack: AnyNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.type === 'Identifier') {
      const name = (current as { name?: string }).name
      if (name !== undefined) names.add(name.toLowerCase())
    }
    if (current.type === 'MemberExpression') {
      const property = (current as { property?: AnyNode }).property
      if ((current as { computed?: boolean }).computed !== true && property?.type === 'Identifier') {
        const name = (property as { name?: string }).name
        if (name !== undefined) names.add(name.toLowerCase())
      }
      if (property?.type === 'Literal' && typeof property.value === 'string') names.add(property.value.toLowerCase())
    }
    for (const key of Object.keys(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'raw' || key === 'range') continue
      const value = current[key]
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item)
      } else if (isNode(value)) {
        stack.push(value)
      }
    }
  }
  return names
}

/** Credential-tab restriction (R-2 vocabulary seam; not on the execution path
 * since R-4 refuses eval entirely while the injected credential is in the page).
 * @param expression - program source about to run.
 */
export function assertCredentialTabExpression(expression: string): void {
  const names = mentionedNames(parseProgram(expression))
  for (const api of EGRESS_APIS) {
    if (names.has(api)) {
      throw browserError(
        'policy',
        `browser_eval: ${api} is blocked on this tab — it received credentials through browser_fill_credentials, and an outbound request can carry them off the page. Read-only expressions and the read* helpers still work; do page-authored requests in a tab without injected credentials.`,
      )
    }
  }
}

/** Parse a program (statements, top-level await/return allowed). */
function parseProgram(source: string): AnyNode {
  try {
    return acorn.parse(source, {
      ecmaVersion: 2024,
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    } as never) as unknown as AnyNode
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw browserError('eval-policy', `browser_eval: program failed to parse — ${message}`)
  }
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

/** Fixed member name of a member expression; computed access is folded when it
 * is built only from string literals (`localStorage['set'+'Item']`). */
function memberName(node: AnyNode | undefined): string | null | undefined {
  if (node === undefined) return null
  if (node.type === 'Identifier') return (node as { name?: string }).name ?? null
  if (node.type === 'MemberExpression') {
    const property = (node as { property?: AnyNode }).property
    if ((node as { computed?: boolean }).computed !== true) {
      if (property !== undefined && property.type === 'Identifier') return (property as { name?: string }).name ?? null
      return null
    }
    if (property !== undefined && property.type === 'Literal' && typeof property.value === 'string') return property.value
    const folded = foldStringConcat(property)
    return folded === undefined ? undefined : folded
  }
  return null
}

/** Fold a literal-only string concatenation/template into its value. */
function foldStringConcat(node: AnyNode | undefined): string | undefined {
  if (node === undefined) return undefined
  if (node.type === 'Literal') {
    return typeof (node as { value?: unknown }).value === 'string' ? (node as unknown as { value: string }).value : undefined
  }
  if (node.type === 'TemplateLiteral') {
    const expressions = (node as { expressions?: AnyNode[] }).expressions ?? []
    if (expressions.length !== 0) return undefined
    const quasis = (node as { quasis?: Array<{ value?: { cooked?: string } }> }).quasis ?? []
    return quasis.map((quasi) => quasi.value?.cooked ?? '').join('')
  }
  if (node.type === 'ParenthesizedExpression') return foldStringConcat((node as { expression?: AnyNode }).expression)
  if (node.type === 'BinaryExpression' && (node as { operator?: string }).operator === '+') {
    const left = foldStringConcat((node as { left?: AnyNode }).left)
    const right = foldStringConcat((node as { right?: AnyNode }).right)
    if (left === undefined || right === undefined) return undefined
    return left + right
  }
  return undefined
}

/** Static dotted path of an expression (`document.body.innerText`), or
 * `undefined` when any hop is dynamic. */
function staticPath(node: AnyNode | undefined): string | undefined {
  if (node === undefined) return undefined
  if (node.type === 'Identifier') return (node as { name?: string }).name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'ChainExpression') return staticPath((node as { expression?: AnyNode }).expression)
  if (node.type === 'MemberExpression') {
    const base = staticPath((node as { object?: AnyNode }).object)
    const property = memberName(node)
    if (base === undefined || property === undefined || property === null) return undefined
    return `${base}.${property}`
  }
  return undefined
}

/** Lower-cased dotted segments of a receiver expression, or `undefined` when dynamic. */
function pathSegments(node: AnyNode | undefined): string[] | undefined {
  const path = staticPath(node)
  return path === undefined ? undefined : path.toLowerCase().split('.')
}

/** Does the lower-cased dotted path of a receiver name one of `names`? */
function receiverMatches(segments: readonly string[] | undefined, names: ReadonlySet<string>): boolean {
  if (segments === undefined) return false
  return segments.some((segment) => names.has(segment))
}

/** Is this receiver a page/window host rather than ordinary user data?
 *
 * `cfg.location.href = …` / `o.location.assign = 2` are data writes, not
 * navigation; only a bare `location` / global-rooted path (`window.location`,
 * `document.location`) names the real host. */
function onGlobalRoot(segments: readonly string[] | undefined): boolean {
  if (segments === undefined || segments.length === 0) return false
  return GLOBAL_ROOTS.has(segments[0]!)
}

/**
 * Refusal reason for a destructive member access, or `null`.
 * @param segments - lower-cased dotted path of the member's receiver.
 * @param name - the member name as written (folded when statically knowable).
 * @param verb - a plain assignment/update or a call.
 */
function destructiveMemberReason(segments: readonly string[] | undefined, name: string, verb: 'assign' | 'call'): string | null {
  const lower = name.toLowerCase()
  const global = onGlobalRoot(segments)
  if (verb === 'assign') {
    if (lower === 'cookie' && receiverMatches(segments, DOCUMENT_RECEIVERS)) return 'writing document.cookie is not allowed'
    if ((lower === 'location' || lower === 'history') && global) {
      return lower === 'location'
        ? 'assigning to location is not allowed — use browser_navigate (the navigation policy is not bypassed by eval)'
        : 'assigning to history is not allowed — use browser_navigate (direction: back)'
    }
    if (global && receiverMatches(segments, NAV_RECEIVERS)) return 'assigning to location is not allowed — use browser_navigate (the navigation policy is not bypassed by eval)'
    if (global && receiverMatches(segments, HISTORY_RECEIVERS)) return 'assigning to history is not allowed — use browser_navigate (direction: back)'
    if (global && receiverMatches(segments, STORAGE_RECEIVERS)) return 'writing localStorage/sessionStorage is not allowed'
    return null
  }
  if ((lower === 'set' || lower === 'delete') && receiverMatches(segments, COOKIE_STORE_RECEIVERS)) return 'writing cookies through cookieStore is not allowed'
  if (DOCUMENT_WRITES.has(lower) && receiverMatches(segments, DOCUMENT_RECEIVERS)) {
    return `document.${name}() is not allowed — it replaces or destroys the page; use browser_navigate and browser_get_snapshot instead`
  }
  if (global && NAV_CALLS.has(lower) && receiverMatches(segments, NAV_RECEIVERS)) return `location.${name}() is not allowed — use browser_navigate`
  if (global && HISTORY_CALLS.has(lower) && receiverMatches(segments, HISTORY_RECEIVERS)) return `history.${name}() is not allowed — use browser_navigate (direction: back)`
  if (global && STORAGE_CALLS.has(lower) && receiverMatches(segments, STORAGE_RECEIVERS)) return `${name}() on localStorage/sessionStorage is not allowed`
  return null
}

/** Is this call a `getOwnPropertyDescriptor`/`Reflect.getOwnPropertyDescriptor`
 * read of a destructive host property (`window.location`, `Document.prototype.cookie`,
 * `localStorage`)? The returned descriptor's `set`/`value` re-opens the surface. */
function isDestructiveHostDescriptorCall(node: AnyNode | undefined, aliases: AliasMap): boolean {
  if (node === undefined || node.type !== 'CallExpression') return false
  const callee = (node as { callee?: AnyNode }).callee
  if (callee === undefined) return false
  const target = callee.type === 'ChainExpression' ? (callee as { expression?: AnyNode }).expression : callee
  if (target === undefined || target.type !== 'MemberExpression') return false
  const method = memberName(target)?.toLowerCase()
  if (method !== 'getownpropertydescriptor') return false
  const receiver = (target as { object?: AnyNode }).object
  const receiverPath = staticPath(receiver)?.toLowerCase()
  if (receiverPath !== 'object' && receiverPath !== 'reflect') return false
  const args = (node as { arguments?: AnyNode[] }).arguments ?? []
  const key = foldStringConcat(args[1])?.toLowerCase()
  if (key === undefined) return false
  if (key !== 'location' && key !== 'history' && key !== 'cookie' && key !== 'localstorage' && key !== 'sessionstorage') return false
  const holder = args[0]
  if (holder === undefined) return false
  if (holder.type === 'Identifier') {
    const name = (holder as { name?: string }).name
    if (name === undefined) return false
    if (name === 'window' || name === 'globalThis' || name === 'document' || name === 'self') return true
    return aliases.location.has(name) || aliases.history.has(name) || aliases.storage.has(name)
      || aliases.globals.has(name) || aliases.documents.has(name)
  }
  const segments = segmentsWithAliases(holder, aliases)
  return onGlobalRoot(segments) || receiverMatches(segments, DOCUMENT_RECEIVERS) || receiverMatches(segments, STORAGE_RECEIVERS)
}

/** Aliases a program binds to a destructive host (`const l = location; l.assign(…)`). */
interface AliasMap {
  readonly location: Set<string>
  readonly history: Set<string>
  readonly storage: Set<string>
  /** Aliases of the window/global object (`const w = window; w.location = …`). */
  readonly globals: Set<string>
  /** Aliases of the document object (`const d = document; d.write(…)`). */
  readonly documents: Set<string>
}

/** Collect simple aliases of the destructive globals declared in this program. */
function collectAliases(program: AnyNode): AliasMap {
  const location = new Set<string>()
  const history = new Set<string>()
  const storage = new Set<string>()
  const globals = new Set<string>()
  const documents = new Set<string>()
  const stack: AnyNode[] = [program]
  const addFromInit = (id: string, init: AnyNode | null | undefined): void => {
    // acorn gives `null` (not `undefined`) for declarations without an
    // initializer: `let x;`, `for (const el of …)`, `for (let k in …)`.
    if (init === undefined || init === null) return
    if (init.type === 'Identifier') {
      const name = (init as { name?: string }).name
      if (name === 'location') location.add(id)
      else if (name === 'history') history.add(id)
      else if (name === 'localStorage' || name === 'sessionStorage') storage.add(id)
      else if (name === 'window' || name === 'globalThis' || name === 'self') globals.add(id)
      else if (name === 'document') documents.add(id)
      return
    }
    if (init.type !== 'MemberExpression') return
    const path = staticPath(init)?.toLowerCase()
    if (path === undefined) return
    if (path === 'window.location' || path === 'document.location' || path === 'globalthis.location' || path === 'self.location') location.add(id)
    if (path === 'window.history' || path === 'globalthis.history' || path === 'self.history') history.add(id)
    if (path === 'window.localstorage' || path === 'window.sessionstorage' || path === 'globalthis.localstorage' || path === 'globalthis.sessionstorage') storage.add(id)
    if (path === 'document.defaultview') globals.add(id)
  }
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.type === 'VariableDeclarator') {
      const id = (current as { id?: AnyNode }).id
      const init = (current as { init?: AnyNode }).init
      if (id !== undefined && id.type === 'Identifier') {
        const name = (id as { name?: string }).name
        if (name !== undefined) addFromInit(name, init)
      }
    }
    for (const key of Object.keys(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'raw' || key === 'range') continue
      const value = current[key]
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item)
      } else if (isNode(value)) {
        stack.push(value)
      }
    }
  }
  return { location, history, storage, globals, documents }
}

/** Lower-cased path of a receiver, with a first-segment alias resolved to its host. */
function segmentsWithAliases(node: AnyNode | undefined, aliases: AliasMap): string[] | undefined {
  const segments = pathSegments(node)
  if (segments === undefined || segments.length === 0) return segments
  const first = segments[0]!
  const canonical = aliases.location.has(first) ? 'location'
    : aliases.history.has(first) ? 'history'
      : aliases.storage.has(first) ? 'localstorage'
        : aliases.globals.has(first) ? 'window'
          : aliases.documents.has(first) ? 'document'
            : undefined
  if (canonical === undefined) return segments
  return [canonical, ...segments.slice(1)]
}

/** Destructive global referenced as a bare identifier (`location`, `history`, `localStorage`, …). */
function destructiveGlobalIdentifier(node: AnyNode | undefined, aliases: AliasMap): string | null {
  if (node === undefined || node.type !== 'Identifier') return null
  const name = (node as { name?: string }).name
  if (name === undefined) return null
  if (aliases.location.has(name)) return 'assigning to location is not allowed — use browser_navigate (the navigation policy is not bypassed by eval)'
  if (aliases.history.has(name)) return 'assigning to history is not allowed — use browser_navigate (direction: back)'
  if (aliases.storage.has(name)) return 'writing localStorage/sessionStorage is not allowed'
  if (name === 'location') return 'assigning to location is not allowed — use browser_navigate (the navigation policy is not bypassed by eval)'
  if (name === 'history') return 'assigning to history is not allowed — use browser_navigate (direction: back)'
  if (name === 'localStorage' || name === 'sessionStorage') return `writing ${name} is not allowed`
  if (name === 'document') return 'mutating the document object is not allowed'
  return null
}

/** Refusal reason for a destructive assignment/update/reflection target; `null` when fine. */
function destructiveTargetReason(target: AnyNode | undefined, aliases: AliasMap): string | null {
  if (target === undefined) return null
  const node = target.type === 'ChainExpression' ? (target as { expression?: AnyNode }).expression : target
  if (node === undefined) return null
  // Bare `location = '/x'` routes through the (unforgeable) window.location setter,
  // which a page-side shim cannot intercept — the AST has to catch it.
  if (node.type === 'Identifier') return destructiveGlobalIdentifier(node, aliases)
  if (node.type !== 'MemberExpression') return null
  const name = memberName(node)
  if (name === undefined || name === null) {
    // `document[m] = …` / `localStorage[m] = …`: an unverifiable member of a
    // destructive host is refused rather than guessed.
    const segments = segmentsWithAliases((node as { object?: AnyNode }).object, aliases)
    if (receiverMatches(segments, DOCUMENT_RECEIVERS) || receiverMatches(segments, NAV_RECEIVERS)
      || receiverMatches(segments, HISTORY_RECEIVERS) || receiverMatches(segments, STORAGE_RECEIVERS)) {
      return 'writing a dynamically named member of a destructive host is not allowed'
    }
    return null
  }
  return destructiveMemberReason(segmentsWithAliases((node as { object?: AnyNode }).object, aliases), name, 'assign')
}

/** Refusal reason for a destructive call (incl. `call`/`apply`/`bind`, reflection
 * smuggling and function-constructor escapes); `null` when fine. */
function destructiveCall(call: AnyNode, aliases: AliasMap): string | null {
  const callee = (call as { callee?: AnyNode }).callee
  if (callee === undefined) return null
  const node = callee.type === 'ChainExpression' ? (callee as { expression?: AnyNode }).expression : callee
  if (node === undefined) return null
  const args = (call as { arguments?: AnyNode[] }).arguments ?? []
  if (node.type === 'Identifier') {
    const name = (node as { name?: string }).name
    return name !== undefined && CODE_EXECUTION_NAMES.has(name) ? `call to ${name} is not allowed (code execution)` : null
  }
  if (node.type !== 'MemberExpression') return null
  const name = memberName(node)
  const receiver = (node as { object?: AnyNode }).object
  // `window.eval(...)`, `window.Function(...)`, `foo.constructor(...)`.
  if (name !== undefined && name !== null && (CODE_EXECUTION_NAMES.has(name) || name === 'constructor')) {
    return `call to ${name} is not allowed (code execution)`
  }
  // `document[m]('x')` / `localStorage[m]('k')`: dynamic member of a destructive host.
  if (name === undefined || name === null) {
    const segments = segmentsWithAliases(receiver, aliases)
    if (receiverMatches(segments, DOCUMENT_RECEIVERS) || receiverMatches(segments, NAV_RECEIVERS)
      || receiverMatches(segments, HISTORY_RECEIVERS) || receiverMatches(segments, STORAGE_RECEIVERS)) {
      return 'calling a dynamically named member of a destructive host is not allowed'
    }
    return null
  }
  const lower = name.toLowerCase()
  // `Object.getOwnPropertyDescriptor(window, 'location').set.call(…)`
  if (isDestructiveHostDescriptorCall(receiver, aliases)) {
    return 'reading a destructive host property descriptor is not allowed (it hands out the setter)'
  }
  // `localStorage.setItem.call(…)`, `history.pushState.apply(…)`, `document.write.bind(…)`.
  if (CALL_WRAPPERS.has(lower)) {
    const inner = receiver !== undefined && receiver.type === 'ChainExpression' ? (receiver as { expression?: AnyNode }).expression : receiver
    if (inner !== undefined && inner.type === 'MemberExpression') {
      if (isDestructiveHostDescriptorCall((inner as { object?: AnyNode }).object, aliases)) {
        return 'reading a destructive host property descriptor is not allowed (it hands out the setter)'
      }
      const innerName = memberName(inner)
      if (innerName === undefined || innerName === null) {
        const segments = segmentsWithAliases((inner as { object?: AnyNode }).object, aliases)
        if (receiverMatches(segments, DOCUMENT_RECEIVERS) || receiverMatches(segments, NAV_RECEIVERS)
          || receiverMatches(segments, HISTORY_RECEIVERS) || receiverMatches(segments, STORAGE_RECEIVERS)) {
          return 'wrapping a dynamic member of a destructive host is not allowed'
        }
      } else {
        const reason = destructiveMemberReason(segmentsWithAliases((inner as { object?: AnyNode }).object, aliases), innerName, 'call')
        if (reason !== null) return reason
      }
    }
    if (inner !== undefined && inner.type === 'Identifier') {
      const innerName = (inner as { name?: string }).name
      if (innerName !== undefined && CODE_EXECUTION_NAMES.has(innerName)) return `call to ${innerName} is not allowed (code execution)`
    }
  }
  const receiverPath = staticPath(receiver)?.toLowerCase()
  // Object.assign(location, …) / Object.defineProperty(localStorage, …) etc.
  if (receiverPath === 'object' && DESTRUCTIVE_TARGET_CALLS.has(lower)) {
    const reason = destructiveTargetReason(args[0], aliases)
    if (reason !== null) return reason
  }
  // Reflect.set(localStorage, …) / Reflect.deleteProperty(history, …).
  if (receiverPath === 'reflect' && (lower === 'set' || lower === 'deleteproperty' || lower === 'defineproperty')) {
    const reason = destructiveTargetReason(args[0], aliases)
    if (reason !== null) return reason
  }
  // Reflect.get(window, 'location') hands out the location object for later use.
  if (receiverPath === 'reflect' && lower === 'get') {
    const key = foldStringConcat(args[1])?.toLowerCase()
    const targetPath = staticPath(args[0])?.toLowerCase()
    if (key !== undefined && REFLECT_GLOBAL_READS.has(key)
      && (targetPath === undefined || GLOBAL_ROOTS.has(targetPath) || targetPath === 'globalthis')) {
      return `Reflect.get(…, '${key}') is not allowed (it hands out a destructive host)`
    }
  }
  const reason = destructiveMemberReason(segmentsWithAliases(receiver, aliases), name, 'call')
  if (reason !== null) return reason
  // Reflect.apply(target, …) must not smuggle a destructive target past the checks.
  if (lower === 'apply' && receiverPath === 'reflect') {
    const target = args[0]
    if (target !== undefined && target.type === 'MemberExpression') {
      const targetName = memberName(target)
      if (targetName !== undefined && targetName !== null) {
        return destructiveMemberReason(segmentsWithAliases((target as { object?: AnyNode }).object, aliases), targetName, 'call')
      }
    }
  }
  return null
}

/** Walk the program; return the first destructive-surface reason, or `null`. */
function findDestructive(node: AnyNode): string | null {
  const aliases = collectAliases(node)
  const stack: AnyNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.type === 'AssignmentExpression') {
      const reason = destructiveTargetReason((current as { left?: AnyNode }).left, aliases)
      if (reason !== null) return reason
    }
    if (current.type === 'UpdateExpression') {
      const reason = destructiveTargetReason((current as { argument?: AnyNode }).argument, aliases)
      if (reason !== null) return reason
    }
    if (current.type === 'CallExpression') {
      const reason = destructiveCall(current, aliases)
      if (reason !== null) return reason
    }
    if (current.type === 'MemberExpression') {
      const name = memberName(current)
      // `window.eval(...)`, `window['Function'](...)` — the identifier rule only
      // sees bare identifiers, so the member spelling needs its own check.
      if (name !== undefined && name !== null && CODE_EXECUTION_NAMES.has(name)) return `${name} is not allowed (code execution)`
    }
    if (current.type === 'Identifier') {
      const name = (current as { name?: string }).name
      if (name !== undefined && CODE_EXECUTION_NAMES.has(name)) return `references to ${name} are not allowed (code execution)`
    }
    for (const key of Object.keys(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'raw' || key === 'range') continue
      if (current.type === 'MemberExpression' && key === 'property' && (current as { computed?: boolean }).computed !== true) continue
      if (current.type === 'Property' && key === 'key' && (current as { computed?: boolean }).computed !== true) continue
      const value = current[key]
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) stack.push(item)
      } else if (isNode(value)) {
        stack.push(value)
      }
    }
  }
  return null
}

/** Validate one eval program (throws BrowserError code 'eval-policy'). */
export function validateEvalExpression(expression: string): void {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw browserError('eval-policy', 'browser_eval: program must be a non-empty string')
  }
  if (expression.length > MAX_EVAL_PROGRAM) {
    throw browserError('eval-policy', `browser_eval: program must be ≤ ${MAX_EVAL_PROGRAM} chars`)
  }
  const violation = findDestructive(parseProgram(expression))
  if (violation !== null) {
    throw browserError('eval-policy', `browser_eval: ${violation}`)
  }
}

/** Rewrite a trailing expression statement into `return (…)` so a REPL-style
 * program yields its last value (statements before it run for their effects). */
function withReturnOfLastExpression(source: string): string {
  let program: AnyNode
  try {
    program = parseProgram(source)
  } catch {
    return source
  }
  const body = (program as { body?: AnyNode[] }).body ?? []
  const last = body[body.length - 1]
  if (last === undefined || last.type !== 'ExpressionStatement') return source
  const expression = (last as { expression?: AnyNode }).expression
  if (expression === undefined) return source
  const start = (last as { start?: unknown }).start
  const end = (last as { end?: unknown }).end
  const exprStart = (expression as { start?: unknown }).start
  const exprEnd = (expression as { end?: unknown }).end
  if (typeof start !== 'number' || typeof end !== 'number' || typeof exprStart !== 'number' || typeof exprEnd !== 'number') return source
  return `${source.slice(0, start)}return (${source.slice(exprStart, exprEnd)});${source.slice(end)}`
}

/** Read helper definitions injected ahead of every program. */
const EVAL_HELPERS_SOURCE = `
    const __readText = (sel) => { const el = document.querySelector(sel); return el ? (el.innerText ?? el.textContent ?? '').slice(0, 4096) : null; };
    const __readAttr = (sel, name) => { const el = document.querySelector(sel); return el ? el.getAttribute(name) : null; };
    const __readJson = (sel) => { const el = document.querySelector(sel); if (!el) return null; try { return JSON.parse(el.textContent || 'null'); } catch { return null; } };
    const __readVar = (path) => { const parts = String(path).split('.'); let cur = globalThis; for (const p of parts) { cur = cur?.[p]; if (cur === undefined) return undefined; } try { return JSON.parse(JSON.stringify(cur)); } catch { return String(cur); } };
    const readText = __readText, readAttr = __readAttr, readJson = __readJson, readVar = __readVar;`

/**
 * Marker thrown by the page-side eval blocker (see {@link wrapEvalExpression}).
 * The runtime can recognize it to turn a page exception into an explicit policy
 * error instead of a generic "page script failed".
 */
export const EVAL_BLOCKED_MARKER = 'ZEOKEEL_EVAL_BLOCKED'

/** Installs the page-side destructive-surface shims for one evaluation.
 *
 * What a shim CAN enforce here (verified against real DOM layout, 2026-10-23
 * batch1-fix audit): `Document.prototype.{write,writeln,open,close}`,
 * `Storage.prototype.{setItem,removeItem,clear}`, `History.prototype` navigation,
 * `Document.prototype.cookie` setter, `globalThis.{eval,Function}`, and — because
 * a Storage object's exotic `[[Set]]` bypasses prototype methods — the
 * `window.localStorage`/`sessionStorage` getters are swapped for Proxies whose
 * set/define/delete traps throw.
 *
 * What it CANNOT enforce: `window.location` and `location.href/assign/replace/
 * reload` are own, non-configurable properties in real Chromium ("[LegacyUnforgeable]")
 * and `Location.prototype` does not carry them, so no page-side shim can patch
 * them. Those are handled by (a) the AST validator (direct forms + aliases) and
 * (b) the runtime's navigation gate, which refuses every top-level navigation
 * while an eval is in flight (`evalInFlight` in runtime.ts).
 */
const EVAL_BLOCK_SOURCE = `
    const __marker = ${JSON.stringify(EVAL_BLOCKED_MARKER)};
    const __block = (label) => { const err = new Error(__marker + ': ' + label + ' is blocked inside browser_eval'); err.name = 'BrowserEvalBlocked'; throw err; };
    const __restores = [];
    const __shadow = (target, key, label) => {
      if (target === undefined || target === null) return;
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(target, key); } catch { return; }
      try {
        Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: desc === undefined ? false : desc.enumerable, value: function () { return __block(label); } });
        __restores.push(() => { try { if (desc === undefined) delete target[key]; else Object.defineProperty(target, key, desc); } catch { /* restore is best effort */ } });
      } catch { /* non-configurable */ }
    };
    const __denySetter = (target, key, label) => {
      if (target === undefined || target === null) return;
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(target, key); } catch { return; }
      if (desc === undefined || typeof desc.set !== 'function') return;
      try {
        Object.defineProperty(target, key, Object.assign({}, desc, { set: function () { return __block(label); } }));
        __restores.push(() => { try { Object.defineProperty(target, key, desc); } catch { /* restore is best effort */ } });
      } catch { /* non-configurable */ }
    };
    const __swapAccessor = (target, key, value) => {
      if (target === undefined || target === null || value === undefined) return;
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(target, key); } catch { return; }
      try {
        Object.defineProperty(target, key, { configurable: true, enumerable: desc === undefined ? true : desc.enumerable, get: function () { return value; } });
        __restores.push(() => { try { if (desc === undefined) delete target[key]; else Object.defineProperty(target, key, desc); } catch { /* restore is best effort */ } });
      } catch { /* non-configurable */ }
    };
    const __storageProxy = (host, label) => {
      if (host === undefined || host === null) return undefined;
      try {
        return new Proxy(host, {
          set() { return __block(label + ' property write'); },
          defineProperty() { return __block(label + ' property write'); },
          deleteProperty() { return __block(label + ' property delete'); },
          get(target, key) {
            if (key === 'setItem' || key === 'removeItem' || key === 'clear') {
              return function () { return __block(label + '.' + String(key)); };
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      } catch { return undefined; }
    };
    const __protoOf = (name) => (globalThis[name] && globalThis[name].prototype) || undefined;
    const __documentHost = __protoOf('Document') || globalThis.document;
    const __storageHost = __protoOf('Storage');
    const __historyHost = __protoOf('History');
    for (const key of ['write', 'writeln', 'open', 'close']) __shadow(__documentHost, key, 'document.' + key);
    for (const key of ['setItem', 'removeItem', 'clear']) __shadow(__storageHost, key, 'storage.' + key);
    for (const key of ['pushState', 'replaceState', 'go', 'back', 'forward']) __shadow(__historyHost, key, 'history.' + key);
    __denySetter(__documentHost, 'cookie', 'document.cookie');
    const __cookieStoreHost = __protoOf('CookieStore');
    for (const key of ['set', 'delete']) __shadow(__cookieStoreHost, key, 'cookieStore.' + key);
    __swapAccessor(globalThis, 'localStorage', __storageProxy(globalThis.localStorage, 'localStorage'));
    __swapAccessor(globalThis, 'sessionStorage', __storageProxy(globalThis.sessionStorage, 'sessionStorage'));
    __shadow(globalThis, 'eval', 'eval');
    __shadow(globalThis, 'Function', 'Function');`

/** Extra network shims used by the credential-window `denyEgress` variant. */
const EVAL_EGRESS_SOURCE = `
    const __egressMarker = ${JSON.stringify(EVAL_EGRESS_BLOCKED_MARKER)};
    const __egressBlock = (name) => { const err = new Error(__egressMarker + ': ' + name + ' is disabled on this tab while injected credentials are present'); err.name = 'BrowserEvalEgressBlocked'; throw err; };
    const __denyValue = (target, key, name) => {
      if (target === undefined || target === null) return;
      let had = false;
      let previous;
      try { had = Object.prototype.hasOwnProperty.call(target, key); previous = target[key]; } catch { return; }
      try {
        Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: false, value: function () { return __egressBlock(name); } });
        __restores.push(() => { try { if (had) Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: true, value: previous }); else delete target[key]; } catch { /* restore is best effort */ } });
      } catch { /* non-configurable */ }
    };
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'Request', 'importScripts']) {
      __denyValue(globalThis, name, name);
    }
    __denyValue(globalThis.navigator, 'sendBeacon', 'sendBeacon');
    __denyValue(globalThis.navigator, 'serviceWorker', 'serviceWorker');
    for (const key of ['open', 'send']) {
      __denyValue(globalThis.XMLHttpRequest && globalThis.XMLHttpRequest.prototype, key, 'XMLHttpRequest.' + key);
    }
    __denyValue(globalThis.HTMLFormElement && globalThis.HTMLFormElement.prototype, 'submit', 'form.submit');
    __denyValue(globalThis.HTMLFormElement && globalThis.HTMLFormElement.prototype, 'requestSubmit', 'form.requestSubmit');`

/**
 * Wrap a validated program for page execution.
 *
 * The wrapper does three things:
 * 1. defines the `read*` helpers locally;
 * 2. installs **page-side shims** for the shimmable destructive surfaces
 *    (document writes, storage writes + storage property sets, history
 *    navigation, `document.cookie` setter, `eval`/`Function`) and restores them
 *    in a `finally`. This closes the indirect shapes a static walk cannot see —
 *    descriptors fetched at runtime, `X.call/apply/bind`, aliases captured before
 *    the call. `location` is NOT shimmable (see EVAL_BLOCK_SOURCE); it is covered
 *    by the AST validator and the runtime navigation gate;
 * 3. runs the program as an async IIFE so top-level `await` works and the last
 *    expression's value is returned.
 *
 * `denyEgress` (R-2, retained vocabulary) additionally disables the network-write
 * APIs for the duration of this one evaluation.
 *
 * Honest boundary: `window.location` is unforgeable, so `location` changes
 * cannot be shimmed at all; the AST validator refuses the direct and aliased
 * spellings, and the runtime refuses every top-level navigation while an eval is
 * in flight. A reference captured into a page global before the call is still
 * outside both layers — this is a guardrail, not a sandbox.
 */
export function wrapEvalExpression(expression: string, options: { denyEgress?: boolean } = {}): string {
  const body = withReturnOfLastExpression(expression)
  const prologue = `${EVAL_HELPERS_SOURCE}${EVAL_BLOCK_SOURCE}${options.denyEgress === true ? EVAL_EGRESS_SOURCE : ''}`
  return `(async () => {${prologue}
    try {
${body}
    } finally {
      for (let i = __restores.length - 1; i >= 0; i--) { try { __restores[i](); } catch { /* restore is best effort */ } }
    }
  })()`
}

/**
 * Value-level projection of one string on its way into the serialized result
 * (F-5, 2026-09-13 round 2).
 *
 * The runtime passes its injected-credential redactor here so that the
 * value-exact masking of {@link maskString} and the size caps below happen in
 * the order that cannot leave a fragment: **project, then cut**. Before this,
 * `maskString` sliced a >4 KB value at 4096 and `serializeEvalResult` sliced
 * the serialized text at 8 KB, and the runtime's redactor only saw the result
 * — a password straddling either cut came back as a plaintext head fragment.
 */
export type EvalValueProjection = (text: string) => string

/** Redact secret-shaped string values inside an arbitrary JSON value (deep).
 * Values under secret-shaped KEYS are masked regardless of the value's own
 * text (a session id value need not contain the word "token").
 *
 * `project` (F-5) runs on every string that survives the depth/width caps —
 * values AND object keys, because a page-chosen key is page-controlled text
 * too — BEFORE the 4 KB per-value cap (see {@link maskString}). */
export function maskEvalResult(value: unknown, depth = 0, project?: EvalValueProjection): unknown {
  if (depth > MAX_EVAL_RESULT_DEPTH) return '[depth-limit]'
  if (typeof value === 'string') return maskString(value, project)
  if (Array.isArray(value)) return value.slice(0, MAX_RESULT_ARRAY_ITEMS).map((item) => maskEvalResult(item, depth + 1, project))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    let count = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (count >= MAX_RESULT_OBJECT_KEYS) { out['…'] = '[truncated]'; break }
      count++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inner = (value as Record<string, unknown>)[key]
      // The KEY is projected before it is cut away with the rest of the text
      // (F-5): a page-chosen key longer than the serialized cap used to be
      // truncated by `serializeEvalResult` with the credential still in it.
      const safeKey = project === undefined ? key : project(key)
      // R23 N3：`cookie` / `Set-Cookie` 是**取值容器**键（`{cookie: 'a=1; b=2'}`），
      // 与 `SECRET_VALUE`（值形态词表）同一口径：键名本身就是"值整体是凭据材料"
      // 的声明。`code`/`session` 这类普通词不在此列，所以 `{code: 'token'}` 不动。
      out[safeKey] = SECRET_VALUE.test(key) || COOKIE_JAR_KEY.test(key) ? MASK : maskEvalResult(inner, depth + 1, project)
    }
    return out
  }
  return value
}

// SECRET_VALUE (credential-shaped key names / free-form values) lives in
// `sensitive.ts` — single definition site shared with the URL/op-log masking
// (P1-6: the two lists had drifted).
const MASK = '****'

/** One `name=value` cookie pair (value may be quoted; empty values allowed). */
const COOKIE_PAIR = /([A-Za-z0-9_.#$%&*+\-^|~]{1,64})=(?:"[^"]*"|[^;\s]*)/gu
/** Cookie names that carry a session/CSRF credential on their own. */
const SESSION_COOKIE_NAME = /^(?:sid|s|session|sessionid|jsessionid|phpsessid|connect\.sid|csrftoken|xsrf-token|xsrf|_csrf|_session_id|auth|authorization)$/iu
/** Cookie **flag** attributes（`HttpOnly`/`Secure`/`Partitioned`，都是无值形态；带 `=`
 *  的 `secure=` 是普通配置键，不算信号）与取值属性（`SameSite=`/`Expires=`/`Max-Age=`）。
 *  `Path=`/`Domain=` 刻意**不**在这里：它们是 CSS/配置里常见的普通键（`path=/api`）。 */
const COOKIE_ATTRIBUTE = /(?:^|[;\s])(?:httponly|secure|partitioned)\b(?!\s*=)|(?:^|[;\s])(?:expires|max-age|samesite)\s*=/iu
/** A KEY whose value is a whole cookie jar (`{cookie: 'a=1; b=2'}`, `Set-Cookie`). */
const COOKIE_JAR_KEY = /^(?:set-)?cookie$/iu

/**
 * Detect a cookie/`Set-Cookie` **jar** shape: a session/CSRF cookie name is
 * present (`sid=…`, `jsessionid=…`) or a cookie flag/attribute is present
 * (`…; HttpOnly`, `…; SameSite=Lax`). Cookie values are opaque credentials and
 * cookie names are not secret-shaped, so keyword matching alone never fired
 * (P1-18) — such a string is masked whole rather than one fragment.
 *
 * `Cookie:`/`Set-Cookie:` **头**形态不在这里判：那条路由
 * {@link COOKIE_HEADER_VALUE} 按头名擦掉取值（`Cookie: a=b` → `Cookie: ****`，
 * 键名保留），整串打码只留给"裸的 jar"（P1-18 的回归面）。
 *
 * R23 N3（2026-09-26）：判据以前是"**≥2 个 `k=v` 且串里有 `;`**"，于是任何分号
 * 分隔的普通正文（CSS 内联样式 `width=100; height=200`、配置片段、日志行）都被
 * 整串抹成 `****`，连键名一起消失 —— 那正是 EV-1 要修的形态，而同一段文本经
 * `browser_get_text` 逐字可读。现在只有**真的 cookie jar**才整串打码（两条信号，
 * 与 {@link COOKIE_HEADER_VALUE} 的"按头名判定"同一精神）；普通 `k=v; k2=v2`
 * 交给片段级规则 —— 敏感键的值照样被擦（`password=hunter2xyz` → `password=****`），
 * 普通键值对逐字保留。
 */
function looksLikeCookieString(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3) return false
  const pairs = trimmed.match(COOKIE_PAIR)
  if (pairs === null || pairs.length === 0) return false
  if (pairs.some((pair) => SESSION_COOKIE_NAME.test(pair.slice(0, pair.indexOf('='))))) return true
  return pairs.length >= 2 && trimmed.includes(';') && COOKIE_ATTRIBUTE.test(trimmed)
}

/**
 * 整串**就是**一个凭据的形态（EV-1：只有整串符合这些形状才整串打码）。
 *
 * 每条都要求整个字符串就是那个凭据，而不是"提到了某个词"：
 *  - HTTP 认证头取值（`Bearer <token>` / `Basic <base64>`）：方案的尾巴必须是
 *    一个不带空格的凭据串 —— `Bearer of good news` 这类散文因此不命中；
 *  - JWT（三段 base64url）；
 *  - 带**公认前缀**的 API key（`sk-`/`ghp_`/`glpat-`/`xoxb-`/`AKIA…`）：前缀本身就
 *    是"这是凭据"的声明，前缀之后还要求 ≥12 位，slug/CSS 类名不会命中。
 *
 * 认账边界（EV-1 的取舍）：**裸的、不带前缀也不含数字的不透明串**不再整串打码
 * （`dXNlcjpwYXNz` 这类 base64 凭据）。旧实现也不打码（`SECRET_VALUE` 只认关键词），
 * 所以这不是覆盖度回退；而放宽整串规则换来的是"普通正文不再被抹成 ****"。真正
 * 需要兜住的三条仍在：①注入凭据走 `project`（值级精确脱敏）；②`Authorization: Basic …`
 * 这类形态由 {@link AUTH_HEADER_VALUE} **整段**擦掉取值（2026-09-26 R22 V6 F2 之前这里
 * 写的是"由 `key=value`/`key: value` 片段规则擦掉值"—— 实测那句话是**假的**：那条规则
 * 在第一个空格处收尾，擦掉的是方案名、凭据留明文）；③**有声明**的裸串（`token <纯字母
 * 不透明串>`）由 {@link KEYWORD_SPAN} + {@link isDeclaredCredentialSpan} 擦掉 ——
 * 声明在场时不再要求"含数字"，所以这条边界只覆盖"既无前缀也无关键词"的形态。
 */
const CREDENTIAL_VALUE_SHAPES: readonly RegExp[] = [
  /^bearer\s+[A-Za-z0-9._~+/=-]{8,}$/iu,
  /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u,
  /^(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9_-]{12,}$/u,
]

/**
 * 敏感关键词后紧跟的 opaque 片段（`token abc123def456` / `Bearer eyJ…`）：
 * 只擦**这个片段**，不是整串（EV-1）。
 *
 * R23 N1（2026-09-26）：关键词命中本身就是"这是凭据声明"，片段是否打码由
 * {@link isDeclaredCredentialSpan} 判定 —— 不再要求片段"同时含数字与字母"
 * （`token ABCDEFGHIJKLMNOPQRSTUVWX` 这类**纯字母**不透明串曾原样出窗）。
 *
 * 片段**不得以分隔符开头**（`(?![=:])`）：`=`/`:` 也在片段的字符集里（base64
 * padding 用到 `=`），没有这条时 `api_key=example`（值只有 7 位）会让分隔符被
 * 回溯进片段、连 `=` 一起被掩码成 `api_key****`；这种形态本该交给 `key=value`
 * 规则，输出 `api_key=****`（键与分隔符保留）。
 */
const KEYWORD_SPAN = /(\b(?:token|secret|password|passwd|pwd|authorization|api[_-]?key|apikey|session[_-]?id|access[_-]?key|refresh[_-]?token|private[_-]?key|bearer|credential)\b\s*(?:[:=]\s*)?["']?)((?![=:])[A-Za-z0-9_+/.=-]{8,})/giu

/**
 * 单个英文单词的形态（首字母任意大小写、其余小写）：`authentication`、
 * `Rotation`、`expiration`。这是声明门限下**唯一**被排除的形状。
 */
const PROSE_WORD_SHAPE = /^[A-Za-z][a-z]+$/u

/**
 * 纯字母"单词"超过这个长度就不像英文词了：英文词极少有 ≥16 个字母的，而
 * 无数字的纯字母句柄（`deadbeefcafebabe`）正好落在这条线之上。
 */
const PROSE_WORD_MAX_LENGTH = 16

/** 片段是否只是散文里的一个英文词（`token authentication` 不许被当成凭据）。 */
function isProseLikeSpan(span: string): boolean {
  return span.length < PROSE_WORD_MAX_LENGTH && PROSE_WORD_SHAPE.test(span)
}

/**
 * **声明之后**的片段是否按凭据打码 —— `KEYWORD_SPAN` 与 `AUTH_HEADER_VALUE`
 * 共用的同一份判据（R23 N1，与 R22 V6 F2 的"方案名即声明"同源）。
 *
 * 判据的**声明**部分由调用方给出（关键词命中 / 认证方案名在场），这里只判片段：
 *
 *  - 命中 {@link CREDENTIAL_VALUE_SHAPES} 的形状（`Bearer x` / JWT / 带公认前缀的
 *    key）⇒ 是凭据；
 *  - 否则只要**不像散文里的一个英文词**（见 {@link isProseLikeSpan}）就算凭据：
 *    `ABCDEFGHIJKLMNOPQRSTUVWX`（纯大写）、`aBcDeFgHiJkL`（混合大小写）、
 *    `deadbeefcafebabe`（16 个纯小写字母）都命中，`authentication`（14 个纯小写
 *    字母）、`Rotation` 不命中。
 *
 * 为什么不再要求"同时含数字与字母"：那是**按长度/字符集**判定，等于把
 * `token <纯字母不透明串>` 这一族（base64 长度 ≥12 时无数字的概率约 8.5%）留在
 * 明文里 —— 同一份实现里 `Authorization: Basic <无数字 b64>` 早就靠"方案名"擦掉了，
 * 关键词分支没有理由用更弱的判据。
 *
 * 认账边界：**纯小写或首字母大写的 8–15 位纯字母串**（`token abcdefghij`）与英文词
 * 在形状上不可分，仍按散文保留（随机 base64 命中该形状的概率 ≈ (26/64)^12 ≈ 0.024%）。
 *
 * 代价（认账，方向与 {@link maskSensitiveKeyValueText} 的"fail-closed"一致）：
 * **全大写**的英文短语（`PASSWORD EXPIRATION`）会被当成不透明串打码 —— 全大写散文与
 * 全大写句柄在形状上不可分，而掩码可恢复、明文泄漏不可恢复。
 */
function isDeclaredCredentialSpan(span: string): boolean {
  if (CREDENTIAL_VALUE_SHAPES.some((shape) => shape.test(span))) return true
  return !isProseLikeSpan(span)
}

/**
 * `Authorization` / `Proxy-Authorization` 头的**整个取值**（`<scheme> <credential>`）。
 *
 * 这类键的值有两段（方案名 + 凭据），而 `maskSensitiveKeyValueText` 的 `key: value`
 * 规则在**第一个空格**处收尾 ⇒ 它擦掉的是**方案名**、真正的凭据反而落单；第二趟
 * `KEYWORD_SPAN` 这时又看不到方案名（而且 `basic` 本来就不在它的关键词表里），于是
 * `Authorization: Bearer <jwt>` 出窗时是 `Authorization: **** <jwt>` —— 凭据明文进
 * 模型上下文（2026-09-26 R22 V6 F2）。这条规则跑在片段级两趟**之前**，把取值整段擦掉。
 *
 * R24 N1（2026-09-26）：判据从"枚举认证方案名"改为**结构判据**。R22 的实现要求取值里
 * 出现白名单里的方案名（`bearer|basic|…|saml`）才整段擦，而没有方案名时退回"片段形状"
 * 门限；于是**任何不在白名单里的方案名**都让凭据原样出窗：
 *
 *   `Authorization: SSWS AQAAANCMND8BFdERjHoAwE`   → `Authorization: **** AQAAANCMND8BFdERjHoAwE`
 *   `Authorization: SNOWFLAKE_JWT <jwt>`           → 同上（`SNOWFLAKE_JWT` 长 13，被片段规则当成"方案名"擦掉）
 *   `Proxy-Authorization: SSWS <token>` / 小写 `authorization: ssws <token>` → 同上
 *
 * 加名字不可能收敛：RFC 7235 的 auth-scheme 是任意 token，白名单永远落后一步（R23 N1
 * 补 `saml` 就是同一修法方向的又一次补丁）。现在的判据是**头名即声明**：头名命中
 * （大小写不敏感）就把取值整段换成 {@link MASK}，取值是不是凭据由
 * {@link isNonCredentialAuthValue} 反向排除（占位符 / 纯散文）。
 *
 * 反向排除不会漏：AUTH_HEADER_VALUE 之后还有 `KEYWORD_SPAN` 与最后那一趟
 * `key: value` 扫描，被放过的取值里紧邻头名的第一个词仍会被擦
 * （`Authorization: Bearer <your-token>` → `Authorization: **** <your-token>`）。
 */
const AUTH_HEADER_VALUE = /(\b(?:proxy-)?authorization\b["']?\s*[:=]\s*["']?)([^\r\n]*)/giu

/** 认证头取值尾部允许被"还原"的标点（JSON 收尾引号/括号、句子句号）。 */
const AUTH_VALUE_TRAILERS = new Set(['"', "'", '}', ')', ']', ',', ';', '.', '`'])

/**
 * 认证头的取值是不是**明确的非凭据形态**（只有这两种才保留原样）。
 *
 *  - **占位符**：`<your-token>` / `<token>`（`Authorization: Bearer <your-token>`）；
 *  - **纯散文**：去掉可能的首词（方案名）之后，剩下的每个词都是单个英文单词形状
 *    （`none required`、`Bearer of good news`）。判定与 {@link isProseLikeSpan}
 *    同源（`[A-Za-z][a-z]+` 且长度 < {@link PROSE_WORD_MAX_LENGTH}），所以
 *    `hunter2`（含数字）、`AKIAIOSFODNN7EXAMPLE`（全大写）都不是散文。
 *
 * 其余一律按凭据整段擦（fail-closed）。取值里的首词无论保留与否都会被后续的
 * `key: value` 扫描擦掉，所以这里放行散文不会留下"看起来已掩码、其实没擦"的形态。
 */
function isNonCredentialAuthValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return true
  if (isPlaceholderWord(trimmed)) return true
  const words = trimmed.split(/\s+/u)
  // 首个词可能是方案名（`Bearer`/`SSWS`/…）：方案名自身不是凭据材料，判定落在
  // 它之后的取值上。
  const rest = words.length > 1 ? words.slice(1) : words
  return rest.length > 0 && rest.every((word) => isPlaceholderWord(word) || isProseLikeSpan(word))
}

/** 文档占位符形态（`<your-token>`/`<token>`）：不是凭据，出窗时必须逐字保留。 */
function isPlaceholderWord(word: string): boolean {
  return /^<[^<>\s]*>$/u.test(word)
}

/** 按 {@link isNonCredentialAuthValue} 决定整段掩码还是原样保留（保留尾部标点）。 */
function maskAuthHeaderValue(value: string): string {
  let end = value.length
  while (end > 0 && AUTH_VALUE_TRAILERS.has(value[end - 1]!)) end -= 1
  const body = value.slice(0, end)
  const trimmed = body.trim()
  if (trimmed === '' || isNonCredentialAuthValue(trimmed)) return value
  const lead = body.slice(0, body.length - body.trimStart().length)
  return `${lead}${MASK}${value.slice(end)}`
}

/**
 * `Cookie` / `Set-Cookie` 头的取值（cookie 对 `k=v`，可 `; ` 分隔多条）。
 *
 * 会话 cookie 名在 {@link SESSION_COOKIE_NAME} 里，所以"整个字符串就是 cookie 串"的
 * 形态早就在 `maskString` 的整串分支被打码（P1-18 的回归面）。落单的是**单条、且
 * cookie 名不在名单里**的形态（`Cookie: a=b`）：`cookie` 有意不在
 * `SENSITIVE_KEY_PATTERN` 的词表里（URL 面的 `?cookie=` 逐字节不动），于是它既不命中
 * 整串形状、也不命中 `key: value` ⇒ 值原样出窗（2026-09-26 R22 V6 F2 的判据形态）。
 * cookie 头的取值整体是凭据材料，这里按"值必须真的是 cookie 对"的形状门限擦掉它 ——
 * 散文（`Cookie: the browser sends cookies`）没有 `k=v` 形态，不命中。
 */
const COOKIE_HEADER_VALUE = /(\b(?:set-)?cookie\b\s*[:=]\s*)([A-Za-z0-9_.#$%&*+\-^|~]{1,64}=[^\s;,]+(?:\s*;\s*[A-Za-z0-9_.#$%&*+\-^|~]{1,64}=[^\s;,]+)*)/giu

/**
 * 片段级凭据打码（2026-09-23 审计 EV-1）——**三个内容出口的唯一共用漏斗**
 * （C3-09，2026-10-04）。
 *
 * 旧实现：`SECRET_VALUE.test(value) && value.length >= 6` ⇒ **整串** `****`。
 * `SECRET_VALUE` 是无词边界的子串正则，于是任何"提到"这些词的普通正文都变成零信息
 * ——`browser_eval` 读 `document.body.innerText`/`document.title` 时，页面里出现
 * "password reset"、"token budgets"、"the secret garden" 这类措辞，模型拿到的是
 * `****`；而**同一段文本**经 `browser_get_text` 是正常可读的 ⇒ 两个工具对同一数据
 * 自相矛盾。
 *
 * **导出**：`runtime.ts` 的 `redactSecretsText`（`browser_get_text` /
 * `browser_get_snapshot` / `browser_eval` 的出口都走它）调用本函数。R23 N2 只把
 * "内嵌 URL"那一趟接进了那条漏斗，另外三趟仍只在 eval 侧生效 —— 同一份页面文本
 * 经两个出口给出不同答案（`browser_get_text` 原样交出 `password=…` /
 * `Authorization: Bearer …`）。现在四趟只有这一份实现，两处都调它。
 *
 * 现在的口径（与 `/op log`/store 同族：先形态、再片段）：
 *  1. 整串**就是** cookie 头/会话 cookie/带 cookie 属性（{@link looksLikeCookieString}）
 *     或是凭据形态 ⇒ 整串打码（cookie 值本身无键可依，键名匹配永远指不到它，
 *     这条是 P1-18 的回归面）—— R23 N3 起"≥2 个 `k=v` 且含 `;`"不再算 cookie 串，
 *     普通键值列表交给片段级规则；`looksLikeCookieString` 那一半只在
 *     {@link maskString}（单个**值**）里跑，页面**正文**出口不做整串判定；
 *  2. 否则只擦片段，**四趟顺序固定为：内嵌 URL（{@link maskCredentialUrlsInText}）
 *     → 认证/cookie 头取值 → 关键词 + opaque 片段 → `key=value`/`key: value`
 *     的敏感值**（最后一趟复用 store 的唯一实现
 *     {@link maskSensitiveContentText}，R24 N2 起走 `content` 档 = 整键判定）；
 *  3. 其余正文原样保留。
 *
 * **为什么是这个顺序**（2026-09-26 R22 V6 F2 / R23 N2）：`key: value` 规则在第一个
 * 空格处收尾，所以它跑在前面时会把"方案名 / 第二个关键词"先擦成 `****`，后面的关键词
 * 片段规则就再也认不出 `<keyword> <credential>` 形态 ⇒ 真正的凭据留明文
 * （`Authorization: Bearer <jwt>` → `Authorization: **** <jwt>`）。URL 那一趟跑在
 * 最前面则是因为 userinfo **没有键**，只有 URL 结构能看见它。四趟都只**增加**掩码、
 * 从不还原，所以顺序只会比旧顺序更严，不会漏；认证头与 cookie 头还要在片段级之前
 * **整段**擦掉取值（见 {@link AUTH_HEADER_VALUE} / {@link COOKIE_HEADER_VALUE}）。
 *
 * 顺序不变（F-5）：**先掩码后截断**，`project` 仍然在 4 KB 上限之前跑 —— 跨截断点
 * 的凭据只会以 `****` 的形式出现。
 *
 * **窗外的形态（认账的边界，C3-09 残余④；2026-10-04 复审用 28 个形态 × 3 个出口实测）**：
 * 这三条规则都是**形态匹配**，不是"值级"识别 —— 值被变换过就看不见它。出窗的整类有：
 *
 *  - **全角/非 ASCII 分隔符**：`password：hunter2xyz`（全角冒号）不命中 ——
 *    {@link KEYWORD_SPAN} 的分隔符与 {@link AUTH_HEADER_VALUE} / `key=value` 那两趟
 *    都只认 ASCII 的 `:`/`=`；
 *  - **非 ASCII 关键词**：`密码=` / `密码：` / `口令=` 整类不命中（关键词表是 ASCII
 *    英文词表，中文输入法下最常见的写法正好在窗外）；
 *  - 以及值/关键词的**变换形态**：整段 base64、关键词反转、逐字母加空格、
 *    零宽字符、西里尔同形字、跨行拆分、percent-encoded 值。
 *
 * 边界的方向是**诚实**而不是**更松**：三个出口（`browser_get_text` /
 * `browser_get_snapshot` / `browser_eval`）走的是同一份实现，同一个形态在三个出口
 * **一致地命中或一致地不命中**（不变量：没有任何出口比另一个更松）。上面每一类都
 * 需要"值级/语义级"识别才能关闭，属产品决策，不在本函数的形态口径内。
 */
export function maskContentText(value: string): string {
  // R23 N2: 内嵌 URL 的 userinfo/查询串先擦（与标题/摘要面同一份实现
  // `store.maskCredentialUrlsInText`）。userinfo 没有键、也不含关键词，只有 URL
  // 结构能看见它；跑在最前面是因为 URL 是最具体的结构，之后的片段级规则只会
  // 在此基础上继续**增加**掩码。R24 N2：这一趟走 `content` 档（整键判定），
  // 普通查询键（`?keyword=`）在页面正文里逐字节保留。
  const urls = maskCredentialUrlsInText(value, 'content')
  const headers = urls
    .replace(AUTH_HEADER_VALUE, (_match: string, key: string, rest: string) => `${key}${maskAuthHeaderValue(rest)}`)
    .replace(COOKIE_HEADER_VALUE, (_match: string, key: string) => `${key}${MASK}`)
  const spans = headers.replace(KEYWORD_SPAN, (match, prefix: string, span: string) =>
    isDeclaredCredentialSpan(span) ? `${prefix}${MASK}` : match)
  return maskSensitiveContentText(spans)
}

function maskString(value: string, project?: EvalValueProjection): string {
  if (value.length === 0) return value
  // Detect BEFORE truncating: a >4 KB value (a routine cookie jar, a long
  // response body) used to be sliced and returned with its credential in the
  // clear — the P1-18 cookie-shape detector never ran (2026-09-11 audit).
  if (looksLikeCookieString(value) || CREDENTIAL_VALUE_SHAPES.some((shape) => shape.test(value))) return MASK
  const masked = maskContentText(value)
  // F-5 (2026-09-13 round 2): the caller's value-level projection runs BEFORE
  // the cap. The other order (slice, then let `runtime.eval` redact the
  // serialized text) left the head of a credential that straddled the cut in
  // the clear, followed by `…` so the R7 tail backstop could not see it either.
  const projected = project === undefined ? masked : project(masked)
  if (projected.length > MAX_RESULT_STRING_CHARS) return `${projected.slice(0, MAX_RESULT_STRING_CHARS)}…`
  return projected
}

/** Serialize an eval result: size + depth caps applied, secrets masked.
 * Never throws.
 *
 * `project` (F-5, 2026-09-13 round 2) is the caller's value-level projection,
 * applied to every string value/key BEFORE the per-value and total caps, so a
 * credential straddling a cut is masked instead of clipped into a fragment. */
export function serializeEvalResult(value: unknown, project?: EvalValueProjection): string {
  const masked = maskEvalResult(value, 0, project)
  let text: string
  try {
    text = JSON.stringify(masked, null, 0) ?? 'null'
  } catch {
    return '"[unserializable]"'
  }
  if (text.length > MAX_EVAL_RESULT_BYTES) {
    text = `${text.slice(0, MAX_EVAL_RESULT_BYTES)}…`
  }
  return text
}
