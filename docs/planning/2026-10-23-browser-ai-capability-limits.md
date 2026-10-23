# 限制 AI 能力的浏览器功能清单（可删）

- 日期：2026-10-23
- 目的：把「**限制 AI 能力的浏览器功能**」单独拉出来，供逐条决定删/放宽/留。
- 口径：
  - **计入**：让 AI 做不成它本来能做的事 —— 拒绝（reject）、截断（truncate）、降级（degrade）、以及**根本没提供**的能力（absent）。
  - **不计入**：纯用户侧的产品形态。**蒙版与用户闸按你的要求保留**（§6），但它们带来的间接限制（如 AI 不能自我解除、整窗暂停）仍在 §3 的 A17 / §5 的 D1–D2 里如实列出。
- 与其它材料的关系：
  - 全量拦截清单（含安全/脱敏/壳页，52 项）：[2026-10-23-browser-gate-inventory.md](2026-10-23-browser-gate-inventory.md)
  - 编程模式方案：[2026-10-23-browser-code-mode-plan.md](2026-10-23-browser-code-mode-plan.md)（**本清单的删除项是 `browser_run` 里 `eval` helper 能否好用的前提**）

## 0. 进度（滚动更新）

| 批次 | 项 | 状态 |
| --- | --- | --- |
| B1 | A1–A5（eval 允许多语句/赋值/正常 API/放宽结果上限，只拦页面破坏面） | ✅ 完成；**审计 P0 已收口**：静态层补裸 `location=`、`call/apply/bind` 解包、`window.eval`/`constructor.constructor`、反射走私、`cookieStore`、破坏宿主动态成员；运行时层加页面 shim（document/storage/history/location/cookie setter/eval/Function，finally 还原）。61 文件 / 1070 tests 绿 |
| B2 | A9 清全部数据、A12 下载上限 2GiB、B1 快照 400、B2 元素文本 200、B3 文本 64KiB | ✅ 完成；审计 P1 已补回归用例（下载阈值三态、初始超限 rejected、快照默认 400、truncated 第二分支），默认装配改为 400/64KiB |
| B3 | C13 定位器（`@N/ref=`、`css=`、`text=`（引号=精确）、`role=`、`loc=role:/css:/href:`、`xpath=`）、B6 `get_text` 定位器、C9 select（value/label/index/多选/clear）、C14 wait（`url-match` + `function`） | ✅ 完成 + 两轮审计收口（shadow 唯一性、候选脱敏、select 同名 fail-loud、`$` 注入、单一真源、wait 真值语义；jsdom 页面行为用例 14 例 + 生产路径单源用例）。63 文件 / 1122 tests 绿 |
| B4（进行中） | C1 对话框（M1 完成）：事件接线 + `browser_dialog` + 双层 fail-fast（CDP choke point + 导航家族）+ 三出口 dismiss + url/defaultPrompt 脱敏 | ✅ M1（63 files / 1135 tests；严格 20 入口矩阵 + CDP hook 单测 + 在途命令中止）|
| B5（进行中） | C2 回执（popup/download/dialog/file-chooser 事件总线 + `expect`）、C3 文件选择器、C4 下载生命周期 | ✅ M2–M4（65 files / 1176 tests，33 工具；`check` EXIT=0） |
| B6（进行中） | C5–C8：指针（hover/dblclick/drag/modifiers）、键盘（heldKeys/hotkey/delay）、剪贴板、滚动运动学 | ✅ 38 工具；65 files / 1191 tests，EXIT=0；真机探针待跑 |
| C15 | `browser_emulate`（viewport/UA clamp、reset、per-tab、op log）✅；**cookie 管理留拒**（`audit-0921` ③ 禁止 src 出现 cookie 搬运通道，属安全不变量，已按方案 A 裁决） | ✅ 部分交付（40 工具；69 files / 1238 tests） |
| A14 | 本机地址灰名单：**维持「一律拒」**（审计建议：灰名单不可预测、每个放行点都是 SSRF/凭据外泄面；若产品确需本地自动化，须显式部署级 host:port allowlist + DNS rebinding 防护，不能做后缀匹配）。用户拍板前保持现状 | ✅ 维持现状（零代码改动，已记录裁决） |
| A11 | 上传目录部署级可配：`Config.uploadDirs`（schemastery `.default([])`）→ runtime 选项 → `uploadAllowDirs`（downloadDir ∪ uploadDirs ∪ session cwd，去重、去尾斜杠、拒绝 `/` 与相对路径）；**权限面**：这些目录下任意文件都可被上传（递归信任），模型/脚本不得提供目录 | ✅ 完成（config→runtime 路径有用例） |
| D2 | 标签配额：`capacity.ts` 从可用内存派生（192MiB/tab、0.5 份额、[4,32]、cgroup memory.max 夹取），`TabPool` 与 surface 共用上限；**配额（maxTabs）与槽位等待速率（tabSlotWaitTimeoutMs）可分别配置** | ✅ 完成（含 N/N+1、close 释放、回滚不占槽、cgroup 合成用例） |
| 待办 | A11/A14/A16（A16 已完成寻址）、B4/B5/B7、C10/C12/C15/C16、D1–D3、browser_run | 排队（C1–C9/C13/C14 已完成并提交 e9d8ceb；下一批 C16/B4/B5/C10/C12/C15 按审计 R1–R4 口径推进） |

