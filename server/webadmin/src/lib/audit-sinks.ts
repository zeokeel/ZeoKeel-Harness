// 审计写入点（sink）图分析（审计 R13-F F-07 / W-2）。
//
// 背景：`Audit.test.tsx` 此前用 `AUDIT_SINKS`（6 个 sink 名 + 动作实参下标）**只认
// 字面量**（`const literal = /^"([^"]*)"$/`）。实测假绿：把动作名经**参数传入**的本地
// 包装写出（`func probeAuditWrapper2(db, username, action, detail) { serverstore.AuditLog(db, username, action, detail) }`，
// 调用点 `probeAuditWrapper2(db, adminUsername(c), "probe_new_action2", conn.ID)`）
// ⇒ `Audit.test.tsx` 18 用例 `EXIT=0`。
//
// 2026-10-22（反证 F-7）又补了一层漏洞：**包级 `const` 实参**。`retirement/scheduler.go`
// 写的是 `const auditAction = "wasm_app_purge"` + `s.opt.Audit(appID, auditActor, auditAction, detail)`
// —— 动作名在承载位上是个**标识符**，只认 `"…"` 字面量的旧口径对它失明，于是"新增写点
// 不补中文标签"这条判据在真源上直接漏掉一整条（审计页会显示裸 id）。
// 现在承载位上的标识符会被解析到**同包（同目录）的包级 const/var 字符串声明**。
//
// 识别 const 实参后多出一个必须处理的干扰：同一出口名存在**多种签名**时，登记表把两种
// 动作位都挂在同一个名字下，于是 `s.opt.Audit(appID, auditActor, auditAction, detail)` 的
// 第 1 位（执行者常量）也会被当成承载位。现在按**实参个数**对已声明签名消歧（见
// `declaredShapes`），执行者常量不会再变成"待补标签的动作"。
//
// 本模块把判据从"grep 字面量"升级为**按实际调用图/参数流**判定：
//   ① 先把"哪些函数能把动作写进审计行"建成闭包：以登记/派生的 sink 为种子，沿调用图
//      把"承载动作的形参位"向外传播（一层/多层本地包装、把 action 作为形参透传、
//      `*Tx` 变体都在内），直到不动点；
//   ② 再对闭包里每个承载位上的**动作名字面量**判定它在审计页有标签；
//   ③ sink 集合本身有完整性判据（见 `audit-sink-inventory` 侧的用例）：
//      - 任何函数体里直接出现 `INSERT INTO audit_logs` ⇒ 必须在行写入点登记表里
//        （登记它的动作形参位，或登记为 plumbing 并写明理由）；
//      - `server/internal/serverstore/audit.go` 里"声明了 action 形参且能到达写入点"
//        的函数 ⇒ 必须在 store sink 登记表里；
//      - 任何 `func(… action …)` 型结构体字段 ⇒ 必须在审计出口登记表里。
//
// 纯函数 + 合成夹具可测（见 `audit-sinks.spec.ts`），不碰网络也不读时钟。

/** 一个 Go 源文件（`path` 用仓库内相对路径，仅用于报错定位）。 */
export interface GoSourceFile {
  path: string
  text: string
}

/** 顶层 `func` 声明（含方法；不含函数字面量）。 */
export interface GoFuncInfo {
  file: string
  /** 所在目录基名（Go 包路径的近似，用于同名跨包消歧）。 */
  dir: string
  receiver: string | null
  name: string
  /** 形参名（按位置；`_` 与无名参数已过滤）。 */
  params: string[]
  /** 函数体（不含外层花括号），已注释清零。 */
  body: string
  /** 函数体起止偏移（相对该文件注释清零后的文本）。 */
  bodyStart: number
  bodyEnd: number
}

/** 承载动作的种子：sink 的调用名 + 动作实参下标。 */
export interface AuditSinkSeed {
  name: string
  actionArg: number
}

