# C16/B4/B5/C10/C12/C15 设计：iframe/shadow、全页截图、page.fetch、模拟与 cookie

- 日期：2026-10-23
- 状态：设计（待审计预读）
- 目标项：[能力清单](2026-10-23-browser-ai-capability-limits.md) C16/B4/B5/C10/C12/C15
- 约束：所有入口走 `agentRun`（全局锁 + 用户闸 + 预算）；页面可控文本/值一律脱敏；不新增绕过导航/凭据的入口（C11 raw CDP 继续留拒）。

---

## 1. B4/C16：iframe 与 shadow DOM

### 1.1 快照

`browser_get_snapshot` 扩展（默认保持现有行为，新增参数）：

| 参数 | 默认 | 语义 |
| --- | --- | --- |
| `includeFrames` | true | 同源 iframe 的内容**内联**进快照，条目带 `frame: N`（N = 0 主帧，1.. 按 DOM 顺序） |
| `includeShadow` | true | open shadow root 的内容展开，选择器用 `>>>`（如 `my-card >>> button`） |
| `frame` | 0 | 只拍某一帧（与 includeFrames 互斥） |

- **默认值（审计 R1）**：`includeFrames` / `includeShadow` 默认 **false**（显式开启）——默认参数下快照输出与 2026-10-23 之前**逐字节一致**，编号/stale/400 上限的既有语义不变；开启后新增条目追加在既有条目之后（主帧优先、shadow 紧随宿主、同源子帧最后），因此旧编号不会重排。
- 截断优先级：主帧文档序 → shadow（宿主处）→ 同源子帧（1..）；达到上限时先截断列表尾部并报 `truncated`。
- **并入后的盲区语义（P1 复审 P2-1）**：开启 extras 后，被覆盖的 frames/shadowRoots 从 note 的 "NOT included" 计数中移除；仍存在的盲区（`nestedFrames` 只数顶层帧、跨域帧 `crossOriginFrames`）单独列出。
- **frame 条目的 visible**：以**帧内**元素的 rect 为准（iframe 自身被隐藏时条目仍可能是 visible:true）；`frame:N` 只数顶层帧。
- 跨域 iframe：**不含** DOM（协议不允许跨世界读取），只报 `crossOrigin: true` 与 frame 序号。**不承诺** `browser_eval(frame:N)` 能进跨域帧的 world，除非实现前确认（审计 R2；确认前文档只写"看 crossOrigin，动作会被拒绝"）。crossOrigin 判定用帧 document 的实际 origin（srcdoc/blob/data/about:blank 继承、sandbox 无 allow-same-origin → 跨源），**异常一律 fail-closed 视为跨源**。
- 条目形状新增可选字段：`frame?: number`、`shadow?: boolean`；不改变既有字段名。
- 上限：条目总数沿用 `snapshotLimit`（400 默认）；帧内条目计入同一上限；shadow 深度上限 8。

### 1.2 动作

- `browser_click/type/select/hover/scroll/get_text` 新增 `frame?: number`（默认 0）；解析与执行都在该帧上下文。
- 选择器支持 `>>>` 穿透 open shadow root（`locator.ts` 的 probe 与 `locateElement` 同步支持）。
- 快照编号仍锚定"上次快照"，但编号现在可指向 `(frame, shadowPath)`：点击时按记录还原，stale 判定沿用现有机制。
- 跨域帧的动作：`policy`（"cross-origin frame cannot be automated from the main world; use browser_eval(frame:N) which runs in that frame's own world"）。

---

## 2. B5/C12：全页 / 裁剪截图

`browser_screenshot` 新增参数：

| 参数 | 语义 |
| --- | --- |
| `fullPage?: boolean` | 用 `Page.captureScreenshot{captureBeyondViewport:true}` 抓整页 |
| `clip?: {x,y,width,height}` | 裁剪区域（与 fullPage 互斥） |
| `format?: 'png' \| 'jpeg'`（默认 jpeg）、`quality?: 1..100`（默认 70） |

- 凭证窗口内仍拒绝（既有语义）。
- 尺寸上限：输出字节 ≤ 8 MiB；超限降 quality 一次，仍超则 `policy`（不静默截断）。
- 全页截图失败时回退到视口截图并**如实**标注 `fullPage:false`（不谎报）。

---

## 3. C10：`browser_fetch`

新工具 `browser_fetch({url, method?, headers?, body?, credentialSite?})`：