> 每批完成后由 `red-team-auditor` 做反证审计（改回旧行为必须变红 / 对抗绕过 / 误杀检查），报告在 `temp/audit/`。

**延迟导航（2026-10-23 审计 P2-④，接受为已知边界）**：`setTimeout(() => { x.href='https://evil' }, 0)` 这类**eval 返回之后**才发生的导航不受 in-flight 闸约束 —— 闸只覆盖 evaluate 在途窗口。理由：页面本来就能自己导航（meta refresh/链接/延时脚本），这不是 eval 新开的口子；若将来要收紧，方向是「把导航闸的判定从 in-flight 窗口扩展为『本 tab 最近一次 eval 的来源标记』」，成本高且会误伤正常页面。

**已知边界（双层实现后仍不在护栏内，已写进测试注释）**：① 调用前就被页面捕获的 `location`/`Storage` 引用；② 同文档 fragment 变化（`location.hash`，不产生跨文档导航）；③ eval 执行窗口内页面自身定时器触碰 shim 会被打断（≤ 一次 eval）。`location` 的 enforcement = AST（直接/别名/descriptor）+ 运行时导航闸（`evalInFlight` 期间顶层导航一律拒）；`Storage` 属性写 = window getter Proxy。

---

## 1. 你举的那一类：`browser_eval` 被拒的完整拆解

> 你的原话是「执行某个页面的 eval 被执行拦截」。它不是一条规则，而是**六条叠在一起**，所以删的时候要逐条删，否则模型换个写法还会被拒。

| # | 规则 | 现状 | 证据 |
| --- | --- | --- | --- |
| A1 | **只允许一条「表达式」** | 包装成 `(${code})` 后用 acorn 解析，要求 Program 里恰好一条 ExpressionStatement；写 `return`/多条语句/`if`/`for` 一律拒 | `src/eval-policy.ts:309-320,639-649` |
| A2 | **禁止赋值与声明** | `x = 1`、`const x = …`、`let`、`var`、`++`、`+=` 全拒 → 无法保存中间结果、无法逐步处理数据 | `src/eval-policy.ts:323-396` |
| A3 | **禁止 62 个 API 名字** | 名单里有真正危险项（`location.assign`、`history.pushState`、`localStorage.setItem`、`document.write`、`submit`、`execCommand`），也有**纯数据/正常页面操作**：`sort`、`fill`、`push`、`pop`、`splice`、`focus`、`click`、`scrollIntoView`、`scrollTo`、`setTimeout`、`addEventListener`、`setAttribute`……（`replace` 仅对字符串接收者豁免） | `src/eval-policy.ts:81-160,164-206` |
| A4 | **禁止 `new` / `eval` / `Function` / `with` / `Reflect.construct`** | 构造器与动态求值全拒；`Reflect.apply/get` 目标必须静态可知 | `src/eval-policy.ts:587-636` |
| A5 | **大小与结构上限** | 表达式 ≤8192 字符；返回 ≤8KiB、JSON 深度 6、数组 64 项、对象 128 键 | `src/eval-policy.ts:53-59,733-755` |
| A6 | **结果只能是 JSON/字符串** | 不能返回 DOM 节点、Node 对象；元素属性要走 `readText/readAttr` 或字符串方法 | `src/eval-policy.ts:733-755` |

