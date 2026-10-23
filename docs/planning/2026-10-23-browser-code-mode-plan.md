# 内置浏览器「编程模式」整体规划（只给浏览器，不全局切 PTC）

- 日期：2026-10-23
- 状态：规划（未改代码；草稿代码已移出仓外到 `temp/drafts/2026-10-23-browser-run-script.ts`，仓内 `packages/host/browser` 零改动）
- 上游决策（已定）：**只让内置浏览器支持编程式执行**（新增窄口 `browser_run`），**不启用**全局 `DSH_TOOLS_MODE=ptc`、不改 agent 预设、不折叠其它工具。
- 未决项：拦截是否放宽 —— 见 [内置浏览器「拦截」全量清单](2026-10-23-browser-gate-inventory.md)（52 项待勾选）。**本规划默认不动任何 gate**；编程模式与拆 gate 是两件独立的事。

---

## 1. 目标与非目标

### 1.1 目标（可验收）

| # | 目标 | 验收口径 |
| --- | --- | --- |
| G1 | 模型可以**一次调用**完成多步浏览器流程（动作 → 等最终态 → 取一次快照） | 10 步任务只产生 1 次 `browser_run` 调用 |
| G2 | 编程模式**不绕过任何现有边界** | 用户闸 / 凭据窗口 / 导航策略 / 配额 / 上传白名单在脚本内仍生效（逐条回归） |
| G3 | 与原生工具面**并存**，模型自选 | 31 个 `browser_*` 工具全部保留；`browser_run` 是第 32 个 |
| G4 | 失败可自纠 | 脚本报错回传：失败类型 + 消息 + 脚本输出（截断），模型能据此改脚本重试 |
| G5 | 主进程安全 | 脚本不在 Electron 主进程执行；无限循环/崩溃不拖垮应用 |

### 1.2 非目标

- ✗ 全局 PTC（`tools.mode=ptc` / `DSH_TOOLS_MODE`）：那会把文件/Shell/浏览器**所有**工具折叠成一段程序，改变非浏览器任务的交互形态（用户已否）。
- ✗ 让脚本能发 raw CDP：那会绕过本文件里几乎所有判据（清 cookie、改权限、开新 target）。
- ✗ 用编程模式替掉原生工具面：短交互、需要人逐步确认的场景，原生工具更好（见 §2）。
- ✗ 在本规划里拆 gate：gate 清单单独拍板，避免两件事的责任混在一起。

---

## 2. 论证：编程模式是不是比「普通模式」更好用？

> 用户问题的直接回答：**不是全面更好，而是在特定任务形态上显著更好；正确形态是"两个入口 + 提示词里给选择规则"。** 下面是可核验的论证。

### 2.1 两种模式的成本结构

| 维度 | 普通模式（逐步工具调用） | 编程模式（一段程序） |
| --- | --- | --- |
| 模型往返 | 每步 1 次（动作 → 结果 → 下一步决策） | 整个流程 1 次 |
| 中间态上下文 | 每步的工具结果都进历史（快照 200 个元素 ≈ 数十行文本；10 步就是 10 份） | 只有脚本自己的输出进历史 |
| 条件/循环 | 由模型每步重新决策（翻页 20 页 = 20 轮） | `for`/`while` 一次表达 |
| 失败恢复 | 丢一步，模型重新规划 | 整个程序失败（除非局部 try/catch） |
| 可重放 | 不可重放（历史是自然语言+结果） | 脚本可原样重跑，便于调试与回归 |
| 权限/呈现粒度 | 每工具一次审批 seam、一次客户端呈现、一条 op log | 一次工具调用（子动作靠 op log 与 dispatch 日志还原） |
| 提示词成本 | 31 个 schema（现有 description 合计约 8.3KB + 参数 JSON） | 一份 helper 目录（约 2–3KB）+ 一段用法说明；但**仍然保留** 31 个 schema（见 G3） |
| 模型能力依赖 | 低（选工具、填参数） | 高（写对 TS：变量、循环、异步、错误处理） |

