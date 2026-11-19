/**
 * 桌面壳对 macOS「新增工作区」目录选择器的接管。
 *
 * 为什么需要它（2026-11-19 用户报「新增工作区时选中文件夹非常困难，点了很多次
 * 也不一定能选上」）：
 *
 * 上游 `@deepseek-ai/dsh-host-directory-picker-native` 在 macOS 用
 * `osascript -l JavaScript` 起一个独立的 `NSOpenPanel`，并且在
 * `panel.runModal()` **之前** 调 `app.activateIgnoringOtherApps(true)`。此时模态
 * 事件循环还没有开始，这次激活请求会丢失，于是面板以一个「非活动应用」的窗口
 * 出现：鼠标点击先被系统拿去激活那个没有 Dock 图标的 osascript 进程，点文件夹
 * 没有反应，常常得多点几下、或切出去再切回来面板才真正响应。
 *
 * 上游在 0.2.2-alpha.2 修掉了它（把激活包进 `NSOperationQueue.mainQueue`
 * 的 block，等 `runModal` 开始后再执行）；本仓 pin 的 0.2.1-rc.2 没有这个修复。
 *
 * 桌面壳有更合适的选择：Electron 的 `dialog.showOpenDialog(窗口, …)` 在 macOS
 * 上是附着在主窗口上的 sheet，由应用自己管理激活与焦点，不存在上面这个竞态。
 * 这里只在 macOS 上把已经组合好的 native capability 的 `pick` 换掉：服务身份
 * 与 `kind` 都不变，消费方（`ctx.uiWorkspace.pickDirectory()` → 远端
 * `directoryPickerController`）无需感知。
 *
 * @module dsh-plugin-desktop/native-directory-picker
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DirectoryPickerNativeCapability } from '@deepseek-ai/dsh-host-directory-picker'

/** 打开一次系统目录选择器；取消时解析为 `null`。 */
export type DirectoryChooser = () => Promise<string | null>

/**
 * 用桌面壳的 Electron 对话框替换已组合的 macOS 原生选择器。
 *
 * 只在服务确实提供了 `native` 能力时接管；browse 后端（远程/无显示器环境）
 * 原样保留。接管通过改写能力对象上的 `pick` 完成 —— 该对象按上游约定在服务
 * 生命周期内稳定，消费方每次调用时读取，因此不需要重新注册服务。
 *
 * @param ctx - 宿主 Context（需要 `directoryPicker` 服务，可能晚于本插件挂载）。
 * @param choose - 桌面壳的对话框实现（Electron `showOpenDialog`）。
 */
export function adoptElectronDirectoryChooser(ctx: Context, choose: DirectoryChooser): void {
  ctx.inject(['directoryPicker'], scope => {
    const capability = scope.directoryPicker.capability()
    if (capability.kind !== 'native') return
    const native: DirectoryPickerNativeCapability = capability
    const original = native.pick
    const adopted: DirectoryPickerNativeCapability['pick'] = async signal => {
      // 与上游原生实现同语义：调用方已经放弃时不再弹窗。
      if (signal.aborted) throw new Error('native directory picker aborted')
      return await choose()
    }
    native.pick = adopted
    scope.effect(() => () => {
      // 只有仍是我们装上的那个函数才还原：能力对象被别处再次接管时不要覆盖回去。
      if (native.pick === adopted) native.pick = original
    }, 'dsh-plugin-desktop: restore the upstream macOS native chooser')
  })
}