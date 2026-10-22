/**
 * 主窗口**一次性 toast**（§5.3 / §19 Q5 的异渠道深链提示）。
 *
 * ## 谁的哪一半
 *
 * 深链解析在**宿主**（`packages/host/wasm-apps-host`，L2）：只有那里知道"这条链接的
 * scheme 属于另一家企业的客户端"。宿主把这件事广播出来，**文案与渲染**在本模块
 * （本包是客户端 UI 的唯一展示面）。两者之间的接缝只有一条：
 * `ctx.on(APP_FOREIGN_DEEP_LINK_EVENT, …)` —— 宿主必须用**同一个事件名**发。
 *
 * ## 为什么是一个模块级 store（而不是 React context）
 *
 * 订阅方是客户端插件（`client/index.ts`，拿得到 `ctx`），渲染方是侧边栏里的
 * `AppToastHost`（拿不到 `ctx`）。两者之间用 `useSyncExternalStore` 连起来，
 * 既不引入第二个 React root，也不让插件去碰 DOM。
 *
 * @module @zeokeel/dsh-wasm-apps/client/app-toast
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { t } from './locales.ts'

// 声明宿主侧广播的事件（客户端编译面不加载宿主模块的声明）——与
// `enterprise/src/client/channel-store.ts` 对 `zeokeel/channel-changed` 的做法一致。
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 收到一条属于**另一家企业客户端**的深链（§5.3；宿主发出）。 */
    'zeokeel/wasm-app-deep-link-foreign'(payload?: { url?: string }): void
    /**
     * 未登录的深链被记住（`queued`）／登录后按队列续开（`opening`）（U-07；宿主发出）。
     * 载荷只用于决定文案，不用于拼接任何 URL。
     */
    'zeokeel/wasm-app-queued'(payload?: { app_id?: string, state?: 'queued' | 'opening' }): void
  }
}

/**
 * 异渠道深链的宿主广播事件（**跨端接缝**，L2 必须用同一个名字发）。
 *
 * 触发条件（§5.3）：收到一条深链，但它的 scheme **属于另一个渠道/安装**
 * （跨渠道不工作属预期，不能静默丢弃 —— 用户要知道该找谁）。
 */
export const APP_FOREIGN_DEEP_LINK_EVENT = 'zeokeel/wasm-app-deep-link-foreign'

/**
 * 深链入队 / 续开的宿主广播事件（**跨端接缝**，U-07；与宿主的
 * `WASM_APP_QUEUED_EVENT` 逐字相同）。
 *
 * 为什么需要它：未登录时点同事发来的 `<scheme>://app/<id>`，宿主把打开请求放进
 * 待打开队列后**什么都不发生**（宿主修前不广播、客户端也就无从提示）。用户会以为
 * 链接坏了或客户端没装 —— 而面板路径对同一件事会显示「已记住这次打开」。
 */
export const APP_QUEUED_EVENT = 'zeokeel/wasm-app-queued'

/** toast 的类型（三种提示各自可辨：异渠道 / 已记住 / 登录后续开）。 */
export type AppToast =
  | { kind: 'foreign-deep-link' }
  | { kind: 'deep-link-queued' }
  | { kind: 'deep-link-resumed' }

/** toast 自动消失的时间（一次性提示，不该常驻）。 */
export const APP_TOAST_TTL_MS = 8000

let current: AppToast | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

/**
 * 通知所有订阅者（`useSyncExternalStore` 的快照读 `currentAppToast`）。
 */
function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * 显示一条 toast（重复调用会重置自动消失计时）。
 * @param toast - 要显示的内容。
 */
export function showAppToast(toast: AppToast): void {
  current = toast
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => { clearAppToast() }, APP_TOAST_TTL_MS)
  // Node 环境下 `setTimeout` 返回的对象带 `unref`：不要让一个 UI 提示拖住进程退出。
  ;(timer as unknown as { unref?: () => void }).unref?.()
  notify()
}

