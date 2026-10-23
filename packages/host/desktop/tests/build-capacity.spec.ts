/**
 * `scripts/build-capacity.mjs` 的判据（机器自适应并发的**唯一口径**）。
 *
 * 为什么这些数字需要判据：并发是"换台机器就换行为"的东西，写错不会报错，只会让门禁
 * 在某台机器上变慢（核没吃满）或被杀（内存爆掉），而两者都表现为"CI 有时很慢/有时红"，
 * 很难回查到并发计算。这里用合成输入把三条规则钉死：
 *
 *   1. CPU 预算 = `min(逻辑核, cgroup 配额, DSH_BUILD_CPUS 覆盖)`；
 *   2. 每个并行点 = `min(CPU 份额, 可用内存/内存单价, 硬顶)`，且**永不为 0**；
 *   3. env 覆盖赢过自然推导（但受硬顶约束），非法值只记 note 不崩。
 *
 * 判据只喂纯函数 {@link planCapacity} / 解析函数，**不依赖本机核数与内存**（否则在
 * 4 核 CI 与 16 核开发机上结论不同 —— 那不是判据）。
 */

import { describe, expect, it } from 'vitest'
import {
  MEMORY_PER_TASK_MB,
  planCapacity,
  readCgroupCpuQuota,
  readCgroupMemoryLimit,
  readMemAvailableMb,
} from '../../../../scripts/build-capacity.mjs'

/** 用一个内存字典造假的 `read`（缺失路径抛错 ⇒ 走"读不出"分支）。 */
function fakeRead(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    const content = files[path]
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }
}

describe('build-capacity: 容器配额探测', () => {
  it('cgroup v2 cpu.max：有配额按 quota/period 折算；max 表示无限制', () => {
    expect(readCgroupCpuQuota(fakeRead({ '/sys/fs/cgroup/cpu.max': '200000 100000\n' }))).toBeCloseTo(2)
    expect(readCgroupCpuQuota(fakeRead({ '/sys/fs/cgroup/cpu.max': '150000 100000\n' }))).toBeCloseTo(1.5)
    expect(readCgroupCpuQuota(fakeRead({ '/sys/fs/cgroup/cpu.max': 'max 100000\n' }))).toBeNull()
    expect(readCgroupCpuQuota(fakeRead({}))).toBeNull()
  })

  it('cgroup v1 回退：cfs_quota_us/-1 表示无限制', () => {
    const v1 = fakeRead({
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '50000\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
    })
    expect(readCgroupCpuQuota(v1)).toBeCloseTo(0.5)
    const unlimited = fakeRead({
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
    })
    expect(readCgroupCpuQuota(unlimited)).toBeNull()
  })

  it('cgroup 内存限额：v2 的 max / v1 的超大哨兵值都表示无限制', () => {
    expect(readCgroupMemoryLimit(fakeRead({ '/sys/fs/cgroup/memory.max': `${2 * 1024 ** 3}\n` }))).toBe(2 * 1024 ** 3)
    expect(readCgroupMemoryLimit(fakeRead({ '/sys/fs/cgroup/memory.max': 'max\n' }))).toBeNull()
    expect(
      readCgroupMemoryLimit(fakeRead({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n' })),
    ).toBeNull()
  })

  it('MemAvailable 从 /proc/meminfo 取（不是 freemem）', () => {
    const meminfo = 'MemTotal:       11706388 kB\nMemFree:          300000 kB\nMemAvailable:    8731000 kB\n'
    expect(readMemAvailableMb(fakeRead({ '/proc/meminfo': meminfo }))).toBe(Math.round(8731000 / 1024))
    expect(readMemAvailableMb(fakeRead({ '/proc/meminfo': 'MemTotal: 1 kB\n' }))).toBeNull()
  })
})

describe('build-capacity: 并发折算', () => {
  it('4 核 / 8.7GB：CPU 限制的四路并发 + vitest 三 worker', () => {
    const plan = planCapacity({ logicalCpus: 4, memoryAvailableMb: 8700, memoryTotalBytes: 11 * 1024 ** 3 })
    expect(plan.cpuBudget).toBe(4)
    expect(plan.values).toEqual({
      packageBuild: 4,
      prebuild: 4,
      vitestWorkers: 3,
      goTestParallel: 4,
      goBuildParallel: 4,
      webadminBuild: 4,
    })
  })

  it('16 核 / 4GB：内存成为限制器（go test 只开 2 路，vitest 到硬顶 8）', () => {
    const plan = planCapacity({ logicalCpus: 16, memoryAvailableMb: 4096, memoryTotalBytes: 16 * 1024 ** 3 })
    expect(plan.cpuBudget).toBe(16)
    expect(plan.values.packageBuild).toBe(4) // 4096 / 900
    expect(plan.values.vitestWorkers).toBe(8) // 4096 / 500 = 8，撞硬顶 8
    expect(plan.values.goTestParallel).toBe(2) // 4096 / 1600
    expect(plan.values.goBuildParallel).toBe(5) // 4096 / 700
    expect(plan.values.webadminBuild).toBe(3) // 4096 / 1300
    expect(plan.reasons.join('\n')).toContain('内存预算')
  })

  it('cgroup 配额压过逻辑核数（容器里 16 核、配额 2）', () => {
    const plan = planCapacity({ logicalCpus: 16, cgroupCpuQuota: 2, memoryAvailableMb: 8192 })
    expect(plan.cpuBudget).toBe(2)
    expect(plan.values.packageBuild).toBe(2)
    expect(plan.values.vitestWorkers).toBe(1) // floor(2 × 0.75)
    expect(plan.values.goTestParallel).toBe(2)
  })

  it('内存极小时也不给出 0（至少 1 路）', () => {
    const plan = planCapacity({ logicalCpus: 8, memoryAvailableMb: 1 })
    for (const value of Object.values(plan.values)) expect(value).toBeGreaterThanOrEqual(1)
  })

  it('env 覆盖赢过自然推导，但被硬顶夹住；非法值只记 note', () => {
    const plan = planCapacity({
      logicalCpus: 4,
      memoryAvailableMb: 8192,
      env: { TEST_PARALLEL: '2', VITEST_MAX_WORKERS: '999', PREBUILD_CONCURRENCY: 'abc' },
    })
    expect(plan.values.goTestParallel).toBe(2)
    expect(plan.values.vitestWorkers).toBe(8) // 硬顶 8，不是 999
    expect(plan.values.prebuild).toBe(4) // 非法值被忽略，回落到自然值
    expect(plan.envNotes.join('\n')).toContain('PREBUILD_CONCURRENCY')
  })

  it('内存单价表与折算用的是同一份常量（改一处不会漂移）', () => {
    const plan = planCapacity({ logicalCpus: 64, memoryAvailableMb: MEMORY_PER_TASK_MB.goTestPackage * 3 })
    expect(plan.values.goTestParallel).toBe(3)
    expect(plan.values.packageBuild).toBe(5) // floor(4800 / 900)，CPU 份额 64 不限制
    expect(plan.values.packageBuild).toBeLessThanOrEqual(8)
  })
})
