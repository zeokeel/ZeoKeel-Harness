#!/usr/bin/env node
/**
 * 构建容量探测（唯一实现）—— 把"这台机器能并行干多少活"变成一个可复算的纯函数。
 *
 * ## 为什么需要它
 *
 * 仓库里每个并行点此前都各自拍了一个数，而且**互相矛盾**：
 *
 *   · `scripts/check-workspaces.mjs`：`min(4, CPU)` —— 16 核机器上也只跑 4 个包；
 *   · `server/Makefile`：`TEST_PARALLEL ?= 4` —— 同上，且不考虑内存；
 *   · `packages/host/desktop/scripts/prebuild-workspace-deps.ts`：**串行** 15 个包
 *     （2026-10-23 实测 4 核 39s，其中大部分时间只有 1 个核在干活）；
 *   · `vitest`：Linux 上不设上限（按 CPU 开 worker），内存小的机器直接 OOM；
 *   · 连接器/桌面包的构建脚本：一串 `&&`，串行。
 *
 * 结果就是"换一台机器，快慢全看运气"：核多的机器浪费核，内存小的机器被 OOM 杀掉，
 * 容器里（cgroup 限额 < 宿主核数）按宿主核数开并发把自己拖死。
 *
 * 本模块把三件事收口成一份口径：
 *   1. **真实可用容量**：`availableParallelism()`（尊重 CPU 亲和性）+ cgroup v2/v1 的
 *      cpu 配额 + cgroup 内存限额 + `/proc/meminfo` 的 `MemAvailable`；
 *   2. **每个并行点的内存单价**（下表，带取值依据），并发 = min(CPU 预算, 内存预算)；
 *   3. **环境变量覆盖**：机器探测不准时（CI 容器、共享构建机、离线机器）用一条 env 改。
 *
 * ## 环境变量（都作用于本模块，不要另立新名）
 *
 * | 变量 | 作用 |
 * | --- | --- |
 * | `DSH_BUILD_CPUS` | 覆盖"可用 CPU 数"（cgroup 读不出/读错时的逃生口） |
 * | `DSH_BUILD_MEMORY_MB` | 覆盖"可用内存 MB" |
 * | `CHECK_CONCURRENCY` | `yarn check` 阶段 2 的包并发（既有变量，语义不变） |
 * | `PREBUILD_CONCURRENCY` | `prebuildWorkspaceDeps` 的包并发 |
 * | `VITEST_MAX_WORKERS` | 各包 `vitest` 的 worker 上限 |
 * | `TEST_PARALLEL` | 服务端 `go test -p`（Makefile 里既有变量） |
 * | `GO_BUILD_P` | 服务端 `go build -p` |
 *
 * ## 用法
 *
 *   node scripts/build-capacity.mjs              # 人类可读的完整决策
 *   node scripts/build-capacity.mjs --json       # 机器可读
 *   node scripts/build-capacity.mjs --print go-test-parallel
 *   node scripts/build-capacity.mjs --explain    # 每个预算的推导（谁限制了它）
 *
 * 纯函数入口是 {@link planCapacity}（测试只喂合成输入，不碰真机）；{@link detectCapacity}
 * 负责读真机。**任何消费方都不许再自己写 min(N, cpus)**。
 */

