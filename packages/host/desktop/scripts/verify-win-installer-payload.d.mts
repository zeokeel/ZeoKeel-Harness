/** Payload files every installer must carry. */
export declare const REQUIRED_PAYLOAD_FILES: readonly string[]
/** Archive names electron-builder may produce for the app payload. */
export declare const PAYLOAD_ARCHIVE_PATTERN: RegExp
/** Find the app payload archive in an extracted installer tree. */
export declare function findPayloadArchive(files: readonly string[]): string | undefined
/** Locate a 7-Zip CLI (`SEVEN_ZIP` override, then standard Windows paths, then PATH). */
export declare function resolveSevenZip(
  env?: Readonly<Record<string, string | undefined>>,
  exists?: (path: string) => boolean,
): string
/** Verify one installer's payload. */
export declare function verifyInstallerPayload(
  installerPath: string,
  options?: {
    readonly sevenZip?: string
    readonly staging?: string
    readonly cleanup?: () => void
    readonly extract?: (sevenZip: string, archive: string, destination: string) => Promise<string[]>
    readonly size?: (path: string) => number
  },
): Promise<{ readonly payloadArchive: string, readonly files: readonly string[] }>