**结构性结论**：编程模式把「模型决策次数」换成「模型写代码的正确性」。当步骤**可以预先确定**时，这是净赚；当步骤**必须边看边决定**时，这是净亏（写一段探索脚本通常比点两下更贵）。

### 2.2 分场景判断（可直接写成提示词规则）

| 场景 | 推荐 | 理由 |
| --- | --- | --- |
| 已知流程 ≥3 步（填表 → 提交 → 校验） | **脚本** | 中间态不需要模型看；失败点明确 |
| 批量/分页/循环（列表 20 页、逐行抽取） | **脚本** | 循环是代码强项，模型逐步翻页成本随页数线性增长 |
| 数据抽取（一次取 100 条结构化数据） | **脚本** | 可在页内/脚本内整形，只回传结果 |
| 需要"看一眼再决定"（找按钮、看报错、挑链接） | **工具** | 快照本身就够，写脚本反而是额外负担 |
| 危险/不可逆动作（清数据、提交订单） | **工具** | 每步可见、可中断；脚本一次跑完更难拦 |
| 需要用户逐步确认 | **工具** | 脚本是一次黑盒调用 |

### 2.3 证据强度分层（避免拿营销数字当证据）

| 主张 | 证据 | 可引用性 |
| --- | --- | --- |
| 少往返 = 少 token / 少延迟 | 结构论证：每步结果都进历史；上游 PTC 的设计目标就是「只让外层 curated 结果进模型历史」（`deepseek-harness/packages/core/tools/src/ptc.ts:1-8`） | **可引用（结构）** |
| 上游把这当作一等能力 | `tools` 的 `mode: 'ptc'`、`run_code`、`ctx.ptcRuntime` 都是上游已发布面，不是我们自造实验 | **可引用（代码）** |
| ego-lite 的 code-first 更快 | 其 README 声称 47–63% 提速，但**无任务集、无 harness、无 rubric、无逐条结果**（唯一证据是一张图） | **不可引用**（只能标为厂商自测） |
| 在我们产品上到底快多少 | **目前没有数据** —— 必须按 §2.4 实测 | **待测** |

### 2.4 实测协议（一天内可跑完，产出可写进 README/决策文档）

- **任务集（10 个，固定 fixture，避免联网波动）**：① 登录后填三段表单并提交；② 分页取 5 页列表；③ 抽取 20 条结构化数据；④ 多标签对比两页；⑤ 搜索→点第一条→取详情；⑥ 上传文件→等结果；⑦ 触发下载并确认文件存在；⑧ 处理一个 `confirm()` 对话框；⑨ 页面内 iframe 操作；⑩ 长流程（10+ 步的审批流）。
- **两种模式**：native（现有 31 工具）/ `browser_run`（本规划）。同模型、同温度、各跑 3 次。
- **指标**：assistant 往返数、工具调用数、输入/输出 token、墙钟、成功率、人工干预次数。
- **判据**：
  - 可预先确定步骤的任务（①–③、⑥、⑩）：`browser_run` 的往返数应降 ≥50%，成功率不低于 native；
  - 探索型任务（④⑤⑨）：成功率不下降（往返数不作为判据）；
  - 任一任务成功率显著下降 ⇒ 提示词规则要改（比如"先 snapshot 再决定"）。
- **注意**：这是**方向性**验证（n=3，不追求显著性）；要作对外宣称需要更大样本，且不要引用 ego 的数字。

### 2.5 结论

编程模式**不是**"更高级的工具"，而是**另一类任务的更优接口**。我们把两者并存、并在提示词里写清选择规则（§4.3 的最后一段），比"默认全局 PTC"更稳：既不牺牲短交互的可见性与审批粒度，也能吃到长流程的往返红利。

---

