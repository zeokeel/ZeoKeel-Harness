# 浏览器锁序表（D1 设计，rev2 —— 吸收 d1-preaudit B1/B2/B3/S1–S8）

- 日期：2026-10-23（rev3 —— 吸收 d1-preaudit2 的 B4/B5）
- 目标：每 tab 串行、跨 tab 并行；不削弱任何 choke point；无环、可超时、可测试。
- rev1 被驳回的三点已按审计建议改写：L1 准入模型（B1）、per-op 上下文（B2）、close 形态（B3）。

## 1. 锁清单

| # | 锁（代码位置） | 保护什么 | 获取/持有 | 释放 |
| --- | --- | --- | --- | --- |
| L1 | **准入队列**（现 `PoolMutex.run`，`pool.ts:130`/`withOperation` `pool.ts:351`） | 用户闸判定 + 全局操作序列 | 只做"等 gate + 准入计数 + 建 op 上下文"，**随即释放**，返回 lease | lease 结束时交付（busy 计数减一） |
| L2 | `TabPool` 注册表 | tab 台账、槽位、`closing` 标记 | 同步段极短持有 | 变更后立即释放（绝不 await） |
| L3 | per-tab FIFO 锁（D1 新增） | 同一 tab 命令串行 | 每条命令在 L1 **之后**取；close 不取 | `finally`；tab 移除时清 map+waiters |
| L4 | `evalInFlight` | eval 期间导航/截图判定 | 在 **L3 内**检查/增减 | eval 结束 |
| L5 | dialog 状态 | dialog fail-fast | 命令入口（L3 内） | 处理/丢弃 |
| L6–L8 | store / surfaces / downloads | 台账/注册/记录 | 极短同步段 | 返回即释放 |

## 2. 唯一方向（B1：L1 不再全程持有）

```
A 类（per-tab）:   admitOperation(gate) → L3(tabId) → 复核 gate → 命令 → finally L3 → lease 交付
B 类（全局独占）: admitOperation(gate) → L9 → [可选 L3] → 命令 → finally [L3] → L9 → lease
C 类（只读全局）: admitOperation(gate) → 命令（无 L3/L9）→ lease 交付
```

  → withTabLock(tabId)（L3，按 op lease 的 abort signal）
  → 复核 gate（TOCTOU）+ beforeCommand choke point
  → CDP 命令
  → finally: 释放 L3 → 交付 lease（busy--）
```

- **`busy/busyDepth` 由活动 lease 计数派生**（`controlState().busy` 语义不变；补两 tab 并发 busy 用例）。
- "排队等前一个操作超时"的文案迁到 **per-tab 队列**（跨 tab 不再排队）。
- gate 预算从**调用时刻**起算（进 admit 前取 deadline）。
- L2 仍只做短同步段；L6–L8 同理；**禁止**持 L2/L4–L8 时 await CDP。

## 2.5 调用点分类（B4 要求：每个 agentRun/withOperation 归属 A/B/C）

| 类 | 锁路径 | 调用点 |
| --- | --- | --- |
| **A per-tab** | L1 → L3(tabId) | navigate/open(有 target)/click/type/select/press/hotkey/hover/drag/scroll/snapshot/get_text/eval/screenshot/fetch/emulate/clipboard/file_chooser(目标 tab)/download(归属 tab)/wait_for(事件类) |
| **B global-exclusive** | L1 → L9（必要时再 L3） | **restore 物化**（`runtime.ts:1042`，P1-2 跨账号不得交错）、应用窗口操作（A16，无 tab id）、`browser_clear_data`、`downloads_remove`、bookmarks add/remove、`closeAll`/会话切换、dialog 全局段、`handleDialog` |
| **C admission-only** | L1 only | `list_tabs` / `downloads_list` / `history_search` / `bookmarks_list` |

规则：B 类在需要操作具体 tab 时（如 dialog 目标 tab）**先 L9 再 L3**，绝不反向；A/C 类不取 L9。用例：restore 与 tab 命令并发不交错、clear_data 与在途导航、两应用窗口命令串行；变异：B 类改成只准入 → 红。

## 3. Per-op 上下文（B2）

- 每个 op 建 `OpContext { opId, tool, tabId?, agentId, controller, deadlineAt, takeoverEpoch }`。
- 机制**二选一已定：`AsyncLocalStorage`**（不写"显式传参或 ALS"）；归属不再用全局 `lastAgentId`，op log 读 ALS 上下文，并补"两 tab、两 agent 并发 → 各自归属正确"用例。
- **per-op `AbortController`**：由接管 epoch / 工具 abort / deadline 触发；`loadURL` 等待、下载等待、截图 promise 都接这个 signal（S1）。用例：接管时若在导航加载或下载等待中，须 **<1s** 以 `window-controlled` 结束。

## 3.5 L3 排队语义（B5）

- 入队即受三种 abort 约束：工具 signal、takeover epoch、tab `closing`。
- 排队超时文案："waited N ms behind an in-flight command on this tab"；超时码 `timeout`。
- `closing` 的错误码：**`not-found`**（tab 已不存在）；排队期间被 close 的同一 tab 用 `not-found`，不新增 `closing` 码（避免模型看到不可执行的中间态）。
- 预算先后：`deadlineAt` 从**调用时刻**算（进 admit 前）→ L1 准入 → L3 排队与执行共用剩余预算；gate 等待与 L3 排队之和不得超过工具注册预算。

## 4. 接管（S1：新实现，不只 abort CDP）

- `setUserControl(true)`：翻标志 + **epoch++** → 遍历所有活动 op 的 controller.abort('window-controlled') → 队列中未准入的命令在 L1 处被 gate 拒绝。
- 两 tab 各挂 CDP/导航/下载等待 → 接管后两者都 `window-controlled`。
- 豁免：`handleDialog`、交还（用户→AI）等宿主路径不走该 abort。

## 5. close 形态（B3）

```
closeTab(tabId):
  L2 内: 标记 closing（立即释放 L2；排队命令见 closing → fail-fast not-found）
  → 不持任何边锁: abort 该 tab 的 op controller（**排除 close 自身 opId**，避免 abort 自己）
  → 固定 primitive: 不持锁 acquire 该 tab 的 L3（短超时）确认 idle 后立即 release
    （禁止轮询、禁止无超时、禁止持 L2 等 L3；超时则强制移除并写 op log）
  → L2 内 remove（清 L3 map+waiters, evalInFlight, dialogs）
  → onChange/emit 在释放 L2 之后
