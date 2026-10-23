# C1–C4 设计：对话框 / 弹窗回执 / 文件选择器 / 下载生命周期

- 日期：2026-10-23
- 状态：设计（待审计员预读出反证清单后开工）
- 目标项：[能力清单](2026-10-23-browser-ai-capability-limits.md) C1–C4
- 约束：不新增"绕过现有边界"的入口；所有新能力仍走 `agentRun`（全局锁 + 用户闸 + 预算）与既有脱敏漏斗

---

## 1. 问题陈述

当前 `packages/host/browser` 对「动作之后的异步事件」完全没有布防：

| 事件 | 现状 | 后果 |
| --- | --- | --- |
| 页面 `alert/confirm/prompt` | **零接线**（全仓无 `Page.javascriptDialogOpening`） | 页面一弹窗，渲染进程阻塞，工具调用到 30s 预算耗尽；模型无法应答 |
| `target=_blank` / `window.open` | `setWindowOpenHandler` 转成新标签（已有） | 模型只能事后 `list_tabs` 找；无回执，容易断链 |
| `<input type=file>` 被点击触发 | 只能直接 `browser_upload_file`（对静态 input） | 由点击触发的 chooser 无人接，页面"点了没反应" |
| 下载 | 只能 `browser_download(url)` 触发 + 列表查询 | 动作触发的下载没有"等完成/拿路径"的入口 |

目标：**先布防、再动作、拿回执**（arm → act → receipt），并且失败必须 fail-loud。

---

## 2. 架构：per-tab 事件总线

新增模块 `src/events.ts`（纯逻辑，可测）：

```ts
export type BrowserEvent =
  | { kind: 'dialog'; dialog: { type: 'alert'|'confirm'|'prompt'|'beforeunload'; message: string; defaultPrompt?: string; url: string } }
  | { kind: 'popup'; popup: { tab: number; url: string; title: string } }
  | { kind: 'download'; download: { id: number; filename: string; path?: string; status: string } }
  | { kind: 'file-chooser'; chooser: { backendNodeId: number; mode: 'selectSingle'|'selectMultiple' } }

export class TabEventBus {
  /** Arm a one-shot waiter BEFORE the action; resolves with the next event of that kind. */
  arm(kind: BrowserEvent['kind'], timeoutMs: number): { promise: Promise<BrowserEvent>; cancel(): void }
  /** Buffer (bounded, e.g. 50) events that no waiter consumed. */
  push(event: BrowserEvent): void
  /** Un-consumed events for the end-of-call receipt. */
  drain(kind?: BrowserEvent['kind']): BrowserEvent[]
}
```

- 每个 tab 一个 `TabEventBus`，随 tab 销毁释放（**多标签隔离**：A 的 waiter 绝不吃 B 的事件）。
- 事件来源：CDP 事件监听（需要 `Page.enable`）与 Electron 回调（window-open / 下载记录器）。
- 缓冲上限 50；超出丢最旧并记一条 op（不静默）。

---

## 3. C1 对话框

### 3.1 接线

- 每个 tab 在 CDP attach 后发 `Page.enable`（若尚未 enable），订阅：
  - `Page.javascriptDialogOpening { type, message, url, defaultPrompt }` → `bus.push({kind:'dialog'…})` + 记 `pendingDialog`（含 tab id 与 dialog 快照）。
  - `Page.javascriptDialogClosed { result, userInput }` → 清 `pendingDialog`，记 op。
- **dialog 打开期间**：该 tab 的所有页面操作**快速失败**（`browserError('policy', …)`，文案点名 dialog 类型与消息，告诉模型调用 `browser_dialog`）。实现点：在 `navigate/reload/back/forward/snapshot/text/screenshot/eval/locateElement/clickAt/typeInto/pressKey/selectOptionChoice/scroll/fillForm/uploadFile/downloadUrl/waitFor` 的入口统一调用 `assertNoDialog(tabId)`；`browser_dialog` 自身豁免。
- 页面跳转/关标签时若仍有 pendingDialog：尽力 `Page.handleJavaScriptDialog{dismiss}` 并清状态（防止僵尸弹窗让后续调用全超时），失败只记 op。

### 3.2 新工具

