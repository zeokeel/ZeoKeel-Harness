# WASM 应用平台「功能不合理」审计汇总（2026-10-22）

- 基线：`master` @ `1143238ca9`（`release: v2.9.1`）
- 性质：**只读审计 + 规划**。本轮**未修改任何产品代码/配置**；本文是唯一入库交付物。
- 需求来源（用户原话）：「检查一下 WASM 的功能，还有很多功能做的不合理。」
- 口径：找**功能做的不合理**（死功能 / 断头路 / 语义矛盾 / 约束与目的错配 /
  默认可怕 / 反馈缺失误导 / 手工税 / 不可逆无回退 / 双源漂移 / 度量自欺），
  **不是安全漏洞复审**（安全已多轮审计）。每一条都给 `文件:行号` 或可复跑命令；
  区分「有实现」与「真的生效」（零生产调用点 = 死功能，本仓历史高发形态）。
- 子报告（只读、含完整证据链与复现命令，均在 `temp/wasm-audit-2026-10-22/`）：
  - `lane-a-server.md`：服务端运行时/工具链（`server/internal/wasmapp/**`、limits、skill、脚本）
  - `lane-b-client.md`：客户端与宿主产品行为（`packages/client/wasm-apps`、`packages/host/wasm-apps-host`）
  - `lane-c-admin.md`：管理端/运营/生命周期/限额控制台（`server/webadmin`、管理面 api）

## 0. 结论摘要

1. **平台主体是能用的**：应用中心、打开/深链、发布、上下架、缓存、数据面板、作者
   schema/rows、AI 工具、限额控制台、审核队列、打开计数、AI 归因都有真实实现与判据；
   2026-09-21 审计登记的 P0 级服务端问题（OOM、DataCount、`.debug_*`、`sock_*`、
   诊断里的 `db_rows`、本地真 SQLite 预览）在 HEAD 上**已闭合**。
2. **但「功能不合理」确实成批存在**，集中在四个面：
   - **承诺与实现分叉**：冻结/退役承诺「只读快照 + 90 天保留 + 到期真删」，
     两个后台任务代码里自己写着**未实现**，而 UI、测试、审计链、作者可读 limits 表
     四处都在承诺它；
   - **动作面缺一半**：管理端有「已删除」筛选却**没有删除/恢复动作**，没有导出、
     没有版本回滚、没有 per-app 限流；只有冻结一个「全组织停服」的核选项；
   - **断头路/死接线**：客户端详情页「应用 AI」发送按钮 **100% 必失败**（P0）；
     应用窗口错误页没有任何自救按钮；下架/删除不清应用浏览器存储；
   - **反馈说不清自己**：作者诊断不报事件丢弃（「0 失败」可能是抽样）；
     冷编译排队被报成「请求已取消」；响应体真正可用上限 168 KiB 而错误文案只说 8 MiB/1 MiB。
3. **计数**（本轮去重后）：**P0 × 1、P1 × 11、P2 × 21、P3 × 3**。
   另有已登记仍开项（真删/快照、回滚、管理端删除恢复导出、AI 归因旧头）不重复计数，
   在 §6 单列。

## 1. 功能合理性总账（先回答「哪些功能不合理」）

图例：✅ 合理（有判据且真的生效）｜🟡 半合理（能用，但有明确不合理处）｜❌ 不合理（断头路/假承诺/必失败）

| # | 功能 | 判定 | 一句话依据 | Finding |
| --- | --- | --- | --- | --- |
| 1 | 应用中心目录/搜索/分页/「我发布的」/空态 | ✅ | 空态、计数不编造、字典 0 死键 | — |
| 2 | 打开应用（本机路由 + 持有性证明 + 会话闸门 + 打开计数） | ✅ | 三条路径终到唯一闸门；计数调度器真装配 | — |
| 3 | 独立窗口（单应用单窗 + 尺寸记忆 + 比例锁定） | 🟡 | 无刷新/无返回；外链/下载无反馈 | F-05、F-06 |
| 4 | 深链分享 `scheme://app/<id>` | ✅ | 未拿到渠道 scheme 时 fail-closed，不编链接 | — |
| 5 | 发布首版 | ✅ | 本地/服务端同源校验、唯一性复检 | — |
| 6 | **发新版** | ❌ | 被按「首版」校验，每版重填 4 项（含数据敏感度），文案却写「首版必填」 | F-02、F-03 |
| 7 | 版本历史 / 审核结论 / 被拒理由 | ✅ | 全量版本行 + 可辨的失败说明 | — |
| 8 | 上下架 | ✅ | 幂等、失败不乐观更新、下架保留「发新版」但禁用给原因 | — |
| 9 | **冻结** | ❌ | 确认框承诺「到期后台真删」，后台任务不存在 ⇒ 冻结=永久封存 | C-01 |
| 10 | **删除 / 恢复** | ❌ | 作者可删，但全仓无 restore；管理端有「已删除」筛选却无动作；404 让人「联系管理员」而管理员也没这能力 | C-04 |
| 11 | 作者诊断面板 | 🟡 | 失败码/hints/内存水位都有，但不报事件丢弃 ⇒「0 失败」可能是抽样 | A3 |
| 12 | 作者数据面板（schema/rows，默认脱敏 + 授权卡） | ✅ | 仅发布者、默认脱敏、显式 unmask、审计不含行值 | — |
| 13 | **详情页「应用 AI」对话** | ❌ | 面板在主渲染页打 `/__zeokeel/ai/chat`，该路径只有应用窗口协议 handler 在服务 ⇒ 必失败；对拍用例只对拍字符串 | **F-01（P0）** |
| 14 | 应用内 AI（应用前端 `fetch('/__zeokeel/ai/chat')`） | ✅ | 协议 handler 本地处理，隐藏会话 `app:<id>#<scope>` | — |
| 15 | **应用窗口错误页 / 软闸门** | ❌ | 会话过期页只有文案没有按钮；`version-unverified` 产出了却没人显示 | F-04 |
| 16 | 静态资源缓存（conditional/put/失效） | ✅ | B3 已真接线（有生产调用点） | — |
| 17 | **下架/删除清浏览器存储** | ❌ | 全包零 `clearStorageData`；`persist:` 分区里 localStorage/IndexedDB 留盘 | F-07 |
| 18 | 管理端应用列表 | 🟡 | SQL 层无 LIMIT（全表读入内存分页）；「已删除」行仍渲染必 404 的按钮 | C-11、C-13 |
| 19 | 管理端审核队列 | 🟡 | 通过/拒绝闭环，但只有计数没有跨应用清单/批量处置；pending 无撤回/清理 | C-07、C-08 |
| 20 | **管理端处置动作（导出/删除/恢复/回滚/per-app 限流）** | ❌ | 五件事全缺或挂错鉴权面 | C-02、C-03、C-04、C-09 |
| 21 | 管理面数据面（schema/rows） | 🟡 | 端点存在、鉴别权齐，但 webadmin 零调用点（管理员看不到） | C-05 |
| 22 | 限额控制台（18 字段 + 序关系 + 有效区间） | 🟡 | 本体扎实；无 per-app 覆盖；两项运行期无水位；内存档位改后需人工重启 | C-09、C-10 |
| 23 | 用量看板（打开数 / AI 归因） | 🟡 | 归因已按会话前缀闭合；打开计数作业没有健康读数，停摆与「没人用」不可辨 | C-14 |
| 24 | 作者工具链（本地 preview 真 SQLite / AI 回读工具 / 打包器） | ✅ | 2026-09-21 的 P1 已闭合（真 SQLite、`--dump-tables`、三个回读工具） | — |
| 25 | 运行时约束（预算/SQL/资源/响应体） | 🟡 | 三层响应上限文案只报前两档；whitelist 模式平台不比对名单且零提示；单槽冷编译；单用户同应用串行化 | A6、A7、A4、A11 |
| 26 | 「单一真源」机制本身（limits） | 🟡 | 门禁只证明「常量 ↔ 文档」，不证明「常量有消费者」⇒ A1/A2 可长期全绿 | A1、A2、A10 |

