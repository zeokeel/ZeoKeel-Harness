#!/usr/bin/env node
/**
 * TS 架构判据（dependency-cruiser）的门禁化：把 `make -f Makefile.agent arch-ts` 变成
 * 可进 `yarn check` 的第 19 条根守卫。
 *
 * ## 为什么要有它
 *
 * `.dependency-cruiser.cjs`（8 条规则）与 `.dependency-cruiser-known-violations.json`
 * （5 条存量基线）已经就位，但它们此前只有一个**手动**入口 `make -f Makefile.agent arch-ts`。
 * 没人跑就等于没有：分层规则（包内 client 面不得引用 host 面、vendor 是叶子、
 * community 只是脚手架、产品代码不得引用上游子模块源码…）会被"顺手加的一条 import"静默破掉。
 * 门禁里的东西必须是"每次 `yarn check` 都真的跑"的那一份。
 *
 * ## 它做什么
 *
 * 用**当前 node**（`process.execPath`）跑根 devDependencies 里的 dependency-cruiser，
 * 参数与本仓唯一入口（`Makefile.agent` 的 `arch-ts`）逐字一致：
 *
 *   packages community --config .dependency-cruiser.cjs \
 *     --ignore-known .dependency-cruiser-known-violations.json --output-type err
 *
 * 退出码语义：
 *
 *   · `0`  ⇒ 通过（打印一行可 grep 的
 *     `check-architecture: OK (N modules, M known violations ignored, 0 stale baseline entries)`）；
 *   · `≠0` ⇒ 失败（新增依赖违规，或基线里有死条目；**不是**让我们去删规则、放宽 severity、
 *     往基线塞例外）；
 *   · 规则文件 / 基线 / dependency-cruiser 主程序缺失或**不是普通文件**、基线不是合法 JSON 数组、
 *     进程起不来或超时没跑完 ⇒ **退出码 2**（fail-closed：判据自身跑不起来不能算通过）。
 *
 * 为什么用 `process.execPath` + `node_modules/dependency-cruiser/bin/dependency-cruiser.mjs`，
 * 而不是 `node_modules/.bin/dependency-cruiser`：`.bin` 在 Windows 上是 `.cmd` 垫片，必须过
 * shell 才能跑，而 `shell: true` 会把带空格/引号的路径交给 cmd.exe 重新解析。这里直接把
 * `.mjs` 喂给同一个 node：跨平台、不经 shell、与 `check-scripts-types.mjs` 同一种形态。
 *
 * ## 三道前置（都 fail-closed：判据"读不到/跑不完"不能算通过）
 *
 * ① **形态**：三个必需文件都要 `statSync().isFile()`。只判 `existsSync` 挡不住同名目录占位
 *    （配置是个目录时 DC 会带着"看起来配好了"的假象跑到莫名失败）；
 * ② **基线内容预检**：基线是**例外登记**，坏 JSON 必须点名"基线损坏"并 exit 2。交给
 *    dependency-cruiser 去撞 JSON 解析错时，输出长得像"架构违规"，人会先怀疑代码而不是基线；
 * ③ **超时**：`spawnSync` 带 `timeout`（默认 120s；`ARCH_CHECK_TIMEOUT_MS` 可覆盖，非法值
 *    exit 2 —— 该口只用于自证/慢机）。没有超时的判据在坏环境（扫描卡住）下会拖死整条
 *    `yarn check`；`ETIMEDOUT` ⇒ exit 2，因为"判据没跑完"既不是通过、也不是"有违规"。
 *
 * ## 基线的死条目（stale）：只能缩不能放
 *
 * dependency-cruiser 18.7.0 在基线与实际不符时打印
 *   `‼ N stale known violations in the baseline. Run with '--baseline --baseline-mode shrink-only' ...`
 * 且**退出码仍是 0**（实测：5 条真违规时 dc 自己 exit 5，死条目不参与退出码）。所以死条目
 * 必须由本判据自己兜住：解析到 N > 0 ⇒ exit 1 并提示删掉。独立第二判据防止 dc 改文案后
 * 这条静默失效：`基线条目数 - 实际忽略数 > 0` 也按 stale 处理，两者取 max —— 基线是
 * "例外登记"，多留一条就是长期放宽一次。
 *
 * ## 认账（别把这句"通过"读成比它更宽的承诺）
 *
 * - dependency-cruiser 的退出码是**违规条数**（实测 5 条违规 ⇒ exit 5，不是 1）。所以透传出来
 *   的 `2` 既可能是"2 条违规"、也可能是本脚本的"前置失败"；**下游门禁只判非 0**，
 *   不要用具体数字区分这两类。
 * - `--ignore-known` 让存量违规不计入失败：基线是例外登记，不是豁免；只能缩不能放
 *   （新增违规必须修，或显式写进基线并单独评审）。
 * - 汇总行里的计数只用来把 OK 行写成人能读的样子；判定只信退出码、stale 解析与基线条目数交叉判据。
 * - 判的是**依赖图**（SWC 解析 `.ts/.tsx/.mjs/.cjs`），不是类型，也不是 Go 侧
 *   （`server/` 归 go-arch-lint，见 `docs/agent/architecture.md`）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** dependency-cruiser 主程序（根 devDependency，版本钉在 yarn.lock 里）。 */