## 3. 现状事实（方案设计的事实基础）

| 事实 | 证据 |
| --- | --- |
| 26/31 个工具各自一步；`browser_eval` 只接受单表达式（写不了循环） | `packages/host/browser/src/eval-policy.ts:309-320` |
| 每个动作一次 `agentRun` → 全局串行锁 + 用户闸 + 配额 + 预算 | `src/runtime.ts:2165-2245` |
| 单工具注册预算 30s；`wait_for` 55s；导航内部 14s；排队 1s 余量 | `src/budgets.ts:27,58,98` 等 |
| 快照是"200 个可交互元素 + 编号"，编号只对当前世代有效 | `src/snapshot.ts:13-16`、`src/runtime.ts:2805-2838` |
| 用户闸：用户持控制权时每次调用轮询等待，10s 超时报 `window-controlled` | `src/pool.ts:160-194` |
| 上游 PTC 已可用：base bundle 组合 `ptc-runtime`，web-app 接 `DSH_TOOLS_MODE`，`preset-ptc` 也在 | `deepseek-harness/packages/bundle/base/cordis.patch.yml:397-398`；`packages/bundle/web-app/cordis.patch.yml:31-38`；`packages/bundle/web-app/presets/ptc.patch.yml` |
| PTC 运行时：TypeScript、进程隔离、默认 120s/上限 600s、堆 512MiB、输出 64MiB、并发调用 128 | `deepseek-harness/packages/ptc-runtime/ptc-runtime-node/src/config.ts`、`src/index.ts:40-60` |
| PTC 调用面：`resolve(request) → spec`，`run(spec) → {logs, value?, error?, sandbox?}`；绑定是 `(args) => Promise<JSON>` | `@deepseek-ai/dsh-ptc-runtime` 的 `types.d.ts` |

---

## 4. 方案设计

### 4.1 工具形态

| 项 | 设计 | 理由 |
| --- | --- | --- |
| 名字 | `browser_run` | 与 `browser_*` 家族一致；不占用上游保留名 `run_code` |
| 参数 | `code`（必填，TS 函数体）、`timeoutMs`（可选，正整数，上限 = 程序预算） | 与上游 `run_code` 的最小面一致，不引入 `description` 这类冗余字段 |
| 返回 | `{ logs: string[], result?: json, sandbox?: {mode, denied, enforcement?} }` | 与上游 `run_code` 的输出形状对齐，客户端 presenter 可复用 |
| 失败 | 抛错（→ `isError` 结果），文案 = `失败类型 + 消息 + 脚本输出（≤4KB）` | 模型可据 kind 自纠（exception/timeout/abort/worker-exit/…） |
| 分组 | 新组 `script`，并在「默认全开」集合里 | 企业策略可**整组关掉**编程模式（与现有 `toolGroups` 语义一致） |
| 并发 | `isConcurrencySafe: false`（独占调度） | 一次程序内部已经串行访问浏览器；避免两个程序交错抢同一标签 |
| 呈现 | `presentCall('Run browser program')`；结果的 `render` 先日志后结果；调用卡片显示代码首行/长度 | 用户在活动面板能看出"在跑一段程序" |

### 4.2 执行载体

**推荐：复用 `ctx.ptcRuntime`（NodePtcRuntime）。**

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A. 复用 `ctx.ptcRuntime` | 进程隔离 + 沙箱 + 预算 + abort 已是成熟实现；行为与上游 `run_code` 一致；改动小 | 增加一个宿主依赖（base bundle 已装）；脚本能 `await import('node:fs')`（受 sandbox 策略；见 §4.8） | **采用** |
| B. 主进程 `new AsyncFunction` | 零依赖、启动快 | 无隔离：死循环卡死 Electron 主进程；`process`/`import()` 全可及；超时无法真正杀断 | ✗ 否决 |
| C. 自建 `worker_threads` + 白名单 | 比 B 安全 | 等于重写一遍 PTC 运行时（预算/序列化/abort/沙箱） | ✗ 否决（重复造轮子） |

