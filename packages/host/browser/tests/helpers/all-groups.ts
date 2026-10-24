/**
 * Every tool group (including the low-frequency ones that are off by default).
 *
 * Audit specs exercise specific tools by name; when a spec needs a tool from
 * `memory`/`human`/`advanced` it registers with this set instead of changing the
 * production default.
 */
import { DEFAULT_GROUPS } from '../../src/tools.ts'

export const ALL_TOOL_GROUPS: ReadonlySet<string> = new Set([...DEFAULT_GROUPS, 'memory', 'human', 'advanced'])