## 2. P0（1 条）

### F-01 详情页「应用 AI」发送按钮必失败 —— 有面板、有流式渲染、有授权，唯独没有服务方

- 机制（可穷举）：`AppCenterPanel.tsx:1584` 无条件渲染 `AppAiPanel`；`app-ai.ts:46/275`
  用**相对路径** `POST /__zeokeel/ai/chat`；该面板所在的是**客户端主渲染页**，
  其 origin 上宿主只注册了三条本机路由：`index.ts:816-817`（open）、`:930-931`（channel）、
  `:951-952`（ai/consent）。唯一处理 `AI_CHAT_PATH` 的是 `handler.ts:238`，它在
  **app scheme 协议 handler** 里 —— 客户端页的请求不经过它。
- 后果：每个用户、每个应用、每次点「发送」都失败；错误落成
  `app_ai_protocol`（「响应与客户端预期不一致」）或 `app_ai_unavailable`
  （「请稍后重试/联系管理员」）—— **两条都在指错方向**。
- 为什么全绿地掩盖了它：`ai-chat-parity.spec.ts:46-53` 只对拍「两端字符串常量逐字相等」，
  对拍不到的正是「这条路径有没有人接」。
- 修法（需产品拍板，planning P1-5 早已列为待拍板）：
  ① 在宿主本机路由补 `POST /api/zeokeel/wasm-apps/ai/chat`，转发到同一个
  `handleAiChat`/`runTurn`（`app-ai-runner` 已是现成执行面）；或
  ② 面板降级为「授权 + 说明」，删掉输入框与发送按钮。
  无论哪条，判据都要加一条**可达性**断言（在本机路由表里断言该 path 被注册），
  不能只对拍字符串。

## 3. P1（11 条）