/**
 * 关掉当前 toast（关闭按钮 / 自动消失 / 切面板）。
 */
export function clearAppToast(): void {
  if (timer !== null) { clearTimeout(timer); timer = null }
  if (current === null) return
  current = null
  notify()
}

/**
 * 当前 toast（`useSyncExternalStore` 的快照）。
 * @returns toast，或 `null`。
 */
export function currentAppToast(): AppToast | null {
  return current
}

/**
 * 订阅 toast 变化。
 * @param listener - 变化回调。
 * @returns 取消订阅。
 */
export function subscribeAppToast(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * toast 文案的字典键（逐条：文案是产品契约，不能散在 JSX 里）。
 *
 * `deep-link-queued` 刻意复用**面板路径**那一句（`appCenter.openPendingLogin`）：
 * 深链与面板点开是同一件事（"这次打开被记住了"），两处文案分叉会让用户以为是
 * 两种不同的能力（U-07 的验收口径 = 同口径）。
 */
const TOAST_TEXT_KEYS = {
  'foreign-deep-link': 'appCenter.toast.foreignDeepLink',
  'deep-link-queued': 'appCenter.openPendingLogin',
  'deep-link-resumed': 'appCenter.toast.deepLinkResumed',
} as const

/**
 * 异渠道深链的提示文案（§5.3/§19 Q5 **逐字**冻结的那一句）。
 * @returns 当前语言下的文案。
 */
export function foreignDeepLinkToastText(): string {
  return t(TOAST_TEXT_KEYS['foreign-deep-link'])
}

/**
 * "已记住这次打开"的提示文案（U-07；**与面板路径同一句** —— 同一个字典键）。
 * @returns 当前语言下的文案。
 */
export function queuedDeepLinkToastText(): string {
  return t(TOAST_TEXT_KEYS['deep-link-queued'])
}

/**
 * 登录后自动续开深链的提示文案（U-07：自动续跑也要可感知）。
 * @returns 当前语言下的文案。
 */
export function resumedDeepLinkToastText(): string {
  return t(TOAST_TEXT_KEYS['deep-link-resumed'])
}

/**
 * toast 宿主组件（主窗口底部居中；由 `AppToastHostMount` 挂在侧边栏底部的
 * `sidebar.footer.action` 座位上 ⇒ 客户端 UI 存续期间一直有真实消费者）。
 *
 * 它只订阅 store：宿主事件 → 插件 → `showAppToast` → 这里渲染。
 */
export function AppToastHost() {
  const toast = useSyncExternalStore(subscribeAppToast, currentAppToast, currentAppToast)
  const dismiss = useCallback(() => { clearAppToast() }, [])
  // 卸载（例如侧边栏整块收起）时不留残影：toast 属于当前 UI，UI 没了它也不该在。
  useEffect(() => () => { clearAppToast() }, [])
  if (toast === null) return null
  return (
    <div style={TOAST} role="status" className="zeokeel-app-toast" data-role="app-toast" data-toast={toast.kind}>
      <span data-role="toast-text">{t(TOAST_TEXT_KEYS[toast.kind])}</span>
      <button
        type="button"
        className="zeokeel-app-toast-dismiss"
        data-action="toast-dismiss"
        style={DISMISS}
        aria-label={t('appCenter.toast.dismiss')}
        onClick={dismiss}
      >
        ✕
      </button>
    </div>
  )
}

/** 底部居中的浮层（不占布局：侧边栏槽位里渲染也不会挤压导航）。 */
const TOAST: React.CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 24,
  transform: 'translateX(-50%)',
  zIndex: 1200,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  maxWidth: 'min(560px, calc(100vw - 32px))',
  padding: '10px 14px',
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'var(--dsw-shadow-lv3)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: '20px',
}

/** 关闭按钮（真实 button：键盘可达）。 */
const DISMISS: React.CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  font: 'inherit',
  padding: '0 2px',
}