/** 直接写 `audit_logs` 行的函数（`INSERT` 语句所在处即写入点）。 */
export interface AuditRowWriter {
  name: string
  file: string
  line: number
  /** 动作形参下标；`null` = 动作来自结构体字段等非位置形参（plumbing）。 */
  actionArg: number | null
}

/**
 * 收集**所有** `func(… action …)` 型结构体字段声明（同名可有多份：`Audit` 在
 * `handlers.Options` 是 3 参、在 `retirement.Scheduler` 是 4 参）。
 *
 * `findAuditActionFields`（按名字索引、后者覆盖前者）服务于"完整性登记表"；
 * 按实参个数消歧需要**全部声明**，所以另开一个不丢声明的收集器。
 * @param files - 非测试 Go 源文件。
 * @returns 声明列表。
 */
export function findAuditActionFieldList(files: readonly GoSourceFile[]): AuditActionField[] {
  const out: AuditActionField[] = []
  for (const file of files) {
    const text = blankComments(file.text)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = FUNC_FIELD_RE.exec(lines[i]!)
      if (m === null) continue
      const name = m[1]!
      const open = lines[i]!.indexOf('(', m.index)
      const offset = lines.slice(0, i).reduce((acc, l) => acc + l.length + 1, 0) + open
      const close = matchParen(text, offset)
      const params = parseParamNames(text.slice(offset + 1, close))
      const actionArg = actionParamIndex(params)
      if (actionArg === null) continue
      out.push({ name, file: file.path, line: i + 1, actionArg, arity: params.length })
    }
  }
  return out
}

/** `func(… action …)` 型结构体字段（注入式审计出口）。 */
export interface AuditActionField {
  name: string
  file: string
  line: number
  actionArg: number
  /** 形参个数（用于按**实参个数**消歧同名出口的多种签名）。 */
  arity: number
}

export interface AuditGraphAnalysis {
  /** 动作名 → `file:line`（闭包内首次出现处）。 */
  actions: Map<string, string>
  /** 承载动作的参数位：`dir|recv|name` → 参数下标集合（含种子自身）。 */
  carriers: Map<string, number[]>
  /** 直接写 audit_logs 的函数。 */
  rowWriters: Map<string, AuditRowWriter>
  /** `func(… action …)` 型结构体字段。 */
  auditFields: Map<string, AuditActionField>
  /** `INSERT INTO audit_logs` 在非测试 Go 源码里的总命中数（0 = 面变了，必须红）。 */
  insertStatements: number
}

const GO_KEYWORDS = new Set([
  'if', 'for', 'func', 'switch', 'select', 'return', 'go', 'defer', 'range',
  'var', 'type', 'struct', 'interface', 'map', 'chan', 'case', 'else', 'package', 'import',
])

/** 结构体字段形态 `Name func(…)`（`go func()`/`defer func()` 不是字段）。 */
const FUNC_FIELD_RE = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]+func[ \t]*\(/u

/**
 * 把注释换成**等长空格**（保留换行与所有偏移）：解析在清零文本上做，报错行号与原文一致。
 * @param src - 源码。
 * @returns 等长、已清零注释的文本。
 */
export function blankComments(src: string): string {
  const out = [...src]
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) {
        // 反引号是**原始字符串**：里面的反斜杠不转义，否则 `\` 会把收尾反引号吃掉。
        if (quote !== '`' && src[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i)
      if (end < 0) end = src.length
      blank(i, end)
      i = end
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    i++
  }
  return out.join('')
}

/** 行号（1 基）由偏移推出。 */
function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

/** 找与 `open` 处 `(` 配对的 `)`（跳过字符串/字符/注释已清零）。 */
function matchParen(text: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== null) {
      if (quote !== '`' && ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`括号不闭合（offset=${open}）：Go 源码解析器失效，对拍必须 fail-loud`)
}

/** 找与 `open` 处 `{` 配对的 `}`。 */
function matchBrace(text: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== null) {
      if (quote !== '`' && ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`花括号不闭合（offset=${open}）：Go 源码解析器失效，对拍必须 fail-loud`)
}

/**
 * 按**顶层逗号**切分实参/形参串（跳过括号、方括号、花括号与字符串里的逗号）。
 * @param src - 待切分文本。
 * @returns 各段（未 trim）。
 */
export function splitTopLevel(src: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quote !== null) {
      cur += ch
      if (ch === '\\') { cur += src[++i] ?? ''; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; continue }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim() !== '') out.push(cur)
  return out
}