**结论**：现在模型连「`[...document.querySelectorAll('a')].map(x => x.href).join('\n')`」这种纯读取都要绕（`map` 允许，但排序/去重/累加这类需要 `sort`/`push`/赋值的都做不了）。**这一组建议整体删掉**，改成「只拦真正的页面破坏面」（见 §8 的 P0-1 落地建议）。

---

## 2. 清单总览

| 组 | 主题 | 项数 | 删掉的收益 | 删掉的代价 |
| --- | --- | --- | --- | --- |
| A | **直接拒绝 AI 动作** | 17 | AI 不再被无谓地拒 | 少部分是不可逆/安全问题（逐条标注） |
| B | **截断 / 降级** | 7 | 大页面/长文本能取全 | token 与上下文压力上升 |
| C | **根本没提供的能力** | 16 | 复杂网页任务从"做不了"变"能做" | 纯新增功能，工作量最大 |
| D | **资源 / 并发限制** | 5 | 快、能并行 | 内存/性能/稳定性 |
| 合计 | | **45** | | |

图例：影响 = 对 AI 日常干活的阻碍（高/中/低）；成本 = S(1–2 天) / M(3–5 天) / L(1–2 周+)；建议 = **删** / **放宽** / **留**（留 = 删了有具体风险，见 §7）。

---

## 3. A 组：直接拒绝（17 项）