const CRUISER = join(ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs')
/** 规则本体：改它等于改结论，必须单独评审。 */
const CONFIG = '.dependency-cruiser.cjs'
/** 存量违规基线：例外登记（只能缩不能放）。 */
const BASELINE = '.dependency-cruiser-known-violations.json'
/** 判据面：产品代码的两个根（`server/` 是 Go、`deepseek-harness/` 是上游子模块，都不进面）。 */
const TARGETS = ['packages', 'community']
/** 默认超时：热缓存实测 ~7s，120s 足够宽；只在坏环境（扫描卡住）时触发。 */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * 文件形态判定。`missing` 与 `not-file` 必须分开报：同名目录/设备文件占位时，
 * "存在"为真但判据实际跑不了（例：`.dependency-cruiser.cjs` 是个目录）。
 * @param {string} path 绝对路径。
 * @returns {'ok' | 'missing' | 'not-file' | 'unreadable'} 形态。
 */
function fileState(path) {
  try {
    return statSync(path).isFile() ? 'ok' : 'not-file'
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    return code === 'ENOENT' ? 'missing' : 'unreadable'
  }
}

/**
 * 判据自身的超时毫秒数。自证"超时 ⇒ exit 2"需要把窗口压到亚秒级，因此留一个 env 覆盖口；
 * 非法值 fail-closed（exit 2），不猜默认值。
 * @returns {number | null} 毫秒；`null` = 非法值（原因已打印，调用方 exit 2）。
 */
function resolveTimeoutMs() {
  const raw = process.env.ARCH_CHECK_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`check-architecture: ARCH_CHECK_TIMEOUT_MS=${JSON.stringify(raw)} 不是正整数毫秒 ——`
      + ' 判据跑不起来，拒绝当作通过')
    return null
  }
  return value
}

/** @type {{ label: string, path: string, fix: string }[]} */
const REQUIRED = [
  {
    label: 'dependency-cruiser 主程序',
    path: CRUISER,
    fix: 'corepack yarn install --immutable（根 devDependencies 里钉了 dependency-cruiser）',
  },
  {
    label: '规则文件 .dependency-cruiser.cjs',
    path: join(ROOT, CONFIG),
    fix: '`git restore .dependency-cruiser.cjs` —— 判据本体缺失时不能"读不到就放过"',
  },
  {
    label: '基线 .dependency-cruiser-known-violations.json',
    path: join(ROOT, BASELINE),
    fix: '`git restore .dependency-cruiser-known-violations.json` —— 基线缺失等于例外登记丢失，'
      + '不能当作零违规',
  },
]

for (const { label, path, fix } of REQUIRED) {
  const state = fileState(path)
  if (state === 'ok') continue
  const why = state === 'missing'
    ? '不存在'
    : state === 'not-file' ? '不是普通文件（目录或设备文件占位）' : '读不动（权限/IO 错误）'
  console.error(`check-architecture: ${label} —— ${why}（${path}）—— 判据自身跑不起来，拒绝当作通过`
    + `\n  ⇒ ${fix}`)
  process.exit(2)
}

/** 重新生成基线的唯一口径（与 `.dependency-cruiser.cjs` 头注释一致，别抄成别的形态）。 */
const REGENERATE_BASELINE = `corepack yarn dependency-cruiser ${TARGETS.join(' ')}`
  + ` --config ${CONFIG} --output-type baseline > ${BASELINE}`

// 基线预检：坏 JSON 要点名"基线损坏"，否则会在 DC 输出里长得像"架构违规"。
/** @type {unknown} */
let baseline
try {
  baseline = JSON.parse(readFileSync(join(ROOT, BASELINE), 'utf8'))
} catch (error) {
  console.error(`check-architecture: 基线 ${BASELINE} 损坏（不是合法 JSON）——`
    + ` ${/** @type {Error} */ (error).message}`)
  console.error('  基线损坏 ≠ "零违规"：拒绝当作通过（先修基线，别去改架构代码）')
  console.error(`  ⇒ 先 \`git restore ${BASELINE}\`；确需重建则 ${REGENERATE_BASELINE} 并评审 diff`)
  process.exit(2)
}
if (!Array.isArray(baseline)) {
  console.error(`check-architecture: 基线 ${BASELINE} 损坏（顶层必须是数组，实际是 `
    + `${baseline === null ? 'null' : typeof baseline}）—— 拒绝当作通过`)
  console.error(`  ⇒ 先 \`git restore ${BASELINE}\`；确需重建则 ${REGENERATE_BASELINE} 并评审 diff`)
  process.exit(2)
}
/** 基线登记条数：与 DC 实际忽略数交叉核对，兜住"死条目但 DC 没打印 stale"（见头注释）。 */
const baselineCount = baseline.length