`browser_dialog`：
- 参数：`action: 'accept' | 'dismiss'`（必填）、`promptText?: string`（仅 prompt）、`tab?`
- 行为：无 pendingDialog → `not-found`（文案说明"当前没有待处理对话框"）；有 → `Page.handleJavaScriptDialog {accept, promptText}`；成功返回 `{ ok: true, dialog: {type, message, url} }`。
- `promptText` 只对 `prompt` 有效；对其他类型传入 → `policy` 拒绝（fail-loud，不静默忽略）。
- 模型面规则：`beforeunload` 的 accept = 允许离开（相当于点击"离开"），在描述里写清风险。

### 3.2.1 单一 choke point（2026-10-23 M1 审计后）

「每个工具入口各加一次 assert」是漂移源：审计实测导航家族 5 个方法（`navigate/reload/goBack/goForward/downloadUrl`）漏了闸。M1 改成两层：

1. **CDP 层**：`CdpSession` 新增 `beforeCommand` 钩子，创建的每个 tab session 都装上——有 pending dialog 时**任何**页面命令立即 `policy` 失败（豁免 `Page.handleJavaScriptDialog` / `Page.enable` / `Runtime.enable`）。
2. **Electron 层**：导航家族走的是 `webContents.loadURL`/`downloadURL`（不经 CDP），所以在 `navigateInternal` 与 4 个导航方法里各加一次 `assertNoDialog`；`screenshot` 走 `capturePage()`（同为 Electron 路径）也保留一次；`waitFor` 的轮询会把 CDP 失败吞成 "page not ready"，因此也显式守卫一次。其余页面命令只靠 CDP hook。
3. **在途命令中止**：dialog 事件到达时 `tab.cdp.abortPending()` —— 触发 dialog 的那条命令立刻被中止，回答入口不再排在它后面等 CDP 预算（M1 复审实测 140ms，生产约 10s）。
4. **豁免名单**只有 3 个：`Page.handleJavaScriptDialog`（回答入口）、`Page.enable` / `Runtime.enable`（域管理）。**M3 不得**把 `DOM.setFileInputFiles` 加进豁免（file chooser ≠ JS dialog）。

已知限制（P3，M2 前用真机探针确认）：`Page.enable` 只发主 session，**OOPIF/跨域 iframe 的 dialog 可能不被拦截**（CDP Page 域是 per-target）。若探针确认，M2 给 child session 补 enable 并加用例。

### 3.3 自动兜底

- 工具预算耗尽/调用 abort 时，**不自动应答**（用户可能正想看内容）；只清 CDP 事件里的 pending 状态并留 op（诚实边界：dialog 仍开着，下一次调用会再看到它）。
- 浏览器窗口关闭/会话切换：`Page.handleJavaScriptDialog{dismiss}` 兜底。

---

## 4. C2 弹窗回执

- 现有 `setWindowOpenHandler` 已经在产生新标签；改为在 `bus.push({kind:'popup', tab, url, title})` **之后**再开标签（回执里带新 tab id）。
- 新工具 `browser_wait_for` 增加条件：`popup`、`download`、`file-chooser`（等待时间受既有 40s/55s 预算约束）。
- 交互工具（`click/type/press/scroll`）增加可选 `expect`：
  - `expect: 'popup' | 'download' | 'dialog' | 'file-chooser'`
  - 语义：动作**之前** arm waiter（timeout 默认 5s，可传 `expectTimeoutMs`），动作后：
    - 等到 → 回执里带 `receipt: {popups?:[…], download?:{…}, dialog?:{…}, fileChooser?:{…}}`
    - 超时 → **动作本身仍算成功**（点击已经发生），但回执里带 `receipt: { timedOut: true, expected: 'popup' }`；这是可执行信息而不是失败（避免"点了但没弹"被误报成点击失败）。
  - `expect` 不消费时必须可恢复：arm 的 waiter 在超时/取消时被移除，事件仍进缓冲，后续 `wait_for` 能取到。

---

## 5. C3 文件选择器

- 每个 tab：`Page.setInterceptFileChooserDialog {enabled: true}`，订阅 `Page.fileChooserOpened {backendNodeId, mode}` → `bus.push` + `pendingFileChooser`。
- 新工具 `browser_file_chooser`：
  - 参数：`paths?: string[]`（绝对路径，白名单同 upload）、`cancel?: true`、`tab?`
  - 行为：无 pending chooser → `not-found`；`paths` → `DOM.setFileInputFiles {files, backendNodeId}` 并返回 `{ok, files}`；`cancel: true` → 发送 `Page.handleFileChooserDialog`? Chromium 无该命令，取消方案：`Page.setInterceptFileChooserDialog{enabled:false}` 后由 Electron 默认行为执行或直接忽略（记录为已取消）。具体：先 disabled 再 re-enable，避免 chooser 卡住。
