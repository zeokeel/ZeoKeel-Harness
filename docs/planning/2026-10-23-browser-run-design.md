# `browser_run` 设计：浏览器编程模式（最初核心诉求）

- 日期：2026-10-23
- 状态：设计（待审计预读）
- 目标：给模型一个**编程模式**入口，用一段 TypeScript 程序完成多步浏览器操作；能力**只来自 helper**，不引入任何新边界。
- 与既有能力的关系：`browser_eval` 仍是"页面内单表达式/短程序"；`browser_run` 是"多步编排"，其 helper 逐个复用现有 runtime 方法与工具语义。

---

## 1. 执行环境（审计点 1）

- 复用上游 `ctx.ptcRuntime`（`@deepseek-ai/dsh-ptc-runtime-node`）：TypeScript、**独立子进程**、默认 120s / 上限 600s、512 MiB heap、64 MiB 输出。
- 宿主侧通过 `RuntimeDeps` 注入一个**受限桥**：脚本只能看到 `browser` 对象（20+ helpers）+ `console` + 语言内建。
- 明确**不可触达**：文件系统、网络、`process`、Electron、CDP、`require`/`import`、宿主对象。
  - 桥接对象是**纯数据 + 方法**，不暴露 `__proto__` 链到宿主；返回给脚本的都是 JSON 值。
  - 脚本内的 `eval`/`Function` 只作用于脚本自身（没有可逃逸的宿主引用）；沙箱逃逸风险按 `ptc-runtime` 既有威胁模型记录，不在本设计里新增进程内 eval 通道。
- 可用性：宿主未注入 ptcRuntime → 工具**fail-loud**（`policy: programming mode is not available in this deployment`），不降级模拟。

## 2. Helper = 现有能力的薄封装（审计点 2）

- 每个 helper 是**同一条 runtime 方法**的调用：预算、用户闸、凭据窗口、脱敏、op log 全部沿用（helper 内部调 `runtime.*`，等价于对应工具）。
- helper 清单（v1，全部已存在）：`open / closeTab / tabs / switchTab / navigate / back / forward / reload / snapshot / text / screenshot / click / dblclick / hover / drag / type / select / press / hotkey / scroll / waitFor / eval / dialog / fileChooser / download / downloads / fetch / emulate / clipboard / history / bookmarks`。
- **一一对应断言**：`HELPER_TO_TOOL` 表把每个 helper 映射到工具名；单测断言"每个 helper 都有对应工具、每个可编程工具都有 helper"，防止 helper 变成隐藏工具或偷偷扩权。
- **负向断言**：helper 表**不得**出现 cookie jar 读取、任意 CDP、`require`、`process`、fs/net 类名字（与 `audit-0921` 同族 tripwire）。
- helper 调用失败 = 抛错（脚本可 try/catch）；错误文案与对应工具一致（policy/not-found/stale-snapshot/timeout）。

## 3. 预算（审计点 3）

| 项 | 值 |
| --- | --- |
| 工具注册预算 | 150s（> 脚本预算，避免上游 timeout 覆盖工具诊断） |
| 脚本总预算 | 120s（`ptcRuntime` 默认），宿主侧 deadline 收紧到 `min(120s, 注册预算-余量)` |
| 单 helper 超时 | 复用各工具/命令预算（CDP 30s、wait_for 55s 等），**不额外放大** |
| helper 调用次数 | 合计 ≤ 200 次（防脚本把浏览器当循环泵） |
| 输出 | 返回值 ≤ 256 KiB（超出截断并标 `truncated`）；console ≤ 64 KiB；总输出 ≤ 64 MiB（ptc 层） |
| abort | 工具 abort → 桥接层立即 reject 所有在途 helper，ptc 进程终止 |

## 4. 数据出口（审计点 4）

- 返回值、console 文本、异常 message/stack 统一过 **`stripSensitiveText` + 该 tab 值集**（与文本出口同口径），再截断。
- 工具结果 schema：`{ result, console, durationMs, helperCalls, truncated }`。
- op log 只记"browser_run 执行了 N 个 helper"，**不记脚本源码**；每个 helper 自己写各自的 op（与工具一致）。

## 5. 安全组别（审计点 5）