/**
 * 解析形参表 ⇒ 形参名列表（处理 `a, b string` 这类共享类型的写法与嵌套类型）。
 * @param paramsSrc - 形参表内部文本（不含外层括号）。
 * @returns 形参名（按位置）。
 */
export function parseParamNames(paramsSrc: string): string[] {
  const names: string[] = []
  let pending: string[] = []
  for (const raw of splitTopLevel(paramsSrc)) {
    const tokens = raw.trim().split(/\s+/u).filter((t) => t !== '')
    if (tokens.length === 0) continue
    if (tokens.length === 1) {
      pending.push(tokens[0]!)
      continue
    }
    for (const name of [...pending, tokens[0]!]) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && name !== '_') names.push(name)
    }
    pending = []
  }
  for (const name of pending) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && name !== '_') names.push(name)
  }
  return names
}

/**
 * 解析一个文件里的顶层 `func` 声明（方法含 receiver；函数字面量不算）。
 * @param file - 源文件。
 * @returns 声明列表。
 */
export function parseGoFuncs(file: GoSourceFile): GoFuncInfo[] {
  const text = blankComments(file.text)
  const dir = file.path.split('/').slice(0, -1).pop() ?? ''
  const out: GoFuncInfo[] = []
  const re = /\bfunc\b/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let i = m.index + 4
    while (i < text.length && /\s/u.test(text[i]!)) i++
    let receiver: string | null = null
    let name: string
    if (text[i] === '(') {
      // `func (r T) Name(` = 方法；`func(a int) error {` = 函数字面量（跳过）。
      const recvEnd = matchParen(text, i)
      let j = recvEnd + 1
      while (j < text.length && /\s/u.test(text[j]!)) j++
      const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(j))
      if (nameMatch === null) continue
      let k = j + nameMatch[0].length
      while (k < text.length && /\s/u.test(text[k]!)) k++
      if (text[k] !== '(') continue
      receiver = text.slice(i + 1, recvEnd).trim()
      name = nameMatch[0]
      i = k
    } else {
      const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(text.slice(i))
      if (nameMatch === null) continue
      name = nameMatch[0]
      i += name.length
      while (i < text.length && /\s/u.test(text[i]!)) i++
      if (text[i] !== '(') continue
    }
    const paramsEnd = matchParen(text, i)
    const params = parseParamNames(text.slice(i + 1, paramsEnd))
    // 跳过返回值（可能带括号），找函数体 `{`
    let j = paramsEnd + 1
    while (j < text.length && text[j] !== '{') {
      if (text[j] === '(') j = matchParen(text, j)
      else if (text[j] === '\n' && text.slice(paramsEnd, j).includes('\n\n')) break
      j++
    }
    if (text[j] !== '{') continue
    const bodyEnd = matchBrace(text, j)
    out.push({
      file: file.path,
      dir,
      receiver,
      name,
      params,
      body: text.slice(j + 1, bodyEnd),
      bodyStart: j + 1,
      bodyEnd,
    })
    re.lastIndex = bodyEnd
  }
  return out
}

/** 函数稳定 id：`dir|recv|name`（同名不同包/不同接收者不互相污染）。 */
export function funcId(f: GoFuncInfo): string {
  return `${f.dir}|${f.receiver ?? ''}|${f.name}`
}

/** 包级字符串常量/变量（`const X = "…"` / `var X = "…"`，含 `const ( … )` 分组）。 */
export interface GoStringConst {
  name: string
  value: string
  file: string
  line: number
}