| # | 功能 | 现状 | 删掉的收益 | 影响 | 成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | eval 只允许单表达式 | 见 §1 | 能写小段逻辑（变量、循环、条件） | 高 | S | **删**（改为"允许多语句，只拦破坏面"） |
| A2 | eval 禁赋值/声明 | 见 §1 | 能累加、能去重、能分页抽取 | 高 | S | **删** |
| A3 | eval 禁 62 个 API 名 | 见 §1 | `sort`/`focus`/`scrollIntoView`/`setTimeout` 等正常操作可用 | 高 | S | **删**（名单缩到真正的破坏面：导航、cookie/storage 写、`document.write`、表单 submit） |
| A4 | eval 禁 `new`/`Function`/`with`/`Reflect.construct` | 见 §1 | 能构造日期/Map/Set、能动态取值 | 中 | S | **放宽**（`new Date()`/`new Map()` 应放行；`Function`/`eval` 可留拒） |
| A5 | eval 结果 8KiB / 深度 6 / 64 项 / 128 键 | 抽 200 条数据会被截断成 64 条 | 一次取全 | 中 | S | **放宽**（按模型上下文调，或改由脚本分页/落盘） |
| A6 | eval 结果只能 JSON | 不能返回 DOM/Node 对象 | 少量写法受限 | 低 | M | **留**（JSON 边界是 PTC/工具契约需要） |
| A7 | eval 在凭据窗口内整体拒绝 | 注入密码后、该 tab 导航前 `browser_eval` 全拒 | 注入后还能继续用 eval 干活 | 中 | S | **留**（见 §7；可给"我确认"一次性开关） |
| A8 | eval 的 `frame:N` 在帧映射不唯一时拒绝 | DOM 序与 CDP 帧无法 1:1 时直接报错 | 复杂 iframe 页面能用 eval | 中 | M | **放宽**（给出候选帧清单让模型选，而不是拒绝） |
| A9 | `clear_data all-data` 被拒 | 只能清本会话数据；清全部要去菜单确认 | AI 能自己清全部登录态 | 低 | S | **删**（你本地信任；建议保留 op log 提示） |
| A10 | `fill_credentials` 只在连接器自己 origin 注入 | 目标站点与连接器记录不符即拒 | 少跳一次页面也能登录 | 中 | S | **留**（防钓鱼站点骗密码，见 §7） |
| A11 | 上传路径白名单（下载目录 + 会话 cwd） | 别的路径一律拒 | 能上传任意本地文件 | 中 | S | **放宽**（加"用户显式选择的目录"，不建议全开） |
| A12 | 下载 >100MB 自动取消 | 大文件直接 cancel | 能下载大文件 | 中 | S | **放宽**到 1–2GB 或按磁盘余量 |
| A13 | 导航 scheme 白名单（只 http/https/about） | `javascript:`/`data:`/`file:` 拒 | 能打开本地 HTML、能跑 data URL | 中 | S | **留**（`file://` 可读本机文件，见 §7） |
| A14 | 本机地址一刀切禁导航 | 127/8、`localhost`、`::1` 全拒 | 能调试本地 dev server | 高（本地开发时） | M | **放宽**为灰名单（只放行非应用端口；见 §7 风险） |
| A15 | 导航 URL >8192 拒绝 | 超长 URL 拒 | 几乎无感 | 低 | S | **留**（数据外带通道） |
| A16 | 应用窗口只能显式寻址：`navigateAppSurface` 只收 `kind:'app'`、per-surface 用户闸、自身 origin + 本机目标拒绝；其余工具收到 `app_id` fail-loud；**已完成（仅 navigate 寻址；点击/输入等动作语义仍留拒）** | ✅ 完成（`audit-0921-app-surface-target` 21 tests / 63 assertions） |
| A16（原条目） | 应用窗口只能被 `browser_navigate` 寻址 | 其它工具对 `app_id` 一律拒 | 能在应用窗口里点/输入 | 中 | M | **已完成寻址部分**；点击/输入等动作语义仍留拒（原因：应用窗内容由 wasm-apps-host 持有，动作语义需另批设计） |
| A17 | 模型不能自我解除用户闸（`browser_release` 已删） | AI 交权后只能等用户点「交给 AI」 | AI 可在用户离开后继续 | 中 | S | **随蒙版保留**（你要求保留蒙版；这条是它的直接后果） |

---

## 4. B 组：截断 / 降级（7 项）

| # | 功能 | 现状 | 删掉的收益 | 影响 | 成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 快照最多 200 个元素（硬顶 2000） | 超出报 `truncated/total` | 一张大列表不再要分页取 | 高 | S | **放宽**（300–500 或按模型上下文） |
| B2 | 单个元素文本 80 字符 | 超出截断 | 长按钮/长选项文字看得全 | 中 | S | **放宽**（128–200） |
| B3 | 页面文本 32KiB | 超出截断 | 长文档能一次读完 | 中 | S | **放宽**（或改由 `browser_run` 分块+落盘） |
| B4 | 快照**不含** iframe / shadow DOM 内容 | 只报数量并提示用 eval | 常见后台站（嵌套 iframe、Web Components）能直接看到 | **高** | M–L | **补**（这是能力缺口，不是删规则） |
| B5 | 截图只有视口、宽 1280、JPEG 70 | 无全页、无裁剪、无高清 | 长页面一屏装不下 | 中 | M | **放宽**（加 `fullPage`/`clip`/更高宽） |
| B6 | `get_text` 只接受 CSS 选择器 | 无 XPath/文本定位 | 少写一次 eval | 低 | S | **放宽**（支持 `text=`/XPath） |
| B7 | `history_search` 无会话/来源过滤 | `group` 字段恒空、过滤参数未实现 | 能按会话查历史 | 低 | S | **补**（降级项，见审计 G3） |

---

## 5. C 组：根本没提供的能力（16 项）——**这组才是"AI 干不了活"的主因**

