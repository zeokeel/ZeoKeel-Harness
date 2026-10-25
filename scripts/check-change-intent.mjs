#!/usr/bin/env node
/**
 * 变更记录判据（第 20 条根守卫 `check:change-intent` 的判据本体）。
 *
 * ## 为什么要有它
 *
 * `changes/README.md` 已经把"一次意图"的字段规则写成了文字：`id` / `status` / `intent` /
 * `modules` 必填，`accepted` 起必须有可证伪的 `acceptance`，`verified` 起必须有
 * `verification`。但**只有文字、没有判据**的纪律在本仓已经被证明守不住：
 * `server/docs/06-database.md` 写下"已应用的迁移永不原地修改"的**次日**就有人违反，直到
 * `check-migration-range.mjs` 把那条纪律变成 sha256 对拍（见该脚本头注释）。同一形态的
 * 缺口就在这里 —— "验收前置"只存在于文档里时，跳过 `acceptance` 写代码既不会红、也不会被
 * 任何人发现。本脚本把 README 的字段规则变成机器判据，让"没写验收标准就动手"这件事在
 * 门禁上显形。
 *
 * ## 判据（全部 fail-closed）
 *
 * 扫 `changes/*.json`（`_template.json` 见 ⑧"模板同判"），对每条记录判：
 *   ① **坏 JSON** ⇒ 红（含解析器给的**原因**；Node 24 的 `JSON.parse` 只给原因、不给行列），
 *      **不**降级成"跳过这条"；首字节 UTF-8 BOM 先剥
 *      （`\uFEFF` 会让 `JSON.parse` 整份失败，而"用 Windows 记事本另存一下"完全不是违规
 *      本意；先例：`check-install-integrity.mjs` 的 `.replace(/^\uFEFF/u, '')`）；
 *   ② `id` 非空 string 且**必须等于文件名去扩展名** —— 记录身份与路径不允许漂移
 *      （改名只改文件、`id` 不动时，历史引用与 `git log --follow` 就对不上了）；
 *   ③ `status` ∈ `proposed | accepted | implemented | verified`（README §命名与生命周期）；
 *   ④ `intent` 为 `{zh,en}` 两个**非空** string（README：写"为什么"，不是"改了什么"）；
 *   ⑤ `modules` 为**仓库相对路径**数组，允许 `[]`（README §字段规则：「空的用 `[]`」）：
 *      条目必须是非空 string，且拒绝四类"不是仓库相对路径"的写法 —— `path.isAbsolute`、
 *      `C:/` 这种 POSIX 下 `isAbsolute` 看不出的 Windows 盘符、含 `\`、以及**任何路径段是
 *      `..`**（`/` 与 `\` 两种分隔都拆开看：`packages/../../outside.ts`、`a/../../b` 同样
 *      会跳出仓库 —— 只判"以 `..` 开头"会放过它们）；
 *   ⑥ `accepted`/`implemented`/`verified` ⇒ `acceptance` **至少 1 条**，每条
 *      `{criterion,evidence,command}` 均非空 string，`evidence` ∈ `test|guard|probe|manual`；
 *      `criterion` 另过一条最小 denylist（见 ⑨）；
 *   ⑦ `verified` ⇒ `verification` **至少 1 条**，每条 `{command,result}` 非空 string，
 *      **且每条 `acceptance[].command` 必须在 `verification[].command` 里有一条 trim 后逐字
 *      相等的条目**（README：verified = 每条 acceptance 都有实际命令输出；只数条数等于允许
 *      "验收写了 3 条、实际只跑了 1 条"）。缺失按 acceptance 索引逐条报；
 *   ⑧ `_template.json` **不再整份跳过**：用同一套判据校验，**只放宽 `id`**（模板的 id 是
 *      占位符 `YYYY-MM-DD-kebab-slug`，不要求等于文件名）。理由：模板是"怎么写"的唯一样板，
 *      它腐烂（字段改名/丢字段/写回 ❌ 措辞）时没有任何判据看得见；
 *      **模板不是符号链接例外**：`_template.json` 与记录一样必须是**普通文件**（与 §扫描面
 *      同一条纪律 —— 分类顺序先判 `isFile`、再落模板分支，否则"模板是符号链接"会与文档
 *      字面矛盾）；
 *   ⑨ `criterion` 的**最小 denylist**：含 README §验收标准写法 明列的三个 ❌ 短语
 *      （「界面正常显示」「逻辑正确」「符合预期」）⇒ 红。这是**启发式**的一条下限，不是
 *      "验收质量"的判据 —— 真语义仍归人评审；后续可以收紧（棘轮），别为它开路豁免。
 *
 * ## 扫描面（**不允许静默忽略**）
 *
 * 采用 **(b) 顶层只认小写 `.json`**，其余形态一律 **exit 2** 并说明原因：
 *   · `changes/` 下出现**子目录**（如 `archive/`）⇒ exit 2 —— 子目录里的 `*.json` 不会被
 *     判据看到，而 OK 行却会宣称"全部合规"；记录必须在顶层、能进 diff 被评审；
 *   · 名字看起来是 JSON 但**扩展名不是小写**（`X.JSON`、`X.Json`）⇒ exit 2 —— 静默忽略
 *     等于给它一个"改个大小写就逃出判据"的开关；
 *   · 名字是记录却**不是普通文件**（目录/符号链接）⇒ exit 2；
 *   · 真正不参与判据的只有**不叫 `*.json`** 的文件（`README.md`、`notes.jsonc` 等）。
 *
 * 任何一处不成立 ⇒ **逐条打印**后 exit 1；全部通过 ⇒ 一行 OK（含记录数）。
 *
 * ## 退出码
 *
 *   0 = 所有记录（含模板）合规；
 *   1 = 有记录不合规（坏 JSON / 类型错 / 非法枚举 / 缺必填 / 路径形态 / denylist /
 *       verified 的命令对不上）；
 *   2 = **前置失败**：`changes/` 目录不存在、目录读不动、某条记录读不动、扫描面出现上面列的
 *       子目录/大写扩展名/非普通文件、**除模板外一条记录都没有**、`--selftest` 与 `--root`
 *       同时出现。与 `check-migration-range.mjs` 的"拒绝把空集当通过"同一取向：扫描面为 0
 *       时本判据什么都没判，这时打印 OK 就是在冒充"覆盖面"（本仓多次栽在"通过行比覆盖面宽"）。
 *
 * 用法：node scripts/check-change-intent.mjs [--root <dir> | --selftest]
 *   · 默认根 = **脚本自己的仓库根**（`import.meta.url` 相对推导，与 cwd 无关）；
 *   · `--root <dir>` 把 `changes/` 换成 `<dir>/changes`（探针/变异副本用，避免污染真仓）；
 *   · `--selftest` 用**内存样本**证明"坏记录会红、好记录不误红"——不读盘、不写盘；
 *     两个参数**互斥**（自证不该顺带读某棵树，静默丢弃 root 会让人以为它判了那份输入）。
 *
 * ## 边界（认账，别把这句通过读成比它更宽的承诺）
 *
 * - 它判的是**形状**，不是**真伪**：无法验证 `acceptance.command` 真跑过、`verification.result`
 *   是真实输出。语义真伪仍归人评审，本守卫只保证"该写的位置上不是空的/不是瞎编的枚举值"。
 * - ⑦ 的对拍是**字符串**对拍：同一行命令写法不同（多一个空格之外的差别、包一层 shell）就会
 *   被判红 —— 这是有意的（"同一件事"应当写成同一行命令）；但它**不**证明执行成功，只证明
 *   "登记过"。
 * - ⑨ 是**启发式**：README 之后新增的 ❌ 措辞不会自动被拦，改了措辞的假验收也拦不住；它只
 *   兜住 README 已经点名的那三种最廉价写法。
 * - 它**不**校验 `modules` 里的路径是否存在：计划中的文件常常晚于记录落地，绑到树状态会
 *   制造假红（`docs/planning` 的路线本来就把记录写在实现之前）。
 * - 它**不**强制 `<YYYY-MM-DD>-<slug>.json` 命名：README 的命名是一致性约定，而 `id ==
 *   文件名` 已经钉住了"身份不许和路径漂移"这条真正会影响引用的事。
 * - 模板**缺失**不判红（本脚本只管"在场就要合规"），但 OK 行会如实写"模板缺失，未判"。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 脚本自身所在的**仓库根**（与调用方 cwd 无关；理由同 `check-migration-range.mjs`）。 */
