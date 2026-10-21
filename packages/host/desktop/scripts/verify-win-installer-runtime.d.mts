/** NSIS GUID of the current product. */
export declare const CURRENT_APP_GUID: string
/** NSIS GUID of the pre-rebrand product. */
export declare const LEGACY_APP_GUID: string
/** Installer exit code the migration shim uses for a legacy installation. */
export declare const LEGACY_ABORT_EXIT_CODE: number
/** Diagnostic file the migration shim writes before aborting. */
export declare const LEGACY_DIAGNOSTIC_FILE: string
/** Product executable name inside the install directory. */
export declare const APPLICATION_FILE: string
/** Notices delivered through extraResources. */
export declare const REQUIRED_RESOURCE_FILES: readonly string[]
/** Run one process with a hard timeout. */
export declare function runWithTimeout(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly code: number, readonly stdout: string, readonly stderr: string }>
/** Read `InstallLocation` from one registry key. */
export declare function readInstallLocation(hive: string, guid: string): Promise<string | undefined>
/** Find the generated NSIS uninstaller in an installation directory listing. */
export declare function findUninstaller(entries: readonly string[]): string | undefined
/** Run the full behaviour gate (Windows only). */
export declare function verifyInstallerRuntime(
  installerPath: string,
  options?: {
    readonly platform?: NodeJS.Platform
    readonly run?: (file: string, args: readonly string[], timeoutMs: number) => Promise<{ readonly code: number }>
    readonly fs?: {
      readonly exists: (path: string) => boolean
      readonly size: (path: string) => number
      readonly list: (directory: string) => string[]
      readonly remove: (path: string, recursive: boolean) => void
    }
    readonly registry?: {
      readonly read: (hive: string, guid: string) => Promise<string | undefined>
      readonly seed: (hive: string, guid: string, directory: string) => Promise<void>
      readonly delete: (hive: string, guid: string) => Promise<void>
    }
    readonly localAppData?: string
    readonly temporaryRoot?: string
    readonly legacyScratchDir?: string
    readonly installDir?: string
  },
): Promise<{ readonly installDir: string, readonly steps: readonly string[] }>