const CONST_GROUP_OPEN = /^[\t ]*(?:const|var)[\t ]*\([\t ]*$/u
const CONST_GROUP_ENTRY = /^[\t ]*([A-Za-z_][A-Za-z0-9_]*)[\t ]*(?:[A-Za-z_][A-Za-z0-9_.\[\]*]*[\t ]+)?=[\t ]*"((?:[^"\\]|\\.)*)"[\t ]*$/u
const CONST_SINGLE = /^[\t ]*(?:const|var)[\t ]+([A-Za-z_][A-Za-z0-9_]*)[\t ]*(?:[A-Za-z_][A-Za-z0-9_.\[\]*]*[\t ]+)?=[\t ]*"((?:[^"\\]|\\.)*)"[\t ]*$/u

/**
 * 收集包级字符串常量（键 = `目录|名字`，与函数解析的包近似口径一致）。
 *
 * 只处理**单行**赋值形态（Go 里动作名常量都是这个形态）；分组 `const ( … )` 的每个条目
 * 同样按行解析。字面量里的转义按 Go 语义原样保留（动作名不含转义，不影响正确性）。
 * @param files - 非测试 Go 源文件。
 * @returns 常量表。
 */
export function collectStringConsts(files: readonly GoSourceFile[]): Map<string, GoStringConst> {
  const out = new Map<string, GoStringConst>()
  for (const file of files) {
    const text = blankComments(file.text)
    const dir = file.path.split('/').slice(0, -1).pop() ?? ''
    const lines = text.split('\n')
    let inGroup = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (CONST_GROUP_OPEN.test(line)) {
        inGroup = true
        continue
      }
      if (inGroup) {
        if (/^[\t ]*\)[\t ]*$/u.test(line)) {
          inGroup = false
          continue
        }
        const m = CONST_GROUP_ENTRY.exec(line)
        if (m !== null) out.set(`${dir}|${m[1]!}`, { name: m[1]!, value: m[2]!, file: file.path, line: i + 1 })
        continue
      }
      const single = CONST_SINGLE.exec(line)
      if (single !== null) out.set(`${dir}|${single[1]!}`, { name: single[1]!, value: single[2]!, file: file.path, line: i + 1 })
    }
  }
  return out
}

/** 一次调用：被调名 + 限定符（`pkg.Fn` 的 `pkg`）+ 顶层实参。 */
export interface CallSite {
  name: string
  qualifier: string | null
  args: string[]
  /** 实参串起始偏移（`(` 之后）。 */
  argsStart: number
}

/**
 * 扫描文本里所有"像调用"的位置（排除 Go 关键字）。
 * @param text - 已注释清零的文本。
 * @returns 调用点列表。
 */
export function scanCalls(text: string): CallSite[] {
  const out: CallSite[] = []
  const re = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[ \t]*\(/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const chain = m[1]!
    const segments = chain.split('.')
    const name = segments[segments.length - 1]!
    if (GO_KEYWORDS.has(name)) continue
    const qualifier = segments.length > 1 ? segments[segments.length - 2]! : null
    const open = m.index + m[0].length - 1
    const close = matchParen(text, open)
    out.push({ name, qualifier, args: splitTopLevel(text.slice(open + 1, close)), argsStart: open + 1 })
    re.lastIndex = close
  }
  return out
}

/** 解析函数字面量 `func(params) … { body }`（含 `Field: func(...) {…}` 的赋值形态）。 */
export interface FuncLiteral {
  file: string
  params: string[]
  body: string
  /** 若该字面量出现在 `Name: func(` 的复合字面量字段位上，则为字段名。 */
  fieldName: string | null
}

/**
 * 找文件里的函数字面量（含字段赋值位上的字段名）。
 * @param file - 源文件。
 * @returns 字面量列表。
 */
