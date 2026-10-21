/**
 * P1（2026-10-21，反证审查 D 的 C3–C6）：致命对话框之后的**退出决策**。
 *
 * 这段语义原先只存在于 `main.ts` 的 catch 里，用源码文本判据约束，删掉分支/改成
 * 恒重启/把 shutdown 提前都能全绿。现在抽成纯函数逐条判：
 *  - retry 一定重启（code 0）；
 *  - 恢复出口只在恢复成功（返回 0）时重启，失败必须留在原地非零退出；
 *  - quit 永远非零退出，绝不伪装成功。
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveFatalExit } from '../src/fatal-exit.ts'

describe('致命退出决策', () => {
  it('retry：重启且退出码 0，不执行恢复', async () => {
    const runRecovery = vi.fn(async () => 0)
    await expect(resolveFatalExit('retry', runRecovery)).resolves.toEqual({ exitCode: 0, relaunch: true })
    expect(runRecovery).not.toHaveBeenCalled()
  })

  it('safe-mode：恢复成功才重启（退出码 0）', async () => {
    const runRecovery = vi.fn(async (action: 'safe-mode' | 'backup-patch') => {
      expect(action).toBe('safe-mode')
      return 0
    })
    await expect(resolveFatalExit('safe-mode', runRecovery)).resolves.toEqual({ exitCode: 0, relaunch: true })
    expect(runRecovery).toHaveBeenCalledTimes(1)
  })

  it('backup-patch：恢复失败时**不重启**，保留非零退出码', async () => {
    const runRecovery = vi.fn(async () => 1)
    await expect(resolveFatalExit('backup-patch', runRecovery)).resolves.toEqual({ exitCode: 1, relaunch: false })
  })

  it('恢复成功但返回非零码时同样不重启（以恢复结果为准，不猜）', async () => {
    const runRecovery = vi.fn(async () => 3)
    await expect(resolveFatalExit('safe-mode', runRecovery)).resolves.toEqual({ exitCode: 3, relaunch: false })
  })

  it('quit：永远非零退出，不执行恢复、不重启', async () => {
    const runRecovery = vi.fn(async () => 0)
    await expect(resolveFatalExit('quit', runRecovery)).resolves.toEqual({ exitCode: 1, relaunch: false })
    expect(runRecovery).not.toHaveBeenCalled()
  })

  it('恢复抛错向上传播（由调用方转成可见错误 + 非零退出）', async () => {
    const runRecovery = vi.fn(async () => { throw new Error('recovery exploded') })
    await expect(resolveFatalExit('safe-mode', runRecovery)).rejects.toThrow(/exploded/u)
  })
})