| ID | 面 | 一句话 | 证据（基线 `1143238ca9`） | 为什么不合理 | 建议 |
| --- | --- | --- | --- | --- | --- |
| F-02 | 客户端 | **发新版被当首版校验**：每次发版要求重填标题/用途/数据敏感度/负责人，文案写「首版必填」，而 `data_sensitivity` 连表单初值都没有 | `PublishForm.tsx:459`（`validatePublishDraft(draft)` 无 options）· `publish-app.ts:469/512-516`（缺省 `firstRelease ?? true`）· `appcfg-contract.ts` 表单初值不含 dataSensitivity | 作者已声明过的合规属性，系统不记住、不展示，每版凭空重填；`publish-app.ts:469` 的理由（「看不到版本历史」）在 `current_version` 已下发后不成立 | 用 `initial.currentVersion` 判定 `firstRelease`；目录行带上次声明、发新版默认沿用 |
| C-01 | 管理端 | **冻结/退役承诺「只读快照 + 90 天 + 到期真删」，两个后台任务代码自认未实现** ⇒ 冻结=永久封存；承诺被写进 UI、测试、追加型审计链、作者可读 limits 表 | UI：`webadmin/.../Apps.tsx:1489-1490`；代码自认：`api/read.go:929/933`、`api/release.go:25/229-230`；审计链写入：`release.go:169`；limits 表：`limitsspec.go:154`；测试钉住：`AppCenter.test.tsx:535`；调度器无此作业：`cmd/server/scheduler_status.go`、`cmd/server` 无 `frozen_at` 消费者 | 合规场景（员工数据删除义务）以为已履约、实际未履约；反向也危险（「反正到期会删」→ 不另备份）。且这是**改不掉的审计链假承诺** | 二选一：① 实现 `internal/wasmapp/retirement` 调度器（`VACUUM INTO` 快照 + 到期 `os.RemoveAll` + 审计 `wasm_app_purge`）并登记；② 明确降级为「需人工处置」，同时改 UI/limits/审计明细，测试断言改成「页面不得出现自动删除承诺」。**不要只改文档** |
| C-02 | 管理端 | **管理面无导出**：导出只挂在员工 Bearer 面，管理员要么登录桌面客户端、要么手搓员工令牌；审计还把操作记成员工账号 | 路由：`router/optional_apps_on.go:39`（客户端面）vs `:124-166`（管理面 18 条无 export）；超管兜底：`release.go:263-265`；鉴权面不互通：`serverauth/admin.go:306-315`（cookie）vs Bearer | 退役前导快照是运维刚需，却必须借作者身份做；事后无法区分「管理员处置」与「作者自己导出」 | 管理面补 `GET /wasm-apps/:app_id/export`，`actor_role=admin_session`；员工面超管兜底显式标记 |
| C-03 | 管理端 | **没有版本回滚**：生效版本恒 = 最新 approved，管理员既不能退回旧版，也不能撤掉一个已生效的坏版本 | `api/admin.go:672-676`（取 `max(id) approved`）、`admin.go:696`（唯一审核触发点）、`serverstore/apps.go:548`（approved 不可拒）、管理面 18 条无 activate/rollback | 线上坏版本只能整体下架/冻结（全组织不可用），或求作者再发一版；作者失联则永远停在坏版本 | 新增 `POST /wasm-apps/:app_id/activate {version}`（只允许 approved）+ 审计；坏版本可「标记不可激活」 |
| C-04 | 管理端 | **管理端有「已删除」筛选却无删除/恢复动作**；全仓无 restore；404 却让人「联系平台管理员」（管理员也没这能力）；决策文档以「软删可撤销」为论证前提 | UI：`Apps.tsx:1258-1260`（只有归属/上下架/冻结）、`:307/:508-510`（已删除筛选）；全仓无 restore：`serverstore/wasmapps.go:644`；误导提示：`api/release.go:268`；决策前提：`docs/decisions/2026-09-21-app-author-data-surface.md:88` | 筛选器暴露了「能看见但做不了」的断头路；反馈指向不存在的能力；给已有产品决策的**事实前提是假的** | 二选一：① 实现 restore（清 `deleted_at`/`frozen_at`、保持下架、写审计、版本号占位语义不变）；② 删掉误导文案、改决策理由、筛选器旁明说「不可恢复、仅供复核」 |
| F-04 | 客户端/宿主 | **应用窗口错误页没有任何动作**：会话过期页只说「请重新登录」却没有登录入口；`retryAction`/`signInAgainAction`/`loadingSkeletonTitle`/`versionUnverifiedBanner` 四条文案零消费方；`version-unverified` 产出了没人显示 | `pages.ts:105-113`（只有 title+message）、`:30-90`（页面壳结构上没按钮位）；`app-window-copy.ts:76/81/151`；宿主产出：`index.ts:686` | 用户按页面唯一指示去做，发现没有入口，只能自己关窗回主窗口；软闸门结论静默 | 页面壳加 `actions` 槽（重试/重新登录）；`warning` 渲染成窗口内提示条 |
| F-07 | 客户端/宿主 | **下架/冻结/删除不清应用 origin 浏览器存储**（B4① 未闭合） | `index.ts:635-668`（404/410 只 `cache.clearApp` + 关窗）；grep `clearStorageData\|clearCache\|session.clear` 在 `wasm-apps-host/src` = 0（`clearCache` 只是内容缓存）；分区是 `persist:`（`partition.ts`）；对照 browser 包已有 `runtime.clearData` | 下架后重发同名应用还能读回「上一世」localStorage/IndexedDB；对员工是「删了没删干净」，对合规是删除承诺落空 | 404/410 分支里关窗 → `session.fromPartition(...).clearStorageData({origin})`；**必须精确到该 app origin**，不能整分区清 |
| A1 | 服务端 | **资源路径 3 个上限登记为「唯一真源」却零运行时消费者**，真值在 `assets` 包另一份副本（注释还写反），打包器第三份 | `limits.go:567-573` + `limitsspec.go:67-69`（只进文档）；消费者零命中；`assets/assets.go:48-64`（第二份 + 假注释）、`:232/253/445`（真判据）；`pack-assets.mjs:115/117`（第三份） | 改 limits（+重生成文档）**行为不变**，改 assets **文档不变**；没有任何跨包等值断言 ⇒ 必然漂移 | 让 `assets` 引用 `limits.Asset*`（删副本），或把条目改口径；补跨包等值断言 |
| A2 | 服务端 | **跨端 AI 桥 2 个上限在 Go 侧零消费者**，真值在 TS 两份；跨端判据只对拍 TS↔TS | `limits.go:551-561` + `limitsspec.go:91-92`；`wasm-apps-host/src/ai-chat.ts:88/91`（真值）；`client/.../app-ai.ts`（第二份）；`ai-chat-parity.spec.ts:56-59`（只对拍 TS） | 改 Go 常量：文档变、TS 判据全绿、运行时不变 ⇒ 文档与行为静默分叉 | parity spec 增加「读 `limits.json` 与 TS 对拍」；或把两条常量移出 Go 表 |
| A3 | 服务端 | **作者诊断不告诉你事件被丢过**：环形缓冲满/落库失败会丢调用事件并计数，作者面响应没有这两个字段（管理面有） | 丢弃计数：`events/events.go:121-150/187-195`；管理面出口：`api/admin.go:1376-1379`；作者面只有 `summary/failures/hints/retention_days`：`api/read.go:96-108` | 作者（第一消费者是 AI）会把「没看到错误」当成「没有问题」，而这期间可能丢了数千条事件 | `diagnostics` 顶层加 `events_dropped` / `events_flush_failed`（0 也发）；>0 时给「统计不完整」hint |
| A4 | 服务端 | **全局单槽冷编译**：`compile_concurrency=1`，排在后面的应用等待失败时报 `MODULE_KILLED`「等待加载槽位时请求已取消（客户端断开或墙钟到点）」——把平台排队归因成调用方取消 | `appserver/modules.go:165`（`compileSem`）、`:186-191`（等待 + 该文案）、`:268-273`（执行路径同槽）；`limits.json` `compile_concurrency=1`；容量承诺 `global_instances=32` | 一个慢应用首开会连累所有应用首开；作者按 `MODULE_KILLED` 去改自己代码，诊断里也查不到真实原因 | 等待槽位单独记 reason（如 `MODULE_LOAD_QUEUED`）+ hints 带 `compile.queue_depth`；中期允许 N>1 或分片 |

