/** Default official staging directory. */
export declare const OFFICIAL_STAGING_DIR: string
/** Find the official NSIS installer in a staging directory. */
export declare function findOfficialInstaller(directory: string, list?: (directory: string) => readonly string[]): string