import { availableParallelism, cpus as cpuList, freemem, platform, totalmem } from 'node:os'
import { realpathSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/**
 * 每个并行任务的**内存单价**（MB，峰值口径）。
 *
 * 取值依据（2026-10-23 在 4 核 / 11GB 机器上采样 RSS 峰值）：
 *   · `packageBuild`：tsdown（rolldown，~150MB）+ `tsc`（6.x ~700MB / 7.x ~250MB）。
 *     按 6.x 的峰值留量（降级回 6 时不能 OOM）；TS7 下实际更宽松。
 *   · `vitestWorker`：单 worker 跑桌面/连接器套件约 350–500MB（jsdom + 模块图）。
 *   · `goTestPackage`：单个 `go test` 包进程 + 它持有的 PG 连接（重包最高见过 ~1.2GB）。
 *   · `goBuildPackage`：`go compile` 子进程约 400–700MB（大包）。
 *   · `webadminBuild`：vite build（rollup）约 0.9–1.3GB。
 *
 * 这些数字是**保守估计**，不是精确测量：宁可少开一个并发，也不要让 8GB 机器进 swap。
 * 若某机型实测更省，用对应 env 覆盖即可，不必改这里。
 */
export const MEMORY_PER_TASK_MB = Object.freeze({
  packageBuild: 900,
  vitestWorker: 500,
  goTestPackage: 1600,
  goBuildPackage: 700,
  webadminBuild: 1300,
})

/** 路径规范化：realpath 失败时回落 `resolve`（符号链接目录里的调用照样能认出自己）。 */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** `import.meta.url` → 文件路径（只在本文件被直接执行时用到）。 */
function fileURLToPathBase(url) {
  return fileURLToPath(url)
}

/** 兜底假设：探测不到内存时按 4GB 可用算（比绝大多数 CI 容器小）。 */
const FALLBACK_AVAILABLE_MB = 4096

/** 并发上限的硬顶：再多的核，包级构建/测试的收益也压不过争抢（构建依赖链本身就窄）。 */
const MAX_PACKAGE_CONCURRENCY = 8
const MAX_GO_TEST_PARALLEL = 8
const MAX_VITEST_WORKERS = 8

/** 读一个文件；不存在/读不到返回 `null`（**不抛**：探测是尽力而为，不能因缺文件让门禁红）。 */
function readText(path, read) {
  try {
    return read(path)
  } catch {
    return null
  }
}

/**
 * 从 cgroup v2/v1 里读 CPU 配额（单位：逻辑核，可为小数）。
 *
 * 容器里 `availableParallelism()` 返回**宿主**核数（除非设了 cpuset），而 `cpu.max`
 * 才是真正的份额 —— 不读它就会在 2 核容器里开 8 路并发，把自己拖成 10× 慢。
 *
 * @param read - 文件读取函数（测试注入）。
 * @returns 配额（逻辑核），读不出返回 `null`。
 */
export function readCgroupCpuQuota(read) {
  const v2 = readText('/sys/fs/cgroup/cpu.max', read)
  if (v2 !== null) {
    const [quota, period] = v2.trim().split(/\s+/u)
    if (quota !== undefined && period !== undefined && quota !== 'max') {
      const q = Number(quota)
      const p = Number(period)
      if (Number.isFinite(q) && Number.isFinite(p) && p > 0) return q / p
    }
    if (quota === 'max') return null
  }
  const quota = readText('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', read)
  const period = readText('/sys/fs/cgroup/cpu/cpu.cfs_period_us', read)
  if (quota !== null && period !== null) {
    const q = Number(quota.trim())
    const p = Number(period.trim())
    // v1 用 -1 表示"无限制"。
    if (Number.isFinite(q) && Number.isFinite(p) && p > 0 && q > 0) return q / p
  }
  return null
}

/**
 * 从 cgroup v2/v1 里读内存限额（字节）。
 * @param read - 文件读取函数（测试注入）。
 * @returns 限额字节数，读不出/无限制返回 `null`。
 */
export function readCgroupMemoryLimit(read) {
  const v2 = readText('/sys/fs/cgroup/memory.max', read)
  if (v2 !== null) {
    const value = v2.trim()
    if (value !== 'max') {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) return n
    }
    return null
  }
  const v1 = readText('/sys/fs/cgroup/memory/memory.limit_in_bytes', read)
  if (v1 !== null) {
    const n = Number(v1.trim())
    // v1 的"无限制"是一个大到离谱的数（2^63 附近）。
    if (Number.isFinite(n) && n > 0 && n < 2 ** 60) return n
  }
  return null
}

/**
 * 读 Linux 的 `MemAvailable`（MB）—— 它才是"现在还能用多少"，`freemem()` 不含可回收页。
 * @param read - 文件读取函数（测试注入）。
 * @returns 可用 MB，读不出返回 `null`。
 */
export function readMemAvailableMb(read) {
  const meminfo = readText('/proc/meminfo', read)
  if (meminfo === null) return null
  const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(meminfo)
  if (match === null) return null
  return Math.round(Number(match[1]) / 1024)
}

/** 正整数环境变量（非法值忽略并记一条 note，不崩）。 */
function envInt(env, name, notes) {
  const raw = env[name]
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    notes.push(`${name}=${JSON.stringify(raw)} 不是正整数，忽略`)
    return null
  }
  return value
}

/**
 * 纯函数：把"探测到的容量"折算成每个并行点的并发数。
 *
 * 规则（三条，全部可解释）：
 *   1. CPU 预算 = `min(逻辑核, cgroup 配额, DSH_BUILD_CPUS)`，向下取整、至少 1；
 *   2. 内存预算 = `可用 MB / 该任务的内存单价`，向下取整、至少 1；
 *   3. 并发 = `min(CPU 预算 × 该任务的 CPU 占比, 内存预算, 硬顶)`，至少 1。
 *      CPU 占比只是"这类任务值不值得吃满所有核"的经验系数（见 {@link CPU_SHARE}）。
 *
 * @param input - 探测结果（见 {@link detectCapacity} 的返回）。
 * @returns 每个并行点的并发数与推导（`reasons` 用于 `--explain`）。
 */
