/**
 * Fatal-startup exit decision (P1).
 *
 * The fatal dialog returns a user choice; what the process does next is a small
 * pure decision that the review rounds asked to be testable on its own
 * (2026-10-21 反证审查 D 的 C3–C6：接线只靠源码文本判据，改坏"失败也重启 /
 * 不重启 / 退出码初值"都能全绿）。
 *
 * Rules:
 *  - `retry` relaunches unconditionally (exit 0 only when the relaunch channel
 *    actually restarts, see `shutdown.ts`);
 *  - a recovery exit relaunches **only** when the recovery itself succeeded
 *    (exit code 0), otherwise the process stays down with a non-zero code rather
 *    than looping through the same dialog;
 *  - `quit` always exits non-zero — a fatal startup must never look like success.
 *
 * @module dsh-plugin-desktop/fatal-exit
 */

import type { FatalBootChoice } from './fatal-boot.ts'

/** What the caller must do after the dialog closed. */
export interface FatalExitDecision {
  /** Process exit code to hand to the shutdown coordinator. */
  readonly exitCode: number
  /** Whether the caller should request a relaunch before exiting. */
  readonly relaunch: boolean
}

/** Recovery exits that run an operation before the relaunch. */
export type FatalRecoveryChoice = 'safe-mode' | 'backup-patch'

/**
 * Decide exit code and relaunch for one fatal-dialog choice.
 * @param action - what the user picked.
 * @param runRecovery - runs one recovery exit; 0 means "recovered, may relaunch".
 * @returns exit code + relaunch flag.
 */
export async function resolveFatalExit(
  action: FatalBootChoice,
  runRecovery: (action: FatalRecoveryChoice) => Promise<number>,
): Promise<FatalExitDecision> {
  if (action === 'retry') return { exitCode: 0, relaunch: true }
  if (action === 'safe-mode' || action === 'backup-patch') {
    const exitCode = await runRecovery(action)
    return { exitCode, relaunch: exitCode === 0 }
  }
  return { exitCode: 1, relaunch: false }
}