## 4. P2（21 条）

### 4.1 作者链路（8 条）

| ID | 一句话 | 证据 | 建议 |
| --- | --- | --- | --- |
| A5 | 「并发改回 1」的**现场回退手册指向已不存在的目录** `internal/wasmapp/limits`（4 处文档） | `docs/decisions/2026-09-19-wasm-app-concurrency-default.md:108-113` 等；真源在 `server/internal/limits` | 改路径；加「文档中 `internal/wasmapp/limits` 零命中」守卫 |
| A6 | `access=whitelist` **平台根本不比对名单**（R24），但发布期/诊断/详情页零提示 | `appcfg/appcfg.go:128-133/166-170`；`diagnosticsPayload` 无相关字段 | 诊断/详情加固定提示 `whitelist_enforced=false`；发布回执带一次性 warning |
| A7 | 响应体有**三层上限**（8 MiB 总输出 / 1 MiB 单帧 / 168 KiB 保证可交付），错误文案只报前两档 | `limits.go:358-381`；`runtime/runtime.go:556-558/567/582`；`abi/abi.go:57-81` | 错误 details 补三层数字，以 168 KiB 为主语；limits 表标注 8 MiB 是内部闸门 |
| A8 | 审批**驳回永久烧掉一个版本号**（行保留，只清 archive），驳回动作没有影响面提示 | `serverstore/apps.go:653-670`；`api/publish.go:1542/1607/1616` | 驳回确认框写明「版本号将永久占用」；或提供显式释放动作 |
| A9 | 作者排障文档有两个 `## 4.` 小节（「别把这些当偶发」与「看数据：schema 与 rows」） | `server/skills/app-builder/references/diagnostics.md:62/73` | 改成 §5；门禁加标题编号单调判据 |
| A10 | limits 门禁只证明「常量 ↔ 文档」，**不证明常量有消费者** ⇒ A1/A2 能长期全绿 | `limits_gen_test.go:141/85/275/422-470` | 加「每个常量必须有非测试消费者」静态判据，例外白名单登记理由 |
| A11 | `user_per_app_running=1` 让**同一员工对同一应用的合法并行请求串行化**，排队时间还计入 60 s 墙钟 | `queue/queue.go:46-47/267/371`；`limits.go` 三项常量 | 评估默认提到 2–4（`app_running` 已是 4，内存账不变）；诊断区分「排队」与「guest 超时」 |
| F-03 | 版本号**没有本地递增校验**、不给建议值：填错要先把 ≤32 MiB wasm base64 传完才吃 4xx，而版本号一经提交永久占位 | `PublishForm.tsx:257/604-615`；`publish-app.ts:512-516`；`initial.currentVersion` 已可见但未参与校验（`:543`） | 提交前用 `currentVersion` 做半严格递增校验 + 一键建议下一版 |

### 4.2 客户端体验（5 条）

| ID | 一句话 | 证据 | 建议 |
| --- | --- | --- | --- |
| F-05 | 外链与下载的 UX 半边仍是死的：应用里 `window.open` 一律 `deny`，不转内置浏览器、不给提示；两条文案零消费方 | `electron-adapter.ts:814-817`；`app-window-copy.ts:18/27` | 先把提示条接到被 deny 的点击；再转内置浏览器新标签 |
| F-06 | 应用窗口**没有刷新、没有返回**（全包无 `reload()`/`goBack()`） | `electron-adapter.ts:589`（唯一 `loadURL`）；grep 零命中 | 窗口层补 reload / 返回（`setAspectRatio` 的 `extraSize` 已为 chrome 预留） |
| F-08 | 详情页同时摆两个不同的「AI」，界面不说关系：应用内 AI（无工具）vs 构建助手读数据（`wasm_app_rows`，且授权卡藏在数据面板展开后） | `locales.ts:86` vs `:276-279`；`DataBrowserPanel.tsx:188-196`；`app-ai-runner.ts:11/329`（工具集 `allow: []`） | 文案区分两个助手；授权卡常驻/给指引 |
| F-09 | 撤销「应用 AI」授权**只有应用详情页一个入口**，没有汇总视图（授过几个应用不知道） | `AppAiPanel.tsx:12-19`（自述唯一入口）；`app-ai.ts:390-397`（三段键） | 设置/账户页加授权汇总表 + 一键撤销 |
| F-10 | 应用中心入口挂在侧边栏底部「更多」浮层（foot menu 第二项），不是一级入口 | `client/index.ts:78-93`；`:96-108` | 提升为一级行，或在「更多」里直接给最近应用（需产品判断） |

### 4.3 管理端（8 条）