export function planCapacity(input) {
  const notes = [...(input.notes ?? [])]
  const logical = Math.max(1, Math.floor(input.logicalCpus ?? 1))
  const quota = input.cgroupCpuQuota ?? null
  const cpuBudget = Math.max(1, Math.floor(Math.min(logical, quota ?? Infinity)))

  const memTotalMb = Math.round((input.memoryTotalBytes ?? 0) / (1024 * 1024)) || null
  const memLimitMb = input.cgroupMemoryLimitBytes === null || input.cgroupMemoryLimitBytes === undefined
    ? null
    : Math.round(input.cgroupMemoryLimitBytes / (1024 * 1024))
  // 可用内存 = min(观测可用, cgroup 限额, 物理总量)；**都没探到**时给保守兜底。
  const observed = input.memoryAvailableMb
  const memoryAvailableMb = observed === undefined && memTotalMb === null && memLimitMb === null
    ? FALLBACK_AVAILABLE_MB
    : Math.max(1, Math.min(observed ?? Infinity, memLimitMb ?? Infinity, memTotalMb ?? Infinity))

  const env = input.env ?? {}
  const memBudget = perTaskMb => Math.max(0, Math.floor(memoryAvailableMb / perTaskMb))

  /**
   * `min(CPU 份额, 内存预算, 硬顶)`，再夹到 `[1, hardCap]`。
   *
   * env 覆盖**赢过自然推导**（它是"机器探测不准"的逃生口），但仍受硬顶约束 —— 覆盖成
   * 999 也不该开 999 路（那只会把机器打死），最多到硬顶。
   */
  const pick = (name, cpuShare, perTaskMb, hardCap, overrideName) => {
    const cpuPart = Math.max(1, Math.floor(cpuBudget * cpuShare))
    const memPart = Math.max(1, memBudget(perTaskMb))
    const natural = Math.max(1, Math.min(cpuPart, memPart, hardCap))
    const override = envInt(env, overrideName, notes)
    if (override !== null) {
      const value = Math.max(1, Math.min(override, hardCap))
      return { value, reason: `${name}=${value}（${overrideName}=${override} 覆盖；自然值 ${natural}）`, naturalValue: natural }
    }
    const limiter = natural === cpuPart
      ? `CPU 预算 ${cpuBudget}×${cpuShare}`
      : natural === memPart
        ? `内存预算 ${memoryAvailableMb}MB/${perTaskMb}MB`
        : `硬顶 ${hardCap}`
    return { value: natural, reason: `${name}=${natural}（由 ${limiter} 限制）`, naturalValue: natural }
  }

  const packageBuild = pick('packageBuild', 1, MEMORY_PER_TASK_MB.packageBuild, MAX_PACKAGE_CONCURRENCY, 'CHECK_CONCURRENCY')
  const prebuild = pick('prebuild', 1, MEMORY_PER_TASK_MB.packageBuild, MAX_PACKAGE_CONCURRENCY, 'PREBUILD_CONCURRENCY')
  const vitest = pick('vitestWorkers', 0.75, MEMORY_PER_TASK_MB.vitestWorker, MAX_VITEST_WORKERS, 'VITEST_MAX_WORKERS')
  const goTest = pick('goTestParallel', 1, MEMORY_PER_TASK_MB.goTestPackage, MAX_GO_TEST_PARALLEL, 'TEST_PARALLEL')
  // `go build -p` 的硬顶 = **CPU 预算本身**（不是 8）：Go 自己的缺省就是 `-p=GOMAXPROCS`，
  // 用一个更小的固定硬顶会在 16 核机器上把冷构建**拖慢**（2026-10-23 复盘发现）。
  // 内存仍由 memPart 收口（单 compile 进程 ~700MB）。
  const goBuild = pick('goBuildParallel', 1, MEMORY_PER_TASK_MB.goBuildPackage, cpuBudget, 'GO_BUILD_P')
  const webadmin = pick('webadminBuild', 1, MEMORY_PER_TASK_MB.webadminBuild, MAX_PACKAGE_CONCURRENCY, 'WEBADMIN_BUILD_CONCURRENCY')

  return {
    cpuBudget,
    /** 折算并发时实际采用的"可用内存 MB"（已按 cgroup/物理总量夹过）。 */
    memoryAvailableMb,
    envNotes: notes,
    values: {
      packageBuild: packageBuild.value,
      prebuild: prebuild.value,
      vitestWorkers: vitest.value,
      goTestParallel: goTest.value,
      goBuildParallel: goBuild.value,
      webadminBuild: webadmin.value,
    },
    reasons: [packageBuild.reason, prebuild.reason, vitest.reason, goTest.reason, goBuild.reason, webadmin.reason],
  }
}