- 点击触发的上传：`click({expect:'file-chooser'})` 回执带 `fileChooser: {backendNodeId, mode}`，模型随后调 `browser_file_chooser({paths})`。
- 与现有 `browser_upload_file` 的关系：后者保留（静态 input 直接设文件，不解雇）。

---

## 6. C4 下载生命周期

- 现有全局下载拦截器（`guard.ts`）已记录 id/文件名/状态/真实路径；新增：
  - `TabEventBus` 在 `guard` 记录 `done/rejected/cancelled` 时 `push({kind:'download', …})`（带 tab 关联：由触发动作的 tab 传入；无关联时 tab 为 0）。
  - `browser_download` 增加 `waitForCompletion?: boolean`（默认 true）：等待记录进入终态（done/rejected/cancelled）或超时（默认 60s），返回 `{id, filename, path?, status}`；超时返回 `status:'in-progress'` 并明确告知"仍在下载"。
  - `click({expect:'download'})` 回执：`download: {id, filename, status}`（首个相关下载；多下载只报第一个 + 总数）。
  - `browser_downloads_list` 增加 `wait?: boolean`（等第一个在途下载到终态，最多 60s）。
- 2GiB 上限、`rejected` 不被 `done` 覆盖等既有语义不变。

---

## 7. 错误码与文案

| 场景 | 码 | 文案要点 |
| --- | --- | --- |
| 有 dialog 时做页面操作 | `policy` | 点名 dialog 类型/消息，要求先 `browser_dialog` |
| 无 dialog 时 `browser_dialog` | `not-found` | "当前没有待处理对话框" |
| `promptText` 给非 prompt | `policy` | 明确只对 prompt 生效 |
| 无 chooser 时 `browser_file_chooser` | `not-found` | 提示先用 `click({expect:'file-chooser'})` |
| chooser 路径越界 | `policy` | 同 upload 白名单 |
| `expect` 超时 | 不报错 | `receipt.timedOut=true`（动作已发生） |
| 下载终态 rejected/cancelled | 工具仍 ok | `status` 如实返回 |
| 事件缓冲溢出 | 不报错 | op log 记一条 `events dropped` |

---

## 8. 预算与并发

- 所有新工具沿用 `BROWSER_TOOL_TIMEOUT_MS=30s`；`browser_dialog` 10s（只是应答）。
- `wait_for` 新条件沿用 40s/55s 预算。
- `browser_download(waitForCompletion)` 注册预算 90s（等待 60s + 余量），遵守"内部等待 < 注册预算"不变量。
- 所有入口仍是 `isConcurrencySafe: false`（走全局锁与用户闸）。

---

## 9. 测试计划

| 层 | 用例 |
| --- | --- |
| 单元（mock CDP） | dialog 事件 → pending 状态 → `browser_dialog` accept/dismiss；dialog 打开时其它工具快速失败；`promptText` 非法类型拒绝；事件总线 arm/超时/缓冲/隔离 |
| 单元（mock Electron） | window-open → 回执 + 新 tab；下载记录器 → 事件与回执；file chooser intercept → `browser_file_chooser` 设置文件/取消 |
| 预算 | `expect` 超时不报错且 `receipt.timedOut`；`browser_download(waitForCompletion)` 在 60s 内返回终态 |
| 多标签隔离 | tab A 的 dialog/popup 不影响 tab B；关 tab 后 waiter 释放 |
| 回归 | 现有 1122 用例全绿；脱敏（dialog message 含凭据时仍打码） |

---

## 10. 反证清单（交给审计员预读）

1. **布防时序**：`expect` 是否真的在动作**之前** arm（把 arm 移到动作之后，用例必须红）。
2. **取消语义**：`expect` 超时后事件仍可被后续 `wait_for` 拿到；waiter 被取消后不残留（连续两次 `expect` 不会互相吃掉）。
3. **多标签隔离**：A 的 dialog/popup/file-chooser 不会被 B 的 waiter 消费；关 A 后 B 正常。
4. **fail-loud**：dialog 打开期间做 `browser_click` 必须失败而不是卡 30s；无 dialog 时 `browser_dialog` 必须 `not-found`；`promptText` 给 alert 必须拒绝。
5. **脱敏一致性**：dialog 的 `message`/`url`、popup URL、下载文件名走同一 `redactFilledSecretsText` 漏斗（凭据窗口内更严）。
6. **预算序关系**：任何内部等待（expect ≤5s、下载 ≤60s）之和 < 注册预算，不出现上游 timeout 覆盖工具诊断。
7. **还原性**：tab 关闭/会话切换后 dialog 兜底 dismiss、file chooser 拦截关闭、下载 waiter 释放，无悬挂 timer/promise。
8. **空转变异**：删掉 `assertNoDialog`、删掉 `expect` 的 arm、删掉 per-tab 隔离、删掉下载终态等待，对应用例必须红。