| ID | 一句话 | 证据 | 建议 |
| --- | --- | --- | --- |
| C-05 | 管理面 `GET …/schema`、`GET …/rows` 两条只读数据面端点**零产品调用点**（管理员仍只能 curl） | `router/optional_apps_on.go:159-160`；`api/rows.go:121/508`；`grep -rn "/rows\|/schema" server/webadmin/src` 零命中 | 详情抽屉加「数据」折叠块（表结构 + 分页行 + 显式 unmask） |
| C-06 | 同一个「已删除应用」在管理面有**三种口径**：诊断 200、版本/数据 404、打开数/AI 用量 200 且恒零（连存在性都不查） | 404：`api/admin.go:1245/1254-1265`；200：`admin.go:1295-1296`、`admin_opens.go:24-29/235-241` | 只读面统一 `allowDeleted=true`；「不存在」与「已退役」分开；打开数补存在性校验 |
| C-07 | 全组织待审队列**只有计数没有清单**：页头「待审 N」不可点，无跨应用清单/批量处置；服务端已查全量只用来数数 | `admin.go:141-149`；`Apps.tsx:937-939`；唯一清单端点要求 app_id：`optional_apps_on.go:138` | 徽标可点 → 待审子页；新增跨应用 pending 清单端点 + 内联通过/拒绝 |
| C-08 | 审核开关关闭后遗留 pending **没有任何清理路径**；作者**不能撤回**已提交版本（无 withdraw 端点） | `admin.go:1236-1241`（开关只回状态）；`grep withdraw\|CancelRelease` 仅 `context.CancelFunc`；动作只有 approve/reject | 作者 withdraw（销毁制品、`withdrawn`、版本号仍占位）；或管理面 `purge-stale` 把积压标 `obsolete` |
| C-09 | 限额只有**一套全局旋钮**，无 per-app 覆盖：异常应用只能整体冻结，不能单独限流/降额 | `applimits/applimits.go:36-100`（全标量）；`queue/queue.go:490-498`；管理面无 per-app limits | 加 `GET/PUT /wasm-apps/:app_id/limits`（不得超全局上限）+ 审计 |
| C-10 | 控制台可调 `module_cache_mb` / `app_db_readers`，但**运行期没有水位出口**（代码自认 unavailable）；`instance_memory_mb` 改后需人工重启，产品内无重启动作 | `admin.go:1331-1345`（`runtimeUnavailable`）；`:901-902`（restart_fields）；管理面无 restart 端点 | 注入 `ModuleCacheStats()/AppDBPoolStats()`；重启项明确标注「尚未生效」并给操作指引 |
| C-11 | 「已删除」行仍渲染**可点**的上下架/冻结/转移归属按钮，点了必然 404 | `Apps.tsx:1259-1318`（无 deleted 守卫）；`admin.go:1254-1265`（写面 404） | deleted 行只保留只读详情与「恢复」；其余隐藏而非禁用 |
| C-13 | 管理列表在 SQL 层**没有 LIMIT**：每次打开都把全部 wasm 应用读进内存再过滤/分页，并每次全量扫待审表 | `api/admin.go:120-121`；`serverstore/wasmapps.go:307-336`（无 LIMIT/OFFSET）；内存分页 `admin.go:155-179` | 把 `q/status/limit/offset` 下推 SQL + `COUNT(*)`；待审计数改聚合 |

## 5. P3（3 条）

| ID | 一句话 | 证据 | 建议 |
| --- | --- | --- | --- |
| C-12 | 「公告模板」只能一键复制文本，平台内无发送通道/回执 | `app-center/announcements.ts:1-17`；`AnnouncementTemplatesDialog.tsx:44-52`；管理面无公告端点 | 近期：明说「平台不发通知」并给可粘贴内容；中长期接通知面 + 已读回执 |
| C-14 | 打开计数的日汇总/清理作业**不在调度状态登记表**里、无 Runs/Errors：作业停摆时看板只是「数字不涨」，与「没人用」不可辨 | `cmd/server/wasmapp.go:520-523`（裸启动）；`scheduler_status.go` 9 条无 opens；`opens/scheduler.go` 无自记账 | 加自记账并登记；summary 加 `aggregated_until`/`stale`，看板明说数据可能未更新 |
| C-15 | 审计页残留已删功能的 `wasm_apps_base_domain_change` 标签；审计无法区分「超管兜底处置」与「作者本人」 | `webadmin/src/pages/Audit.tsx:184`；`release.go:263`（超管放行）+ `auditApp(...u.Username...)` | 删死标签；`auditApp` 加 `actor_role`（owner / super_admin_fallback / admin_session） |

## 6. 已登记仍未闭环（不重复计数，但用户会撞到）

| 项 | HEAD 状态 | 证据 |
| --- | --- | --- |
| 冻结/退役「定期快照 + 到期真删」 | 未实现，且承诺面比台账记录的更大（UI+测试+审计链+limits 表） | 见 C-01 |
| 版本回滚 / 管理端删除、恢复、导出 | 未实现 | 见 C-02/C-03/C-04 |
| 应用 AI 归因「旧请求头无发送方」 | **已改径闭合**：`X-ZeoKeel-App-Id` 被显式忽略并记日志；改读隐藏会话 id 的 `app:` 前缀，网关派生 + 形状/存在性校验，webadmin 文案与实现对拍 | `llmgateway/app_attribution.go:36-70/78-85`、`opens-contract.ts:216`、`opens-contract-parity.spec.ts` |
| 模块缓存 / 应用库句柄水位 | 未实现（代码自认 unavailable） | 见 C-10 |
| 签名密钥轮换 / 技能热加载 | `KeyRing.Rotate` / `Catalog.Reload` 无非测试调用点 | lane-a §7.2 |
| `/readyz` 未认证 + 水位细分 | 仍开（本轮未复核是否有变更） | lane-a §7.2 |

## 7. 已核对「其实没问题」（防误报）