| # | 能力 | 现在能怎么绕过 | 缺它的后果 | 影响 | 成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | **同步对话框**（alert/confirm/prompt） | 无（页面一弹就没有工具能应答） | 一个 `confirm()` 就能把工具拖到超时；用户必须手动点 | **高** | M | **补**（见对比文档 §4.4） |
| C2 | **弹窗（popup）等待与回执** | 只能事后 `list_tabs` 找 | `target=_blank` 流程容易断 | 高 | M | **补** |
| C3 | **文件选择器**（点击触发的上传） | 只能直接 `browser_upload_file` | 门户类上传按钮点了没反应 | 高 | M | **补** |
| C4 | **下载生命周期**（等下载完成/另存/取消/删除） | 只有「触发下载 + 列记录」 | 下载后不知道文件在哪、有没有成功 | 中 | M | **补** |
| C5 | **悬浮/双击/拖放** | 只能单击 | 悬浮菜单、看 tooltip、拖拽排序全做不了 | **高** | M | **补** |
| C6 | **键盘和弦 / 按住 / 逐字 / 粘贴** | 只能单键 press（11 个键名） | Ctrl+A、Shift+Tab、Ctrl+Enter、富文本粘贴全做不了 | **高** | M | **补** |
| C7 | **剪贴板** | 无 | 跨页复制、粘贴表格/富文本做不了 | 中 | M | **补** |
| C8 | **滚轮运动学 / 横向滚动 / 滚到底** | 只能 `deltaY` 一锤子 | 懒加载列表、横向表格、虚拟滚动不触发 | 中 | M | **补** |
| C9 | **`select` 按 label / 序号 / 多选 / 清空** | 只能按 value | 选项 value 与可见文字不一致时选不中 | 中 | S | **补** |
| C10 | **页面内 `fetch`** | 只能 eval 里写（A1–A4 又拦着） | 调页面自身 API（带 cookie）很别扭 | 中 | S | **补** |
| C11 | **raw CDP** | 无 | 诊断/特殊能力（网络、性能、DOM 域）无出路 | 中 | L | **留拒**（会绕过几乎所有边界，见 §7） |
| C12 | **全页截图 / 裁剪截图** | 只有视口 | 长页面要拼接 | 中 | M | **补**（同 B5） |
| C13 | **定位器：`text=` / `role=` / `xpath=` / Playwright 子集** | 只有快照编号 + CSS | 选择器写不出来的元素只能靠编号猜 | **高** | M | **补** |
| C14 | **`waitForFunction` / URL glob / 精细 networkidle** | 只有 6 种条件 | SPA 等待要靠固定 sleep | 中 | S | **补** |
| C15 | **视口/UA/设备模拟/cookie 管理** | 无 | 响应式页面、登录态注入做不了 | 中 | L | **补**（按需求排期） |
| C16 | **iframe 内直接动作**（不经过 eval） | 只能 `browser_eval(frame:N)` | 嵌套后台站点的按钮点不到 | **高** | L | **补**（同 B4） |

---

## 6. D 组：资源 / 并发限制（5 项）

| # | 限制 | 现状 | 删掉/放宽的收益 | 影响 | 成本 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | **全局串行锁** | 同一时刻只有一个 AI 浏览器操作 | 多会话/多任务并行 | 高 | L | **放宽**为"每 tab 一把锁" |
| D2 | 标签配额 16 + 槽位等 5s | 池满即等/失败 | 多标签任务不受限 | 中 | S | **放宽**（32 或按内存） |
| D3 | 单工具 30s / `wait_for` 55s / 导航内部 14s | 长任务被切 | 长加载页面不必重试 | 中 | M | **放宽**（与 `browser_run` 的 120s 统一规划） |
| D4 | 排队预算（1s 余量） | 排队太久即失败 | 高并发下更稳 | 低 | S | **留**（删了会变成无限等） |
| D5 | 快照 shadow 扫描上限 20000 节点 | 超大页面只报下限 | 极端页面看得全 | 低 | S | **留** |

---