**缺失时的行为**：`ctx.ptcRuntime` 不存在 ⇒ `browser_run` **明确报错**（"本部署没有组合 PTC runtime，请用单个 browser_* 工具"），**不降级**到主进程执行。理由：静默降级会把"模型代码"变成主进程任意代码执行，且用户与我们都不知道。

### 4.3 Helper API 面（脚本里能调什么）

约定：**每个 helper 收一个对象参数**（PTC 桥的调用约定），返回 JSON；错误以 rejection 形式进脚本，可用 `try/catch`。

| helper | 参数 | 映射到 | 说明 |
| --- | --- | --- | --- |
| `open` | `{url?}` | `runtime.open` | 新标签 |
| `navigate` | `{url, tab?, waitUntil?}` | `runtime.navigate` | 导航策略照旧 |
| `reload` / `back` / `forward` | `{tab?}` | `runtime.reload/goBack/goForward` | — |
| `tabs` / `activate` / `close` | `{}` / `{tab}` / `{tab?}` | `listTabs/switchTab/closeTab` | 返回控制权状态（`controlled`/`busy`） |
| `snapshot` | `{tab?}` | `runtime.modelSnapshot` | 返回 `{snapshot(世代), url, title, elements[], truncated, total}`；selector 经值级擦除 |
| `text` | `{tab?, selector?}` | `runtime.textWithMeta` | 有界输出 |
| `screenshot` | `{tab?}` | `runtime.screenshot` | **落盘**到下载目录并返回绝对路径（不把 base64 塞进上下文） |
| `click` / `type` / `select` | `{target, …}` | `locateElement`+`clickAt` / `typeInto` / `selectOption` | `target` = 快照编号或 CSS；返回 `hit` 身份（与工具面同口径） |
| `press` / `scroll` | `{key}` / `{deltaY?, target?}` | `pressKey` / `scroll` | — |
| `fill` | `{fields[], submit?}` | `runtime.fillForm` | 返回 `missed[]` |
| `upload` | `{paths[]}` | `runtime.uploadFile` | 白名单 = 下载目录 + 会话工作区（与工具一致） |
| `waitFor` | `{condition, selector?, text?, timeoutMs?, tab?}` | `runtime.waitFor` | 条件集与 `browser_wait_for` 相同 |
| `eval` | `{expression, frame?, tab?}` | `runtime.eval` | 与 `browser_eval` **同一**策略（单表达式、危险 API 名拒绝、凭据窗口内整体拒绝） |
| `fillCredentials` | `{connectorId, tab?}` | `runtime.fillCredentials` | 站点绑定照旧 |
| `download` | `{url}` | `runtime.downloadUrl` | 下载上限照旧 |
| `bookmarks` / `history` / `downloads` | `{q?, limit?, status?}` | 对应 runtime 查询 | 只读 |
| `takeover` | `{}` | `setUserControl(true,'ai')` | 交权给用户（**不提供**反向操作） |

**不提供**：raw CDP、任意 Node API 的封装、`browser_release`（夺权）、应用窗口寻址（`app_id`）、`clear_data`。理由见 §4.8 与 gate 清单 B5/B7/F3。

**提示词**：工具 description 里直接给 helper 目录 + 三条规则：① 编号只对本次快照有效；② 先 `snapshot` 再行动、动作后等最终态；③ 短任务/需要人确认的任务用原生工具。

### 4.4 预算与并发模型

