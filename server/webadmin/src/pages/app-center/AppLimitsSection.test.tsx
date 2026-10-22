/**
 * 详情抽屉「限流」块（契约 `docs/decisions/2026-10-22-wasm-per-app-limits.md` §2.5/§2.6）
 * 的行为级用例。
 *
 * 每一条都咬**行为**（发了什么请求、成败后界面以谁为准），不是"页面上出现过某个字符串"：
 *
 *   1. 空 = 继承：四个输入留空、占位符 = 该轴的**全局默认值**，生效值行 = 全局值；
 *   2. 保存请求体：只填一轴 ⇒ 另外三轴写 `null`；「恢复默认」⇒ 顶层 `null`（清空覆盖）；
 *   3. `exceeds_global`：超过全局的提交**先弹二次确认**，取消时一个请求都不发；确认后才 PUT；
 *      服务端判定的"已保存覆盖越界"单独可见；
 *   4. 保存失败：**不乐观更新**（输入框与服务端视图一个字都不动），服务端信封原样渲染；
 *   5. 已删除 / 已清除：不渲染写入口、**连 GET 都不发**（服务端 404 不泄露存在性）；
 *   6. 保存成功**回读**服务端视图：服务端归一过的值（例如 clamp 后的 app_queue）必须出现在
 *      输入框里 —— 拿 PUT 响应/请求体拼界面（乐观更新）会让这条红。
 *
 * 变异自证（把对应实现删掉，这些用例会红）：
 *   · 删掉 `previewExceeds` 的确认闸门 ⇒ 第 3 条红（PUT 在确认前就发了）；
 *   · 把「恢复默认」改成只清表单不发请求 ⇒ 第 2 条红（第二次 PUT 不存在 / body 不是 null）；
 *   · 成功后不 GET、直接用请求体回填 ⇒ 第 6 条红（app_queue 不会变成 8）；
 *   · 失败后按提交值回填 ⇒ 第 4 条红（覆盖摘要会变成 app_running=3）；
 *   · 已删除行照旧渲染写入口 ⇒ 第 5 条红（GET 会被打出去）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError, request } from '../../api'
import { AppLimitsSection } from './AppLimitsSection'
import { APP_LIMIT_KEYS, appLimitsPath, type AppLimitValues } from './app-limits'

const mockRequest = vi.mocked(request)

const APP_ID = 'share-note'

/** 全局四值（服务端默认口径：`user_per_app_running` 2026-10-22 起是 2）。 */
const GLOBAL: AppLimitValues = {
  app_running: 4,
  app_queue: 32,
  user_per_app_running: 2,
  user_per_app_queued: 4,
}

type Override = Record<(typeof APP_LIMIT_KEYS)[number], number | null>

interface PutRecord {
  path: string
  method: string
  /** `JSON.parse(body)`：`null` 表示"清空全部覆盖"。 */
  body: Record<string, number | null> | null
}

let stored: Override
let putMode: 'ok' | 'fail'
let getMode: 'ok' | 'drift' | 'missing'
let gets: number
let puts: PutRecord[]
/** 服务端在保存时可能归一（clampCrossField 一类）：用来证明界面以**回读**为准。 */
let serverAdjust: ((override: Override) => Override) | null

const FAIL_ERR = new ApiError(
  422,
  'VALIDATION',
  '单用户单应用并发不能大于单应用并发',
  undefined,
  ['全局 app_running=4，本次提交 user_per_app_running=5'],
  { field: 'user_per_app_running' },
)

function allInherit(): Override {
  const out = {} as Override
  for (const key of APP_LIMIT_KEYS) out[key] = null
  return out
}

function effectiveOf(override: Override): AppLimitValues {
  const out = {} as AppLimitValues
  for (const key of APP_LIMIT_KEYS) {
    const value = override[key]
    out[key] = typeof value === 'number' ? value : GLOBAL[key]
  }
  return out
}

function viewOf(override: Override, changed?: boolean) {
  const effective = effectiveOf(override)
  const exceeds: Record<string, boolean> = {}
  for (const key of APP_LIMIT_KEYS) exceeds[key] = effective[key] > GLOBAL[key]
  return {
    app_id: APP_ID,
    global: GLOBAL,
    override: { ...override },
    effective,
    exceeds_global: exceeds,
    ...(changed === undefined ? {} : { changed }),
  }
}