```

- `browser_close_tab` 自身不得包在 caller tab 的 L3 里；A 关 B / B 关 A 互不持锁等待。
- 用例：close-during-op、跨 tab 互关、abort-while-queued 都带**显式 timeout** 断言（S8）。

## 5.5 不走 `withTabLock` 的工具（B5 要求显式列出）

| 工具 | 原因 | 锁路径 |
| --- | --- | --- |
| `browser_close_tab` | 关闭目标 tab 会 abort 其 op，包进 caller tab 的 L3 会自锁 | B：L1 → L9（目标 tab 的 L3 由 close 的 acquire/idle 步骤独立处理） |
| `browser_dialog` / `handleDialog` | 目标 tab 可能被 dialog 阻塞 | B：L1 → L9 →（必要时 L3） |
| `browser_takeover` / 交还 | 全局控制权切换 | B：L1 → L9 |
| `browser_open`（无 target tab） | 新 tab 尚无 id | A：L1 → L3（新建后绑定） |
| `browser_list_tabs` / `downloads_list` / `history_search` / `bookmarks_list` | 只读、无副作用 | C：L1 only |
| restore（会话恢复入口） | 跨账号物化，必须与 agent 命令互斥 | B：L1 → L9 |

## 6. 其余并入项

- **S2**：gate 在取到 L3 后复核一次，`beforeCommand` 入口再核（同 tab 并发不能绕过）。
- **S3**：无 tab 的全局操作只经 L1；`downloadOwnerTab`/activeTab 读取在 L2 内或显式传 tabId。
- **S4**：A16 应用窗口（无 tab id）在 D1 后**仍走 L1 全局串行**；后续再给 surface 键。
- **S5**：`evalInFlight` 的检查移入 L3 内。
- **S6**：op log 跨 tab 交错可接受，**每 tab 内顺序保留**；补归属/顺序用例。
- **S7**：destroy/remove 清 L3 map、waiter、计数；重开同 id 用新锁。
- **S8**：close-during-op / 互关 / abort-while-queued 全部显式超时断言。

## 7. 变异清单（审计用）

| 变异 | 期望 |
| --- | --- |
| L1 改回全程持有 work | 跨 tab 并发用例红 |
| 去掉 L3 | 同 tab 串行用例红 |
| per-op 上下文退回全局 `lastAgentId` | 双 agent 归属用例红 |
| close 等 L3 无超时 | 互关/close-during-op 超时红 |
| 接管只 abort CDP（不接 loadURL/下载/截图） | 非 CDP 等待的接管用例红 |
| 失败创建不 release | 槽位泄漏用例红 |
| B 类操作改成只准入（不取 L9） | restore/clear_data/应用窗口并发用例红 |
| close 的 abort 包含自身 opId | close 自锁/超时红 |

## 8. 实现顺序

1. `admitOperation` + lease + busy 计数（拆 `withOperation`），保持现有 gate 测试绿；
2. `withTabLock` + 命令入口改造（L3 内复核 gate / beforeCommand）；
3. op 上下文 + per-op controller + 接管遍历；
4. close 新形态 + `closing` fail-fast + emit 在 L2 外；
5. 用例：同 tab 串行、跨 tab 并行、双 agent 归属、接管（CDP/导航/下载）、close-during-op、互关、失败创建、op log 顺序；
6. 逐项跑 §7 变异。