| 层 | 值 | 说明 |
| --- | --- | --- |
| `browser_run` 注册预算 | **150s** | 必须 > 程序预算，否则上游 timeout-policy 会把可执行诊断换成笼统 timeout（踩坑记录：`docs/planning/2026-09-16-browser-user-gate-tool-budget-diagnosis.md`） |
| 程序预算（传给 PTC） | **默认 120s**，模型可传更小值 | 与上游 PTC 默认一致；部署可配 |
| 单 helper 内部预算 | 沿用 runtime 的 30s 派生（`toolBudgetMs`） | 单个浏览器动作不该超过 30s；程序级预算不是"给单步加时" |
| 用户闸等待 | 每次 helper 调用独立等待，10s 超时 | 脚本内多步 = 多段 10s；**新增规则**：一旦某步报 `window-controlled`，脚本应当中止（提示词要求 `catch` 后 `return` 而不是重试） |
| 排队 | 每次 helper 调用排队（全局锁） | 程序运行期间**不长期占锁**（只在调用内持锁），其它会话仍可插入 ⇒ 与"独占调度"配合时不会饿死别人 |
| 取消 | `exec.signal` → PTC run signal（硬中止进程）；在途 binding 调用由我们按同一 signal 结算 | 工具被 abort 时脚本立刻死，不会留下跑飞的进程 |
| 输出上限 | 日志回传截断 4KB（失败文案）；成功日志按 PTC 输出的上限（64MiB）但**工具输出 schema 再截断到 8KB** | 防止脚本 `console.log` 洪水冲爆上下文（截断必须显式告知模型） |

### 4.5 拦截继承矩阵（关键：脚本不绕过任何 gate）

| 边界 | 脚本内是否生效 | 说明 |
| --- | --- | --- |
| 全局串行锁 | ✅ | 每个 helper 调 runtime 方法 → `agentRun` 内持锁 |
| 用户闸（10s + `window-controlled`） | ✅ | 同上；脚本需要处理该错误 |
| 标签配额 / 槽位等待 | ✅ | `open` 走同一池 |
| 凭据窗口（禁 eval/截图） | ✅ | `eval`/`screenshot` 用同一 runtime 方法 |
| 凭据值级擦除 | ✅ | 快照/文本/返回的 `hit.selector` 全部走同一擦除 |
| 导航策略（scheme / 本机地址 / 应用 origin） | ✅ | `navigate` 用同一 `navigateInternal` |
| 上传白名单、下载上限 | ✅ | 同一方法 |
| 应用窗口寻址 | ❌ 不提供 | 脚本没有 `app_id` 入口（B7 保持） |
| 模型自我解除用户闸 | ❌ 不提供 | 没有 `release` helper（B5 保持） |
| raw CDP / 危险 CDP | ❌ 不提供 | 见 §4.8 |
| 系统权限（摄像头等） | ✅ 仍全拒 | 与脚本无关，平台层拒绝 |
| 工具组策略 | ✅ | `script` 组可被企业策略整组关闭 |

### 4.6 呈现与可观测

- **op log**：每个 helper 调用都经 runtime 记录（`browser_click`、`browser_navigate`…），活动面板时间线**照旧逐动作可见**；`browser_run` 自身再记一条 `browser_run`（含代码长度/耗时/成败），便于对账。
- **客户端**：调用卡片显示「运行浏览器程序」+ 代码首行（截断）+ 结果摘要；执行期间既有胶囊/面板的"AI 正在操作 · <工具>"照常工作（子动作会刷新 busyTool）。
- **SSE**：不需要新事件类型；现有 `state/tab/ops` 事件已覆盖。
- **日志**：程序 `console.log` 只在结果里回传（截断），不写 op log（避免把脚本数据落盘）。

### 4.7 错误契约

| PTC 失败 kind | 回传给模型 | 是否 `isError` |
| --- | --- | --- |
| `exception` | `browser_run failed (exception): <message>` + 输出 | 是 |
| `timeout` | `… (timeout): 程序超出预算；把任务拆小或传更小的 timeoutMs` | 是 |
| `abort` | `… (abort): 调用被取消`（用户中止/取消失效时） | 是 |
| `worker-exit` / `sandbox-unavailable` / `output-limit` / `invalid-output` / `protocol` | 原文 + 输出 | 是 |
| 无 PTC runtime | `browser_run needs a PTC runtime … 用单个 browser_* 工具` | 是 |
| helper 内 `window-controlled` | 脚本里是 rejection；脚本不 `catch` 则整程序以 exception 失败，文案里含该状态 | 是（且 runtime 会记 `noteControlBlock` 给客户端提示） |