beforeEach(() => {
  stored = allInherit()
  putMode = 'ok'
  getMode = 'ok'
  gets = 0
  puts = []
  serverAdjust = null
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    const raw = String(path)
    const method = (init?.method ?? 'GET').toUpperCase()
    // 关掉这个块之外的一切请求：本块只许打 `/limits`。
    expect(raw).toBe(appLimitsPath(APP_ID))
    if (method === 'GET') {
      gets += 1
      if (getMode === 'missing') throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在')
      // 形状漂移：缺 global/effective（页面必须说"读取失败"，不能渲染成"全部继承"）。
      if (getMode === 'drift') return { app_id: APP_ID }
      return viewOf(stored)
    }
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    puts.push({ path: raw, method, body: body as PutRecord['body'] })
    if (putMode === 'fail') throw FAIL_ERR
    const next: Override =
      body === null ? allInherit() : { ...allInherit(), ...(body as Record<string, number | null>) }
    stored = serverAdjust === null ? next : serverAdjust(next)
    return viewOf(stored, true)
  })
})

function renderBlock(props: {
  canRead?: boolean
  canWrite?: boolean
  app?: Record<string, unknown> | null
} = {}) {
  return render(
    <AppLimitsSection
      appId={APP_ID}
      app={props.app ?? {}}
      canRead={props.canRead ?? true}
      canWrite={props.canWrite ?? true}
    />,
  )
}

/** 等首屏视图落地（四个输入出现）。 */
async function waitLoaded() {
  await screen.findByTestId('app-limit-app_running')
}

describe('① 空 = 继承全局（占位符就是全局默认值）', () => {
  it('四个输入留空、占位符 = 全局值、生效值 = 全局值，且不会发任何写请求', async () => {
    renderBlock()
    await waitLoaded()

    for (const key of APP_LIMIT_KEYS) {
      const input = screen.getByTestId(`app-limit-${key}`)
      expect(input, `${key} 无覆盖时必须留空`).toHaveProperty('value', '')
      // 占位符 = 全局默认值（这是"空 = 继承"唯一可读的依据）。
      expect(input.getAttribute('placeholder'), `${key} 的占位符必须是全局值`).toBe(String(GLOBAL[key]))
      expect(screen.getByTestId(`app-limit-global-${key}`).textContent).toContain(String(GLOBAL[key]))
      expect(screen.getByTestId(`app-limit-effective-${key}`).textContent).toContain(
        `继承（生效 ${GLOBAL[key]}）`,
      )
    }
    const summary = screen.getByTestId('app-limits-effective')
    expect(summary.textContent).toContain(`app_running=${GLOBAL.app_running}`)
    expect(summary.textContent).toContain(`app_queue=${GLOBAL.app_queue}`)
    expect(screen.getByTestId('app-limits-override-summary').textContent).toContain('app_running=继承')

    // 没有改动 ⇒ 保存不可点（避免"点了没反应"式的空 PUT）；「恢复默认」也没有可清的东西。
    expect(screen.getByTestId('app-limits-save')).toBeDisabled()
    expect(screen.getByTestId('app-limits-reset')).toBeDisabled()
    expect(screen.queryByTestId('app-limits-dirty')).toBeNull()
    expect(puts).toHaveLength(0)
  })
})

describe('② 保存请求体（空轴 = null；恢复默认 = null）', () => {
  it('只填一轴 ⇒ 四轴都进 body，其余三轴显式 null；成功后回读', async () => {
    renderBlock()
    await waitLoaded()

    fireEvent.change(screen.getByTestId('app-limit-app_running'), { target: { value: '3' } })
    expect(screen.getByTestId('app-limits-dirty')).toBeTruthy()
    fireEvent.click(screen.getByTestId('app-limits-save'))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.path).toBe('/api/server/admin/wasm-apps/share-note/limits')
    expect(puts[0]!.method).toBe('PUT')
    expect(puts[0]!.body).toEqual({
      app_running: 3,
      app_queue: null,
      user_per_app_running: null,
      user_per_app_queued: null,
    })

    // 成功 ⇒ 回读服务端视图（gets 从 1 变 2），输入框回填为服务端真值。
    await waitFor(() => expect(gets).toBe(2))
    await waitFor(() => expect(screen.getByTestId('app-limit-app_running')).toHaveProperty('value', '3'))
    expect(screen.getByTestId('app-limits-flash').textContent).toContain('已保存')
    expect(screen.getByTestId('app-limits-flash').textContent).toContain('wasm_app_limits_change')
  })

  it('「恢复默认」= 立刻 PUT 顶层 null（不是只清表单），四轴回到继承全局', async () => {
    stored = { app_running: 6, app_queue: 40, user_per_app_running: 3, user_per_app_queued: 8 }
    renderBlock()
    await waitLoaded()
    expect(screen.getByTestId('app-limit-app_running')).toHaveProperty('value', '6')

    fireEvent.click(screen.getByTestId('app-limits-reset'))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.method).toBe('PUT')
    expect(puts[0]!.body).toBeNull() // JSON.stringify(null) ⇒ "null"，= 清空全部覆盖
    await waitFor(() => expect(gets).toBe(2))
    for (const key of APP_LIMIT_KEYS) {
      await waitFor(() => expect(screen.getByTestId(`app-limit-${key}`)).toHaveProperty('value', ''))
    }
    expect(screen.getByTestId('app-limits-flash').textContent).toContain('已恢复默认')
  })
})

