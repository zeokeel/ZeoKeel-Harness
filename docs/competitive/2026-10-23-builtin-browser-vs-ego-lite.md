# 内置 AI 浏览器 vs ego-lite：详细对比与可借鉴清单

- 日期：2026-10-23
- 对象 A：本仓内置浏览器 `packages/host/browser`（`@zeokeel/dsh-browser`，31 个 `browser_*` 模型工具，Electron `WebContentsView` + 进程序列 `webContents.debugger` 的 CDP）
- 对象 B：[`citrolabs/ego-lite`](https://github.com/citrolabs/ego-lite)（MIT；闭源 ego lite 浏览器 app + 开源 Node.js 连接层 + 薄 Skill，模型侧只有 **1 个命令** `ego-browser nodejs`）
- 证据口径：对象 A 的行号来自本仓 `master`（取证时 HEAD `38fa040`）；对象 B 的行号来自其公开仓浅克隆的 `d392204`，路径按**对方仓库相对路径**书写（本地副本在 `temp/ego-lite`，不入库）。凡「宣称 / 待上线」均单独标注，不与「已实现」混算。
- 调研边界：对象 B 只做**只读**盘点（未安装、未跑其测试、未验证其真机行为）；其 README 的基准数字不具备可复现条件（见 §7.3），本文不引用为证据。

---

## 0. 结论摘要

### 0.1 三句话

1. **两者不是同一类东西**：我们是「共享一个浏览器窗口、用 31 个离散工具逐步驱动的嵌入式浏览器」；ego-lite 是「把浏览器变成脚本 API、让模型写一段 JS 一次跑完」的通用外部浏览器。**最大的差距在执行模型，而不是工具数量**。
2. **ego-lite 的真正创新只有一条**：code-first 执行面（1 个命令 + 约 55 个注入 helper + 一个脚本内完成「动作→等最终态→取一次快照」）。其余（快照压缩、ref 身份、actionability、对话框、下载布防、hard stop 文案、站点经验包）都是为这条执行模型配套的正确性工程，**可以逐条独立借鉴**。
3. **我们的安全面领先，且不能为对标而放弃**：凭据按 origin 记账 + 凭据窗口内整体拒绝 eval/截图 + 三层掩码词表、来源分级、拒绝一切权限、多租户分区、op log 审计——ego-lite 一条都没有（它的产品前提是「用用户自己的登录态，所以不需要凭据注入」）。所以借鉴方向是**在保住这些边界的前提下补齐能力**，而不是换成它的形态。

### 0.2 差距分级（先分级，避免把「产品选择」当「缺陷」）

| 级别 | 差距 | 性质 | 处置建议 |
| --- | --- | --- | --- |
| **结构性** | 模型接口形态：我们 31 个工具逐步调用 vs 它 1 个命令写脚本 | 架构/执行模型 | **P0**：平台已有 `run_code`（PTC）承载点，见 §4.1；是决策 + 投影问题，不是造运行时 |
| **结构性** | 隔离单元：我们单池 16 标签 + 全局串行锁 vs 它每 Agent 一个 Space（用户的前台浏览完全不受影响） | 产品形态（我方 2026-09-07 有意定案） | **P2 战略选项**：与「蒙版常驻 + 整窗接管」是一体两面，改动牵涉产品定位，不建议当技术债处理 |
| **能力级（真缺口）** | 页面自弹 `alert/confirm/prompt` 无任何工具出路；`popup`/`file chooser`/`download` 无法「先布防再动作」；无全页截图；无 hover/双击/拖放；无键盘和弦与粘贴；无 `page.fetch`；`browser_eval` 只接受单表达式（批量抽取写不了循环） | 真实缺失 | **P0/P1**：逐条补，见 §4.4、§4.6、§4.7 |
| **能力级（真缺口）** | 快照不穿透 iframe/OOPIF/shadow DOM，只报数量 | 真实缺失 | **P1**：见 §4.6，这是「网页看不懂」的最大单一来源 |
| **实现级（我们更弱）** | ref 只在「当前快照世代 + 同一文档」内有效；跨轮/跨进程不稳定；无节点身份 | 实现差距 | **P0**：见 §4.3 |
| **实现级（我们更弱）** | 点击是「事后回传命中身份」，不是「动作前检测拦截者」；错误文案不含拦截者 | 实现差距 | **P1**：见 §4.7 |
| **契约级** | 错误分类没有 `transient/permanent`；「用户接管」是工具错误而非会话级硬停止；没有输出缓冲/硬停止丢弃 | 契约差距 | **P0**（低成本）：见 §4.5 |
| **我们领先** | 凭据掩码与凭据窗口、来源分级、权限一律拒绝、多租户分区、op log + SSE 审计、工具组策略骨架 | 对方没有 | **守住**，见 §5.2 |
| **双方都缺** | 站点经验包的**失效检测**；真机浏览器动作 e2e 进 CI（它的 69 个真机 case 只在 pre-commit） | 空白 | 我们若要抄经验包，必须补这一环 |

---

## 1. 定位差异（先对齐「它们各自是什么」）

| 维度 | 我们（`@zeokeel/dsh-browser`） | ego-lite | 含义 |
| --- | --- | --- | --- |
| 谁是浏览器 | **我们自己就是浏览器**：一个独立 `BrowserWindow` + 工具栏壳页 + N 个 `WebContentsView` + 常驻透明 overlay（蒙版/胶囊/面板） | 开源仓**不是浏览器**：浏览器是闭源 ego lite app；公开仓是连接层 SDK + Skill | 我们是产品内建面，它是「外部浏览器 + 连接层」 |
| 模型怎么调用 | 31 个 `browser_*` 工具，一步一次调用，结果逐步回灌上下文 | **1 个命令** `ego-browser nodejs`，模型写一段 JS（heredoc/`-e`/`.mjs`），一次执行 N 步，只有脚本输出回灌上下文 | 执行模型分水岭 |
| 人和 AI 的关系 | **互斥交接 + 整窗接管**：默认蒙版常驻、AI 操作期间窗口上锁，用户点「我来操作」才解锁；AI 交权后**只能等用户点「交给 AI」**（`browser_release` 已从模型面移除，32→31） | **并行共存**：每个 Agent 一个 Space 在后台跑，用户在自己的 Space 里浏览，互不抢标签；控制权按 Space 交接（`handOff`/`takeOverTaskSpace`） | 产品定位差异，不是优劣 |
| 隔离单元 | **无会话隔离**：一个扁平标签池（上限 16）+ 一把全局串行锁；任何会话可操作任何标签（提示词第 7 条明写 "Tabs are GLOBAL"） | **Space**：每 Agent 一个隔离浏览上下文（独立 profile 可指定），有标签预算、`agent`/`user` 归属、`finish({keep})` 收尾语义 | 见 §2.4 |
| 内核控制点 | 吃 Electron 44 的 `WebContentsView` + CDP 1.3（进程序列），**不可改内核** | 改内核：原生注入 `globalThis.ego` 绑定（16 方法）+ 原生 snapshot/ref；对内核有**需求文档 + 验收条件** | 它能做的事我们只能「用 CDP 逼近」 |
| 分发形态 | 单产品内建（无需外部 app） | 9 个宿主适配（含 DSH），「一个 Skill + 一个 CLI」 | 它的集成矩阵可借鉴写法，不是我们的目标 |
| 失败代价 | 模型看不到页面 → 点错元素/假成功 → 用户信任受损；凭据流出不可逆 | 同理，但它把「可执行状态」写进错误文案（hard stop），模型更少乱撞 | — |

---

## 2. 架构对比

### 2.1 进程 / 通信边界

| 维度 | 我们 | ego-lite |
| --- | --- | --- |
| Agent → 浏览器 | 进程内 Cordis 插件（`src/index.ts:85` 注入 `webServer/tools/systemPrompt/attachments`），工具 handler 直接调 `BrowserRuntime` | Agent → **子进程**：`ego-browser nodejs` 读 stdin 脚本（`package/ego-browser/src/run.ts:75-114`） |
| 浏览器控制通道 | `webContents.debugger.attach('1.3')`，`CdpSession.send`（可带 `sessionId` 驱动 OOPIF）——**不开 remote-debugging 端口** | native bridge：`ego.sendCDPMessage` 中继 CDP，`ego.onCDPMessage` 回事件——**运行时无本地端口**（唯一 `listen` 在 e2e fixture） |
| UI 与本体的通道 | 复用宿主 loopback HTTP（`http://127.0.0.1:<webServer.port>`），壳页/overlay 是 HTTP 页面，写面靠 `dsh-auth-*` HttpOnly cookie 的**持有性证明**（`src/index.ts:750-789`） | 原生 UI，无 HTTP 面 |
| 进程边界 | 主进程持 runtime/CDP/store；每个视图独立 renderer，统一 `contextIsolation/sandbox`，标签与 overlay `backgroundThrottling:false` | app 主进程 + 每轮新 Node 进程（状态靠磁盘 ledger 跨越） |
| 并行模型 | **全局串行锁**：同一时刻只有一个 AI 操作在跑，其余排队（`src/pool.ts:128-194`） | **Space 级**：`NativeOperationGate` 用 `AsyncLocalStorage` 持租约 + FIFO 队列；跨 Space 重入直接 reject（`src/native-gate.ts:26-107`） |
| 状态持久化 | ledger JSONL（扁平标签账本）、书签/历史/下载落盘；**快照锚点在内存**（`snapshotAnchors`），重启即失效 | Page ledger（每 Space 一份 JSON，含 **refs 失效态**）、每轮进程退出后靠它恢复同一 targetId |

### 2.2 各自的「内核控制点」差异（决定能力上限）

| 能力 | 我们（CDP 逼近） | ego-lite（原生注入） |
| --- | --- | --- |
| 快照 | 页内 `Runtime.evaluate` 跑固定探针，只收**可交互元素**（`src/snapshot.ts:1-9,75-253`） | 原生 `ego.snapshot()` 返回**带 role 的文本树 + refs 元数据**，JS 侧只做压缩（`src/snapshot-result.ts`） |
| ref | 我们自己发号：快照世代号 + 1 基文档序 index | 原生给 `backendNodeId/frameId`，SDK 再发 `@N` 并绑定三元身份（`src/page-ref-registry.ts`） |
| iframe/OOPIF | 快照**不含**帧内容，只报数量并给 `browser_eval(frame:N)` 出路 | 快照**含**普通 iframe 文本与 OOPIF 文本；原生对帧内可动作节点「有时不给 ref」，SDK 在 JS 侧回填 `frameId`（`docs/native-snapshot-ref-requirement.md:39-72`，对方自己承认的缺口） |
| 对话框 | **零接线**（`grep` 无 `javascriptDialog`）：页面自弹 `alert/confirm/prompt` 没有工具出路 | 原生桥转发 `Page.javascriptDialogOpening/Closed` 并在 dialog 打开期间**快速失败**其他命令（`src/browser-runtime.ts:31-36,519-530`） |
| 截图 | `capturePage()` 视口 JPEG，无全页 | 原生/CDP `captureScreenshot`，支持 `fullPage`/`clip`/CSS 像素换算（`driver/observe.ts:108-174`） |

> 结论：**同样的能力，对方是「改内核 + 写需求文档」，我们是「在 CDP 上层补偿」**。它的 `docs/native-*-requirement.md` 这套「把能力诉求写成带验收条件的原生契约」的做法本身值得抄（见 §4.6）。

### 2.3 「单池 + 全局锁」vs 「Space + 原生门」的取舍

| 维度 | 我们（单池） | ego-lite（Space） |
| --- | --- | --- |
| 多 Agent 并发 | 串行（一个 AI 操作在跑，其余排队） | 并行（不同 Space 各自跑） |
| 用户能否同时浏览 | 不能（蒙版常驻；点「我来操作」= 暂停所有 AI） | 能（用户自己的 Space 不受影响） |
| 谁能看谁的标签 | 都能（共享池，产品意图 "AI 可以控制所有页面"） | 只能看本 Space 的受管 Page + 显式 `adopt` 的非受管 tab |
| 收尾语义 | 显式 `browser_close_tab`；无「本轮结束自动清场」 | `task.finish({keep})` **必填**；`keep:[]` 默认全关，用户/非受管 tab 受保护 |
| 隔离实现 | 分区级（按账号 + 服务端哈希 `persist:`），**不是会话级** | 原生 Space（独立浏览上下文）+ 每 Space ledger |

> 这是**产品形态**差异（我方 `docs/planning/2026-09-07-browser-bug-audit.md:88` 记录了 v4.2 单池定案、分组架构 774 行被删）。若要吸收 Space 模型，成本是「重写隔离层 + 改产品交互」，不是补工具；见 §5.3。

---

## 3. 工具集对比

### 3.1 口径先对齐：31 工具 ≠ 74 API

| 计数口径 | 我们 | ego-lite |
| --- | --- | --- |
| 模型可**直接调用**的入口 | **31** 个 `browser_*`（7 组：navigate 8 / interact 7 / read 4 / write 1 / memory 4 / artifacts 3 / control 4；`src/tools.ts:1605-1622`，测试 `TOOL_COUNT=31` 双重钉住） | **1** 个命令 `ego-browser nodejs`（+ `skill` 打印手册） |
| 脚本/调用面里的可编程 API | 无（每个工具一个 schema） | **74** 条 v2 schema（顶层 5 / TaskSpace 14 / Page 45 / Download 8 / FileChooser 2，`src/public-api-schema.ts:60-749`）+ 约 55 个注入 helper |
| 系统提示词 | 1 个 section（`tool:browser`，order 111），散文点名 9 个工具；其余 22 个只靠各自 description | 551 行版本化手册（`package/ego-browser/skill-body/SKILL.md`），由命令打印，带首尾版本标记与 25 000 字符上限 |
| 错误码 | 14 个（10 个有构造点，4 类死码） | 20 个（native 16 + 自行扩展 4），其中只对 2 个码「拥有文案」 |
| 超时/预算 | 全工具 30s（`wait_for` 55s），预算单点真源 `src/budgets.ts` | 逐层下传 deadline（每次 CDP 调用按剩余预算收紧），无统一工具预算概念（一轮脚本就是一个进程） |

> **不要用「31 vs 74」下结论**：对方 74 条是**同一执行面内的 API**，我们 31 个是**不同回合的入口**。可比的是「完成同一件事需要几次模型往返」——这正是 §4.1 的题眼。

### 3.2 能力域映射矩阵

图例：✅ 有；△ 有但更弱/形态不同；❌ 无。

| # | 能力域 | 我们 | ego-lite | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 打开/导航/刷新/前进后退 | `browser_open/navigate/reload/go_back/go_forward`（`waitUntil` 3 档） | `Page.goto/reload`（`commit/domcontentloaded/load/networkidle` 4 档） | △ 我们少 `commit`、无 `referer` |
| 2 | 标签/页面管理 | 8 个工具（含 `list_tabs` 报控制权、`switch_tab`、`close_tab`） | `TaskSpace.*` 14 条（`pages/tabs/newPage/adopt/release/page(label)` + 永久标签 `p1…`） | △ 它多了「受管/非受管归属」与「adopt/release」 |
| 3 | 快照 | 扁平**可交互元素列表** + 编号；200/2000 上限；`truncated/total/note` | **带 role 的文本树** + 每行 `[ref=N, loc=…]`；3 种 scope（viewport 默认 / full_page / subtree+root）；文本压缩规则；**自带状态头**（Space/受管数/预算） | ❌/△ 形态与语义都不同，见 §3.3 |
| 4 | 文本抽取 | `browser_get_text`（整页或单 CSS，32KiB，掩码后截断） | 快照本身含可见文本，通常不需要单独取；另可 `evaluate` | △ 我们是「先快照定位、再取文本」两步 |
| 5 | 截图 | 视口 JPEG；凭据窗口内整体拒绝 | `Page.screenshot({path, fullPage, clip, scale:"css", raw})` | △ 我们无全页/裁剪 |
| 6 | 元素定位 | 快照编号（锚定世代）或 **CSS 选择器**（会话内唯一性校验） | `@N` ref、`loc=css:` / `loc=role:` / `loc=href:`、`text=`（引号精确/非引号模糊）、`xpath=`、裸 CSS（穿透 open shadow）、Playwright 子集（`:has-text()`、`>> nth=`） | ❌ 我们选择器语义窄得多 |
| 7 | 点击类动作 | `browser_click`（单击；数字/CSS；返回 `hit` 身份） | `click/dblclick/hover/dragAndDrop`（可带 3–6 词 `label` 显示在 Agent 光标旁；`position`、`force`） | ❌ 缺双击/悬浮/拖放 |
| 8 | 输入类动作 | `type`（默认清空、读回校验）、`select`（仅 value）、`press`（固定键表）、`fill_form`（按 label 批量 + `missed[]`）、`scroll`（仅 deltaY/`elementsIntoView`） | `fill`（清空+逐字+验证生效，最多 5 次/50ms）、`selectOption`（value/label/index/多选/清空）、`focus`、`press`（Playwright 和弦）、`keyboard.*`（down/up/press/type/insertText/paste）、`mouse.*`（click/move/down/up/wheel） | △ 我们胜在批量与读回，弱在和弦/指针原语 |
| 9 | 滚动 | `deltaY` 或滚到元素 | `mouse.wheel` + **运动学**（120px 阈值、80px/步、≤12 步、8ms 间隔、smoothstep 缓动）+ `scrollToBottomUntil` | △ 对方的运动学解决「一次性大 delta 触发不了懒加载/惯性」 |
| 10 | 输入法/粘贴 | ❌ 无剪贴板能力（`grep clipboard` 零命中） | `keyboard.paste({text, html})`：写系统剪贴板 → 原生粘贴 → **恢复用户剪贴板**（进程内串行队列；恢复失败抛 `EGO_CLIPBOARD_RESTORE_FAILED` 并声明「粘贴已完成，不要重试」） | ❌ 真实缺失（富文本/表格粘贴、中文输入） |
| 11 | 等待 | `browser_wait_for` 6 种条件（element-present/visible、text-appear、url-change、network-idle、settled），40s 上限、55s 工具预算 | `waitForSelector`（4 种 state，默认 **visible**）、`waitForURL`（string glob/RegExp/函数）、`waitForFunction`（Playwright 参数序）、`waitForLoadState`（含 networkidle，逐 Page+OOPIF 请求跟踪）、`waitForEvent`（**先订阅再动作**）、`waitForTimeout` | △ 我们够用但缺「先布防」与「条件函数」 |
| 12 | 对话框 | ❌ 无 `acceptDialog/dismissDialog`，无 dialog 状态 | `Page.acceptDialog(promptText?)`/`dismissDialog()`；dialog 打开时其他命令**快速失败**并点名 dialog；上传触发的 dialog 作为 `result.dialog` 返回 | ❌ **P0 缺口**（页面一个 `confirm()` 就能把工具拖到预算耗尽） |
| 13 | 弹窗 popup | `window.open`/`target=_blank` 转成新标签（有配额/闸门/op log），模型只能事后 `list_tabs` 发现 | `waitForEvent("popup")` 先订阅；高层动作回执 `receipt.popups`；轮末汇总「发现但没用过」的页面 `[ego-browser:pages] Unhandled page …` | ❌ 缺回执与未处理清单 |
| 14 | 文件上传 | `browser_upload_file`（路径白名单 = 下载目录 + 会话 cwd；无对话框） | `setInputFiles` + `waitForFileChooser`（**先订阅**）+ `FileChooser.setFiles`；动作期间收到没人等的 chooser 会明确报错 | △ 我们只有「直接设文件」，缺「由点击触发的 chooser」 |
| 15 | 下载 | `browser_download`（按 URL 触发，自动命名，>100MB cancel）+ `downloads_list/remove` | `waitForEvent("download")` 布防 → `saveAs/path/failure/cancel/delete`；**逐 Page 布防并恢复**（不动共享上下文）；临时目录轮末清理 | △ 我们缺「动作触发的下载」与产物生命周期 API |
| 16 | 代码执行 | `browser_eval`：**单表达式**（acorn AST 判据），禁语句/赋值/`new`/`eval`/写类 API；允许 fetch/XHR；8KB 表达式/结果上限；凭据窗口内整体拒绝 | `Page.evaluate(fnOrString, arg)`：函数或字符串、可有语句/循环、一个 JSON 参数；无 timeout 选项（内部 14s 执行/15s 传输预算）；另有 `page.cdp`/`task.cdp` 原始逃生口 | ❌ 我们的模型写不了「批量抽取的循环」，要么多次工具、要么走 PTC |
| 17 | 页面内网络请求 | 只能靠 `browser_eval` 里的 `fetch`（表达式限制） | `page.fetch(url, {method, headers, body, timeout, saveAs})`：走该页的 cookie/CORS/SW；二进制可 `saveAs` | △ 形态可用但笨 |
| 18 | 自描述/帮助 | 只有工具 description + 一份诊断记录（`docs/FIX-TOOL-DIAGNOSIS-2026-09-12.md`） | `help()` 返回全部 74 条；`help("page.click")` 单条；**运行时用 acorn 解析自己的 bundle 提取 JSDoc**，新增 API 只改一处 | ❌ 低成本可补（见 §4.9） |
| 19 | 用户协作 | `browser_takeover`（交权）；用户绑定「我来操作」；AI 侧无解除路径；`list_tabs` 报 `controlled/busy/awaitingRelease`；客户端 foot-menu 三档提示 | `handOff()` / `takeOverTaskSpace()` / `claimTaskSpace()` / `waitForControl()`；ownership 是**会话级状态**；用户闸错误是 hard stop，文案固定「不要重试、不要自行夺权」 | △ 状态机与文案差距（见 §4.5、§4.8） |
| 20 | 会话/空间隔离 | ❌ 单池 16 + 全局串行锁 | ✅ 每 Agent Space，标签预算，`openedBy` 归属，`adopt/release` | 产品形态差异（§2.3） |
| 21 | 记忆/经验 | 书签 3 + 历史 1（`history_search`，`group` 字段恒空）、op log 200 环 | 无书签/历史（用用户浏览器自身）；有**站点经验包**（`learnings/<site>/{manifest,notes,tools,browser-tools}`，3 个站点 8 个工具） | 方向相反：我们记忆浏览数据，它记忆「怎么在这个站干活」 |
| 22 | 安全 | ✅ 三层掩码词表 + origin 级注入值集合 + 凭据窗口（eval/截图整体拒绝）+ 站点绑定 + 来源分级（本机地址一刀切）+ 权限一律拒绝 + 应用协议请求闸 | 基本没有：靠「用用户登录态」的产品前提；只有「破坏性 CDP 命令手册」+ 设备/权限提示交还用户 | **我们领先**，见 §5.2 |
| 23 | 预算/超时 | 7 常量（30s/55s/10s/5s/14s/40s/1s）+ 4 个运行期收紧入口，核心不变量「内部等待之和 < 注册预算」 | 逐层下传剩余 deadline；导航超时错误带 `committed/url/readyState` 与「下一步该换哪个 waitUntil」建议 | 我们更系统，它更「错误可执行」 |
| 24 | 错误契约 | `network/timeout/not-found/stale-snapshot/navigation-blocked/interrupted/quota/window-controlled/eval-policy/policy`（10 活） | 20 码；**transient/permanent 二元分类驱动重试**；只对 2 个码拥有文案（其余透传 native 原文）；hard stop 单点打标 | 它有我们缺的两件事：可重试性分类、硬停止文案 |
| 25 | 产物/输出管理 | 截图进 attachment store；下载落盘；op log 200 环不落盘 | 输出**全程缓冲**，硬停止时丢弃业务输出只留 owned 文案；`exit` 用 `writeSync`（管道友好）；轮末追加未处理页面清单 | ❌ 我们无缓冲/丢弃概念 |
| 26 | 审计/观测 | op log（用户可见活动面板）+ SSE + `GET /state` / `GET /ops`；用户与 AI 动作分 actor | 无审计面（每轮 stdout 就是全部） | **我们领先** |
| 27 | 测试/门禁 | 60 测试文件 / 21 180 行 / 805 用例调用点；vitest 单测为主，真机验证在 `e2e:client`（驱动 UI 面，不驱动浏览器动作）与人工探针 | 539 单测 + **69 个真机 e2e case**（37 模块 7 034 行，全打真内核、零 mock）但**不在 CI**（`lefthook.yml:45-48` pre-commit） | 我们有覆盖深度，它有能力级真机矩阵（见 §4.11） |

### 3.3 三处「同一件事、两套哲学」的对照

**(a) 快照与 ref**

| 维度 | 我们 | ego-lite |
| --- | --- | --- |
| 输出 | 扁平列表：`Page: 标题 · URL` + `N: [kind] text (off-screen)/(disabled)` | 缩进文本树：每行 `role "name" [ref=N, loc=…]`，顶部一行状态头 |
| 语义 | 只收「可交互元素」（a/button/input/select/textarea + 一批 ARIA role + `[tabindex]`），不含正文结构 | 全可见文本 + 语义节点（image/svg/canvas/iframe/table cell），再做压缩（删空文本、折叠单子容器） |
| 编号 | 1 基文档序 index，**只对这一世代的这次快照有效**（导航即 `stale-snapshot`） | `@N` 由 SDK 分配、**单调递增不复用**，身份 = `(frameId, backendNodeId, documentId)`；同身份跨快照保号；失效态落盘 |
| 选择器 | 根锚定唯一 CSS（DevTools Copy selector 等价），每次使用都验唯一性 | 快照行直接给 `loc=`，**只在唯一且身份一致时才序列化**（不唯一就省略，绝不给 `loc=unstable`） |
| 失效策略 | fail-loud（`stale-snapshot` / `not-found`），绝不重解析 | fail-loud（`Stale ref: @N; take a new snapshot`）+ 跨轮恢复 |
| 跨帧 | 不支持（note 明示盲区） | 支持文本；可动作节点有 ref 缺口（对方自己认账） |

> 判读：**我们的 fail-loud 是优点**（杜绝「点到自己没见过的元素」）；**它的跨轮稳定 ref 是缺点补偿**（因为脚本跨进程，ref 必须能跨轮）。两者并不互斥——`stale-snapshot` 语义可以保留，同时给「同一个 documentId 内的节点」一个稳定标识（§4.3）。

**(b) actionability 与命中**

| 维度 | 我们 | ego-lite |
| --- | --- | --- |
| 可动作性 | 快照标 `visible`（矩形非零且与视口相交）/ `disabled`（`el.disabled` 或 `aria-disabled`） | 4 档 `visible/enabled/pointer/pointer-enabled`；动作→档位映射（点击类要 pointer-enabled，输入类只要 enabled）；检查序列化到 `firstActionabilityBlocker` |
| 命中校验 | **事后**：返回 `hit{index,snapshot,kind,text,selector}`；DOM 派发路径用 `elementFromPoint` 失败即报错 | **事前**：composed-tree `elementsFromPoint` 找真正拦截者；每次 press 前复核（hover 出新浮层也能挡住）；文案 `dialog "Sign in" intercepts pointer events` |
| 兜底 | 隐藏窗口退化为 DOM 派发并记 op log | `installClickProbe` 看 `isTrusted` click，50ms 没看到就发合成事件并标 `fallback` |
| 填充安全 | `fill_form` 读回每字段值 | 额外 `assertSafeFillActivationTarget`：点击点落在别的可交互元素上先拒绝（防「填充变提交」） |

**(c) 用户接管**

| 维度 | 我们 | ego-lite |
| --- | --- | --- |
| 粒度 | **整窗**（所有组/所有会话一起暂停） | **按 Space**（别的 Space 照跑） |
| AI 能否自行解除 | **不能**（`browser_release` 已删） | 不能（`takeOverTaskSpace` 只在用户明确要求后调用；插件测试用 Proxy 禁止 `ctx.tools` 扩权） |
| 模型拿到什么 | 工具错误 `window-controlled` + `awaitingRelease` 标记 | 会话级 hard stop：固定文案 + 禁令 + 「重新接管」的 API 调用示例 + 给用户的措辞建议 |
| 客户端提示 | 三档（none/holding/waiting）+ foot-menu 琥珀点 + 5s 轮询 | 无（空间管理在浏览器 UI 里） |

---

## 4. 可借鉴的十个设计方案（按性价比排序）

> 每条给：**对方做法 → 对方的证据 → 我们落在哪 → 成本 → 风险/前置 → 验收判据**。
> 「成本」= 人日量级（S ≈ 1–2 天，M ≈ 3–5 天，L ≈ 1–2 周+）。

### 4.1 【P0，L】code-first 执行面：多步合成一次执行

**对方做法**：模型写一段 JS，SDK 用 `new AsyncFunction(...helperNames, code)` 把 helper 作为**函数形参**注入（不是 import、不是全局），支持顶层 `await`；一段脚本内完成「动作序列 → 等最终态 → 取一次快照」，只把最后一次输出回灌上下文。配套：语法错误用 acorn 二次解析还原行/列/源码行/插入符；把 `window/document/location` 定义成**抛 ReferenceError 的 getter**，错误文案直接教模型改用 `page.evaluate()`；输出全程缓冲，硬停止时丢弃（§4.5）。

**证据**：`package/ego-browser/src/run.ts:96-147`、`src/page-context-guard.ts:1-60`、`skill-body/SKILL.md:229-237`（"complete them in one script invocation, then observe the result once… Print the snapshot last"）。

**对 DSH 的判断（本文最重要的一条）**：**我们平台已经有这个能力，只是没开**。
- `deepseek-harness/packages/core/tools/src/ptc.ts:32` 定义 `RUN_CODE_NAME = 'run_code'`；`index.ts:26,948` 组装该工具；`index.ts:672,812` 定义 `ToolPresentationMode = 'native' | 'ptc'`，**默认 `native`**；PTC 模式下「只有 `run_code` 可直接调用，其余工具只能从程序内调」，且「只有外层 curated 结果进模型历史」（`ptc.ts:1-8`）。
- 执行能力由 `@deepseek-ai/dsh-ptc-runtime`（`ctx.ptcRuntime`，`PtcRunSpec`/`PtcBindingNamespace`/sandbox 模式/预算/abort）提供。
- 我们的浏览器包**已经声明了这个依赖**（`packages/host/browser/package.json:84`），但 `src/` 里零引用；桌面发行形态也没有任何 `ptcRuntime` / `mode: 'ptc'` 配置（全仓 grep 零命中）⇒ 用户拿到的仍是 31 个离散工具。

**我们的落点**：
1. **不必造运行时**。先做「浏览器域的 code-first 通道」：评估 `tools` 的 `mode: 'ptc'` 在该会话打开（全局或按面板/场景），浏览器 31 个工具**自动**成为脚本内可调 binding；或者做一个更窄的 `browser_run`（仅浏览器命名空间，复用同一 PTC 运行时）。
2. **前置改造**（真实工作量在这两处）：
   - **投影友好性**：31 个工具的 schema 已是纯 JSON 参数（无二进制/无回调），天然适合 binding；但要把「快照编号只在本次快照有效」讲清楚（脚本内先 `get_snapshot` 再动作），并把 `hit/stale-snapshot` 语义写进 PTC 版用法说明。
   - **预算与锁的交互**：我们每个子调用 30s、`wait_for` 55s，且全局串行锁 + 用户闸在锁入口排队。一段脚本里 10 步 = 10 次子调度，**总时长可能超过单次工具预算**，而 PTC 的外层预算是一次 run。必须定下：子调用沿用 30s？还是脚本级预算覆盖？用户闸等待算谁的？**这一条要先写设计再写代码**，否则会出现「脚本跑一半被上游 timeout 抹掉」的老问题（同族踩坑见 `docs/planning/2026-09-16-browser-user-gate-tool-budget-diagnosis.md`）。
3. **验收判据**（可测）：同一组 20 步任务，native 模式下 N 次工具往返；PTC 模式下 1–3 次；`tool/ptc-dispatch` 事件能重建每个子调用（上游已提供 `PtcDispatchLog`）；用户闸/排队/凭据窗口在脚本内仍生效（用现有 31 个工具的回归套件在 PTC 路径重跑）。

**风险**：① 这是「能力面扩张」（模型可写代码），需要产品与安全共同决策（虽然 PTC 运行时自带 sandbox 模式与审批 seam）；② 现有 `isConcurrencySafe: false` 的工具在 PTC 并行子调用下仍然被全局锁串行，收益在「往返数」而不在「墙钟并行」；③ 提示词与客户端呈现（工具卡片）要区分两种模式。

### 4.2 【P0，S】快照自带「我在哪、几个页、快到预算没」的状态头

**对方做法**：每次 `snapshot()` 第一行固定格式：`[p1 "标题" | space "名字"(7): 2 managed, 1 untracked — p1 "…", p2 "…" | budget 2/8]`（`src/page-model.ts:2960-2984`）。消掉「先问有哪些页面」的一轮，并天然抑制「忘关页」。

**我们的落点**：`browser_get_snapshot` 的 `render` 首行加：`[tab 7 "标题" | 池 3/16 · 本会话 2 | 后台 1]`。数据我们都有（`pool.tabs`、`tab.ownerSession`、配额 16）。成本 S：`src/tools.ts:1466-1485` 的格式化 + 一条测试。
**风险**：多标签时首行过长 → 只列本会话 + 计数，别列全部 URL。
**验收**：快照 render 含状态头；`tools-interaction-verdicts.spec.ts` 加一条形状断言（防止 render 与 JSON 漂移，历史 CP-1）。

### 4.3 【P0，M】ref 的三元身份 + 只增不复用 + 失效态持久化

**对方做法**：`@N` 由 SDK 分配、单调递增永不复用；身份 = `(frameId, backendNodeId, documentId)`，同身份跨快照保留原号；`full_page` 快照 `replace()`（旧 refs 全失效）、局部快照 `merge()`；`documentId` 由 `Page.getFrameTree` 的 `loaderId` 派生，快照前后各读一次，变了即失效；用前复核失败 = `Stale ref: @N; take a new snapshot`；**失效态也写进磁盘 ledger**，跨轮/跨进程恢复。
**证据**：`src/page-ref-registry.ts:18-126,178-228`、`src/page-model.ts:2820-2895`、`src/page-ledger.ts:66-71`。

**我们的落点**：保留现有 `stale-snapshot` 语义，增量做三件事：
1. 锚点从「纯文档序 index」升级为「index → `backendNodeId`」映射（CDP `DOM.getDocument` + `Runtime.evaluate` 返回 `DOM.requestNode` 可行；我们已有 `cdp.ts` 通道与 `sessionId` 支持）；
2. 同 `backendNodeId + loaderId` 的节点在校验后**可跨快照复用编号**（模型不必重抽快照）；
3. 锚点/编号表持久化进 `BrowserStore`（现在的 `snapshotAnchors` 只在内存，重启即失效）。
**成本 M**（约 250–350 行 + 与 `resolveTarget` 接线）；**风险**：编号复用会让「模型以为还是它看过的那个元素」——必须保留 fail-loud：节点被替换（`backendNodeId` 变）即 `stale-snapshot`，绝不按位置猜。
**验收**：导航前后 ref 失效且报 `stale-snapshot`；同文档 DOM 变更后同身份 ref 仍可用；跨会话恢复后 ref 仍指向同一节点（新增 3 组单测 + 真机探针）。

### 4.4 【P0，M】对话框 / 弹窗 / 文件选择器 / 下载：先布防再动作 + 动作回执

**对方做法**：所有「动作之后才发生的事件」都要求**先订阅再动作**——`waitForEvent("popup"|"download")` 同步返回 Promise；`waitForFileChooser` 同步返回 Promise；高层动作把**立即观察到**的 popup 放进 `receipt.popups`、dialog 放进 `receipt.dialog`；轮末汇总「发现但没用过」的页面（`[ego-browser:pages] Unhandled page p3 from p1: <url>`）。对话框：`acceptDialog(promptText?)`/`dismissDialog()`；dialog 打开期间其他命令**立即失败**并点名 dialog，而不是等 15s 传输超时。
**证据**：`skill-body/SKILL.md:396-408,442-463`、`src/page-model.ts:1786-1815,2790-2815`、`src/browser-runtime.ts:31-36,111-146,519-530`、`src/page-discovery.ts:20-93`。

**我们的落点**（这是当前**最像 P0 的能力缺口**）：
1. `browser_click`（及 type/press/scroll）新增可选 `expect: {popup|download|fileChooser|dialog}`，在动作**之前**武装 CDP 监听，返回 `receipt: {popups[], download?, dialog?}`；
2. 新增 `browser_dialog({action:'accept'|'dismiss', promptText?})`，并在任何工具执行前探测未处理 dialog（`Page.javascriptDialogOpening` 需要先接线——目前**零接线**）；
3. 新增 `browser_wait_for` 条件 `popup` / `download` / `fileChooser`（与现有 6 种条件同构）；
4. `browser_list_tabs` 增加「本轮发现但未被使用的标签」清单（我们有 op log，能算出来）。
**成本 M；风险**：① Electron 的 `will-download` 已在 session 级拦截（`src/guard.ts:288-420`），逐动作布防要与其共存；② 对话框必须先解决「Chromium 默认行为阻塞渲染进程」——接上 `Page.javascriptDialogOpening` 后要立即 `Page.handleJavaScriptDialog` 或显式挂起等待模型决定；③ 用户接管期间的 dialog 归属（谁应答）要写清。
**验收**：真机探针覆盖 alert/confirm/prompt、`target=_blank` 弹窗、点击触发下载、点击触发 file chooser 四类，全部在**同一次工具调用内**返回回执，且不出现「工具超时」。

### 4.5 【P0，S】错误契约：transient/permanent 分类 + hard stop 单点 + 输出缓冲

**对方做法**：
- 元素解析失败分 `transient`（元素在但暂不可动作 / 帧消失 / session 丢）与 `permanent`（选择器非法 / 匹配多个），**等待循环只重试 transient**；
- 「用户接管」「任务结束」是不二义的 hard stop：错误文案 = 分类 + 禁令（"do not retry and do not take ownership back on your own"）+ 重新接管的 API 调用示例 + 给用户的措辞建议；且文案只在**错误唯一出生地**（`buildEgoError`）打标，即使 Agent 的 try/catch 吞了也拦住输出；
- 输出全程缓冲：硬停止时丢弃全部业务输出，只输出那一条 owned 文案（且只一次）；未捕获异常时 sink 沉默（避免重复）。
**证据**：`src/element-resolver.ts:28-34`、`src/driver/waits.ts:60-70`、`src/ego-errors.ts:21-243`、`src/output-sink.ts:1-140`。

**我们的落点**：
1. `src/errors.ts` 的错误码加 `retryable: boolean`（`network/timeout/not-found` 里区分：元素暂不可见 = transient；选择器非法/多匹配 = permanent；`window-controlled` = hard stop）；
2. `window-controlled` 文案补「给用户的措辞 + 恢复路径」（我们已有 `awaitingRelease` 状态，缺文案契约）；
3. 工具结果层加「硬停止」标记：一旦本轮出现 hard stop，后续工具调用直接返回同一条引导（不发散），并在客户端呈现「AI 已暂停」。
**成本 S（文案+类型）+ S（缓冲逻辑，仅浏览器域）；风险**：错误码是已发布契约（14 个码里 4 个是死码），加字段要走类型兼容；文案改动要同步 `tests/` 里的字符串断言。
**验收**：新增单测「hard stop 只出现一次」「transient 才进重试循环」「permanent 立即失败并带诊断」；`tools-interaction-verdicts.spec.ts` 覆盖 `window-controlled` 文案。

### 4.6 【P1，M】快照 scope + iframe/OOPIF/shadow DOM 可动作节点

**对方做法**：`Page.snapshot({scope: "only_within_viewport"|"full_page"|"subtree", root: "@12"})`；普通 iframe 内容默认包含，OOPIF 也包含；`subtree` + iframe 行的 ref 可下钻；快照压缩规则（删空/零宽文本、折叠无名单子容器、保留语义节点）作为**对原生侧的需求 + 验收条件**写在 `docs/native-snapshot-ref-requirement.md`，并要求「连续两次快照输出逐字节一致」的幂等性测试。
**证据**：`skills/.../SKILL.md:246-256`、`docs/native-snapshot-ref-requirement.md:3-25`、`src/snapshot-result.ts:82-187`。

**我们的落点**：
1. `browser_get_snapshot` 新增 `scope`：`viewport`（默认，现状）/ `full_page` / `subtree`（`root` 用编号或 CSS）；
2. **子帧快照**：我们已有 `browser_eval(frame:N)` 的 1:1 帧映射（`src/frames.ts:69-127`），快照探针可复用同一映射逐帧执行并把结果按帧分组返回（每个元素带 `frame` 索引，动作时自动落到该帧的 CDP session——OOPIF 需要带 `sessionId`，我们的 `cdp.ts` 已支持）；
3. **open shadow DOM**：探针改成 composed-tree 遍历（`assignedSlot → parentElement → shadowRoot.host`），元素编号仍按文档序；
4. 压缩规则对齐它的三条（我们能做的是「减少 note 噪声 + 折叠容器」，因为我们本来就不吐文本树）。
**成本 M–L（按是否含 OOPIF 动作路径）；风险**：帧内动作的坐标/命中校验要重做（我们现在的 `click` 是本帧 `elementFromPoint`）；快照体积会上涨 → 必须同时落实 `truncated/total/note` 的分帧计数。
**验收**：新建 4 组真机探针（同源 iframe / 跨域 OOPIF / 嵌套 iframe / open shadow root）：「快照能看到 + 编号能点中」双断言；`truncated` 语义在分帧后仍准确。

### 4.7 【P1，M】点击三重校验与「拦截者」诊断

**对方做法**：候选级 4 档 actionability + 动作前 composed-tree `elementsFromPoint` 找真正拦截者（先找 `role=dialog`/`aria-modal` 祖先并输出「dialog 名字」）+ 每次 press 前复核；文案 `page.click failed: dialog "Sign in" intercepts pointer events`；`fill` 额外拒绝「点击点落在别的可交互元素上」。
**证据**：`src/driver/action-target.ts:309-414`、`src/driver/page-actions.ts:326-345,1724-1790`、`src/element-resolver.ts:1792-1840`。

**我们的落点**：我们已有 `hit`（事后）与 `not-found`（点不到就失败）。升级为「事前拦截检测 + 拦截者描述」：
- `click` 之前用一次 `Runtime.evaluate` 跑 injected helper（`elementsFromPoint` 冒泡穿透 shadow/iframe host），命中不是目标且不是其祖先/后代 → 报 `not-found` 并带 `interceptedBy{tag,id,role,text}`；
- 双击/连点（未来支持）每次 press 前复核；
- `fill_form` 的每个字段在 click 前做同样的检查（防「填充变提交」）。
**成本 M（约 300 行页内 JS + 接线）；风险**：页内注入 helper 与 `eval-policy` 的关系（这不是模型 eval，是宿主注入，需与 `snapshot.ts` 同级的「固定探针」通道，不要走 `browser_eval`）。
**验收**：遮罩/浮层/弹窗三种拦截场景全部给出拦截者名字；`hit` 语义保持不变（回归 `tools-interaction-verdicts.spec.ts`）。

### 4.8 【P1，M】用户闸升级为 ownership 状态机 + 收尾语义

**对方做法**：Space 有 `agent`/`user` 归属；`handOff()` 交权、`takeOverTaskSpace()`/`claimTaskSpace()` 恢复、`waitForControl()` 原地等；`finish({keep})` **必填**并保护用户/非受管页面；权限弹窗用 12 个原因键细分文案；`probeAgentControl()` 把「预期中的用户接管」当返回值而不是异常。
**证据**：`src/public-api-schema.ts:122-176`、`src/ego-errors.ts:71-107,174-194`、`skill-body/SKILL.md:496-545`。

**我们的落点**：我们已有闸门与三档 UI 提示，缺三件：
1. **归属字段进工具返回值**：`browser_list_tabs` 已有 `control`；再给「本会话在这个标签上的归属」与「用户是否曾在此标签接管」；
2. **收尾语义**：给模型一个 `browser_finish({keep:[tab…]})`（关闭本会话打开的标签，保留用户标签），替代「逐个 close_tab」——这是模型最常见的浪费（留一堆标签直到池满）；
3. **文案契约**：`window-controlled` 的 render 里给出「请用户点浏览器窗口的『交给 AI』」+「不要重试」的固定句式（英文模型面）。
**成本 M（含产品确认：finish 会不会误关用户标签）；风险**：我们是共享池，没有「本会话打开的标签」的强归属——`tab.ownerSession` 有记录但用户也可在同标签操作，需要产品规则（建议：只关「本会话创建且用户未接管过」的标签）。
**验收**：`finish` 在混合场景下不关用户标签；`window-controlled` 只出现一次引导；客户端状态不变。

### 4.9 【P1，S】自描述 `help()` 与「破坏性命令手册」

**对方做法**：`help()` 返回全部 schema、`help("page.click")` 返回单条；**运行时用 acorn 解析自己的 bundle 提取 JSDoc**，所以新增 API 只改一处；另有一份「破坏性 CDP 命令」参考文件（`references/clearing-state.md`），明确「通过 page.cdp 发 ≠ 作用域是这一页」，把「哪些命令会清掉整 profile」交给模型自己避开。
**证据**：`src/help-runtime.ts:32-205`、`skills/ego-browser/references/clearing-state.md:3-24`、`AGENTS.md:25`。

**我们的落点**：
1. `browser_help(topic?)`：从 `src/tools.ts` 的 `GROUP_OF` + 各自 schema **生成**（单一数据源，避免手写漂移），返回「工具名/参数/限制/错误码含义」；`topic` 支持 `snapshot`/`eval`/`credentials`/`quota` 等；
2. 一份模型可读的「危险动作手册」（不是工具）：清数据、下载、上传、eval 出站、凭据注入的边界与代价——我们已经有大量这类文案散落在 description 里（极长），抽成可 `help` 的主题反而**减少**系统提示词长度。
**成本 S；风险**：`help` 输出本身会占上下文 → 默认只返回目录（工具名+一句话），按 topic 才展开。
**验收**：`help()` 输出与 schema 一致性有单测（照抄它 `public-api-schema.test.mjs` 的两条兜底思路）。

### 4.10 【P2，M】站点经验包（learnings）+ 必需的失效检测

**对方做法**：`learnings/<site>/{manifest.json, notes/*.md, tools/*.js, browser-tools/*.js}`；`manifest` 声明 `domains`（支持 `*.` 通配）+ 工具 schema（args/returns/callable）；按 URL 匹配后把 notes 与工具用法注入语境；`nodeTools` 用 `callable(ctx,args)`、`browserTools` 是页面内函数体；`validate-site-skills` 强制：id=目录名、路径只能在 `tools/`/`browser-tools/`、工具名白名单、**禁止出现 `@123`/`ref=123` 这类一次性 ref**（强制沉淀稳定选择器）。
**证据**：`skills/ego-browser/learnings/github/manifest.json`、`src/learning/index.ts:39-187`、`src/learning/validate-learning-format.ts:19,315-374`、`AGENTS.md:71`。

**我们的落点**：与我们已有的「能力中心 / 技能市场 / market-skill 更新语义」天然同构——把「某站点的操作经验」做成**可版本化、可审批、可 diff 的技能包**，而不是塞进模型上下文：
- 包结构：`manifest.json`（domains + 工具 schema + 验证用例）+ `notes/*.md` + `tools/*.js`（宿主侧，走 PTC/内部 API）；
- 校验器进 CI：照抄它的四条硬规则（尤其**禁一次性 ref**），再加我们自己的两条：**必须带失效检测用例**（一条 smoke：打开固定页面 → 断言关键选择器仍命中 → 失败即标 `stale` 并禁止注入）+ **不得包含凭据/真实 URL 参数**（复用 `check-no-real-domains` 与 `sensitive` 词表）；
- 路由：域名 → 经验包，注入到 `browser_get_snapshot` 的 note 或系统提示词的一个 section。
**成本 M（机制）+ 持续运营；风险**：站点改版会让工具坏掉——**对方的最大空洞正是没有失效检测**（它只有 3 个站点、8 个工具，且 `x-com` 直接写 `[data-testid="tweet"]`）。我们若做，必须把「失效检测 + 自动降级」当第一等公民，否则半年后全是坏工具。
**验收**：新增一个经验包能通过 CI 校验；失效用例在页面改版后**红**而不是静默错。

### 4.11 【P2，S】真机浏览器动作 e2e 的 case 命名法

**对方做法**：69 个 case 按「行为契约」命名（`page labels: persist before hard stop`、`Page refs across rounds: prepare/resume`、`Page snapshot nested/sibling/lazy/replaced iframe`、`Page OOPIF restore and close`、`Concurrent TaskSpace downloads`），全部打真内核零 mock，运行器支持单跑（`EGO_BROWSER_REAL_E2E_ONLY`）；**但它不在 CI**（只有 pre-commit）。
**证据**：`package/ego-browser/scripts/real-browser-e2e/cases/index.mjs:83-208`、`lefthook.yml:45-48`、`.github/workflows/ci.yml:24-49`。

**我们的落点**：我们已有 `e2e:client`（驱动客户端 UI，不驱动浏览器动作）与人工真机探针（`temp/audit-browser-mask-probe.mjs` 等，不入库）。建议新增 `e2e:browser`：打包应用 + 真 Chromium + mock gateway，用同一套 CDP 驱动跑**动作级** case（对话框/弹窗/下载/上传/iframe/ref 失效/用户闸），命名照它的「契约式命名」，并以**新增能力必须带 case** 作为门禁。成本 S–M；**优势**：它做不到「进 CI」，我们 CI 已有 Linux 打包 + Xvfb 链路，可以做得比它更完整。

---

## 5. 不建议照搬的五件事

### 5.1 不要把 31 个工具收成 1 个命令
我们的用户闸、工具组策略、`isConcurrencySafe` 并发契约、客户端活动面板的 `toolLabels`、审计 op log 都以**工具粒度**为单位。收成 CLI 会让「谁在操作浏览器」「哪个动作被拒」「用户看到的动作名」全部退化。正确姿势是**叠加**（§4.1），不是替换。

### 5.2 不要为「共享登录态」放弃凭据保护
ego-lite 不做凭据注入（它用用户自己的登录态，profile 就是用户的），所以它能省掉整套掩码。我们的企业场景需要「AI 代用户登录连接器站点」，因此 `browser_fill_credentials` + 凭据窗口（注入后整体拒绝 eval/截图直到导航）+ origin 级值集合 + 三层词表是**不可交换的资产**。对比时不要把它读成「我们更复杂所以更差」。

### 5.3 不要把「每 Agent 一个 Space」当技术债
它是产品形态（并行共存 vs 互斥接管）。我们 v4 曾定稿分组架构后又**主动**删掉（`registry.ts` 648 行 + `resolve.ts` 126 行，`docs/planning/2026-09-07-browser-bug-audit.md:88`），换来的是「单池 + 蒙版 + 整窗接管」的简单模型。若要做并行，正确入口是**产品决策**（蒙版是否常驻、标签是否可见、审计怎么归属），不是「补一个隔离层」。

### 5.4 不要引用它的基准数字
README 声称 31 个真实任务、比 4 个工具快 47%–63%、token 更省，但仓库里**没有任务集、没有 harness、没有 rubric、没有逐任务结果**，唯一「证据」是一张图。方法论（code-first 减少往返）可引用，数字不可以。

### 5.5 不要只抄 learnings 的机制而不抄它的教训
它自己就是「机制完整、内容很少、没有失效检测」的样本（3 站 8 工具，站点一改版就坏）。抄机制的同时必须把**失效检测 + 自动降级**写进第一版，否则是负资产。

---

## 6. 落地路线（按依赖排序）

| 阶段 | 内容 | 涉及面 | 验收 | 量级 |
| --- | --- | --- | --- | --- |
| **S1（1 周内）** | §4.2 快照状态头；§4.5 错误契约（transient/permanent + hard stop 文案 + 硬停止单次引导）；§4.9 `browser_help` + 危险动作手册 | `src/tools.ts`、`src/errors.ts`、`src/snapshot.ts`、`src/client/` | 单测 + `tools-interaction-verdicts.spec.ts` 扩展；系统提示词长度不增 | 3×S |
| **S2（2–3 周）** | §4.4 对话框/弹窗/文件选择器/下载「先布防再动作」+ 回执；§4.3 ref 三元身份与持久化（先做同文档复用，再做跨轮）；§4.11 `e2e:browser` 真机动作门禁 | `src/runtime.ts`、`src/cdp.ts`、`src/snapshot.ts`、`src/guard.ts`、`scripts/e2e-browser*` | 4 类事件同一次调用内回执；ref 跨轮恢复；新门禁在 CI Linux job 跑通 | 2×M |
| **S3（3–6 周，需决策）** | §4.1 code-first（PTC 投影 + 预算设计）；§4.6 快照 scope + iframe/OOPIF/shadow；§4.7 拦截者诊断；§4.8 finish 语义 | `packages/host/desktop`（profile 组合）、`packages/host/browser` | 20 步任务往返数从 N→≤3；4 组 iframe 探针；finish 不误关用户标签 | L + M |
| **S4（可选）** | §4.10 站点经验包 + 失效检测（与能力中心/技能市场合流） | 能力中心 + browser + server（技能分发） | 一个站点的包能过 CI；改版后失效用例变红 | M + 运营 |

**可测量指标（建议先埋点再改）**：① 每任务工具往返数；② 每任务 token；③ `stale-snapshot` / `not-found` / `timeout` 三类错误占比；④ 用户接管后模型「继续撞墙」的次数（我们已有 `awaitingRelease` 可计数）；⑤ 真机动作 case 通过率。

---

## 7. 证据与引用

### 7.1 我们侧（`packages/host/browser`，HEAD `38fa040`）

| 结论 | 证据 |
| --- | --- |
| 31 个工具 / 7 组 | `src/tools.ts:1605-1625`；`tests/audit-r22-tool-groups-production.spec.ts:41` |
| 单池 + 全局锁（v4.2 取消分组） | `src/pool.ts:1-10,128-194`；`src/tools.ts:38`（提示词第 7 条 Tabs are GLOBAL） |
| 用户闸 10s / 工具预算 30s / wait_for 55s | `src/budgets.ts:27,36-45,58` |
| 快照不穿透 iframe/shadow | `src/snapshot.ts:229-251,304-310` |
| ref = 世代锚定编号 + 根锚定唯一选择器 | `src/runtime.ts:2805-2838`；`src/snapshot.ts:144-192` |
| 命中身份回传 | `src/tools.ts:46-57,670-704` |
| 凭据三层掩码 + 凭据窗口 + origin 级值集合 | `src/sensitive.ts:32-93,155-291`；`src/runtime.ts:1880-2030,2880-2905` |
| 来源分级（本机地址一刀切） | `src/guard.ts:115-216`；`src/runtime.ts:1071-1094` |
| 无剪贴板 / 无 dialog 接线 / 无 CSP | `grep clipboard src/` 零命中；`grep javascriptDialog` 零命中；`src/index.ts:999-1002` |
| 无 per-action approval | `src/guard.ts:6-13` |
| 测试规模 | `tests/*.ts` 60 文件 / 21 180 行 / 805 用例调用点 |
| PTC 依赖已声明未使用 | `package.json:84`；`grep ptc src/` 零命中 |
| 本仓已有 PTC 承载点 | `deepseek-harness/packages/core/tools/src/ptc.ts:32,330`；`index.ts:26,672,812,948,1360` |

### 7.2 ego-lite 侧（`citrolabs/ego-lite` @ `d392204`）

| 结论 | 证据 |
| --- | --- |
| 1 个命令 + 脚本执行模型 | `package/ego-browser/src/run.ts:96-147`；`docs/ego-browser-skill-command.md:39-73` |
| 74 条 v2 API / 55 helper | `package/ego-browser/src/public-api-schema.ts:60-749`；`src/helpers.ts:695-750` |
| 原生绑定 16 方法 | `docs/native-bindings-api.md:1-120,610-664` |
| ref 三元身份 / 持久化 | `src/page-ref-registry.ts:18-126,178-228`；`src/page-ledger.ts:66-71` |
| 快照压缩规则 + 状态头 + scope | `src/snapshot-result.ts:82-187`；`src/page-model.ts:2960-2984`；`docs/native-snapshot-ref-requirement.md:3-37` |
| actionability 4 档 / 拦截者 / 命中 | `src/element-resolver.ts:19-34,1792-1840`；`src/driver/action-target.ts:309-414` |
| 对话框/弹窗/下载/chooser 布防 | `src/browser-runtime.ts:31-146,519-530`；`src/page-model.ts:1786-1815`；`src/driver/downloads.ts:41-90` |
| 错误契约 / hard stop / 输出缓冲 | `src/ego-errors.ts:21-243`；`src/output-sink.ts:1-140` |
| 站点经验包 + 校验 | `src/learning/index.ts:39-187`；`src/learning/validate-learning-format.ts:19,315-374`；`skills/ego-browser/learnings/*/manifest.json` |
| 9 宿主 / DSH 走 skills provider | `plugins/scripts/package-plugins.mjs:19-61`；`plugins/ego/dsh/src/index.js:85-89` |
| 69 个真机 e2e（不进 CI） | `package/ego-browser/scripts/real-browser-e2e/cases/index.mjs:83-208`；`lefthook.yml:45-48`；`.github/workflows/ci.yml:24-49` |
| 基准不可复现 | `README.md:120-130`（无任务集/harness/rubric/逐条结果） |

### 7.3 明确不采信的内容

| 内容 | 原因 |
| --- | --- |
| 「比其他工具快 47%–63%」「token 成本更低」 | 无任务定义、无 harness、无原始轨迹、无 judge prompt，唯一证据是一张图 |
| 「市面上最强的页面 Snapshot」 | 纯营销，无对比方法与数据 |
| 「经验沉淀最高 5x」 | 纯营销 + 其 README 标 `coming soon`，而代码里已实现（反向不一致） |
| 其 Star 历史 | 生成该图的 workflow 文件在仓库中不存在，无法核验 |

### 7.4 调研方法

- 对象 A：只读通读 `src/`（`runtime.ts` 5 168 行采用「方法索引 + 定点深读」）、`tests/` 用 grep 统计用例标题、8 篇审计/规划文档全读；行号为本仓 HEAD 实测。
- 对象 B：`git clone --depth 1`（不入库，副本在 `temp/ego-lite`），只读通读 `package/ego-browser/src`、`docs/`、`skills/`、`plugins/`、`scripts/real-browser-e2e/cases/`（只读 case 名与断言意图），未安装依赖、未运行其测试。
- 两份原始盘点报告（含逐条 file:line 与量化表）：`temp/research/our-browser-surface.md`（500 行）、`temp/research/ego-lite-surface.md`（1042 行），均在 gitignored 的 `temp/` 下，不入库。
