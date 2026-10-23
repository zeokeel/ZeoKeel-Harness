/**
 * Upload allow-list derivation (A11 single source, 2026-10-23).
 *
 * The list comes ONLY from deployment/session context — never from a tool or a
 * program argument. Shared by `browser_upload_file`, the file-chooser tool and
 * the `browser_run` fileChooser helper so the three cannot drift.
 * @module @zeokeel/dsh-browser
 */

/** Inputs that may contribute upload directories. */
export interface UploadDirSources {
  /** Where downloads land (always allowed for uploads, after normalisation). */
  downloadDir?: string | undefined
  /** Deployment-configured extra directories (`Config.uploadDirs`). */
  uploadDirs?: readonly string[]
  /** Session workspace (never a model-supplied path). */
  sessionCwd?: string | undefined
}

/**
 * Normalise one directory entry: trim, collapse trailing slashes.
 * @param dir - raw entry.
 * @returns the normalised path (possibly empty).
 */
function normalize(dir: string): string {
  return dir.trim().replace(/\/+$/u, '')
}

/**
 * Derive the upload allow-list.
 * @param sources - deployment + session inputs.
 * @returns absolute, de-duplicated directories; `/` and relative paths dropped.
 */
export function uploadAllowDirs(sources: UploadDirSources): string[] {
  const dirs = new Set<string>()
  for (const raw of [sources.downloadDir, ...(sources.uploadDirs ?? []), sources.sessionCwd]) {
    if (typeof raw !== 'string') continue
    const dir = normalize(raw)
    if (dir === '' || dir === '/' || !dir.startsWith('/')) continue
    dirs.add(dir)
  }
  return [...dirs]
}