describe('③ exceeds_global：保存前二次确认（取消则一个请求都不发）', () => {
  it('超过全局的提交先弹确认框；取消不发请求，确认才 PUT', async () => {
    renderBlock()
    await waitLoaded()

    fireEvent.change(screen.getByTestId('app-limit-app_running'), { target: { value: '6' } })
    // 保存**之前**就要把"会超过全局"摆在眼前（不必等到点保存）。
    expect(screen.getByTestId('app-limits-exceeds-warning').textContent).toContain('占用更多槽位')

    fireEvent.click(screen.getByTestId('app-limits-save'))
    const dialog = await screen.findByTestId('app-limits-confirm-dialog')
    expect(dialog).toBeTruthy()
    expect(screen.getByTestId('app-limits-confirm-warning').textContent).toContain(
      '单应用并发：全局 4 → 该应用 6',
    )
    expect(puts, '确认之前一个写请求都不许发').toHaveLength(0)

    fireEvent.click(screen.getByTestId('app-limits-confirm-cancel'))
    await waitFor(() => expect(screen.queryByTestId('app-limits-confirm-dialog')).toBeNull())
    expect(puts).toHaveLength(0)
    expect(screen.getByTestId('app-limit-app_running')).toHaveProperty('value', '6')

    // 第二次：确认提交。
    fireEvent.click(screen.getByTestId('app-limits-save'))
    fireEvent.click(await screen.findByTestId('app-limits-confirm'))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]!.body).toEqual({
      app_running: 6,
      app_queue: null,
      user_per_app_running: null,
      user_per_app_queued: null,
    })

    // 回读后：**服务端判定**的"当前覆盖已越界"单独一条文案（与待保存的警告分开）。
    await waitFor(() => expect(screen.getByTestId('app-limits-server-exceeds')).toBeTruthy())
    expect(screen.getByTestId('app-limits-server-exceeds').textContent).toContain('app_running')
  })

  it('没有超过全局 ⇒ 不弹确认框，直接 PUT', async () => {
    renderBlock()
    await waitLoaded()
    fireEvent.change(screen.getByTestId('app-limit-app_running'), { target: { value: '4' } })
    expect(screen.queryByTestId('app-limits-exceeds-warning')).toBeNull()

    fireEvent.click(screen.getByTestId('app-limits-save'))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(screen.queryByTestId('app-limits-confirm-dialog')).toBeNull()
  })
})

