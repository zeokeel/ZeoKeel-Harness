/**
 * P6（2026-10-22）：Windows 静默安装/重装/卸载 + 迁移负例的行为门禁。
 *
 * CI 在 windows-latest 上跑真实安装器；这里用注入的 `run`/`fs`/`registry` 覆盖
 * 编排逻辑本身：超时视为失败、legacy 命中必须 exit 2 且不落盘、静默安装必须
 * per-user（HKCU 有键/HKLM 无键）、重装单份、卸载干净。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CURRENT_APP_GUID,
  LEGACY_ABORT_EXIT_CODE,
  LEGACY_APP_GUID,
  LEGACY_DIAGNOSTIC_FILE,
  findUninstaller,
  runWithTimeout,
  verifyInstallerRuntime,
} from '../scripts/verify-win-installer-runtime.mjs'

const INSTALLER = 'C:\\Downloads\\ZeoKeel-Harness-2.9.0-x64-Setup.exe'
const LOCAL_APP_DATA = 'C:\\Users\\runner\\AppData\\Local'
const INSTALL_DIR = `${LOCAL_APP_DATA}\\Programs\\dsh-plugin-desktop`
const UNINSTALLER = `${INSTALL_DIR}\\Uninstall ZeoKeel Harness.exe`
const DIAGNOSTIC = `C:\\Temp\\${LEGACY_DIAGNOSTIC_FILE}`

interface FakeWorld {
  legacySeeded: boolean
  installDir: boolean
  diagnostic: boolean
  registry: Map<string, string>
  files: Set<string>
}

/** Build the injected filesystem/registry/process trio for the happy path. */
function world(options: { legacyExitCode?: number, installExitCode?: number } = {}): {
  world: FakeWorld
  fs: Record<string, unknown>
  registry: Record<string, unknown>
  run: ReturnType<typeof vi.fn>
} {
  const state: FakeWorld = {
    legacySeeded: false,
    installDir: false,
    diagnostic: false,
    registry: new Map(),
    files: new Set(),
  }
  const normalize = (path: string): string => path.replace(/[\\/]+/gu, '\\')
  const fs = {
    exists: (path: string) => {
      if (normalize(path) === normalize(INSTALL_DIR)) return state.installDir
      if (normalize(path) === normalize(DIAGNOSTIC)) return state.diagnostic
      return state.files.has(normalize(path))
    },
    size: () => 10,
    list: () => ['Uninstall ZeoKeel Harness.exe', 'ZeoKeel Harness.exe'],
    remove: (path: string, recursive: boolean) => {
      void recursive
      if (normalize(path) === normalize(INSTALL_DIR)) state.installDir = false
      if (normalize(path) === normalize(DIAGNOSTIC)) state.diagnostic = false
    },
  }
  const registry = {
    read: async (hive: string, guid: string) => state.registry.get(`${hive}\\${guid}`),
    seed: async (hive: string, guid: string, directory: string) => {
      state.registry.set(`${hive}\\${guid}`, directory)
      state.legacySeeded = true
    },
    delete: async (hive: string, guid: string) => {
      state.registry.delete(`${hive}\\${guid}`)
      state.legacySeeded = false
    },
  }
  const run = vi.fn(async (file: string, args: readonly string[]) => {
    if (normalize(file) === normalize(INSTALLER) && args[0] === '/S') {
      if (state.legacySeeded && state.registry.has(`HKLM\\${LEGACY_APP_GUID}`)) {
        state.diagnostic = true
        return { code: options.legacyExitCode ?? LEGACY_ABORT_EXIT_CODE, stdout: '', stderr: '' }
      }
      if ((options.installExitCode ?? 0) !== 0) return { code: options.installExitCode, stdout: '', stderr: '' }
      state.installDir = true
      state.files.add(normalize(`${INSTALL_DIR}\\ZeoKeel Harness.exe`))
      state.files.add(normalize(`${INSTALL_DIR}\\resources\\LICENSE`))
      state.files.add(normalize(`${INSTALL_DIR}\\resources\\THIRD_PARTY_NOTICES.md`))
      state.registry.set(`HKCU\\${CURRENT_APP_GUID}`, INSTALL_DIR)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (normalize(file) === normalize(UNINSTALLER)) {
      state.installDir = false
      state.files.clear()
      state.registry.delete(`HKCU\\${CURRENT_APP_GUID}`)
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected process: ${file} ${args.join(' ')}`)
  })
  return { world: state, fs, registry, run }
}

function options(source: { fs: Record<string, unknown>, registry: Record<string, unknown>, run: ReturnType<typeof vi.fn> }) {
  return ({
    platform: 'win32' as const,
    localAppData: LOCAL_APP_DATA,
    installDir: INSTALL_DIR,
    temporaryRoot: 'C:\\Temp',
    legacyScratchDir: 'C:\\Temp\\dsh-legacy-fake',
    fs: source.fs,
    registry: source.registry,
    run: source.run,
  }) as unknown as Parameters<typeof verifyInstallerRuntime>[1]
}

describe('安装器行为门禁（编排）', () => {
  it('happy path：迁移负例 → 静默安装 → 重装单份 → 静默卸载', async () => {
    const scene = world()
    const result = await verifyInstallerRuntime(INSTALLER, options(scene))
    expect(result).toEqual({
      installDir: INSTALL_DIR,
      steps: ['preflight', 'legacy-abort', 'silent-install', 'reinstall-single', 'silent-uninstall'],
    })
    // 卸载后目录与 HKCU 键都必须消失（断言由脚本内部完成，这里再确认一遍世界状态）。
    expect(scene.world.installDir).toBe(false)
    expect(scene.world.registry.has(`HKCU\\${CURRENT_APP_GUID}`)).toBe(false)
  })

  it('迁移负例退出码不是 2 → 失败（防止"静默装第二份"回归）', async () => {
    const scene = world({ legacyExitCode: 0 })
    await expect(verifyInstallerRuntime(INSTALLER, options(scene)))
      .rejects.toThrow(/legacy abort must exit 2/u)
  })

  it('静默安装非零退出 → 失败', async () => {
    const scene = world({ installExitCode: 3 })
    await expect(verifyInstallerRuntime(INSTALLER, options(scene)))
      .rejects.toThrow(/silent install failed with exit code 3/u)
  })

  it('已存在安装/注册表不干净时拒绝运行（CI 必须从干净 runner 开始）', async () => {
    const scene = world()
    scene.world.registry.set(`HKCU\\${CURRENT_APP_GUID}`, INSTALL_DIR)
    await expect(verifyInstallerRuntime(INSTALLER, options(scene)))
      .rejects.toThrow(/registry already has u?HKCU/u)
  })
})

describe('进程超时与卸载器定位', () => {
  it('runWithTimeout：正常退出返回退出码', async () => {
    const result = await runWithTimeout(process.execPath, ['-e', 'process.exit(0)'], 10_000)
    expect(result.code).toBe(0)
  })

  it('runWithTimeout：超时被硬失败（静默挂起必须让 CI 失败而不是卡住）', async () => {
    await expect(runWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], 200))
      .rejects.toThrow(/timed out/u)
  })

  it('findUninstaller 只认生成器产出的 Uninstall *.exe', () => {
    expect(findUninstaller(['ZeoKeel Harness.exe', 'Uninstall ZeoKeel Harness.exe', 'resources']))
      .toBe('Uninstall ZeoKeel Harness.exe')
    expect(findUninstaller(['ZeoKeel Harness.exe'])).toBeUndefined()
  })

  it('平台不是 Windows 时明确拒绝（避免门禁在 Linux 上假装通过）', async () => {
    const scene = world()
    await expect(verifyInstallerRuntime(INSTALLER, { ...options(scene), platform: 'linux' }))
      .rejects.toThrow(/requires Windows/u)
  })
})
