# C5–C8 设计：指针 / 键盘 / 剪贴板 / 滚动运动学

- 日期：2026-10-23
- 状态：设计（待审计预读出反证清单后开工）
- 目标项：[能力清单](2026-10-23-browser-ai-capability-limits.md) C5–C8
- 前提约束：所有输入仍走 `agentRun`（全局锁 + 用户闸 + 预算）、`isConcurrencySafe:false`；页面可控文本一律过脱敏漏斗；不新增"绕过导航/凭据"的入口。

---

## 1. 现状与缺口

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| 指针 | `browser_click`（左键、单次）、`browser_type`、页面内 DOM 派发兜底 | 无 hover / 双击 / 右键 / 拖拽 / 组合键点击 / 坐标点击 |
| 键盘 | `browser_press` 单键（Enter/Tab/Escape/方向键等白名单） | 无 chord（Ctrl+A）、无 keyDown/keyUp 分离、无逐字延时的 type |
| 剪贴板 | 无 | 读/写剪贴板（Electron `clipboard`） |
| 滚动 | `browser_scroll`（deltaY、target 滚入视野） | 无水平滚动、无绝对位置、无"滚到底/懒加载直到稳定" |

---

## 2. C5 指针

### 2.1 工具面

1. `browser_hover({target, tab?})` → `Input.dispatchMouseEvent{mouseMoved, x, y}`（触发 :hover / mouseenter）。
2. `browser_click` 扩展参数：
   - `modifiers?: Array<'ctrl'|'shift'|'alt'|'meta'>` → CDP `modifiers` 位掩码（1/8/2/4）
   - `button?: 'left'|'right'|'middle'`（默认 left）
   - `clickCount?: integer`（默认 1；2 = 双击）
   - `x?, y?`（可选，坐标点击；给了就跳过 locateElement，仍记录 hit）
3. `browser_dblclick({target, tab?})` → clickCount=2 的 click 序列（等价 click 扩展，但模型友好）。
4. `browser_drag({from, to, tab?})` → 序列：
   `mouseMoved(from)` → `mousePressed(from)` → 多次 `mouseMoved(中间点, buttons=1)` → `mouseMoved(to, buttons=1)` → `mouseReleased(to)`。
   中间点按 CDP 建议插 2–4 个（每步 ~50ms 预算内），并可选 `dataTransfer`（HTML5 拖拽用派发 `DragEvent` 兜底脚本，`DataTransfer` 在页面构造）。
   - 失败语义：from/to 任一解析失败 → `not-found`，不发任何事件。
5. `browser_click({expect})` 沿用 C2 回执。

### 2.2 复用与边界

- 全部走现有 `locateElement`（CSS/定位器/快照锚定）与 `clickAt` 的坐标换算；坐标点击仍限制在视口内（越界 → `policy`）。
- 按下与松开必须成对：内部 `try/finally` 保证 `mouseReleased`，异常路径也发（防页面卡在按下态）；测试断言序列成对。
- `modifiers` 只接受白名单字符串；未知 → 参数错误（不静默忽略）。
- 右键点击不额外弹菜单（CDP 菜单由页面处理；contextmenu 事件会被派发）。

---

## 3. C6 键盘

1. `browser_press` 扩展：
   - `modifiers?: Array<'ctrl'|'shift'|'alt'|'meta'>`
   - `action?: 'press'|'down'|'up'`（默认 press；down/up 必须成对使用，模型责任）
   - `times?: integer`（默认 1，上限 50）
2. 新 `browser_hotkey({keys: string[], tab?})`：按序列按下再逆序松开（如 `['Control','A']` → keyDown Control、keyDown A、keyUp A、keyUp Control）。参数校验：1–4 个键，键名走现有 `normalizeKey` 白名单 + 修饰键集合。
3. `browser_type` 扩展 `delayMs?: integer`（默认 0，上限 100）：逐字符 `Input.insertText`/`dispatchKeyEvent` 二选一：文本用 `insertText` + 每字符间隔 `delayMs`（对 React 受控组件仍走现有读回校验）。
4. 键盘事件仍要求"有接收者"（现有 `pressKey` 的页内判定）；无接收者 → `not-found`。

---

## 4. C7 剪贴板

