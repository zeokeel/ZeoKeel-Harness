#!/usr/bin/env node
// 公开面文本守卫：扫描 PR / Issue / Release / 任意文本，命中私有 denylist 即失败。
//
// 背景（2026-11-14 事故）：PR 描述（公开面）里写了客户员工英文名；仓库内容守卫
// `check-no-real-domains.mjs` 只扫文件和 commit message，扫不到 GitHub PR 元数据。
// 本脚本把“公开面文本”也纳入同一套私有 denylist：客户/渠道名、员工姓名（含英文名/
// 昵称）、真实域名、IP、手机号、工号、账号、密钥等。
//
// 关键纪律：denylist **只存在私有位置**（默认 ~/.config/zeokeel/public-text-denylist.txt，
// 或 PUBLIC_TEXT_DENYLIST_FILE / PUBLIC_TEXT_DENYLIST 环境变量），绝不提交到公开仓。
// 本脚本也不打印命中的词或原文，避免把泄露内容再写进 CI 日志/终端日志。
//
// 用法：
//   node scripts/check-public-text.mjs --file /tmp/pr-body.md
//   node scripts/check-public-text.mjs --pr 28
//   node scripts/check-public-text.mjs --pr 28 --quiet
//   node scripts/check-public-text.mjs --text '要检查的文本'
//   printf '%s' "$PR_JSON" | node scripts/check-public-text.mjs --stdin-json
//   node scripts/check-public-text.mjs --file x.md --denylist /path/to/private-denylist.txt
//
// 退出码：0 干净；1 命中；2 配置/输入错误（默认 fail-closed）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DEFAULT_DENYLIST = path.join(os.homedir(), '.config', 'zeokeel', 'public-text-denylist.txt')

/** @typedef {{ source: string, line: number, termNumber: number }} Finding */

/**
 * @param {string[]} argv
 * @returns {{ file?: string, pr?: string, text?: string, stdinJson: boolean, quiet: boolean, denylist?: string }}
 */
function parseArgs(argv) {
  /** @type {{ file?: string, pr?: string, text?: string, stdinJson: boolean, quiet: boolean, denylist?: string }} */
  const out = { stdinJson: false, quiet: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`缺少参数值: ${arg}`)
      i += 1
      return value
    }
    switch (arg) {
      case '--file': out.file = next(); break
      case '--pr': out.pr = next(); break
      case '--text': out.text = next(); break
      case '--stdin-json': out.stdinJson = true; break
      case '--quiet': out.quiet = true; break
      case '--denylist': out.denylist = next(); break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`未知参数: ${arg}`)
    }
  }
  return out
}

function printHelp() {
  process.stdout.write(`用法:
  node scripts/check-public-text.mjs --file <path>
  node scripts/check-public-text.mjs --pr <number>
  node scripts/check-public-text.mjs --text <text>
  printf '%s' '<json>' | node scripts/check-public-text.mjs --stdin-json
  node scripts/check-public-text.mjs [--denylist <path>] [--quiet]

denylist 来源优先级: --denylist > PUBLIC_TEXT_DENYLIST_FILE > PUBLIC_TEXT_DENYLIST > ~/.config/zeokeel/public-text-denylist.txt
`)
}

/** @returns {string[]} */
function loadDenylist(explicitPath) {
  /** @type {string[]} */
  const raw = []
  const envFile = process.env.PUBLIC_TEXT_DENYLIST_FILE
  const envInline = process.env.PUBLIC_TEXT_DENYLIST
  if (envInline && envInline.trim() !== '') raw.push(...envInline.split(/\r?\n/))
  const filePath = explicitPath || envFile || DEFAULT_DENYLIST
  let shouldRead = Boolean(explicitPath || envFile)
  if (!shouldRead && fs.existsSync(DEFAULT_DENYLIST)) shouldRead = true
  if (shouldRead) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`私有 denylist 不存在: ${filePath}（不要把它提交到仓库）`)
    }
    raw.push(...fs.readFileSync(filePath, 'utf8').split(/\r?\n/))
  }
  const terms = new Map()
  for (const line of raw) {
    const term = line.trim()
    if (term === '' || term.startsWith('#')) continue
    const normalized = term.normalize('NFKC').toLowerCase()
    if (normalized.length < 2) continue
    terms.set(normalized, (terms.get(normalized) || 0) + 1)
  }
  return [...terms.keys()]
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 词边界匹配：ASCII 词两侧不能是字母/数字；中文/符号词做子串匹配。
 * @param {string} term
 * @returns {RegExp}
 */
function termRegex(term) {
  const escaped = escapeRegExp(term)
  if (/^[a-z0-9][a-z0-9._@:/-]*[a-z0-9]$/.test(term) || /^[a-z0-9]$/.test(term)) {
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i')
  }
  return new RegExp(escaped, 'i')
}

