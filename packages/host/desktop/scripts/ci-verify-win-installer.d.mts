/** Default official staging directory. */
export declare const OFFICIAL_STAGING_DIR: string
/** Root of all staged channel installers. */
export declare const STAGING_ROOT: string
/** Find the staged installer for the current release channel. */
export declare function findStagedInstaller(root?: string, list?: (directory: string) => readonly string[]): string
/** Find the official NSIS installer in a staging directory. */
export declare function findOfficialInstaller(directory: string, list?: (directory: string) => readonly string[]): string
