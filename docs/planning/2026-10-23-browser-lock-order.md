# 浏览器锁序表（D1 设计预读）

- 日期：2026-10-23
- 目的：把"谁持有哪把锁、在哪些函数获取、何时释放"写成唯一真源；D1 的每 tab 锁必须**不改变**既有 choke point 的入口语义，且**不产生环**。

## 1. 锁清单

| # | 锁（代码位置） | 保护什么 | 获取点 | 释放 |
| --- | --- | --- | --- | --- |
| L1 | 用户闸 `PoolMutex.run`（`pool.ts:130`，全局） | 用户 `我来操作` vs agent 行动 | `runtime.agentRun`（`runtime.ts:2580`） | `finally`（work 结束）；gate 拒绝也走同一 finally |
| L2 | `TabPool` 注册表（`liveTabs/reserved`） | tab 台账、槽位配额 | `reserveTab` / `registerTab` / `removeTab` / `releaseReservation`（`pool.ts:401/482/468`） | 每次变更后立即释放（**绝不跨 await CDP**） |
| L3 | per-tab 锁（**D1 新增**，目标） | 同一 tab 的命令串行 | `runtime` 的命令入口（在 L1 之后、命令前） | `finally`；tab 关闭时释放 |
| L4 | `evalInFlight` 计数（`runtime.ts:722`） | eval 期间的导航/截图判定 | eval 前后 | decrement（`runtime.ts:4066`） |
| L5 | dialog 状态（`dialogs` map） | dialog fail-fast / 处理 | `noteDialogOpened` / `handleDialog` | `discardDialog` / 处理完成 |
| L6 | store 写（`BrowserStore`） | 台账持久化 | 各写方法内部 | 方法返回 |
| L7 | surfaces 注册表 | 应用窗口/标签 surface | 注册/注销时 | 方法返回 |
| L8 | downloads recorder | 下载记录 | `record`/`update` | 方法返回 |

## 2. 方向（唯一允许的获取顺序）

```
L1（gate 等待） → 复核 gate → L3（per-tab） → 命令（CDP）
                       ↘ 期间可短暂取 L2（注册表）/L4–L8（状态/存储），但绝不在持有 L2/L4–L8 时 await CDP
```

- **L1 在 L3 之外**：gate 等待可长（用户闸），不能占着 tab 锁。
- **拿到 L3 后必须再复核 gate**（TOCTOU：等待期间用户可能接管）。
- **L2 只在注册表变更的同步段持有**；`closeTab` 采用"**标记 closing → 等在途（拿 L3）→ 移除（取 L2 短暂）**"，不允许"持 L2 等 L3"。
- **L4–L8 都是短临界区**，禁止在持有时 await CDP/gate。
- `beforeCommand` / dialog fail-fast / credential window 保持在**每个命令入口**（L3 之内），不得挪到锁外。

## 3. 与接管（setUserControl）的关系

- 接管是**全局 epoch**：对**所有** tab 调用 `cdp.abortPending`（遍历 `tabs`），并让排队命令失败。
- 在途命令返回 `window-controlled`；队列中的命令在 L1 处被 gate 拒绝。
- 用例：两 tab 各挂一个 CDP → setUserControl → 两者都以 `window-controlled` 失败。

## 4. 关闭 / 失败创建

- `reserveTab` 成功但创建失败 → `releaseReservation`（已有幂等令牌）。
- `closeTab` 后同 id 锁必须清理；重开同 id 并操作成功（防泄漏表现为挂 30s）。
- 测试必须带**显式超时**，避免"泄漏 = 30s 挂起"。

## 5. 变异点（审计用）

| 变异 | 期望 |
| --- | --- |
| 退回全局锁（L3 用同一把） | 跨 tab 并发用例红 |
| 去掉 L3 | 同 tab 串行用例红 |
| close-during-op 不清理锁 | 关闭后重开用例超时红 |
| 接管只 abort 当前 tab | 双 tab 接管用例红 |
| 失败创建不 release | 槽位泄漏用例红 |

## 6. 实现顺序

1. 先在 `runtime` 引入 per-tab 异步锁（简单 FIFO 队列 + finally 释放），所有命令入口经 `withTabLock(tabId, signal, work)`；
2. `agentRun` 保持 gate 语义不变（L1）；
3. `closeTab` 按"标记 → 等 L3 → 移除"实现；
4. 补锁序/并发/接管/泄漏/op log 归属用例，再对变异点逐项验证。