const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 记录目录（相对根）。 */
const CHANGES_DIR = 'changes'
/** 模板是"怎么写"的示范：不按记录计数，但**要判**（见头注释 ⑧）。 */
const TEMPLATE_FILE = '_template.json'
/** README §命名与生命周期 的四态（顺序即生命周期，别改）。 */
const STATUSES = ['proposed', 'accepted', 'implemented', 'verified']
/** README §字段规则：`evidence` 的四类证据来源（test | guard | probe | manual）。 */
const EVIDENCES = ['test', 'guard', 'probe', 'manual']
/** 记录的文件扩展名：**只认小写**（大写形态走 exit 2，理由见头注释 §扫描面）。 */
const RECORD_EXTENSION = '.json'
/**
 * README §验收标准写法 明列的三个 ❌（「界面正常显示」/「逻辑正确」/「符合预期」）。
 * 命中即红 —— 这是**启发式**下限（头注释 ⑨）：只为拦住最廉价的那三种"没法证伪"的写法。
 */
const VAGUE_CRITERIA = ['界面正常显示', '逻辑正确', '符合预期']
/** 首字节 UTF-8 BOM（U+FEFF）：剥掉再解析，不然"用记事本另存一下"就成了整份坏 JSON。 */
const LEADING_BOM = /^\uFEFF/u
/** POSIX 下 `path.isAbsolute` 看不出 `C:/x` 这种 Windows 盘符绝对路径，单独补一条。 */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u