| 面 | 结论 | 关键证据 |
| --- | --- | --- |
| 打开失败的 13 种文案分层 | 每类有独立文案与 hints，冻结 vs 不存在可辨 | `AppCenterPanel.tsx:410-448` |
| 今日打开次数不编造 | 只在服务端回传 `counts` 时渲染 | `AppCenterPanel.tsx:1518-1521` |
| 版本历史 / 被拒理由 / 形状漂移 | 全量版本行、rejected 必带「升版本号重发」；形状漂移走错误块而非「没有理由」 | `app-releases.ts:1-90`、`AppCenterPanel.tsx:2235-2280` |
| 删除/下架/冻结的二次确认与回执 | 三种危险动作都有 `role="alertdialog"`；回执用服务端 note；客户端**拒绝**替服务端承诺「90 天后自动删」 | `AppCenterPanel.tsx:2109-2180/1601-1620` |
| 数据面板（作者看 SQL） | 仅发布者、默认脱敏、显式 unmask、NULL 与空串可辨、分页/截断提示、竞态防护 | `DataBrowserPanel.tsx` 全量 |
| AI 行数据授权卡 | 默认关、宿主为真源、写失败不乐观切换、作用域含服务端 | `DataBrowserPanel.tsx:285-350`、`app-routes.ts:74-108` |
| 应用 AI 授权/拒绝/撤销**写面** | 三方向独立失败文案；「不允许」真关宿主闸门 | `AppAiPanel.tsx:150-235` |
| 缓存接线（B3） | `conditional` 在 GET、`put` 在写路径、`clearApp` 在换代/生命周期分支 | `handler.ts:298/565`、`index.ts:301-312` |
| 声明几何（ratio/尺寸）进窗口（B2） | 三态语义 + `setAspectRatio` + 按 ratio 校正记忆尺寸 | `index.ts:704-711`、`windows.ts:870` |
| 应用窗口接入 browser surface（B1） | `registerApp` 有生产调用点 | `windows.ts:677-707` |
| 分区名含服务端哈希（B4②） | `serverPartitionHash`（sha256 前 32 hex） | `partition.ts`、`index.ts:507` |
| 审核队列通过/拒绝闭环 | 拒绝必须带理由（≤200 字）、approved 拒绝返回 409 且 hint 与文档对拍 | `admin.go:338-430`、`apps.go:547-548` |
| 打开计数（PV/UV/趋势） | 调度器真装配、先汇总后清理、整日粒度 | `cmd/server/wasmapp.go:520-523`、`opens/scheduler.go:100-179` |
| 调用事件 7 天保留 | 有真实清理作业 | `events/scheduler.go:136-141` |
| 限额控制台本体 | 18 字段真落地、序关系/有效区间、信封严格校验、来源三态、审计 | `admin.go:853-1064`、`applimits.go:395-520` |
| 本地 preview | 真 SQLite + `--selftest/--dump-tables/--data-dir` | `examples/go/preview.mjs:24-53/463/845` |
| 服务端 34 条路由 | 客户端面 18 + 管理面 18 都有真实 handler（无 501/TODO 桩） | `optional_apps_on.go`、`handlers.go` |
| 客户端字典 275 键 | 0 死键（脚本扫描） | lane-b §1.2 |
| 2026-09-21 登记的 9 项服务端问题 | 已闭合（OOM、DataCount、`.debug_*`、`sock_*`、`db_rows`、preview、schema/rows 入口、预算进控制台、并发 1→4） | lane-a §7.1 |

## 8. 交叉矛盾与判定修正

1. **B5（应用 AI 归因）不再成立**：lane B 按 `X-ZeoKeel-App-Id` 零发送方判「未闭合」，
   但 HEAD 已改径 —— 旧头被**显式忽略并记日志**，改读隐藏会话 id 的 `app:` 前缀，
   网关做形状 + 存在性校验，webadmin 面板文案已与实现对拍（lane C 实跑 11/11）。
   ⇒ 归入「已闭合」，不要按缺陷修；若要补强，只能补「头伪造」的运营口径说明。
2. **C-01 不是「未做功能」，是「假承诺」**：代码与首次审计都如实写着未实现，
   但 UI/测试/审计链/limits 表四处对外承诺。定级按「承诺分叉」（P1），修法必须
   同时处理**四处承诺面**，只改代码或只改文档都会留下另一半。
3. **F-01 的「有实现」是假象**：`AI_CHAT_PATH`、`handleAiChat`、流式渲染、授权、
   隐藏会话、对拍用例全都存在，唯独客户端页 origin 上没有路由。这是本仓口径里
   点名的「有用例掩盖的假功能」，不能按「AI 面板待优化」降级。
4. **`AppPlatform.tsx` 已不存在**是 2026-09-19 的合理合并（并入应用中心「限制项」），
   不是断头路；老路径有重定向。

## 9. 需真机 / 运行期才能定论的

| 项 | 需要什么 |
| --- | --- |
| F-01 的具体错误文案 | 打包版点「发送」，看落 `app_ai_protocol` 还是 `app_ai_unavailable`（机制已确认，症状分级待真机） |
| F-07 存储残留 | 发布 → 应用内写 localStorage → 下架 → 重发同名 → 读回（Electron `persist:` 落盘行为） |
| F-04 错误页 | 拔网/令令牌过期后打开应用，看页面能否自救 |
| F-05 外链 | 应用页点外链，看是否有任何可见反馈 |
| C-01 数据残留 | 起服务端 + 冻结 + 观察 `data_root/apps/<id>/` 是否被清 |
| A3 丢弃量级 | 测试环境压到 5000 req/min 后读 `/admin/runtime` 的 `events.dropped` |
| A4 排队时长 | 两应用 + 冷编译缓存，并发首开，看 `reason_code` 与 `compile.queue_depth` |
| A7 错误 details | 真跑一次「返回 200 KiB 的 `<`」，读 `details`/`hints` |
| C-13 规模影响 | 几百/几千应用库上实测分页耗时 |
| 三平台差异 | Windows/macOS 的存储与外链表现（本轮只有 Linux 读码） |