- 新组 `script`，**默认启用**（与 `write`/`control` 并列；部署可按组关闭）。
- `isConcurrencySafe:false`；脚本内 helper 走全局 `agentRun`，因此用户闸/接管对每个 helper 生效（接管后第一个 helper 收到 `window-controlled`，脚本按抛错处理）。
- 凭据窗口：helper 复用各工具检查（eval/screenshot 拒绝、其他照常）；`browser_run` 自身不额外放宽。

## 6. 失败模式（审计点 6）

| 场景 | 语义 |
| --- | --- |
| 脚本抛错 | 工具错误，message = 脱敏后的脚本错误 + helper 上下文；码 `policy`（脚本错误不是浏览器错误） |
| helper 报 policy | 原样抛给脚本；脚本未捕获则工具错误里保留原码与文案 |
| 脚本超时 | `timeout`，带 `helperCalls`/最后 helper 名，控制台部分输出随错误文案 |
| 运行中弹 dialog | 后续 helper 按 C1 fail-fast 抛 policy（脚本可 `await browser.dialog(...)` 处理） |
| 运行中用户接管 | 在途 helper 以 `window-controlled` 失败，脚本终止；工具结果说明"用户接管" |
| 结果序列化失败（不可 JSON 化） | 工具错误 `policy`，提示返回值必须是可序列化值 |

## 7. 测试计划与必红变异

- 单测（假 ptcRuntime 注入）：helper→runtime 方法映射（用 spy 断言调用与参数）；`HELPER_TO_TOOL` 完整性与负向断言；预算/次数上限；abort 传播；console/返回值/异常的脱敏与截断；op log 不含脚本；`browser_run` 未注入 ptcRuntime 时 fail-loud。
- 变异：删某个 helper 的 `agentRun` 包装（应红）、helper 表加入 cookie helper（负向断言红）、输出不过脱敏（红）、脚本超时不清进程（红）、`browser_run` 绕过用户闸（红）。

## 8. 工具面与注册

- `browser_run`：工具数 40 → 41；组 `script`；`isConcurrencySafe:false`；`timeoutMs=150_000`（登记到预算表与 0916/c3 注册表）。
- 描述里明确：能力=helper 列表；无 fs/net/process/CDP/cookie；脚本返回值必须可序列化。

---

## 9. 宿主接线状态（2026-10-23）

- ✅ screenshot helper → 宿主 attachment store 返回 ref（无裸 base64 过 4 MiB 桥）。
- ✅ fileChooser helper → 与工具共用 `uploads.ts` 单一真源（downloads dir + `Config.uploadDirs` + session cwd）；脚本 `allowedDirs` 构造上被忽略；端到端用例（真实 chooser + `/etc/passwd` policy 拒绝）。
- ⏳ `attachments` / `sessionCwd` 尚未在 desktop 装配注入 → 生产形态 screenshot helper 仍 policy 拒（登记待办）。
- ⏳ 真实 ptc `spawn` 注入与 `Config → apply → programRuntime` 装配 fixture。
- ⏳ A11/Config 注入行端到端 fixture、真机进程级 R2。

### 第 3 项（真实 ptc）接入契约（待实现）

- 宿主侧已有 `@deepseek-ai/dsh-ptc-runtime` 的 **`PtcRuntime` 服务**（`ptcRuntime` 注入点，`language/isolation/timeout/run/release`）；浏览器包**不自行构造**子进程，而是把该服务适配成 `ProgramRuntime`：
  - `execute(program, bridge, { signal })` → `ptcRuntime.run({ program, bindings: [{ global: 'browser', functions: <桥接函数> }], timeoutMs, signal })`；
  - 返回值 `value` → `result`；`console` → 受控消息通道文本；错误按 code 透传；
  - `release(owner)` 在 run 结束/取消时调用，配合审计要求"真 kill + await exit"（由 ptc 服务自身保证，浏览器包只负责释放与预算）。
- `attachments` 适配：`ctx.attachments.saveImages([{ data, mediaType, name }])` → `store(dataUrl, meta) => ref`，ref 不得含 base64/本地路径，失败要给可读错误。
- `sessionCwd`：`apply(ctx)` 时注入 **执行时快照**（会话 cwd 由宿主在 apply 时提供，或每 run 前读取一次并快照），禁止在运行期读全局可变值。
- 装配 fixture（P3-1）：用 `apply(ctx)` 捕获 runtime，断言 `runtime.options` 等于 `runtimeOptionsForConfig(...)`，并把装配行变异（换回 `{...config}`）变红。