const timeoutMs = resolveTimeoutMs()
if (timeoutMs === null) process.exit(2)

const result = spawnSync(
  process.execPath,
  [CRUISER, ...TARGETS, '--config', CONFIG, '--ignore-known', BASELINE, '--output-type', 'err'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
)

// 探针/违规原文必须原样透出（两个流都可能有内容），否则人看不到"哪条边坏了"。
const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout)
const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr)
if (stdout !== '') process.stdout.write(stdout)
if (stderr !== '') process.stderr.write(stderr)

if (result.error !== undefined) {
  // 超时被 SIGTERM 时 Node 给的是带 `code: 'ETIMEDOUT'` 的 Error，不是"跑完了但有违规"。
  const code = /** @type {NodeJS.ErrnoException} */ (result.error).code
  if (code === 'ETIMEDOUT') {
    console.error(`check-architecture: dependency-cruiser 在 ${timeoutMs}ms 内没跑完（spawnSync timeout）`
      + ' —— 判据未完成，拒绝当作通过')
    console.error('  ⇒ 本机负载过高时重跑；确需放宽则设 ARCH_CHECK_TIMEOUT_MS=<毫秒>（默认 120000）')
    process.exit(2)
  }
  console.error(`check-architecture: 起不了 dependency-cruiser —— ${result.error.message}`
    + '\n  ⇒ corepack yarn install --immutable；`node -v` 需满足 package.json 的 engines')
  process.exit(2)
}

if (typeof result.status !== 'number') {
  // 被信号打断：判据没有跑完，既不算通过也不算"有违规"。
  console.error(`check-architecture: dependency-cruiser 没有正常退出（signal=${String(result.signal)}）`
    + ' —— 判据未跑完，拒绝当作通过')
  process.exit(2)
}

/**
 * 从 dependency-cruiser 的输出里抠出计数，仅用于 OK 行可读性与 stale 交叉判据（不参与
 * "有没有新违规"的判定）。形态（dc 18.7.0，`--output-type err`，两流都扫）：
 *   ✔ no dependency violations found (1255 modules, 4757 dependencies cruised)
 *   ‼ 5 known violations ignored. Run with --no-ignore-known to see them.
 *   ‼ 1 stale known violations in the baseline. Run with '--baseline --baseline-mode shrink-only' ...
 * @param {string} text dependency-cruiser 的 stdout 与 stderr 合并文本。
 * @returns {{ modules: string | null, ignored: number | null, stale: number | null }}
 */
function parseSummary(text) {
  const modules = /\((\d+) modules, \d+ dependencies cruised\)/.exec(text)
  const ignored = /(\d+) known violations? ignored/.exec(text)
  // 单复数都认：dc 现在固定用复数，但把 "1 stale known violation" 这类写法一并兜住。
  const stale = /(\d+) stale known violations? in the baseline/.exec(text)
  return {
    modules: modules === null ? null : (modules[1] ?? null),
    ignored: ignored === null ? null : Number(ignored[1]),
    stale: stale === null ? null : Number(stale[1]),
  }
}

const summary = parseSummary(stdout + stderr)
// 死条目判据：DC 自己报的数字 + 独立交叉核对（基线条目数 vs 实际忽略数）取 max。
const staleCount = Math.max(
  summary.stale === null ? 0 : summary.stale,
  summary.ignored === null ? baselineCount : Math.max(0, baselineCount - summary.ignored),
)

if (result.status !== 0) {
  if (staleCount > 0) {
    console.error(`check-architecture: 另有 ${staleCount} 条基线条目已失效（stale）—— 修完违规后一并删掉`)
  }
  console.error('check-architecture: 架构判据红了 —— 修掉新增的依赖违规（包内 client/host 面互引、'
    + 'vendor 反向依赖、community 声明可加载入口、引用上游子模块源码…）；'
    + '**不要**删规则、放宽 severity 或往基线里塞例外来变绿（那等于改结论）')
  process.exit(result.status)
}

if (staleCount > 0) {
  console.error(`check-architecture: 基线只能缩不能放：删掉已不再违规的 ${staleCount} 条基线条目`
    + `（${BASELINE} 的 stale known violations）—— 死条目会让"例外登记"长期变宽，`
    + '真正新增的违规就藏进"反正基线里有一堆"里')
  console.error(`  ⇒ 重新生成后评审 diff：${REGENERATE_BASELINE}`)
  process.exit(1)
}

if (summary.modules !== null && summary.ignored !== null) {
  console.log(`check-architecture: OK (${summary.modules} modules, ${summary.ignored} known violations ignored,`
    + ' 0 stale baseline entries)')
} else {
  // 汇总行解析失败不改判定：退出码 0 + stale 交叉判据 0 才是权威结论（dc 改文案时退回通用行）。
  console.log('check-architecture: OK (dependency-cruiser 退出码 0；汇总行未解析；'
    + `基线条目 ${baselineCount} 条、0 stale)`)
}