/**
 * 读真机容量并折算并发（{@link planCapacity} 的 IO 包装）。
 *
 * @param options - 可注入 `read` / `env` / `platformName` / `logicalCpusOverride`（测试用）。
 * @returns 探测结果与并发计划（字段见 {@link planCapacity}）。
 */
export function detectCapacity(options = {}) {
  const read = options.read ?? (path => readFileSync(path, 'utf8'))
  const env = options.env ?? process.env
  const notes = []

  const osLogical = options.logicalCpusOverride ?? availableParallelism()
  const logicalCpus = envInt(env, 'DSH_BUILD_CPUS', notes) ?? osLogical

  const platformName = options.platformName ?? platform()
  const isLinux = platformName === 'linux'
  const cgroupCpuQuota = isLinux ? readCgroupCpuQuota(read) : null
  const cgroupMemoryLimitBytes = isLinux ? readCgroupMemoryLimit(read) : null

  const memoryTotalBytes = totalmem()
  const meminfoAvailable = isLinux ? readMemAvailableMb(read) : null
  const memoryAvailableMb = envInt(env, 'DSH_BUILD_MEMORY_MB', notes)
    ?? meminfoAvailable
    ?? Math.max(1, Math.round(freemem() / (1024 * 1024)))

  const plan = planCapacity({
    logicalCpus,
    cgroupCpuQuota,
    memoryTotalBytes,
    cgroupMemoryLimitBytes,
    memoryAvailableMb,
    env,
    notes,
  })

  return {
    platform: platformName,
    logicalCpus,
    osLogicalCpus: osLogical,
    cpuModels: (options.cpuModels ?? cpuList()).map(cpu => cpu.model),
    cgroupCpuQuota,
    memoryTotalBytes,
    cgroupMemoryLimitBytes,
    memoryAvailableMb,
    ...plan,
  }
}

/** `--print` 可选的键（与 {@link planCapacity} 的 `values` 一一对应）。 */
export const PRINTABLE_KEYS = Object.freeze([
  'packageBuild',
  'prebuild',
  'vitestWorkers',
  'goTestParallel',
  'goBuildParallel',
  'webadminBuild',
])

/** 人类可读的一行摘要（`--json` 之外的所有输出都基于它）。 */
export function formatSummary(plan) {
  const cpu = plan.cgroupCpuQuota === null || plan.cgroupCpuQuota === undefined
    ? `${plan.logicalCpus}`
    : `${plan.logicalCpus}（cgroup 配额 ${plan.cgroupCpuQuota.toFixed(2)}）`
  const mem = plan.cgroupMemoryLimitBytes === null || plan.cgroupMemoryLimitBytes === undefined
    ? `${plan.memoryAvailableMb}MB 可用 / ${Math.round(plan.memoryTotalBytes / (1024 * 1024))}MB 总`
    : `${plan.memoryAvailableMb}MB 可用 / cgroup 限额 ${Math.round(plan.cgroupMemoryLimitBytes / (1024 * 1024))}MB`
  return `build-capacity: CPU ${cpu} · 内存 ${mem} · 并发 ${JSON.stringify(plan.values)}`
}

/** CLI 入口：`--json` / `--print <key>` / `--explain`。 */
async function main(argv) {
  const asJson = argv.includes('--json')
  const explain = argv.includes('--explain')
  const printIndex = argv.indexOf('--print')
  const printKey = printIndex === -1 ? null : argv[printIndex + 1]

  const plan = detectCapacity()
  if (printKey !== null) {
    if (!PRINTABLE_KEYS.includes(printKey)) {
      console.error(`build-capacity: --print 只接受 ${PRINTABLE_KEYS.join('|')}，收到 ${JSON.stringify(printKey)}`)
      process.exitCode = 2
      return
    }
    // 只打印数字：Makefile / shell 直接吃。
    process.stdout.write(`${plan.values[printKey]}\n`)
    return
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ...plan, cpuModels: undefined }, null, 2)}\n`)
    return
  }
  console.log(formatSummary(plan))
  if (explain) {
    for (const reason of plan.reasons) console.log(`  · ${reason}`)
    for (const note of plan.envNotes) console.log(`  ! ${note}`)
  }
}

/**
 * 本文件被当作入口执行吗？（仓库口径：优先 `import.meta.main`，加载器判定、argv 改不动；
 * 旧 Node 上退回 realpath 比较。不确定时按"是入口"处理 = fail-closed，多跑而不是少跑。）
 */
function isMain() {
  if (typeof import.meta.main === 'boolean') return import.meta.main
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return canonical(entry) === canonical(fileURLToPathBase(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  await main(process.argv.slice(2))
}
