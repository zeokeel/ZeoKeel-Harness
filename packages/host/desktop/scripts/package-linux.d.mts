/**
 * `package-linux.mjs` 的类型声明。
 *
 * 与 `pack-app-root.d.mts` 同款：`.mjs` 打包脚本被 `.ts` 测试 import，需要显式声明面，
 * 否则 `tsconfig.tests.json` 报 TS7016。
 */

import type { StagedPackAppRootArgs } from './pack-app-root.mjs'

/** `packageLinux()` 的注入缝（测试用；生产一律用缺省值）。 */
export interface PackageLinuxOptions {
  /** 桌面包根（应用根；真实实现要求它是真实存在的目录）。 */
  readonly desktopRoot: string
  /** electron-builder CLI 模块的绝对路径。 */
  readonly builderCli: string
  /**
   * 渠道化 `--config.*` 覆盖参数（官方渠道为空数组）。
   *
   * **是函数而不是数组**：生成配置文件必须发生在**应用根暂存之后**（见
   * channel-build.ts 的 channelConfigArgs 说明与 2026-09-23 复审 N-1）。
   */
  readonly channelConfigArgs: () => readonly string[]
  /** 本次构建的渠道 id（日志用）。 */
  readonly channelId: string
  /**
   * 目标格式（缺省 `['AppImage', 'deb']`）。
   *
   * CI 的 Linux 交付面只收 AppImage（deb 不进入任何 artifact/镜像/发布面），而 deb 是
   * electron-builder 里最慢的一段（2026-10-23 实测 ≈284s/次 vs AppImage ≈108s）⇒
   * CI 传 `--no-deb`（= 本字段 `['AppImage']`）。本地与 release 入口不传 ⇒ 行为不变。
   */
  readonly formats?: readonly string[]
  /**
   * 打包输入暂存（见 `pack-app-root.mjs`）。**只有测试注入替身**：生产调用一律走
   * 缺省的真实现（能力级接线判据的对象就是这条缺省路径）。
   */
  readonly stagePackAppRoot?: (packageRoot: string, outputDir: string) => StagedPackAppRootArgs
  /** 执行一条打包命令。 */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** 非敏感进度日志。 */
  readonly log: (message: string) => void
}

/**
 * 打 AppImage + deb（应用根走暂存白名单副本）。
 * @param options - 注入缝；缺省 = 生产路径。
 */
export declare function packageLinux(options?: PackageLinuxOptions): void