## 7. 你已明确保留 / 我不建议删的（删了有具体攻击路径）

| 类别 | 项 | 为什么 |
| --- | --- | --- |
| **你已明确保留** | 蒙版（默认整窗覆盖）、用户闸（10s 等待 + `awaitingRelease`）、三档提示 | 产品形态；本清单不把它们当"限制 AI 能力"处理（A17 是它的直接后果） |
| **凭据面** | A7 凭据窗口、A10 站点绑定、值级擦除（gate 清单 C1–C4） | 防的是**被注入的网页**读回密码再外带；"本地信任"信任的是你和我，不是 AI 打开的那个页面 |
| **危险导航** | A13 `file:`/`javascript:`、A14 本机地址（可改灰名单）、A15 URL 长度 | `file:` 可读本机文件；本机地址能打到应用自己的 loopback 写面（`dsh-auth-*` same-site cookie） |
| **代码面** | C11 raw CDP | 能清 cookie、改权限、开新 target，等于绕过上面所有项 |
| **本地回环** | 写面持有性证明（gate 清单 G1） | 与 AI 无关：防任意网页调本机管理 API |
| **系统权限** | 摄像头/麦克风/定位一律拒绝 | AI 浏览器用不到；真需要用户手动授权 |

---

## 8. 建议的删除顺序（按"干活收益 ÷ 成本"）

| 优先级 | 内容 | 为什么先做 | 成本合计 |
| --- | --- | --- | --- |
| **P0** | **A1–A5**（eval 策略整体重写：允许多语句/赋值/正常 API，只拦页面破坏面） | 这是你点名的那个问题；且是 `browser_run` 里 `eval` helper 能用的前提 | ~2–3 天 |
| **P0** | **C1/C2/C3/C5/C6/C13**（对话框、弹窗回执、文件选择器、悬浮/双击/拖放、键盘和弦/粘贴、定位器扩展） | 这 6 项是"网页做不了"的主因，且互相独立可并行 | ~2 周 |
| **P1** | A9、A11、A12、A14（灰名单）、B1–B3、C4、C8、C9、C10、C14 | 体验与吞吐的明显改善，单项都不大 | ~1 周 |
| **P1** | B4/C16（iframe/shadow 快照与动作）、B5/C12（全页截图） | 结构性能力，需要改快照探针 | ~2 周 |
| **P2** | D1（锁粒度）、D2、D3、A16、C7、C15 | 并发与长尾能力 | 按需 |

**落地建议（P0-1 的具体形态）**：把 `eval` 从「AST 白名单/黑名单」改成「**只拦破坏面 + 凭据窗口**」：
- 允许：多语句、赋值、`new`（`Date/Map/Set/RegExp` 等）、`sort/push/filter`、`focus/click/scrollIntoView`（让页面自己响应，本来就是 AI 该能做的）；
- 仍拦：`location`/`history` 导航、`document.write`、`cookie`/`storage` 写、表单 `submit`、`eval`/`Function`、以及凭据窗口内的任何 eval（A7）；
- 结果上限（A5）改为"按模型上下文动态"，超出时**返回截断标记**而不是拒绝；
- 删掉之后，`browser_eval` 的护栏定位仍要写清楚：**它不是安全边界**（现在文档已经这么写），真正边界是凭据窗口 + 导航策略 + 凭据掩码。

---

## 9. 与编程模式（`browser_run`）的关系

| 关系 | 说明 |
| --- | --- |
| 两条路互补 | **删 A1–A5** 让"单步能力完整"；**加 `browser_run`** 让"多步合成一次"。只做前者，长流程仍要很多往返；只做后者，脚本里的 `eval` 仍被子集规则拦住。 |
| 依赖顺序 | 建议先删 A1–A5（低成本、收益立现），再做 `browser_run`（M1 骨架），两者不冲突 |
| 不互相替代 | `browser_run` 不给 raw CDP（C11 仍留拒）、不给用户闸解除（A17 随蒙版）、不给应用窗口寻址（A16 另议） |