## 10. 建议修复批次（待用户确认后执行）

- **W0 · 止血（1–2 天，改动小、用户可见）**
  - F-01：补本机 AI 路由（或按产品决定降级 UI）+ 可达性判据；
  - C-01：先销承诺（UI 文案 / limits 表 / 审计明细 / 测试断言四处同批），
    或直接实现 retirement 作业（若选实现，W0 只做 UI 与审计口径，W3 做作业）；
  - F-02：发新版传 `firstRelease:false` + 目录行带上次声明；
  - F-04：错误页加动作槽 + `version-unverified` 提示条。
- **W1 · 反馈与文档对齐（2–3 天）**
  - A3 诊断补 `events_dropped/failed`；A4 单独 reason + `compile.queue_depth` hint；
  - A5/A9/C-15 文档与标签修正；F-03 本地版本递增校验；
  - A6 whitelist 提示；A7 三层响应上限文案。
- **W2 · 管理动作面（1 周）**
  - C-02 导出、C-03 回滚/activate、C-04 删除/恢复、C-06 只读口径统一、C-11 行内按钮；
  - C-07 待审清单 + 批量、C-08 withdraw/purge-stale、A8 驳回影响面提示。
- **W3 · 容量与度量（1 周）**
  - C-05 管理面数据面板、C-09 per-app 限额、C-10 运行期水位、C-13 SQL 分页、C-14 作业健康；
  - A1/A2/A10 单一真源收口、A11 并发默认评估；F-05/F-06/F-08/F-09/F-10 体验项。
- **不建议当 bug 修的既有设计取舍**（需要产品再拍板，不是实现缺陷）：
  - 应用无域名、只能在客户端内打开、无 cookie、无 Cache Storage、无网络/文件；
  - 版本号永久占位（已写进 SKILL 与文档）；`whitelist` 由应用自己判（R24）；
  - 单槽冷编译（`compile_concurrency=1`，内存受限机器的取舍）；
  - 「一套全局限额」（per-app 覆盖是新能力，不是补漏）。

## 11. 证据与复跑

- 三份 lane 报告（含逐条 file:line、已核对项、复跑命令、认账）：
  `temp/wasm-audit-2026-10-22/lane-a-server.md`、`lane-b-client.md`、`lane-c-admin.md`
- 关键复核（本轮 Lead 实跑）：
  - `grep -rn -w 'AssetMaxPathBytes|AssetMaxSegmentBytes|AssetMaxListEntries' server/ --include=*.go | grep -v internal/limits` → 空（A1）
  - `grep -rn 'AIBridgeMaxMessages|AIBridgeMaxContentBytes' --include=*.go --include=*.ts .` → 只有 limits/limitsspec/测试（A2）
  - `grep -rn 'clearStorageData|clearCache|session.clear' packages/host/wasm-apps-host/src/` → 只有内容缓存（F-07）
  - `AppCenterPanel.tsx` 渲染 `AppAiPanel` 且无人注入 `aiDeps`；宿主本机路由只有 open/channel/ai-consent（F-01）
  - `PublishForm.tsx:459` / `:325` 调 `validatePublishDraft` 不传 options（F-02）

## 12. 实施状态（2026-10-22 当日修复后）

> 本节是**索引**，不是"已闭合"的凭据；凭据 = 代码 + 行为级用例 + 变异验证（用例位置在各条括号里）。
> 生命周期重设计的实施记录见 `docs/planning/2026-10-22-wasm-lifecycle-redesign.md` §13。