- 在页面主世界执行 `fetch(url, {credentials:'include'})`，因此带上该站点 cookie；不许导航。
- 参数与结果都走 `Runtime.callFunctionOn` 常量谓词（不拼接模型输入）。
- 返回：`{status, ok, headers, body, bytes, truncated}`；body cap 1 MiB、字符串 cap 256 KiB；headers 只回 `content-type/content-length` 等白名单键（不回声敏感头）。
- 安全：URL 仍走现有导航策略（禁止 shell origin / 本机敏感地址）；响应体过脱敏漏斗；`method` 白名单 GET/POST/PUT/PATCH/DELETE，`body` ≤ 256 KiB。
- 与 `eval` 的差别：这是"带认证的页面内请求"的明确入口，不替代任意脚本。

---

## 4. C15：视口/UA 模拟与 cookie

### 4.1 `browser_emulate`

`browser_emulate({viewport?:{width,height,deviceScaleFactor?,mobile?}, userAgent?: string, reset?: boolean})`

- viewport → `Emulation.setDeviceMetricsOverride`；UA → `Emulation.setUserAgentOverride`；`reset:true` 清两者。
- **fullPage × emulate（审计 R4）**：`fullPage` 截图在 override 生效时先 **clear override → captureBeyondViewport → restore override**，并在用例里断言 clear/restore 成对；emulate 后的坐标点击另有用例（坐标以模拟视口计）。
- 边界：width/height ∈ [200, 4096]；只影响该 tab；op log 记录（模拟状态是模型可观察的）。
- 切 tab / 导航不重置（与 Chrome DevTools 行为一致）；`browser_close_tab` 自然清理。

### 4.2 `browser_cookies`

`browser_cookies({action: 'list'|'set'|'remove', domain?, name?, value?, path?, secure?, httpOnly?, sameSite?, expires?})`

- 走 Electron `session.cookies`（get/set/remove），按当前 tab 的 partition。
- **list 的 value 一律打码**（`****`），只回 name/domain/path/expires/secure/httpOnly/sameSite；整体再过 `stripSensitiveText`，name/domain cap 256 字符、条数 cap 200；`browser_cookies` 永不回显 cookie 值。文档写清：这是**主进程能力**，不是页面 `document.cookie` 权限。
- set 只允许写当前 tab 的站点（domain 必须是当前 origin 的域或子域），value ≤ 4 KiB；remove 按 name+domain。
- HttpOnly cookie 不可被页面脚本读，但本工具是主进程能力——因此 set/remove 记 op log，list 打码。

---

## 5. 预算与错误

| 项 | 值 |
| --- | --- |
| 快照帧/shadow 扩展 | 不新增等待，沿用 30s 工具预算 |
| 截图 | 30s；输出 ≤8 MiB |
| fetch | 30s；body ≤1 MiB |
| emulate/cookies | 30s |
| 错误码 | 跨域帧动作 `policy`；fetch 导航类 URL `policy`；cookie 域越界 `policy`；截图超限 `policy` |

---

## 6. 测试计划

| 层 | 用例 |
| --- | --- |
| 快照 | 同源 iframe 内联 + frame 号；open shadow 展开 + `>>>` 选择器；跨域帧只报 crossOrigin；上限/深度 |
| 动作 | click/type in frame N；`>>>` 选择器命中 shadow 内元素；跨域帧动作 policy |
| 截图 | fullPage 参数传入 CDP；clip 与 fullPage 互斥；超 8 MiB 降 quality 一次；凭证窗口拒绝保持不变 |
| fetch | 常量谓词（不拼 URL）；status/headers 白名单；body 截断；导航类 URL 拒绝 |
| emulate | 参数范围；reset；op log |
| cookies | list 全打码；set 域越界拒绝；remove 精确匹配 |
| 回归 | 现有 1193 用例全绿；快照编号锚定语义不变 |

---

## 7. 反证清单

1. **跨域帧**：动作不可用、快照不含其 DOM、但报 crossOrigin —— 删任一必红。
2. **shadow 穿透**：`>>>` 在 probe 与动作两条路径一致（唯一命中规则沿用 C13）。
3. **打码不变式**：cookies list / fetch body / 快照文本的敏感值均不回流（注入 secret 断言 `****`）。
4. **不谎报**：fullPage 失败回退时 `fullPage:false`；fetch truncated 标记；截图超限 policy。
5. **参数互斥**：fullPage×clip、frame×includeFrames、reset×其它。
6. **页面脚本无拼接**：fetch/emulate 一律 `callFunctionOn` arguments。
7. **模拟状态可观察**：op log 有记录，切 tab 不串。