---

## 10.5 已定口径（2026-10-23，审计预读后）

| # | 口径 | 决定 |
| --- | --- | --- |
| 1 | 事件消费 | **consume-once**：waiter 命中即移除；未命中事件进有界缓冲；`drain` 只在工具返回时取；waiter 取消（超时/动作失败）必须移除自己，不得吃掉下一次事件 |
| 2 | 下载归属 | session 级 `will-download` 只能 **best-effort**：回执带 `attribution: 'best-effort'`；waiter 只消费"触发窗口内、且归属不是其它 tab 在途动作"的事件；补「B 的下载不被 A 吃掉」用例 |
| 3 | popup 回执 tab id | 先 `await open()` 再回执，带真实 tab id（不允许 -1） |
| 4 | file chooser 取消 | 取消 = `DOM.setFileInputFiles {files: []}` 标记为空选择（不 replay intercept），随后 `Page.setInterceptFileChooserDialog{enabled:true}` 保持布防；必须测「不二次弹、不卡住」 |
| 5 | `Page.enable` | 每 tab **只发一次**（tab 装配处单一发送点）；失败必须可见（op log 一条 `browser_page_state`），否则"以为有 fail-fast 其实没有" |
| 6 | 回答入口豁免 | **回答事件的入口永不被该事件的 fail-fast 挡住**（`browser_dialog`/`wait_for` 新条件/`browser_file_chooser` 都适用）—— M1 已按此修掉一个 P0 |
| 7 | dialog 预算耗尽 | **绝不清 pendingDialog**；关 tab / 切会话 / 用户接管三个出口才 dismiss（先 dismiss 后清状态） |
| 8 | 测试基建 | fake timers + deferred CDP（事件在命令 await 期间到达），避免 5s/60s 等待把套件拖成分钟级 |

## 12. 待真机探针（本机无 Electron 显示环境，未跑）

1. **file chooser 取消**：空 `DOM.setFileInputFiles{files:[]}` 后 500ms 内无第二个 `fileChooserOpened`、`input.files.length===0`、`Runtime.evaluate` 可继续；若否，退回 disable→re-enable。
2. **iframe file input**：跨域 iframe 内 `<input type=file>` 是否需要在 child session 上再 `Page.setInterceptFileChooserDialog{enabled:true}` 才发 `Page.fileChooserOpened`；断言事件落 bus 且 backendNodeId 可设置。
3. **OOPIF dialog（C1 残留）**：同族限制，探针方式同上。

## 11. 里程碑

| 里程碑 | 内容 | 验收 |
| --- | --- | --- |
| M1 对话框 | 事件接线 + `browser_dialog` + `assertNoDialog` + 三个 dismiss 出口 | ✅ 已实现（`63 files / 1126 tests` 绿；含「browser_dialog 自己不被挡」回归） |
| M2 回执 | `TabEventBus`（17 例语义单测，含严格 arm）+ popup/dialog/download 事件接线 + `expect` 回执（click/type/select/press/scroll）+ `wait_for` 三种新条件 | ✅ 已实现（65 files / 1168 tests，check EXIT=0；strict arm 防回执错位；`clampExpectTimeoutMs` 纯 helper 单测；下载归属走真实 recorder 路径；事件类 wait_for 不受 dialog 守卫且有正反用例） |
| M3 文件选择器 | `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened` + `browser_file_chooser`（files/空选择取消）+ 用户接管 disable/re-enable | ✅ 已实现（33 工具；dialog pending 时 CDP 写入被拦、chooser 存活；路径白名单复用 `assertAllowedUploadPath`） |
| M4 下载 | `waitForDownload`/`waitForNewDownload` + `browser_download{waitForCompletion}` + `downloads_list{wait}`（60s 等待，注册预算 90s） | ✅ 已实现（终态/超时/真实 recorder 路径） |
