/**
 * 「应用 AI 授权」**汇总视图**（2026-10-22 审计 F-09 的落点）。
 *
 * 缺陷形态：撤销应用 AI 授权此前**只有应用详情页一个入口**（`AppAiPanel` 的注释自己
 * 写着"这是唯一的撤销入口"）—— 用户授过几个应用、分别是哪些，界面上无处可查，只能
 * 一个个点进详情页去看。授权键是 用户 × 服务端 × 应用 三段（`app-ai.ts` 的
 * `appAiConsentKey`），所以"列出来"必须先枚举存储里属于**当前作用域**的键：
 * 换账号/换服务端之后的授权既不该被列出，也不该被这次撤销影响。
 *
 * ## 为什么放在应用中心而不是"设置页"
 *
 * 设置页的 `settings.section` 槽位由 `@deepseek-ai/dsh-client-ui-settings` 声明，而本包
 * 没有、也**不该**为了一段汇总去新增一个与设置壳耦合的依赖（`nmHoistingLimits:
 * workspaces` 下那会连带改 lockfile）。应用中心是这些授权**产生的地方**（每个应用的
 * AI 面板都在这里打开），汇总视图放在目录页顶部，位置与语义一致。要挪到设置页只需要
 * 把这一个组件注册进那个槽位，协议与状态机不用动。
 *
 * ## 撤销的两步（与 `AppAiPanel` 同一条链）
 *
 * ① 宿主闸门（`POST /api/zeokeel/wasm-apps/ai/consent`，`granted:false`）—— 它才是
 * 真正的权限；② 渲染层 `localStorage`（决定"要不要再弹一次说明卡"）。**先宿主后本地**：
 * 宿主没答应就不删本地记录，否则界面显示"已撤销"而调用仍然放行（反过来是最坏的组合）。
 *
 * @module @zeokeel/dsh-wasm-apps/client/AppAiConsentSummary
 */

import { useCallback, useEffect, useState } from 'react'
import {
  defaultAppAiConsentStore,
  listAppAiConsents,
  revokeAppAiConsent,
  revokeAllAppAiConsents,
  syncAppAiConsent,
  type AppAiConsentGrant,
  type AppAiConsentStore,
  type AppAiDeps,
  type AppAiScope,
} from './app-ai.ts'
import { t } from './locales.ts'

/** 组件依赖（全部可注入：单测用内存存储与假 fetch）。 */
export interface AppAiConsentSummaryProps {
  /** 当前作用域（用户 × 服务端）；`null` = 未登录/缺段 ⇒ 不渲染任何授权。 */
  scope: AppAiScope | null
  /** 渲染层授权存储（缺省 `localStorage`）。 */
  store?: AppAiConsentStore | null
  /** 宿主同步的传输依赖（测试注入假 fetch）。 */
  deps?: AppAiDeps
}

/** 一行按钮的样式（与面板里的小动作一致：无边框、hover 由 class 负责）。 */
const ROW_ACTION: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 6,
  border: '1px solid currentColor',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

const ROW_ACTION_DISABLED: React.CSSProperties = { ...ROW_ACTION, opacity: 0.55, cursor: 'default' }

const SECTION: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2, #D0D5DD)',
  fontSize: 12,
}

const HINT: React.CSSProperties = { margin: 0, opacity: 0.75 }
const ERROR: React.CSSProperties = { margin: 0, color: 'var(--dsw-alias-state-error-primary)' }
const LIST: React.CSSProperties = { margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }

/**
 * 已授权使用「应用 AI」的应用清单 + 单条撤销 + 一键全部撤销。
 *
 * 渲染条件：**当前作用域下至少有一条授权**（没有授权时不渲染 —— 一个恒空的
 * "授权汇总"只会占位置）。
 * @param props - 作用域、存储、传输依赖。
 * @returns 汇总块；没有授权时返回 `null`。
 */
