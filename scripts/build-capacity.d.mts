/**
 * `scripts/build-capacity.mjs` 的类型声明（该模块是纯 JS，供 TS 消费方 import）。
 *
 * 唯一实现仍在 `.mjs` 里；这里只声明导出面，**不得**出现第二份逻辑。
 */

/** 每个并行任务的内存单价（MB，峰值口径）。 */
export declare const MEMORY_PER_TASK_MB: Readonly<{
  packageBuild: number
  vitestWorker: number
  goTestPackage: number
  goBuildPackage: number
  webadminBuild: number
}>

/** 折算结果（`planCapacity()` 的返回）。 */
export interface CapacityPlan {
  /** CPU 预算（= min(逻辑核, cgroup 配额)，至少 1）。 */
  readonly cpuBudget: number
  /** 折算时采用的可用内存 MB（已按 cgroup 限额 / 物理总量夹过）。 */
  readonly memoryAvailableMb: number
  /** 环境变量里的非法值等提示（不致命）。 */
  readonly envNotes: readonly string[]
  readonly values: Readonly<{
    packageBuild: number
    prebuild: number
    vitestWorkers: number
    goTestParallel: number
    goBuildParallel: number
    webadminBuild: number
  }>
  /** 每个预算的推导（谁限制了它），供 `--explain` 打印。 */
  readonly reasons: readonly string[]
}

/** 探测结果（`detectCapacity()` 的返回）。 */
export interface CapacityReport extends CapacityPlan {
  readonly platform: string
  /** 参与折算的逻辑核数（已含 `DSH_BUILD_CPUS` 覆盖）。 */
  readonly logicalCpus: number
  /** OS 报告的核数（覆盖前，用于诊断）。 */
  readonly osLogicalCpus: number
  readonly cpuModels: readonly string[]
  /** cgroup CPU 配额（逻辑核，可为小数）；读不出为 `null`。 */
  readonly cgroupCpuQuota: number | null
  readonly memoryTotalBytes: number
  readonly cgroupMemoryLimitBytes: number | null
}

/** `planCapacity()` 的输入：全部来自探测（测试可喂合成值）。 */
export interface CapacityInput {
  readonly logicalCpus?: number
  readonly cgroupCpuQuota?: number | null
  readonly memoryTotalBytes?: number
  readonly cgroupMemoryLimitBytes?: number | null
  readonly memoryAvailableMb?: number
  readonly env?: Record<string, string | undefined>
  readonly notes?: readonly string[]
}

/** `detectCapacity()` 的可注入项（测试用）。 */
export interface CapacityDetectOptions {
  readonly read?: (path: string) => string
  readonly env?: Record<string, string | undefined>
  readonly platformName?: string
  readonly logicalCpusOverride?: number
  readonly cpuModels?: readonly { model: string }[]
}

/** `--print` 可选的键。 */
export declare const PRINTABLE_KEYS: readonly [
  'packageBuild',
  'prebuild',
  'vitestWorkers',
  'goTestParallel',
  'goBuildParallel',
  'webadminBuild',
]

/** 从 cgroup v2/v1 读 CPU 配额（逻辑核）；读不出 `null`。 */
export declare function readCgroupCpuQuota(read: (path: string) => string): number | null

/** 从 cgroup v2/v1 读内存限额（字节）；读不出/无限制 `null`。 */
export declare function readCgroupMemoryLimit(read: (path: string) => string): number | null

/** 从 `/proc/meminfo` 读 `MemAvailable`（MB）；读不出 `null`。 */
export declare function readMemAvailableMb(read: (path: string) => string): number | null

/** 纯函数：容量 → 每个并行点的并发数。 */
export declare function planCapacity(input: CapacityInput): CapacityPlan

/** 读真机并折算并发。 */
export declare function detectCapacity(options?: CapacityDetectOptions): CapacityReport

/** 一行人类可读摘要。 */
export declare function formatSummary(plan: CapacityReport): string