### 4.8 安全新增面的处理

| 面 | 处理 |
| --- | --- |
| 脚本是任意 TS（Node 进程） | 沿用部署的 PTC sandbox 策略（默认 `sandboxPolicy.resolve()`）；本地信任模式若要放宽，走 gate 清单 H2 单独拍板 |
| 脚本可 `import('node:fs')` | 不额外封（沙箱策略已管）；但**不提供**浏览器 helper 以外的便利封装，提示词明确"文件操作走宿主文件工具" |
| raw CDP | 不提供；`eval` 仍是唯一页内代码入口，且受现有 eval 策略 |
| 代码本身进会话历史 | 是（工具调用参数），与 `run_code` 一致；长脚本会占上下文 ⇒ 提示词建议"只写必要代码" |
| 日志外带 | 输出截断 + 不落盘；如需长输出，模型应写入文件（用宿主文件工具） |

### 4.9 兼容与迁移

| 影响面 | 变化 | 处理 |
| --- | --- | --- |
| 模型工具面 | 31 → 32 | 更新提示词 section（加第 8 条）与两条钉死数量的测试 |
| `toolGroups` | 新增 `script` | `DEFAULT_GROUPS` 含 `script`；**显式列过 7 组的部署**需要补 `script`，否则该组被关（当前语义：显式数组按字面生效、未知值忽略 = 关）。需在发布说明写清 |
| 客户端 locale | 新增 `browser_run` 的活动面板文案（zh/en） | `src/shell-pages.ts` 的 `toolLabels` 补两条 |
| 企业策略/审计 | 新工具名进审计与策略 | op log 记 `browser_run`；后续若做「禁编程模式」策略，用 toolGroups 即可 |
| 文档 | 用户可见说明 | 更新 `docs/planning` 与产品帮助（如需要） |

---

## 5. 里程碑与验收

| 里程碑 | 内容 | 验收判据 | 回滚 |
| --- | --- | --- | --- |
| **M1 骨架（3–4 天）** | `src/script.ts`（bindings + runner）、`browser_run` 注册、budgets、组别、locale | 单测：helper→runtime 映射（stub runtime）、无 PTC runtime 的明确报错、失败 kind 映射；包 `build/typecheck/test` 全绿 | 删工具注册即回到 31 |
| **M2 稳定（3–5 天）** | abort 传播、预算序关系、日志截断、`hit`/擦除口径、脚本内 `window-controlled` 提示 | 真机探针：一次脚本完成"打开→填表→提交→快照"；用户中途接管时脚本以可执行文案失败；abort 能杀死进程 | 保留 M1；关 `script` 组 |
| **M3 体验（3–5 天）** | 客户端卡片/代码预览、op log 记账、提示词选择规则、活动面板文案 | `e2e:client` 能断言卡片渲染；提示词与 31 工具 schema 无漂移（一致性测试） | 关客户端卡片（退化为纯文本） |
| **M4 数据（2–3 天，可与 M3 并行）** | §2.4 的 10 任务 A/B 实测，产出报告 | 报告含每任务往返数/成功率的对比表；据此定"默认推荐脚本"的提示词阈值 | 无需回滚（纯测量） |

**开工顺序**：M1 →（M2 ∥ M4）→ M3。gate 清单的勾选结果与 M1–M3 无依赖，可并行推进。

---

## 6. 测试策略