/**
 * 一条记录/样本的**文件形态**（磁盘文件或 `--selftest` 的内存样本走同一套判据）。
 * @typedef {{ fileName: string, text: string, relaxedId?: boolean }} ChangeRecordSource
 */

/**
 * `--selftest` 的一条断言。
 * @typedef {{ name: string, fileName: string, text: string, expected: RegExp | null, relaxedId?: boolean }} SelftestSample
 */

/**
 * @param {unknown} value 待判定值。
 * @returns {value is Record<string, unknown>} `true` = 普通对象（不是 null、不是数组）。
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 去掉首尾空白后的非空字符串。
 * @param {unknown} value 待判定值。
 * @returns {string | null} 非空 string ⇒ 值本身；否则 `null`（空白串也算"没写"）。
 */
function nonEmptyString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 诊断里的短值描述（类型错时点名"实际是什么"，别只写"类型不对"）。
 * @param {unknown} value 任意值。
 * @returns {string} 截断到 120 字符的 JSON 片段（`undefined` 单独说明）。
 */
function describeValue(value) {
  if (value === undefined) return '（缺失）'
  const json = JSON.stringify(value)
  const text = json === undefined ? String(value) : json
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

/**
 * 这个名字**看起来**是个 JSON 文件（任意大小写）—— 用来判"扩展名大小写不对"这一类，
 * 与"是不是记录"分开：前者要 fail-loud，后者才决定参不参与判据。
 * @param {string} fileName `changes/` 下的目录项名。
 * @returns {boolean} `true` = 大小写归一后是 `.json`。
 */
function looksLikeJson(fileName) {
  return fileName.toLowerCase().endsWith(RECORD_EXTENSION)
}

/**
 * `changes/` 里一个目录项的处理方式（纯函数，`--selftest` 直接断言它）。
 *
 * **不允许静默忽略**（头注释 §扫描面）：只有"名字根本不是 JSON"的文件可以跳过。
 * @param {string} name 目录项名。
 * @param {{ isFile: boolean, isDirectory: boolean }} kind `Dirent` 的类型判定结果。
 * @returns {{ action: 'record' } | { action: 'template' } | { action: 'ignore' } | { action: 'fail', reason: string }}
 *   处理动作；`fail` ⇒ 调用方 exit 2。
 */
function classifyEntry(name, kind) {
  if (kind.isDirectory) {
    return {
      action: 'fail',
      reason: `${name} 是目录 —— 记录必须是 ${CHANGES_DIR}/ 顶层的普通文件；子目录里的 *.json`
        + ' 不会被本判据看到，而 OK 行会照样宣称"全部合规"',
    }
  }
  // 顺序有意：**先判普通文件、再落模板分支** —— 否则 `_template.json` 是符号链接时会被当
  // 模板读，与头注释 §扫描面（"名字是记录却不是普通文件 ⇒ exit 2"）字面矛盾。
  if (!kind.isFile) {
    if (looksLikeJson(name)) {
      return {
        action: 'fail',
        reason: `${name} 不是普通文件（符号链接/其它）—— 模板与记录都必须是普通文件、能进 diff 评审`,
      }
    }
    return { action: 'ignore' }
  }
  if (name === TEMPLATE_FILE) return { action: 'template' }
  if (looksLikeJson(name) && !name.endsWith(RECORD_EXTENSION)) {
    return {
      action: 'fail',
      reason: `${name} 的扩展名不是小写 \`.json\` —— 只认小写；大小写不同会让它静默逃出判据`,
    }
  }
  if (!name.endsWith(RECORD_EXTENSION)) return { action: 'ignore' }
  return { action: 'record' }
}

/**
 * `acceptance` 条目的形状判据。
 *
 * `command` 对**所有** evidence 都必填（不只是 `manual`）：README 的唯一硬要求是"能回答
 * 跑什么、看到什么、算通过"，`manual` 的人工步骤也写在同一格 —— 于是"command 非空"同时
 * 覆盖了"人工步骤必须写清"，且更强（`test`/`guard`/`probe` 缺命令同样无法复核）。
 * @param {string} at 诊断里的字段路径（如 `acceptance[0]`）。
 * @param {unknown} entry 待判定的条目值。
 * @returns {string[]} 问题列表（空 = 合规）。
 */
function acceptanceEntryProblems(at, entry) {
  if (!isPlainObject(entry)) {
    return [`\`${at}\` 必须是 {criterion,evidence,command} 对象（实际 ${describeValue(entry)}）`]
  }
  const problems = []
  // criterion 单独判（要过 denylist），command 只判非空。
  const criterion = nonEmptyString(entry.criterion)
  if (criterion === null) {
    problems.push(`\`${at}.criterion\` 必须是非空字符串`)
  } else {
    const vague = VAGUE_CRITERIA.find(phrase => criterion.includes(phrase))
    if (vague !== undefined) {
      problems.push(`\`${at}.criterion\` 含 README 明列的不合法写法「${vague}」—— 验收标准要能回答`
        + '"跑什么、看到什么、算通过"（启发式 denylist，后续可棘轮）')
    }
  }
  if (nonEmptyString(entry.command) === null) problems.push(`\`${at}.command\` 必须是非空字符串`)
  const evidence = nonEmptyString(entry.evidence)
  if (evidence === null) {
    problems.push(`\`${at}.evidence\` 必须是非空字符串（${EVIDENCES.join(' | ')} 之一）`)
  } else if (!EVIDENCES.includes(evidence)) {
    problems.push(`\`${at}.evidence\` 不认识：${JSON.stringify(evidence)}（只允许 ${EVIDENCES.join(' | ')}）`)
  }
  return problems
}

/**
 * `verification` 条目的形状判据（README：verified 起必填，`[{command,result}]`）。
 * @param {string} at 诊断里的字段路径（如 `verification[0]`）。
 * @param {unknown} entry 待判定的条目值。
 * @returns {string[]} 问题列表（空 = 合规）。
 */
function verificationEntryProblems(at, entry) {
  if (!isPlainObject(entry)) {
    return [`\`${at}\` 必须是 {command,result} 对象（实际 ${describeValue(entry)}）`]
  }
  const problems = []
  for (const field of ['command', 'result']) {
    if (nonEmptyString(entry[field]) === null) problems.push(`\`${at}.${field}\` 必须是非空字符串`)
  }
  return problems
}

/**
 * 一条记录的全部字段判据（不含"文件是否记录/扫描面"那一层，便于 `--selftest` 复用）。
 * @param {ChangeRecordSource} source 文件或内存样本。
 * @returns {string[]} 问题列表（空 = 通过）；每条都带文件名前缀，可直接打印。
 */
function recordProblems(source) {
  const { fileName, text, relaxedId = false } = source
  const at = `${CHANGES_DIR}/${fileName}`
  /** @param {string} problem 字段级问题。 @returns {string} 带文件定位的诊断行。 */
  const wrap = problem => `${at}：${problem}`
  let data
  try {
    // 首字节 BOM 先剥（先例见头注释 ①）；只剥一次、只在开头。
    data = JSON.parse(text.replace(LEADING_BOM, ''))
  } catch (error) {
    // bad JSON **不能**降级成"跳过这条" —— 那正好是"改坏了就删掉"这类绕过的入口。
    return [wrap(`不是合法 JSON —— ${error.message}（坏 JSON 不是"没有记录"）`)]
  }
  if (!isPlainObject(data)) return [wrap(`顶层必须是对象（实际 ${describeValue(data)}）`)]

  const problems = []
  const stem = fileName.endsWith(RECORD_EXTENSION) ? fileName.slice(0, -RECORD_EXTENSION.length) : fileName

  // ① id == 文件名去扩展名（记录身份与路径同源）；模板放宽成"非空即可"（id 是占位符）。
  const id = nonEmptyString(data.id)
  if (id === null) {
    problems.push('`id` 必须是非空字符串')
  } else if (relaxedId !== true && id !== stem) {
    problems.push(`\`id\`（${JSON.stringify(id)}）必须等于文件名去扩展名（${JSON.stringify(stem)}）—— 记录身份与路径不允许漂移`)
  }

  // ② status ∈ 四态（未知值**不**当成 proposed 放行）。
  const status = nonEmptyString(data.status)
  const statusKnown = status !== null && STATUSES.includes(status)
  if (status === null) problems.push('`status` 必须是非空字符串')
  else if (!statusKnown) problems.push(`\`status\` 不认识：${JSON.stringify(status)}（只允许 ${STATUSES.join(' | ')}）`)

  // ③ intent：{zh,en} 两个非空 string（写"为什么"，不是"改了什么"）。
  const intent = data.intent
  if (!isPlainObject(intent)) {
    problems.push(`\`intent\` 必须是 {zh,en} 对象（实际 ${describeValue(intent)}）`)
  } else {
    for (const locale of ['zh', 'en']) {
      if (nonEmptyString(intent[locale]) === null) problems.push(`\`intent.${locale}\` 必须是非空字符串`)
    }
  }

  // ④ modules：仓库相对路径数组（没有可写模块时用 []）。
  const modules = data.modules
  if (!Array.isArray(modules)) {
    problems.push(`\`modules\` 必须是字符串数组（没有可写模块时用 \`[]\`；实际 ${describeValue(modules)}）`)
  } else {
    for (const [index, entry] of modules.entries()) {
      const value = nonEmptyString(entry)
      if (value === null) {
        problems.push(`\`modules[${index}]\` 必须是非空字符串（仓库相对路径）`)
        continue
      }
      if (isAbsolute(value) || WINDOWS_ABSOLUTE.test(value)) {
        problems.push(`\`modules[${index}]\` 是绝对路径（${describeValue(value)}）—— 只收**仓库相对**路径`)
        continue
      }
      if (value.includes('\\')) {
        problems.push(`\`modules[${index}]\` 含反斜杠（${describeValue(value)}）—— 仓库内路径一律用 \`/\``)
        continue
      }
      // 任何位置出现 `..` 段都算跳出仓库（只判"以 .. 开头"会放过 `packages/../../outside.ts`）；
      // 反斜杠刚在上一条被拒，这里仍按 `/` + `\` 拆，避免两处分隔符口径不一致。
      if (value.split(/[\\/]/u).includes('..')) {
        problems.push(`\`modules[${index}]\` 含 \`..\` 路径段（${describeValue(value)}）——`
          + ' 该路径可以跳出仓库（`packages/../../outside.ts` 这类同样要拦）')
      }
    }
  }

  // ⑤ acceptance：accepted 起至少 1 条（proposed 允许没有 —— README 允许评审用草稿）。
  const acceptanceRequired = statusKnown && status !== 'proposed'
  const acceptance = data.acceptance
  if (acceptance === undefined) {
    if (acceptanceRequired) {
      problems.push('`status` 是 ' + String(status) + ' 时 `acceptance` 必填且至少 1 条 —— '
        + '"accepted = 验收标准已定稿"，没有标准就开始写代码只能事后编故事')
    }
  } else if (!Array.isArray(acceptance)) {
    problems.push(`\`acceptance\` 必须是数组（实际 ${describeValue(acceptance)}）`)
  } else {
    if (acceptanceRequired && acceptance.length === 0) {
      problems.push('`status` 是 ' + String(status) + ' 时 `acceptance` 至少 1 条（现在是 0 条）')
    }
    for (const [index, entry] of acceptance.entries()) {
      for (const problem of acceptanceEntryProblems(`acceptance[${index}]`, entry)) problems.push(problem)
    }
  }

  // ⑥ verification：verified 起至少 1 条（实际跑过的命令 + 结论）。
  const verificationRequired = statusKnown && status === 'verified'
  const verification = data.verification
  if (verification === undefined) {
    if (verificationRequired) {
      problems.push('`status` 是 verified 时 `verification` 必填且至少 1 条 —— '
        + 'README：verified = 每条 acceptance 都有实际命令输出')
    }
  } else if (!Array.isArray(verification)) {
    problems.push(`\`verification\` 必须是数组（实际 ${describeValue(verification)}）`)
  } else {
    if (verificationRequired && verification.length === 0) {
      problems.push('`status` 是 verified 时 `verification` 至少 1 条（现在是 0 条）')
    }
    for (const [index, entry] of verification.entries()) {
      for (const problem of verificationEntryProblems(`verification[${index}]`, entry)) problems.push(problem)
    }
  }

  // ⑦ verified 的交叉对拍：每条 acceptance.command 都要在 verification[].command 里出现
  // （trim 后逐字相等）。只判条数会放过"验收写了 N 条、实际只跑了 1 条"这种形态。
  if (verificationRequired && Array.isArray(acceptance) && Array.isArray(verification)) {
    const verifiedCommands = new Set()
    for (const entry of verification) {
      if (!isPlainObject(entry)) continue
      const command = nonEmptyString(entry.command)
      if (command !== null) verifiedCommands.add(command)
    }
    for (const [index, entry] of acceptance.entries()) {
      if (!isPlainObject(entry)) continue
      const command = nonEmptyString(entry.command)
      if (command === null) continue // 形状判据已经报过
      if (verifiedCommands.has(command)) continue
      problems.push(`\`acceptance[${index}].command\` 在 \`verification[].command\` 里没有对应条目`
        + `（${describeValue(command)}）—— verified = 每条 acceptance 都有实际命令输出`)
    }
  }

  return problems.map(wrap)
}

/**
 * 收集 `<root>/changes` 下的记录源文件（按文件名排序，输出稳定）。
 * @param {string} root 仓库根。
 * @returns {{ records: ChangeRecordSource[], template: ChangeRecordSource | null } | null}
 *   记录源与模板；`null` = 前置失败（原因已打印，调用方 exit 2）。
 */
function collectSources(root) {
  const directory = join(root, CHANGES_DIR)
  if (!existsSync(directory)) {
    console.error(`check-change-intent: 找不到 ${directory} —— 拒绝把"扫不到"当通过`)
    return null
  }
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    console.error(`check-change-intent: 读不动 ${directory}（${error.message}）—— 拒绝把"扫不动"当通过`)
    return null
  }
  const records = []
  let template = null
  for (const entry of entries) {
    const decision = classifyEntry(entry.name, { isFile: entry.isFile(), isDirectory: entry.isDirectory() })
    if (decision.action === 'ignore') continue
    if (decision.action === 'fail') {
      // 静默忽略 = 该记录不参与判据，而 OK 行却照样绿（头注释 §扫描面）。
      console.error(`check-change-intent: ${decision.reason}（${join(directory, entry.name)}）——`
        + ' 拒绝静默忽略')
      return null
    }
    let text
    try {
      text = readFileSync(join(directory, entry.name), 'utf8')
    } catch (error) {
      // 一条读不动的记录不得静默跳过：跳过 = 该条判据不参与，而通过行却照样绿。
      console.error(`check-change-intent: 读不动 ${join(directory, entry.name)}（${error.message}）——`
        + ' 拒绝跳过一条读不动的记录')
      return null
    }
    if (decision.action === 'template') template = { fileName: entry.name, text }
    else records.push({ fileName: entry.name, text })
  }
  records.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
  return { records, template }
}