describe('④ 保存失败：不乐观更新 + 服务端信封原样渲染', () => {
  it('422 VALIDATION：输入框保留用户的值、覆盖摘要不变、不回读、错误里点名字段与判据', async () => {
    putMode = 'fail'
    renderBlock()
    await waitLoaded()

    fireEvent.change(screen.getByTestId('app-limit-app_running'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('app-limits-save'))

    const err = await screen.findByTestId('app-limits-save-error')
    // 服务端 message / details.field / hints 三件都要在（不许被前端文案吃掉）。
    expect(err.textContent).toContain('单用户单应用并发不能大于单应用并发')
    expect(err.textContent).toContain('字段 user_per_app_running')
    expect(err.textContent).toContain('全局 app_running=4，本次提交 user_per_app_running=5')
    expect(err.textContent).toContain('applimits.Validate')

    // 不乐观更新：用户填的值还在（没被吞掉），但"已保存的覆盖"一个字都没变。
    expect(screen.getByTestId('app-limit-app_running')).toHaveProperty('value', '3')
    expect(screen.getByTestId('app-limits-override-summary').textContent).toContain('app_running=继承')
    expect(screen.getByTestId('app-limits-effective').textContent).toContain('app_running=3')
    // 失败后没有回读（gets 仍是首屏那一次），也没有成功回执。
    expect(gets).toBe(1)
    expect(screen.queryByTestId('app-limits-flash')).toBeNull()
  })

  it('格式不合法（0）⇒ 前端当场拦下，一个 PUT 都不发', async () => {
    renderBlock()
    await waitLoaded()
    fireEvent.change(screen.getByTestId('app-limit-app_running'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('app-limits-save'))

    const err = await screen.findByTestId('app-limits-save-error')
    expect(err.textContent).toContain('必须填正整数')
    expect(puts).toHaveLength(0)
    expect(screen.getByTestId('app-limit-app_running')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('⑤ 已删除 / 已清除 / 只读：没有写入口（也不发请求）', () => {
  it('已删除（保留期内）：说明"不能配置 + 先恢复"，不渲染输入与按钮，连 GET 都不发', async () => {
    renderBlock({ app: { deleted_at: '2026-10-01T00:00:00Z' } })
    const note = await screen.findByTestId('limits-block-unavailable')
    expect(note.textContent).toContain('已删除')
    expect(note.textContent).toContain('恢复')
    expect(gets, '已删除应用不该发 GET（服务端 404 不泄露存在性）').toBe(0)
    expect(screen.queryByTestId('app-limit-app_running')).toBeNull()
    expect(screen.queryByTestId('app-limits-save')).toBeNull()
    expect(screen.queryByTestId('app-limits-reset')).toBeNull()
  })

  it('已清除（purged）：说明不可恢复，同样不渲染写入口、不发请求', async () => {
    renderBlock({
      app: { deleted_at: '2026-09-01T00:00:00Z', purged_at: '2026-12-01T00:00:00Z' },
    })
    const note = await screen.findByTestId('limits-block-unavailable')
    expect(note.textContent).toContain('已清除')
    expect(gets).toBe(0)
    expect(screen.queryByTestId('app-limits-save')).toBeNull()
  })

  it('无 capability:write：值可读、输入禁用、写入口全部不可用（禁用原因可见）', async () => {
    // 覆盖里有值 ⇒ 「恢复默认」本来该可点（limitsHasOverride=true）；这里它必须因为**权限**
    // 而禁用 —— 否则"只读账号点得动写按钮"这条就漏了。
    stored = { app_running: 3, app_queue: null, user_per_app_running: null, user_per_app_queued: null }
    renderBlock({ canWrite: false })
    await waitLoaded()

    expect(screen.getByTestId('app-limit-app_running')).toBeDisabled()
    expect(screen.getByTestId('app-limit-app_running')).toHaveProperty('value', '3')
    expect(screen.getByTestId('app-limits-save')).toBeDisabled()
    expect(screen.getByTestId('app-limits-reset')).toBeDisabled()
    expect(screen.getByTestId('app-limits-readonly').textContent).toContain('capability:write')
    // 点禁用按钮不会发出任何写请求（服务端也会拒，但前端不该先发一次）。
    fireEvent.click(screen.getByTestId('app-limits-save'))
    fireEvent.click(screen.getByTestId('app-limits-reset'))
    expect(puts).toHaveLength(0)
    // 只读时仍然读到了服务端视图（gets=1），不是把"没权限"渲染成"没有覆盖"。
    expect(gets).toBe(1)
  })
})

describe('⑥ 保存成功回读服务端视图（不是拿请求体回填）', () => {
  it('服务端归一过的值必须出现在输入框里（PUT body 里没有它）', async () => {
    // 服务端在保存时把 app_queue 归一成 8（模拟 clampCrossField 一类的服务端真值）。
    serverAdjust = (override) => ({ ...override, app_queue: 8 })
    renderBlock()
    await waitLoaded()

    fireEvent.change(screen.getByTestId('app-limit-app_running'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('app-limits-save'))
    await waitFor(() => expect(puts).toHaveLength(1))
    // 请求体里 app_queue 是 null（继承）—— 8 只可能来自回读。
    expect(puts[0]!.body!.app_queue).toBeNull()

    await waitFor(() => expect(gets).toBe(2))
    await waitFor(() => expect(screen.getByTestId('app-limit-app_queue')).toHaveProperty('value', '8'))
    expect(screen.getByTestId('app-limit-app_running')).toHaveProperty('value', '3')
  })
})

describe('⑦ 读取失败与形状漂移（不得渲染成"全部继承全局"）', () => {
  it('形状漂移（缺 global/effective）⇒ 读取失败，且不渲染输入', async () => {
    getMode = 'drift'
    renderBlock()
    const err = await screen.findByTestId('app-limits-load-error')
    expect(err.textContent).toContain('读取限流失败')
    expect(err.textContent).toContain('global')
    expect(screen.queryByTestId('app-limit-app_running')).toBeNull()
  })

  it('404 ⇒ 明说服务端尚未提供该端点（后端泳道未合入）', async () => {
    getMode = 'missing'
    renderBlock()
    const err = await screen.findByTestId('app-limits-load-error')
    expect(err.textContent).toContain('尚未提供该端点')
    expect(err.textContent).toContain('/wasm-apps/share-note/limits')
  })
})