| 层 | 内容 |
| --- | --- |
| 单元（vitest，无 Electron） | ① `browserBindings` 每个 helper → 正确调用 stub runtime 并回传 JSON；② 参数校验（缺 url、target 类型错、tab 非正整数）；③ `runBrowserProgram`：无 runtime 报错、`error.kind` 映射、日志截断、abort 透传；④ 组别与数量钉子（32/8 组） |
| 装配 | `applyBrowserTools` 注册面含 `browser_run`；`toolGroups: ['navigate']` 时不含；`toolGroups: []` 时全关 |
| 真机（新增 `e2e:browser` 的首批 case） | ① 脚本一次完成三步流程；② 脚本内 `snapshot` 后 `click` 成功、再次 `snapshot` 编号变化；③ 用户接管 → 脚本失败文案含"交给 AI"；④ abort 中途取消 → 无残留进程；⑤ 凭据窗口内脚本 `eval`/`screenshot` 被拒 |
| 提示词一致性 | 工具 description 里的 helper 目录必须与 `SCRIPT_HELPERS` 同源（生成，不手写两份） |

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 模型写错脚本，越改越差 | 成功率下降、用户困惑 | 失败文案带 kind + 输出；提示词写"最多重试一次，仍失败就改回原生工具" |
| 长脚本期间用户看不到进展 | 体验差（最长 120s） | 子动作实时进活动面板；调用卡片显示"运行中" |
| 日志/结果洪水 | 上下文爆炸 | 双层截断（失败 4KB / 成功结果 8KB）+ 显式告知截断 |
| 脚本把"编号"当长期有效 | `stale-snapshot` 报错 | 提示词与 helper catalog 明确"编号只对本次快照有效" |
| 企业部署显式列了 7 组 toolGroups | `script` 被静默关掉 | 发布说明 + 可选：显式数组里出现 7 组全名时补 `script`（需产品确认是否做"温和升级"） |
| PTC 运行时在桌面发行版里缺失/被裁 | `browser_run` 直接不可用 | 工具报明确可执行错误；`docs` 记录组合要求（base bundle 默认已装） |
| 脚本扩大权限面 | 安全争议 | §4.5 继承矩阵 + §4.8 不提供 raw CDP/app 寻址/夺权 |

---

## 8. 待拍板问题（开工前需要你确认）

| # | 问题 | 选项 | 我的建议 |
| --- | --- | --- | --- |
| Q1 | 程序默认预算 | 60s / 120s / 300s | **120s**（与上游 PTC 默认一致；单步仍受 30s 约束） |
| Q2 | `screenshot` helper 的产物 | 落盘返回路径 / 回传 attachment（需要新通道） | **落盘返回路径**（M1 最简；attachment 留到 M3） |
| Q3 | 是否允许脚本内 `eval` | 允许（同 `browser_eval` 策略）/ 不允许 | **允许**（策略一致；凭据窗口照旧拒绝） |
| Q4 | `script` 组默认开还是默认关 | 默认开 / 默认关（用户显式启用） | **默认开**（这正是你要的能力）；企业侧可用策略关 |
| Q5 | 本期是否连带做 gate 放宽 | 只做编程模式 / 同时按勾选拆 gate | **只做编程模式**（M1–M3），gate 另开一轮（避免责任混在一起） |

---

## 9. 与既有材料的关系

| 材料 | 关系 |
| --- | --- |
| [内置浏览器 vs ego-lite](competitive/2026-10-23-builtin-browser-vs-ego-lite.md) | 本文的"为什么借鉴 code-first"来自它 §4.1；helper 面设计参考其 74 条 API 的分组 |
| [内置浏览器「拦截」全量清单](2026-10-23-browser-gate-inventory.md) | 52 项待勾选；本文 §4.5 的"继承矩阵"与之逐条对齐 |
| `docs/planning/2026-09-07-ai-browser-redesign.md` | v4 设计里的"AI 优先工具面"与本规划的编程模式同源；本文不复活已删除的分组架构 |