export function AppAiConsentSummary({ scope, store, deps }: AppAiConsentSummaryProps): React.ReactElement | null {
  const consentStore = store ?? defaultAppAiConsentStore()
  const [grants, setGrants] = useState<AppAiConsentGrant[]>(() => listAppAiConsents(scope, consentStore))
  /** 正在撤销的 app_id，或 `'all'`（按钮据此禁用，避免连点）。 */
  const [busy, setBusy] = useState<string | 'all' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    setGrants(listAppAiConsents(scope, consentStore))
  }, [scope, consentStore])

  // 作用域到位（身份是异步取的）或存储变化时重算：`scope` 从 `null` 变成真实值的那一刻
  // 必须重新列一次，否则汇总会永远停在"没有授权"。
  useEffect(() => { refresh() }, [refresh])

  /**
   * 撤销一条：先宿主闸门、再本地记录（顺序不能反，见模块注释）。
   * @param appId - 应用标识。
   * @returns 是否成功（失败原因已进状态）。
   */
  const revokeOne = async (appId: string): Promise<boolean> => {
    const synced = await syncAppAiConsent(appId, false, deps)
    if (!synced.ok) {
      setFailure(`${t('appCenter.ai.revokeFailed')} ${synced.message}`)
      return false
    }
    revokeAppAiConsent(scope, appId, consentStore)
    return true
  }

  const handleRevoke = async (appId: string): Promise<void> => {
    if (busy !== null) return
    setBusy(appId)
    setFailure(null)
    setNotice(null)
    try {
      if (await revokeOne(appId)) {
        setNotice(t('appCenter.aiConsentRevoked'))
        refresh()
      }
    } finally {
      setBusy(null)
    }
  }

  /**
   * 一键撤销全部：**逐条**走同一条链（宿主是权威），失败的条目留在列表里并如实报数 ——
   * "全部撤销成功"这句话只有在每条都成功时才可以显示。
   */
  const handleRevokeAll = async (): Promise<void> => {
    if (busy !== null || grants.length === 0) return
    setBusy('all')
    setFailure(null)
    setNotice(null)
    try {
      const failed: string[] = []
      for (const grant of grants) {
        if (!await revokeOne(grant.appId)) failed.push(grant.appId)
      }
      // 本地的其它记录（宿主同步失败的那些）不动 —— 与宿主保持一致优先于"列表变空"。
      const leftover = listAppAiConsents(scope, consentStore)
      const cleared = grants.length - leftover.length
      if (failed.length === 0 && leftover.length === 0) {
        setNotice(t('appCenter.aiConsentRevokedAll'))
      } else {
        // 宿主的失败原因已经由 `revokeOne` 写进 `failure`；这里补一句「还剩几条」。
        setNotice(t('appCenter.aiConsentRevokedSome').replace('{n}', String(cleared < 0 ? 0 : cleared)))
      }
      refresh()
    } finally {
      setBusy(null)
    }
  }

  // 渲染条件：有授权可撤，**或**刚刚产生了一条结果（否则"全部撤销成功"会连提示一起
  // 消失 —— 用户点完什么都没发生的样子与失败无法区分）。
  if (scope === null) return null
  if (grants.length === 0 && notice === null && failure === null) return null

  return (
    <section className="zeokeel-app-center-ai-consents" data-role="ai-consent-summary" style={SECTION}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {`${t('appCenter.aiConsentTitle')} (${String(grants.length)})`}
      </p>
      <p style={HINT} data-role="ai-consent-hint">{t('appCenter.aiConsentHint')}</p>
      {grants.length > 0 && (
      <ul style={LIST} data-role="ai-consent-list">
        {grants.map(grant => (
          <li key={grant.appId} data-role="ai-consent-row" data-app-id={grant.appId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span data-role="ai-consent-app">{grant.appId}</span>
            <button
              type="button"
              className="zeokeel-app-center-ai-consent-revoke"
              data-action="revoke-ai-consent"
              style={busy === null ? ROW_ACTION : ROW_ACTION_DISABLED}
              disabled={busy !== null}
              aria-label={`${t('appCenter.ai.revoke')} ${grant.appId}`}
              onClick={() => { void handleRevoke(grant.appId) }}
            >
              {t('appCenter.ai.revoke')}
            </button>
          </li>
        ))}
      </ul>
      )}
      {grants.length > 0 && (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="zeokeel-app-center-ai-consent-revoke-all"
          data-action="revoke-all-ai-consents"
          style={busy === null ? ROW_ACTION : ROW_ACTION_DISABLED}
          disabled={busy !== null}
          onClick={() => { void handleRevokeAll() }}
        >
          {t('appCenter.aiConsentRevokeAll')}
        </button>
      </div>
      )}
      {notice !== null && <p style={HINT} role="status" data-role="ai-consent-notice">{notice}</p>}
      {failure !== null && <p style={ERROR} role="alert" data-role="ai-consent-error">{failure}</p>}
    </section>
  )
}

/** 供其它模块复用的撤销全部（**只清本地记录**；宿主那条链在组件里逐条走）。 */
export { revokeAllAppAiConsents }