/**
 * @param {string} source
 * @param {string} text
 * @param {string[]} terms
 * @returns {Finding[]}
 */
function scanText(source, text, terms) {
  /** @type {Finding[]} */
  const findings = []
  if (typeof text !== 'string' || text === '') return findings
  const normalizedText = text.normalize('NFKC')
  const lines = normalizedText.split(/\r?\n/)
  const regexes = terms.map((term) => ({ term, regex: termRegex(term) }))
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] || ''
    for (let termIndex = 0; termIndex < regexes.length; termIndex += 1) {
      const entry = regexes[termIndex]
      if (entry && entry.regex.test(line)) {
        findings.push({ source, line: lineIndex + 1, termNumber: termIndex + 1 })
      }
    }
  }
  return findings
}

/** @param {unknown} value @returns {string[]} */
function collectTexts(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => collectTexts(item))
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((item) => collectTexts(item))
  }
  return []
}

/**
 * @param {any} pr
 * @returns {string[]}
 */
function prTextSections(pr) {
  const sections = []
  if (pr && typeof pr.title === 'string') sections.push(pr.title)
  if (pr && typeof pr.body === 'string') sections.push(pr.body)
  for (const comment of asNodes(pr?.comments)) {
    if (typeof comment?.body === 'string') sections.push(comment.body)
  }
  for (const review of asNodes(pr?.reviews)) {
    if (typeof review?.body === 'string') sections.push(review.body)
  }
  // GitHub 的“已编辑”旧版本仍在公开 API 可读：只扫当前 body 会漏掉事故里的旧文案。
  for (const edit of asNodes(pr?.userContentEdits)) {
    if (typeof edit?.diff === 'string') sections.push(edit.diff)
  }
  return sections
}

/** GitHub GraphQL connection（{nodes:[]}）与 gh CLI 数组两种形态都接受。 */
function asNodes(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.nodes)) return value.nodes
  return []
}

const PR_METADATA_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title
      body
      comments(first: 100) { nodes { body } }
      reviews(first: 100) { nodes { body } }
      userContentEdits(first: 100) { nodes { diff editedAt } }
    }
  }
}`

/** @param {string} number @returns {any} */
function fetchPR(number) {
  const repo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim()
  const [owner, name] = repo.split('/')
  const raw = execFileSync(
    'gh',
    ['api', 'graphql', '-f', `query=${PR_METADATA_QUERY}`, '-F', `owner=${owner}`, '-F', `repo=${name}`, '-F', `number=${number}`],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  )
  const parsed = JSON.parse(raw)
  if (parsed?.errors?.length) throw new Error(`gh api graphql: ${parsed.errors[0].message}`)
  return parsed?.data?.repository?.pullRequest ?? {}
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.file && !args.pr && args.text === undefined && !args.stdinJson) {
    printHelp()
    process.exit(2)
  }
  const terms = loadDenylist(args.denylist)
  if (terms.length === 0) {
    throw new Error('私有 denylist 为空；请配置 PUBLIC_TEXT_DENYLIST_FILE / PUBLIC_TEXT_DENYLIST，绝不提交到仓库')
  }

  /** @type {{ source: string, text: string }[]} */
  const sources = []
  if (args.file) sources.push({ source: `file:${args.file}`, text: fs.readFileSync(args.file, 'utf8') })
  if (args.text !== undefined) sources.push({ source: 'text', text: args.text })
  if (args.stdinJson) {
    const raw = fs.readFileSync(0, 'utf8')
    const parsed = JSON.parse(raw)
    const pr = parsed?.pull_request ?? parsed
    prTextSections(pr).forEach((text, index) => sources.push({ source: `stdin-json:section-${index + 1}`, text }))
    if (sources.length === 0) collectTexts(pr).forEach((text, index) => sources.push({ source: `stdin-json:text-${index + 1}`, text }))
  }
  if (args.pr) {
    const pr = fetchPR(args.pr)
    prTextSections(pr).forEach((text, index) => sources.push({ source: `pr#${args.pr}:section-${index + 1}`, text }))
  }

  /** @type {Finding[]} */
  const findings = []
  for (const section of sources) findings.push(...scanText(section.source, section.text, terms))

  if (findings.length > 0) {
    process.stderr.write(`check-public-text: FAIL — ${findings.length} 处命中私有 denylist（词条数=${terms.length}）\n`)
    for (const finding of findings) {
      process.stderr.write(`  ${finding.source}:${finding.line} term#${finding.termNumber}\n`)
    }
    process.exit(1)
  }
  if (!args.quiet) {
    process.stdout.write(`check-public-text: OK — 扫描 ${sources.length} 段公开面文本，denylist 词条 ${terms.length}\n`)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`check-public-text: ERROR — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}