export function parseFuncLiterals(file: GoSourceFile): FuncLiteral[] {
  const text = blankComments(file.text)
  const out: FuncLiteral[] = []
  const re = /\bfunc[ \t]*\(/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('(', m.index)
    // 方法声明也是 `func (` —— 但方法声明后面跟标识符 + `(`，字面量后面直接是返回类型/`{`。
    const paramsEnd = matchParen(text, open)
    let j = paramsEnd + 1
    while (j < text.length && /\s/u.test(text[j]!)) j++
    if (/^[A-Za-z_][A-Za-z0-9_]*/u.test(text.slice(j))) {
      const after = text.slice(j).match(/^[A-Za-z_][A-Za-z0-9_]*\s*\(/u)
      if (after !== null) continue // 方法声明
    }
    let k = paramsEnd + 1
    while (k < text.length && text[k] !== '{') {
      if (text[k] === '(') k = matchParen(text, k)
      else k++
    }
    if (text[k] !== '{') continue
    const bodyEnd = matchBrace(text, k)
    // 字段位形态：`Name: func(…) {…}` —— 取同一行 `func` 之前的前缀 `Name:`。
    const linePrefix = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index)
    const fieldName = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*$/u.exec(linePrefix)?.[1] ?? null
    out.push({
      file: file.path,
      params: parseParamNames(text.slice(open + 1, paramsEnd)),
      body: text.slice(k + 1, bodyEnd),
      fieldName,
    })
    re.lastIndex = bodyEnd
  }
  return out
}

/** 动作形参下标（形参里叫 `action` 的那个位置）。 */
function actionParamIndex(params: readonly string[]): number | null {
  const i = params.indexOf('action')
  return i >= 0 ? i : null
}

/** 直接写 `audit_logs` 的函数（`INSERT INTO audit_logs` 语句所在函数）。 */
export function findAuditRowWriters(files: readonly GoSourceFile[]): Map<string, AuditRowWriter> {
  const out = new Map<string, AuditRowWriter>()
  for (const file of files) {
    const text = blankComments(file.text)
    for (const f of parseGoFuncs(file)) {
      const at = f.body.indexOf('INSERT INTO audit_logs')
      if (at < 0) continue
      out.set(f.name, {
        name: f.name,
        file: file.path,
        line: lineAt(text, f.bodyStart + at),
        actionArg: actionParamIndex(f.params),
      })
    }
  }
  return out
}

/** `func(… action …)` 型结构体字段（注入式审计出口）。 */
export function findAuditActionFields(files: readonly GoSourceFile[]): Map<string, AuditActionField> {
  const out = new Map<string, AuditActionField>()
  for (const file of files) {
    const text = blankComments(file.text)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = FUNC_FIELD_RE.exec(lines[i]!)
      if (m === null) continue
      const name = m[1]!
      const open = lines[i]!.indexOf('(', m.index)
      // 字段可能跨行；用全文偏移找配对括号。
      const offset = lines.slice(0, i).reduce((acc, l) => acc + l.length + 1, 0) + open
      const close = matchParen(text, offset)
      const params = parseParamNames(text.slice(offset + 1, close))
      const actionArg = actionParamIndex(params)
      if (actionArg === null) continue
      out.set(name, { name, file: file.path, line: i + 1, actionArg, arity: params.length })
    }
  }
  return out
}

/**
 * `server/internal/serverstore/audit.go` 里"声明了 action 形参且能到达写入点"的函数。
 *
 * 这是 store sink 登记表的**完整性判据**：新增一个 `AuditLogXxx(db, username, action, detail)`
 * 并接到写入链上（直接 INSERT 或经本文件内的转发）⇒ 这里多出一条 ⇒ 未登记即红。
 * @param file - audit.go（单文件；跨文件转发由调用图闭包负责）。
 * @returns 函数名 → 动作形参下标。
 */