| 原编号 | 状态 | 落点 / 判据 |
| --- | --- | --- |
| **F-01**（P0，应用 AI 必失败） | **已修** | 宿主本机命名路由 `POST /api/zeokeel/wasm-apps/ai/chat`，与协议 handler 共用同一个 `handleAiChat`；可达性用例在 `packages/host/wasm-apps-host/src/index.spec.ts` F-01 组（坏路径 404 且零执行面调用）。 |
| F-02（发新版被当首版） | **已修** | `firstRelease` 由 `current_version` 推导；发新版省略空声明（缺席=继承）；`data_sensitivity` 作者目录字段端到端预填；`appcfg-contract.spec.ts` 字段对拍。 |
| F-03（版本号无本地校验） | **已修** | `compareVersions` 对齐 `util.CompareSemVer`（prerelease 正确）；建议下一版按已知全部版本取 max；错误态零上传。 |
| F-04（错误页无动作） | **已修** | 页面壳 `actions` 槽接到 localError 8 处 + 平台信封 404/410/500；`version-unverified` 提示条；登录 URL 白名单。 |
| F-05（外链/下载无反馈） | **部分** | 外链被 deny 时注入提示条（`externalLinkNotice`）；**转内置浏览器新标签未做**（需要新的宿主服务面，待产品定）。 |
| F-06（窗口无刷新/返回） | **已修** | 应用窗口右键菜单 + Ctrl/Cmd+R、Alt+←、Cmd+[。 |
| F-07（下架不清存储） | **已修** | `clearStorageData({origin})` 精确到 app origin；下架/删除在 `changed` 为真时清；冻结=只读快照**不清**；404/410 打开失败清。 |
| F-08（两个 AI 不区分） | **已修** | 双向指路文案（应用内助手无工具 / 构建助手可读数据）。 |
| F-09（撤销授权入口单一） | **部分** | 授权汇总 + 单条/一键撤销已做，落点在**应用中心目录页**；进设置页需要新增 settings 契约依赖（未授权，保持现状）。 |
| F-10（入口埋在「更多」） | **未改** | 产品决定（导航层级），未动。 |
| **A1/A2/A10**（limits 双源） | **已修** | 资源路径上限收敛到 `limits.Asset*`（`assets` 别名 + 跨语言对拍）；AI 桥上限加 Go↔TS 对拍；limits 消费者守卫 + 例外登记。 |
| A3（诊断无丢弃计数） | **已修** | `diagnostics` 顶层 `events_dropped/events_flush_failed`（0 也下发）+ hints。 |
| A4（冷编译排队误报取消） | **已修** | 新错误码 `MODULE_LOAD_QUEUED`（503）+ `queue_depth` + 独立 hints；判据 `modules_queue_test.go`。 |
| A5/A9（文档路径/编号） | **已修** | 回退手册路径改 `internal/limits`；diagnostics.md 重复编号修正；文档守卫复跑通过。 |
| A6（whitelist 假准入） | **已修** | 诊断与发布回执显式 `whitelist_enforced:false` + hint（不改准入语义）。 |
| A7（三层响应上限文案） | **已修** | 错误同时写 8 MiB / 1 MiB / 168 KiB，并以 168 KiB 给动作；`output_overrun_test.go`。 |
| A8（驳回烧版本号无提示） | **已修** | 服务端 reject 回执 `version_occupied` + `note`，webadmin 消费并展示；作者端 my-releases 已有 reason。 |
| A11（用户级串行化） | **已修** | `user_per_app_running` 默认 1→2（常见 `Promise.all` 不再被强制串行），仍 ≤ app_running/全局；管理台全局限制项可随时改，且新增 per-app 覆盖（见 C-09）。 |
| **C-01**（冻结承诺无执行者） | **已修** | 迁移 0086 + `lifecycle` 快照 + `retirement` 真删调度器（登记进调度状态表、失败不删）；UI/审计/limits 文案已对齐真实语义。 |
| C-02（管理端无导出） | **已修** | 管理面 `GET …/:app_id/export`（含 `?database=1&assets=1` zip）+ 审计 `admin_session`；员工面保留。 |
| C-03（无版本回滚） | **已修** | 部署历史 + `POST …/deployments`（回滚=旧版本再部署）；**执行面已按指针取版本**（P0 反证后修），判据 `rollback_serving_test.go`。 |
| C-04（无删除/恢复） | **已修（管理员）** | 管理面 DELETE + restore；软删可恢复（purged 后 410）；作者面恢复入口仍不可达（目录不下发已删行，见 §11 遗留）。 |
| C-05（管理端无数据面） | **已修** | 详情抽屉「数据」块（schema + 分页行 + unmask 二次确认 + 审计提示），`AppDataSection.test.tsx`。 |
| C-06（已删应用三种口径） | **已修** | 只读面统一 `allowDeleted=true`；打开数/AI 用量补存在性校验。 |
| C-07（待审无清单） | **已修** | 跨应用待审队列端点 + 页头徽标可点 + 内联通过/拒绝。 |
| C-08（pending 不能撤回/清理） | **已修** | 作者 withdraw（pending→withdrawn）+ `purge-stale`（管理面，需先关审核开关）+ UI。 |
| C-09（无 per-app 限额） | **已修** | 迁移 0087 `wasm_app_limits` + 队列按应用生效 + 管理 API + 应用详情「限流」UI；默认继承全局、可一键恢复；允许高于全局但需二次确认并审计（决策 `docs/decisions/2026-10-22-wasm-per-app-limits.md`）。 |
| C-10（运行期水位缺失） | **已修** | `ModuleCacheStats/AppDBPoolStats` 接入 `/runtime`；instance_memory 重启项如实标注。 |
| C-11（已删除行按钮必 404） | **已修** | 已删除行只保留只读详情 + 恢复 + 导出。 |
| C-12（公告无发送通道） | **已改文案** | 明说「平台不发送通知、无回执」，复制只表示进剪贴板。 |
| C-13（管理列表无 LIMIT） | **已修** | SQL 层 LIMIT/OFFSET + COUNT；前端传分页参数。 |
| C-14（打开计数作业无健康） | **已修** | opens 调度器自记账 + 登记 `wasm_opens`；summary 下发 `aggregated_until/stale/opens_job`；看板显示健康与陈旧。 |
| C-15（审计死标签/身份） | **已修** | 新增/补齐审计标签；`actor_role` 区分 owner/super_admin/admin_session/seed/system；死标签清理。 |

### 12.1 遗留与需真机/需产品决策

- **作者恢复自己软删的应用**：服务端 restore 已实现（管理员面），但作者目录不下发已删行 ⇒ 客户端入口不可达（客户端已交付 `restoreApp` 函数 + 单测，未造假按钮）。要么目录对归属人下发已删行，要么只在管理面提供恢复。
- **F-05 转内置浏览器**：需要新的宿主"打开浏览器标签"服务面（本轮没有），目前只做提示条。
- **F-09 设置页落点**：需要给客户端包增加 settings 契约依赖（会动 package.json/lockfile 与构建依赖图），未授权前保持在应用中心。
- **导出审计"成功后才写"**：实现正确，但缺"导出失败不得留成功审计"的判据（变异无法打红）。
- **真机/生产演练**：Electron 自定义 scheme 的 `clearStorageData({origin})`、右键菜单/CSP 提示条、`/open` 真实链路、生产数据根「冻结→快照→恢复→删除→真删」演练、大库快照耗时、三平台差异 —— 均未在真机执行（设计 §12 已列入发布检查单）。
- **全量门禁**：`go build`（三组 tags）与 `go test`（真 PG、`-tags=skills,apps,connectors`，serverstore/api/appserver/runtime/router/cmd 等全部 ok）已跑；`corepack yarn check` = 34/34 通过（17 包 + 17 根守卫）。三平台打包/真机 E2E 未在本轮执行（见上条）。
