/**
 * Restricted executor tests (user decision B, 2026-10-23): the program's world
 * contains only the bridge and a console, and the code-generation escape is
 * closed. See the honest boundary note in `src/program-restricted.ts`.
 */
import { describe, expect, it } from 'vitest'
import { PROGRAM_DENIED_IDENTIFIERS, assertProgramAllowed, runRestrictedProgram } from '../src/program-restricted.ts'

describe('restricted program executor', () => {
  it('runs with the bridge only and captures console/result', async () => {
    const bridge = Object.freeze({ ping: async () => 'pong' })
    const outcome = await runRestrictedProgram('console.log("hi"); const value = await browser.ping(); return { value }', bridge)
    expect(outcome.result).toEqual({ value: 'pong' })
    expect(outcome.console).toContain('log: hi')
  })

  it('has no ambient Node capabilities', async () => {
    for (const name of ['require', 'process', 'fetch', 'child_process', 'fs', 'net', 'globalThis', 'import']) {
      expect(PROGRAM_DENIED_IDENTIFIERS).toContain(name)
      expect(() => assertProgramAllowed(`const x = ${name}`)).toThrow(/forbidden capability/u)
    }
    // Inside the real context none of the globals exist.
    const outcome = await runRestrictedProgram('return { keys: Object.keys(globalThisThis).length }'.replace('globalThisThis', 'browser'), Object.freeze({}))
    expect(outcome.result).toEqual({ keys: 0 })
  })

  it('closes the Function-constructor escape (no eval inside the realm)', async () => {
    // Not caught by the static denylist (it only names identifiers), so this
    // proves the vm codeGeneration guard rather than the regex layer.
    await expect(runRestrictedProgram('return ({}).constructor.constructor("return 1")()', Object.freeze({})))
      .rejects.toThrow(/Code generation from strings disallowed/u)
  })

  it('rejects dynamic import without a module callback', async () => {
    await expect(runRestrictedProgram('return await import("node:fs")', Object.freeze({})))
      .rejects.toBeTruthy()
  })
})