1. 新工具 `browser_clipboard({action: 'read'|'write', text?, tab?})`。
2. 实现：Electron `clipboard.readText()/writeText()`（主进程能力，session 无关）；通过 adapter 的新可选方法 `readClipboardText?: () => string` / `writeClipboardText?: (text: string) => void` 暴露；adapter 未提供时 fail-loud（`policy: clipboard unavailable in this deployment`）。
3. 安全：`read` 返回值过脱敏漏斗（`stripSensitiveText` + 该 tab 值集 verbatim）；`write` 不接受超过 1 MiB 文本（`policy`）；不自动读剪贴板。
4. 与页面剪贴板的关系诚实说明：这是**系统剪贴板**，不是页面 `navigator.clipboard` 权限；页面 Ctrl+V 粘贴由 C6 的 hotkey 触发、内容来自本工具写入。

---

## 5. C8 滚动

1. `browser_scroll` 扩展：
   - `deltaX?: integer`（水平）
   - `position?: {x, y}`（绝对滚动位置；与 deltaY/deltaX 互斥）
   - `untilBottom?: boolean`（滚到底；每次 1 屏，页内 `scrollHeight` 稳定或到 `scrollY + innerHeight >= scrollHeight` 停止，最多 20 次）
   - `settle?: boolean`（默认 false；true 时滚动后轮询 `scrollHeight` 稳定最多 2s，用于懒加载）
2. 页内脚本保持**常量**：参数走 `Runtime.callFunctionOn` arguments（沿用 wait_for 的恒等方法），不拼接模型输入。
3. `untilBottom` 的每次滚动之间 sleep 100ms（可 abort）；总预算受工具 30s 限制，超过 20 次即停并返回 `reachedBottom:false`（诚实）。
4. target 滚入视野保持现有语义；`position` 与 `target` 互斥（参数错误）。

---

## 6. 错误码

| 场景 | 码 |
| --- | --- |
| 目标/坐标越界、未知 modifier/键名、互斥参数 | `policy`（参数级）或工具参数错误 |
| hover/drag 目标不存在 | `not-found`（无副作用） |
| 键盘无接收者 | `not-found` |
| clipboard 不可用 / >1 MiB | `policy` |
| untilBottom 未到底 | 成功返回 `reachedBottom:false`（不是失败） |

---

## 7. 测试计划

| 层 | 用例 |
| --- | --- |
| 单元（mock CDP） | modifiers 位掩码；click 序列 button/clickCount；hover 只发 mouseMoved；drag 序列成对 + 中间点；异常路径也发 release；hotkey 按下/松开逆序；press down/up/times；type delay；clipboard read 脱敏/write 上限；scroll deltaX/position 互斥/untilBottom 20 次上限 |
| 回归 | 现有 click/type/press/scroll 语义与快照锚定不变 |
| 预算 | 所有新等待（untilBottom/settle/delay 总时长）≤ 工具预算 - 余量；`press times` 上限 |

---

## 8. 反证清单（交给审计）

1. **成对性**：dragging/`down` 路径异常时是否仍发 release/up（删 finally 必红）。
2. **modifiers 位掩码**：ctrl=2?（CDP: Alt=1, Ctrl=2, Meta=4, Shift=8）——写错会让组合键变成普通点击，用例要逐位断言。
3. **坐标越界/参数互斥**：不静默忽略（position+target、position+delta、未知 modifier、超长 keys）。
4. **无副作用失败**：hover/drag 目标不存在时 CDP 命令数为 0。
5. **剪贴板脱敏**：注入 secret 后 read 返回 `****`；write >1 MiB 拒绝且未写。
6. **untilBottom 诚实**：未到底返回 `reachedBottom:false`，不谎报。
7. **预算**：untilBottom 20 次 × 间隔 + settle 2s < 30s；超时由工具自己的结果表达。
8. **页面脚本无拼接**：scroll 参数作为 CDP arguments；删常量谓词改拼接必红（bad-code-sanitization 面）。

---

## 9. 里程碑

| 里程碑 | 内容 |
| --- | --- |
| P1 指针 | ✅ hover / click 扩展（modifiers/button/clickCount/x,y）/ dblclick（两对 1,1,2,2）/ drag（指针模式，异常也 release） |
| P2 键盘 | ✅ press{modifiers,action,times} + heldKeys 账本 + hotkey（保留组合 denylist）+ type{delayMs} 总延迟 5s 封顶 |
| P3 剪贴板 | ✅ clipboard read(64KiB 截断)/write(1MiB 上限)，adapter 可选方法，不可用 fail-loud |
| P4 滚动 | ✅ deltaX / position（返回实际 scrollX/Y）/ untilBottom（≤20 步、每步检查 abort、`bottomReason` 区分 reached/no-progress/step-limit）/ settle |