/**
 * 真仓模式：扫 `changes/` 判全部记录（模板同判、只放宽 id）。
 * @param {string} root 仓库根。
 * @returns {void}
 */
function runCheck(root) {
  const collected = collectSources(root)
  if (collected === null) process.exit(2)
  const { records, template } = collected
  if (records.length === 0) {
    console.error(`check-change-intent: ${CHANGES_DIR}/ 里除 ${TEMPLATE_FILE} 外没有任何 *.json 变更记录 ——`
      + ' 拒绝把空集当通过（模板不是记录；扫描面为 0 时这条判据什么都没判）')
    process.exit(2)
  }
  const problems = []
  for (const source of records) {
    for (const problem of recordProblems(source)) problems.push(problem)
  }
  if (template !== null) {
    for (const problem of recordProblems({ ...template, relaxedId: true })) problems.push(problem)
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-change-intent: ${problem}`)
    console.error(`check-change-intent: ${records.length} 条记录 + 模板 里有 ${problems.length} 处不合规 ——`
      + ` 契约见 ${CHANGES_DIR}/README.md（字段规则 + "跑什么、看到什么、算通过"）`)
    process.exit(1)
  }
  console.log(`check-change-intent: OK — ${records.length} 条变更记录全部合规`
    + (template === null ? '（模板缺失，未判）' : `（${TEMPLATE_FILE} 同判：仅放宽 id 占位符）`))
}

/**
 * `--selftest` 的基线记录：一条**合法**的 `implemented` 记录（每个样本各自深拷贝后破坏）。
 * @returns {Record<string, unknown>} 合法记录。
 */
function selftestBaseRecord() {
  return {
    id: '2026-10-26-selftest',
    status: 'implemented',
    intent: { zh: '自证样本：这条记录只用于证明判据能被杀死，不描述任何真实改动', en: 'Selftest sample: exists only to prove the guard can be killed.' },
    modules: ['scripts/check-change-intent.mjs'],
    acceptance: [{
      criterion: '跑 `node scripts/check-change-intent.mjs --selftest` 看到 exit 0 与一行断言统计',
      evidence: 'test',
      command: 'node scripts/check-change-intent.mjs --selftest',
    }],
  }
}

/**
 * 构造一个样本：从合法记录出发，按 `mutate` 破坏它（不改则保持合法）。
 * @param {string} name 样本名（出现在自证输出里）。
 * @param {(record: Record<string, unknown>) => void} mutate 破坏动作。
 * @param {RegExp | null} expected 期望命中的诊断；`null` = 期望**不**报错。
 * @returns {SelftestSample} 样本。
 */
function selftestSample(name, mutate, expected) {
  const record = selftestBaseRecord()
  mutate(record)
  return { name, fileName: '2026-10-26-selftest.json', text: JSON.stringify(record, null, 2), expected }
}

/**
 * 构造一个"直接给文本/放宽 id"的样本（BOM、模板两种形态用）。
 * @param {string} name 样本名。
 * @param {string} fileName 文件名。
 * @param {string} text 记录文本。
 * @param {RegExp | null} expected 期望命中的诊断；`null` = 期望不报错。
 * @param {boolean} relaxedId 是否放宽 id（模板形态）。
 * @returns {SelftestSample} 样本。
 */
function selftestTextSample(name, fileName, text, expected, relaxedId) {
  return { name, fileName, text, expected, relaxedId }
}

/**
 * `--selftest` 的样本表：绿样本证明"不误红"，红样本证明"判据可被杀死"且点名到具体字段。
 * @returns {SelftestSample[]} 固定样本。
 */
function selftestSamples() {
  const fileName = '2026-10-26-selftest.json'
  const baseText = JSON.stringify(selftestBaseRecord(), null, 2)
  const templateRecord = {
    id: 'YYYY-MM-DD-kebab-slug',
    status: 'proposed',
    intent: { zh: '为什么改（一句话）', en: 'Why this change exists, in one sentence.' },
    modules: [],
  }
  return [
    selftestSample('implemented + 完整 acceptance', () => {}, null),
    selftestSample('proposed 允许没有 acceptance（评审用草稿）', (record) => {
      record.status = 'proposed'
      delete record.acceptance
    }, null),
    selftestSample('verified + 每条 acceptance.command 都有输出', (record) => {
      record.status = 'verified'
      record.verification = [{ command: 'node scripts/check-change-intent.mjs --selftest', result: 'exit 0' }]
    }, null),
    selftestSample('accepted 但删掉 acceptance', (record) => {
      record.status = 'accepted'
      delete record.acceptance
    }, /acceptance/u),
    selftestSample('verified 但 verification: []', (record) => {
      record.status = 'verified'
      record.verification = []
    }, /verification/u),
    selftestSample('verified 但 verification 的命令对不上 acceptance', (record) => {
      record.status = 'verified'
      record.verification = [{ command: 'node -e "process.exit(0)"', result: 'exit 0' }]
    }, /acceptance\[0\]\.command/u),
    selftestSample('evidence = magic（未知枚举）', (record) => {
      record.acceptance = [{ criterion: '跑命令看到 exit 0', evidence: 'magic', command: 'node -e "process.exit(0)"' }]
    }, /evidence/u),
    selftestSample('manual 缺 command（人工步骤没写）', (record) => {
      record.acceptance = [{ criterion: '人工点一遍面板看到 N/N 通过', evidence: 'manual', command: '   ' }]
    }, /command/u),
    selftestSample('criterion 是 README 的 ❌ 措辞（符合预期）', (record) => {
      record.acceptance = [{ criterion: '界面逻辑符合预期', evidence: 'manual', command: '人工看一眼' }]
    }, /criterion/u),
    selftestSample('modules 是绝对路径', (record) => {
      record.modules = ['/etc/passwd']
    }, /modules\[0\]/u),
    selftestSample('modules 以 .. 开头（指向仓库外）', (record) => {
      record.modules = ['../outside/file.ts']
    }, /modules\[0\]/u),
    selftestSample('modules 中间嵌 .. 段（packages/../../outside.ts）', (record) => {
      record.modules = ['packages/../../outside.ts']
    }, /modules\[0\]/u),
    selftestSample('modules 中间嵌 .. 段（a/../../b）', (record) => {
      record.modules = ['a/../../b']
    }, /modules\[0\]/u),
    selftestSample('modules 含反斜杠', (record) => {
      record.modules = ['packages\\host\\desktop\\src\\index.ts']
    }, /modules\[0\]/u),
    selftestSample('id 与文件名不一致', (record) => {
      record.id = '2026-10-25-other'
    }, /文件名/u),
    selftestSample('status 不认识', (record) => {
      record.status = 'done'
    }, /status/u),
    selftestSample('modules 不是数组', (record) => {
      record.modules = 'scripts/check-change-intent.mjs'
    }, /modules/u),
    selftestTextSample('带 UTF-8 BOM 的合法 JSON（BOM 应被剥掉）', fileName, `\uFEFF${baseText}`, null, false),
    selftestTextSample('模板形态：放宽 id 占位符', TEMPLATE_FILE, JSON.stringify(templateRecord, null, 2), null, true),
    selftestTextSample('模板形态不放宽 id ⇒ 仍按文件名对拍', TEMPLATE_FILE, JSON.stringify(templateRecord, null, 2), /文件名/u, false),
    {
      name: '坏 JSON',
      fileName,
      text: '{ "id": "2026-10-26-selftest", ',
      expected: /JSON/u,
    },
  ]
}

/**
 * 扫描面识别（头注释 §扫描面）的固定断言：哪些名字参与判据、哪些必须 exit 2、哪些可忽略。
 * @type {Array<[string, { isFile: boolean, isDirectory: boolean }, string]>}
 */
const SELFTEST_CLASSIFICATION = [
  ['2026-10-26-agent-dev-environment.json', { isFile: true, isDirectory: false }, 'record'],
  [TEMPLATE_FILE, { isFile: true, isDirectory: false }, 'template'],
  [TEMPLATE_FILE, { isFile: false, isDirectory: false }, 'fail'],
  ['README.md', { isFile: true, isDirectory: false }, 'ignore'],
  ['notes.jsonc', { isFile: true, isDirectory: false }, 'ignore'],
  ['2026-10-26-agent-dev-environment.JSON', { isFile: true, isDirectory: false }, 'fail'],
  ['2026-10-26-agent-dev-environment.Json', { isFile: true, isDirectory: false }, 'fail'],
  ['archive', { isFile: false, isDirectory: true }, 'fail'],
  ['2026-10-26-old.json', { isFile: false, isDirectory: false }, 'fail'],
]

/**
 * `--selftest`：只跑内存样本，不读盘、不写盘。
 * @returns {void}
 */
function runSelftest() {
  const samples = selftestSamples()
  const failures = []
  let greens = 0
  let reds = 0
  for (const item of samples) {
    const problems = recordProblems({
      fileName: item.fileName,
      text: item.text,
      relaxedId: item.relaxedId === true,
    })
    if (item.expected === null) {
      greens += 1
      if (problems.length > 0) {
        failures.push(`样本「${item.name}」本该是绿的，却报了 ${problems.length} 条：${problems.join('；')}`)
      }
      continue
    }
    reds += 1
    if (problems.length === 0) {
      failures.push(`样本「${item.name}」本该红（期望命中 ${String(item.expected)}），却一条问题都没报 —— 判据不可被杀死`)
      continue
    }
    if (!problems.some(problem => item.expected.test(problem))) {
      failures.push(`样本「${item.name}」红了但没点名期望字段（期望 ${String(item.expected)}；实际：${problems.join('；')}）`)
    }
  }
  for (const [fileName, kind, expected] of SELFTEST_CLASSIFICATION) {
    const actual = classifyEntry(fileName, kind).action
    if (actual === expected) continue
    failures.push(`样本「扫描面识别」把 ${fileName} 判成 ${actual}，期望 ${expected}`)
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`check-change-intent: [selftest] ${failure}`)
    console.error(`check-change-intent: --selftest 失败 —— ${failures.length} 条断言不成立。`
      + ' 判据本身不可信时先修脚本，别去改真仓记录。')
    process.exit(1)
  }
  const total = samples.length + SELFTEST_CLASSIFICATION.length
  console.log(`check-change-intent: --selftest OK — ${total} 条断言（${greens} 绿 / ${reds} 红 +`
    + ` ${SELFTEST_CLASSIFICATION.length} 条扫描面识别）；坏记录都能被点名到字段，好记录不误红`)
}

const args = process.argv.slice(2)
/** `--selftest`：只跑内存自证（不读盘）。 */
let selftest = false
/** 判据根（默认脚本自己的仓库根）。 */
let root = SCRIPT_ROOT
/** 是否显式给了 `--root`（与 `--selftest` 互斥，见头注释 §用法）。 */
let rootGiven = false
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--selftest') selftest = true
  else if (arg === '--root') {
    const value = args[index + 1]
    if (value === undefined) {
      console.error('check-change-intent: --root 需要一个目录')
      process.exit(2)
    }
    root = resolve(value)
    rootGiven = true
    index += 1
  } else {
    console.error(`check-change-intent: 未知参数 ${arg}（只支持 --root <dir> 或 --selftest）`)
    process.exit(2)
  }
}

if (selftest && rootGiven) {
  console.error('check-change-intent: --selftest 与 --root 互斥 ——'
    + ' 自证只跑内存样本；同时给 root 会让人以为它判了那棵树（静默丢弃 root = 假绿）')
  process.exit(2)
}

if (selftest) runSelftest()
else runCheck(root)