export function deriveStoreAppenders(file: GoSourceFile): Map<string, number> {
  const funcs = parseGoFuncs(file)
  const rowWriters = funcs.filter((f) => f.body.includes('INSERT INTO audit_logs')).map((f) => f.name)
  if (rowWriters.length === 0) {
    throw new Error(`${file.path} 里没有任何 INSERT INTO audit_logs：审计写入面变了，对拍必须 fail-loud`)
  }
  const reach = new Set<string>(rowWriters)
  for (let round = 0; round < 32; round++) {
    let grew = false
    for (const f of funcs) {
      if (reach.has(f.name)) continue
      for (const callee of reach) {
        if (new RegExp(`\\b${callee}\\s*\\(`, 'u').test(f.body)) {
          reach.add(f.name)
          grew = true
          break
        }
      }
    }
    if (!grew) break
  }
  const out = new Map<string, number>()
  for (const f of funcs) {
    if (!reach.has(f.name)) continue
    const idx = actionParamIndex(f.params)
    if (idx !== null) out.set(f.name, idx)
  }
  return out
}

/**
 * 建"哪些函数/出口能把动作写进审计行"的闭包，并抽出闭包内每个承载位上的动作名字面量。
 * @param files - 非测试 Go 源文件。
 * @param seeds - 已登记的 sink（调用名 + 动作实参下标）。
 * @returns 闭包分析结果。
 */
export function analyzeAuditGraph(
  files: readonly GoSourceFile[],
  seeds: readonly AuditSinkSeed[],
): AuditGraphAnalysis {
  const texts = new Map<string, string>()
  const funcs: GoFuncInfo[] = []
  for (const file of files) {
    texts.set(file.path, blankComments(file.text))
    funcs.push(...parseGoFuncs(file))
  }
  const byName = new Map<string, GoFuncInfo[]>()
  for (const f of funcs) {
    const list = byName.get(f.name)
    if (list === undefined) byName.set(f.name, [f])
    else list.push(f)
  }

  /** 名字解析：优先"限定符 == 目录名"，其次"同目录"，最后全部同名（宁松勿漏）。 */
  const resolve = (call: CallSite, callDir: string): GoFuncInfo[] => {
    const all = byName.get(call.name) ?? []
    if (all.length === 0) return []
    if (call.qualifier !== null) {
      const byDir = all.filter((f) => f.dir.toLowerCase() === call.qualifier!.toLowerCase())
      if (byDir.length > 0) return byDir
    }
    const sameDir = all.filter((f) => f.dir === callDir)
    if (sameDir.length > 0) return sameDir
    return all
  }

  // 种子：登记 sink 的调用名 → 动作实参位（sink 是函数字面量字段时没有声明，靠 virtual）
  const carriers = new Map<string, Set<number>>()
  const virtual = new Map<string, Set<number>>()
  for (const seed of seeds) {
    const add = (map: Map<string, Set<number>>, key: string) => {
      const set = map.get(key)
      if (set === undefined) map.set(key, new Set([seed.actionArg]))
      else set.add(seed.actionArg)
    }
    add(virtual, seed.name)
    for (const f of byName.get(seed.name) ?? []) add(carriers, funcId(f))
  }

  /**
   * 已**声明**的出口签名（名字 → [{动作形参位, 形参个数}]）。
   *
   * 为什么需要它：同一个出口名可能有多种签名（`Audit` 在 `handlers.Options` 里是
   * `func(username, ACTION, detail)`、在 `retirement.Scheduler` 里是
   * `func(appID, username, ACTION, detail)`）。登记表把两种动作位都记在**同一个名字**下，
   * 于是 `s.opt.Audit(cand.AppID, auditActor, auditAction, detail)` 的第 1 位
   * （`auditActor = "system"`）也会被当成"承载动作的位" —— 识别 const 实参之后，
   * `"system"` 就会凭空变成一个待补标签的审计动作。
   *
   * 按**实参个数**消歧即可：4 个实参的调用只可能是 4 参签名（动作在 2）。
   */
  const declaredShapes = new Map<string, { actionArg: number; arity: number }[]>()
  const addShape = (name: string, actionArg: number, arity: number) => {
    const list = declaredShapes.get(name)
    if (list === undefined) declaredShapes.set(name, [{ actionArg, arity }])
    else if (!list.some((s) => s.actionArg === actionArg && s.arity === arity)) list.push({ actionArg, arity })
  }
  for (const f of funcs) {
    const idx = f.params.indexOf('action')
    if (idx >= 0) addShape(f.name, idx, f.params.length)
  }
  for (const field of findAuditActionFieldList(files)) addShape(field.name, field.actionArg, field.arity)

  const carrierArgs = (call: CallSite, callDir: string): Set<number> => {
    const out = new Set<number>(virtual.get(call.name) ?? [])
    for (const f of resolve(call, callDir)) {
      for (const idx of carriers.get(funcId(f)) ?? []) out.add(idx)
    }
    if (out.size === 0) return out
    // 实参个数能唯一对上某个已声明签名 ⇒ 只认那个签名的动作位（消歧）；
    // 对不上（未声明/变参）⇒ 保留全部登记位（宁松勿漏）。
    const matched = (declaredShapes.get(call.name) ?? []).filter((shape) => shape.arity === call.args.length)
    const narrowed = matched.map((shape) => shape.actionArg).filter((idx) => out.has(idx))
    return narrowed.length > 0 ? new Set(narrowed) : out
  }

  // 不动点：把"承载动作的形参位"沿调用图向外传播（多层包装/形参透传）。
  for (let round = 0; round < 32; round++) {
    let grew = false
    for (const f of funcs) {
      const id = funcId(f)
      for (const call of scanCalls(f.body)) {
        const idxs = carrierArgs(call, f.dir)
        if (idxs.size === 0) continue
        for (const idx of idxs) {
          const arg = call.args[idx]?.trim()
          if (arg === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(arg)) continue
          const paramIdx = f.params.indexOf(arg)
          if (paramIdx < 0) continue
          let set = carriers.get(id)
          if (set === undefined) {
            set = new Set<number>()
            carriers.set(id, set)
          }
          if (!set.has(paramIdx)) {
            set.add(paramIdx)
            grew = true
          }
        }
      }
    }
    if (!grew) break
  }

  // 抽动作名：扫描全部文件（含包级复合字面量里的函数字面量体），承载位上认两种形态：
  //   ① 字符串字面量 `"wasm_app_delete"`；
  //   ② 同包（同目录）的包级 const/var 标识符（反证 F-7：`const auditAction = "wasm_app_purge"`
  //      ⇒ 承载位上是 `auditAction`，只认字面量的口径会整条漏掉）。
  const consts = collectStringConsts(files)
  const actions = new Map<string, string>()
  for (const [path, text] of texts) {
    const dir = path.split('/').slice(0, -1).pop() ?? ''
    for (const call of scanCalls(text)) {
      const idxs = carrierArgs(call, dir)
      if (idxs.size === 0) continue
      for (const idx of idxs) {
        const arg = call.args[idx]?.trim()
        if (arg === undefined) continue
        const literal = /^"([^"]*)"$/u.exec(arg)
        if (literal !== null) {
          const action = literal[1]!
          if (!actions.has(action)) actions.set(action, `${path}:${lineAt(text, call.argsStart)}`)
          continue
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(arg)) continue
        const resolved = consts.get(`${dir}|${arg}`)
        if (resolved === undefined) continue
        if (!actions.has(resolved.value)) actions.set(resolved.value, `${resolved.file}:${resolved.line}`)
      }
    }
  }

  const carriersOut = new Map<string, number[]>()
  for (const [id, set] of carriers) carriersOut.set(id, [...set].sort((a, b) => a - b))
  return {
    actions,
    carriers: carriersOut,
    rowWriters: findAuditRowWriters(files),
    auditFields: findAuditActionFields(files),
    insertStatements: [...texts.values()].reduce(
      (acc, t) => acc + t.split('INSERT INTO audit_logs').length - 1,
      0,
    ),
  }
}
