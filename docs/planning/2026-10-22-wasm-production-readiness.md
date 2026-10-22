# WASM 应用平台：生产级就绪评估与整改（2026-10-22）

- 状态：**进行中**
- 范围：`server/internal/wasmapp/**` + `server/cmd/server` 的 wasm 装配 + `server/webadmin` 应用中心 +
  `packages/client/wasm-apps` + `packages/host/wasm-apps-host` + 桌面端接线 + 作者工具链
  （`server/skills/app-builder`、`docs/wasm-app-authoring.md`）+ 站点文档（`site/src/content/docs/apps.md`）。
- 运行时边界：Go `wasm32-wasip1` + wazero 沙箱；**不引入 V8/容器**。生命周期语义参考 Cloudflare Workers
  （不可变版本/部署历史、回滚=部署旧版本），但执行面不变。
- 前序：`docs/planning/2026-10-22-wasm-feature-rationality-audit.md`（36 项功能审计）、
  `docs/planning/2026-10-22-wasm-lifecycle-redesign.md`（生命周期重设计）、
  `docs/decisions/2026-10-22-wasm-per-app-limits.md`（限流默认值与 per-app 覆盖）。

## 1. 什么叫「生产级可用」（验收定义）

### 1.1 硬性阻塞项（P0，任一存在即不发布）

1. **数据不可逆丢失**：删除/下架/冻结/恢复/purge 任一路径在快照失败、并发、重试、进程重启下会丢应用
   数据库或资源，且没有审计/恢复路径。
2. **安全隔离破坏**：应用可越权访问其他应用/用户数据、可逃逸沙箱、可伪造宿主证明、可读平台密钥；
   管理端点缺鉴权或越权（读写级别错配）。
3. **生命周期状态机自相矛盾**：同一时刻数据库、运行期、管理台、客户端对"线上版本/状态"给出不同答案，
   或回滚/审批/发布互相覆盖且不可审计。
4. **核心流程不可用**：新建→发布→打开→更新→下架在全绿门禁下不可完成，或错误不可定位。

### 1.2 三视角验收（P1 门槛）

**应用开发者**

- 从零到发布：示例/脚手架/技能文档足够，不需要读服务端源码；本地能跑、能预检、能看到结构化错误。
- 失败可行动：编译/ABI/导入白名单/内存/时间/队列/DB/资源/权限每类错误都给出"下一步改什么"，
  数值与**该应用生效上限**一致（不是全局默认）。
- 可观测：诊断能回答"最近失败是什么、被谁限流、排队多久、内存峰值、版本是哪个"。
- 版本与回滚：发布历史、审批状态、旧版本重新部署、资源与数据库随版本迁移的边界清楚。

**终端用户**

- 打开/关闭/重开、断网/服务端不可达、登录过期、应用被冻结/下架/删除/恢复，行为可解释且不丢数据
  （除平台明确承诺会清理的浏览器存储，且清理范围精确到 app origin）。
- 冷启动/排队/超时/崩溃有明确反馈；429 有退避提示；不会"白屏无原因"或把可恢复错误显示成"应用没了"。
- 应用中心可发现、可搜索、状态（可用/冻结/已下架/审核中）一致；AI 面板与主流程不互相拖垮。
- 多窗口、键盘、i18n、错误上报（Sentry）链路真实可用。

**管理员 / 运维**

- 发布审核（待审、通过、拒绝、撤回）、部署历史、回滚、下架/冻结/恢复/删除/导出/purge 全部可操作、
  幂等、可审计（actor + actor_role + app_id），且失败可见。
- 可观测：`/admin/runtime`、`/readyz`、诊断、队列水位、模块缓存、appdb 池、限流覆盖（全局与按应用）
  能回答"现在发生了什么、哪个应用在拖垮平台"。
- 安全：管理面读写权限正确、审计哈希链完整、冻结/删除不泄露存在性、导出不含他人数据。
- 容量与隔离：单应用不能拖垮全局（队列/并发/内存/磁盘/编译队列），限流可按应用调整且有上界。
- 运维：迁移可重放/校验、调度器（opens/retention）幂等可恢复、备份/恢复/升级路径明确。
- 文档：站点与作者文档不写未实现能力、不写错默认值、不泄露渠道/真实域名。

### 1.3 判据与证据纪律

- 每条发现必须带 `file:line` 或可复现命令；"我读代码觉得"不算证据。
- 区分**新发现**与**已记录取舍**（前序文档里明确"不做/后续"的不重复当 bug，除非它违反 1.1）。
- 修复必须配行为级判据（删实现会红），并有变异方式；只改注释/文档不算修复 P0/P1。
- 每轮结束跑：`go build`（默认 + 三 tags）、定向 `go test`（真 PG）、`yarn check`、根守卫；
  涉及并发的改动追加 `-race`。

## 2. 评审协议（三视角 + 反证）

1. **独立评审**：三个 fresh-context 评审员各自只读评估（开发者 / 用户 / 管理员），产出带证据的
   发现清单，禁止改代码（只写自己的报告文件）。
2. **合流定级**：Lead 去重、对照前序审计、定 P0–P3；P0/P1 必须修，P2 按"是否影响生产操作"取舍，
   P3 记入文档。
3. **整改**：按 P0→P1→P2 分批；每批有测试/门禁/变异验证。
4. **反证**：整改后再开独立反证（可用原评审员或新反证员）复核"是否真的修好、是否引入新缺口"。
5. **退出条件**：三视角均无 P0/P1；P2 有明确处置（修/记录取舍）；全部门禁绿；文档记录剩余风险。

## 3. 当前已知状态（评审起点，避免重复）

- 功能合理性 36 项、生命周期重设计、per-app 限流默认值+覆盖：已实现并有测试；详见前序三份文档。
- 已知未闭环（本轮必须重新评估是否仍是阻塞）：
  - 作者恢复自己软删应用：服务端 restore + 客户端函数已实现，但作者目录不下发已删行 ⇒ 入口不可达。
  - F-09 设置页落点（依赖契约）、F-05 内置浏览器新标签、per-app 内存/时间预算（明确不做）。
  - 真机/三平台打包/生产数据根演练未做；工作区大量改动未提交。
  - 可观测性：管理端无 per-app 限流覆盖总览；作者诊断 429 hints 仍可能显示全局默认值。
- 生产门禁现状（2026-10-22）：`yarn check` 34/34；server 真 PG 全量绿；webadmin 927 用例绿；
  迁移 0001–0087 校验；根守卫 17/17。

## 4. 产出物

- 三份独立评审报告（`temp/wasm-audit-2026-10-22/prod-review-*.md`）。
- 合流后的整改清单与本文件的"实施记录/残留风险"两节（每轮追加）。

## 5. 第一轮三视角评审结果（2026-10-22 深夜）

三份独立报告（`temp/wasm-audit-2026-10-22/prod-review-{developer,user,admin}.md`）合计：

| 视角 | P0 | P1 | P2 | P3 | 结论 |
|---|---|---|---|---|---|
| 应用开发者 | 0 | 2 | 5 | 8 | 不达生产级（部署/回滚/撤回不可见、诊断无版本） |
| 终端用户 | 0 | 3 | 6 | 5 | 不达生产级（白窗、首版待审消失、应用窗口无错误上报） |
| 管理员/运维 | 1 | 3 | 6 | 6 | 不达生产级（purge/restore 并发删数据、缺运行读数、队列内存未入账） |

### 已修复（本轮）

- **P0（管理员）purge 与 restore 并发删掉刚恢复数据**：迁移 **0088** 把真删改为两阶段：
  1. `BeginWasmAppPurge` 在事务内 `SELECT … FOR UPDATE` **重校验**（已删/到期/有快照/未清除）
     后置 `purged_at`（终态）；restore 先提交 ⇒ purge 跳过；purge 先提交 ⇒ restore 410；
  2. 数据目录清理单独记账 `data_cleaned_at`，失败由调度器下一轮补清理（`PurgeCleanupCandidates`），
     让"元数据说清了"与"盘上真的清了"可分别收敛。
  证据/判据：`serverstore/wasm_purge_race_test.go`（并发不变量 20 轮、资格矩阵、恢复互斥）、
  `retirement` 的补清理用例；变异（删重校验）⇒ 三条用例红，已还原。
- **管理员 P1 可观测性（部分）**：`/admin/runtime` 新增
  `queue`（全局水位 + 429 计数 + 按应用 top_apps）、`schedulers`（含 `wasm_retirement` 的
  runs/errors/last_run_at/last_error）、`app_limits.override_count`。
- **应用开发者 P1（部分）**：诊断响应新增 `limits` 段（该应用生效四轴 + `source=override|global`），
  429 hints 改用该应用生效值（`diag.HintsForApp`）。
- **管理员 P2（部分）**：审批状态已落库但部署/投影失败时**照样写审批审计**
  （`wasm_app_release_approve`/`reject` 注明失败）；审计 HTTP 面支持 `app_id` 过滤。
- **管理员 P2（部分）**：管理台限流覆盖总览/筛选（并行泳道）；API 参考与作者文档补齐（并行泳道）。

### 进行中 / 待下一轮

- 用户 P1：应用窗口骨架屏（U-01）、应用窗口错误上报/复制诊断（U-03）、首版待审可见（U-02）。
- 开发者 P1：部署/回滚/撤回在作者文档与 AI 工具面可见（D-01，文档/工具面）。
- 开发者 P1：诊断版本维度（D-02，需迁移 0089 + 事件/指标/诊断）。
- 管理员 P1：队列内存上界入账（进行中）。
- 用户 P2：410 下架被显示成"不存在"（U-04）、版本更新提示（U-06）、深链未登录无 UI（U-07）、
  会话过期 recovery 页被关（U-08）；管理员 P2：导出/原始行与只读共用权限点、90 天保留期不可配、
  站点"删除不可逆"文案；开发者 P2：config 字段集/生成物类型/归因文档/诊断参考。
- 三平台打包/真机/生产数据根演练（需环境）。

## 6. 第二轮整改进展（2026-10-23 凌晨）

- **U-02 首版待审不可见（用户 P1）**：员工目录对**归属人**下发首版 pending/rejected 行
  （`first_release*` 字段 + `enabled=false`），行内可撤回、可看被拒理由；非 owner/超管仍不可见；
  发布响应新增 `release.current_version`（首版待审 = 空串）让客户端区分"首版"与"线上仍是旧版本"，
  并据此不再给首版待审渲染分享链接；目录过滤/详情页同口径。客户端 `first-release.spec.tsx`
  11 条行为用例 + 服务端 3 条真 PG 用例，14 条变异全部实测变红。
- **U-05 下架/删除文案**：补"浏览器本地存储会被清理（服务端数据保留）"，与 host 的
  `clearStorageData({origin})` 一致。
- **U-01/U-03/U-08/U-06（用户 P1/P2）**：应用窗口骨架屏（暗色不闪白、加载看门狗）、应用窗口
  preload 错误上报（app_id/windowKind tag + 崩溃/加载失败/unresponsive）、失败页「复制诊断」、
  会话过期不立即关窗并在同账号重登后恢复原路径、版本更新可关闭提示条；host 33 文件/460 用例、
  desktop 95 用例、enterprise 45 用例，17 条变异全红。
- **D-02 诊断版本维度（开发者/管理员 P1）**：迁移 **0089** `wasm_call_events.version`
  + 索引；`CallMetrics.Version` 由 `serve.go` 写入**实际执行版本**；诊断 `failures[].version`
  与 `summary.versions[]`（total/failed/last_failure_at）；参考文档与 SKILL 2.13.8 同步。
- **D-01 作者面生命周期文档（开发者 P1）**：作者手册/技能参考补 deployments、回滚、撤回、
  restore、审核状态与"回滚不恢复应用库"；API 参考新增 §11c（管理面 13 端点 + 错误码 + 权限）；
  站点删除"不可逆"旧口径；config 字段集/生成物 window 类型/归因文档修正；SKILL 2.13.7。
- **管理员可观测/审计（P1/P2）**：`/admin/runtime` 增加 queue（429 计数 + top_apps）与
  schedulers（含 wasm_retirement）；审计 HTTP 支持 `app_id` 过滤 + 管理台应用列/筛选；
  审批状态已落库但部署失败时照样写审批审计；管理台限流覆盖总览/筛选/运行时摘要。

## 7. 第三批（队列内存上界与预算第六笔）

- **P1 队列内存上界入账（管理员评审）**：新增 `limits.WasmQueueBodyBytesMax = 256 MiB` 作为
  **全局**排队请求体硬上界（不是 4096×1MiB 的乘积）；`queue.AcquireWithSize(..., bodyBytes)`
  在入队前按"加上这一个是否超预算"判（429 `APP_QUEUE_FULL`，`reason=queue_bytes_exceeded`，
  details 含限值/当前值/请求体/峰值 + hint），授权/超时/被拒三条路径都归还额度（幂等），
  `-race` 通过。
- **预算第六笔**：`readyz.MemoryPlan/Budget` 增加 `queue_body_bytes` 并计入 `total`；
  默认档 2710 → **2966 MiB**、small 档 645 → **901 MiB**；`/readyz` 在 4 GiB 机器上从
  "账绿"纠正为 `mem_budget_ok=false`。管理台限制项页补第六笔明细与校验。
- **可观测**：`queue.Stats` 增加 `queued_body_bytes` / `max_queued_body_bytes` /
  `queue_body_bytes_limit` / `rejected_queue_bytes`，`AppWatermark` 增加按应用
  `queued_body_bytes`；`/admin/runtime` 的 `queue` 段自动下发。
- **顺带修的真实缺陷**：`Acquire` 的三处 429 计数此前在解锁后自增（对受锁字段的无锁写，
  map 写会 panic 且计数丢更新）——已移回锁内，`-race` 全绿。

## 8. 第二轮反证（refute-round2）与闭环

独立反证报告：`temp/wasm-audit-2026-10-22/refute-round2.md`（38 项裁决：成立 26 / 部分 4 /
被证伪 3 / 无法验证 5；**P0=0**，新 P1=1，P2=5）。

**已闭环**
- **R2-P1-1（新 P1）"已清理"不可读**：`apps.data_cleaned_at` 已进入 `WasmApp`/管理列表
  响应；管理台生命周期块新增「数据清理时间」，`purged_at` 已置而 `data_cleaned_at` 为空时
  显示「不可恢复但清理仍在重试」（不再宣称"都已删除"）。
- **R2-P2-2 退役积压不可见**：`retirement.Scheduler.PurgeBacklog()` 暴露
  `blocked_no_snapshot` / `cleanup_pending`；`/admin/runtime` 新增 `purge` 段。
- **R2-P2-1 装配假绿**：新增 `cmd/server/wasm_runtime_wiring_test.go`，对
  `QueueStats/QueueApps/AppLimitsCount/AppLimitsEffective/PurgeBacklog/SchedulerStatus/
  retirementSched.Start` 的生产接线做源码级判据（删任意一行即红）。
- 旧注释修正：`retirement/scheduler.go` 的顺序注释、`MarkWasmAppPurged` 标注为
  测试/历史工具（生产走两阶段）；诊断版本文档补「空版本 = 老数据或准入前失败」。

**仍记录的 P2/P3（下一轮/需环境）**
- U-06 注入脚本只有契约级判据（真机需确认提示条在 asar 内可见）；应用面 wasm E2E 仍为 0。
- 导出/快照与真删缺文件级互斥（purge 已置 terminal 但盘上清理中时的并发导出）；
- `rejectedByApp` 长期只增不减（有界于曾撞队列的应用数）；
- D-07 描述回退目前由 enterprise 描述判据兜底（`check-authoring-claims` 未加反向模式）；
- 真机/多实例/磁盘满/大库快照/备份回滚演练/旧客户端兼容仍无法在本环境验证。

## 9. 本轮最终门禁与结论（2026-10-23 02:40）

| 门禁 | 结果 |
|---|---|
| `corepack yarn check` | **34/34 PASS**（17 workspace 包 + 17 根守卫） |
| `check-root-guards` | 17/17 PASS |
| server 全量（真 PG + `-tags=skills,apps,connectors`） | serverstore / wasmapp 全包 / router / cmd/server / serverauth / limits / skillseed 全绿 |
| webadmin | `tsc` 0；**60 文件 / 960 用例**通过 |
| client / host / enterprise | 516 / 462+ / 企业包测试通过（以 yarn check 为准） |
| 迁移守卫 | 0001–**0089** / **81** 个迁移 sha256 逐对拍 |
| 文档/域名/作者面守卫 | 全部通过 |
| 反证 | 第一轮 3 视角（P0=1→已修）、第二轮独立反证 P0=0（新 P1=1→已修；P2 已记录） |

**结论（诚实版）**：核心链路的 P0/P1 已清零并通过独立反证复核，门禁全绿；按"可上线运营"标准
本轮已达标。**但仍不是"零风险生产级"**：真机/三平台打包/生产数据根演练/多实例/磁盘满/大库快照
/旧客户端兼容未验证；剩余 P2 已在上节列出（导出与真删文件级互斥、U-06 注入脚本判据、应用面
wasm E2E 为 0 等）。**工作区 253 个文件尚未提交 git**，交付闭环还差一次提交与真机验证。

## 10. 剩余取舍（明确记录，不假装已解决）

| 项 | 现状 | 取舍理由 / 下一步 |
|---|---|---|
| 保留期策略 | **已可配**：`retirement_snapshot_retention_days`（1–3650，默认 90）进入限制项控制台，冻结/删除的 purge_after 按当前生效值计算，管理列表/审计同步 | 无"手动立即 purge"入口：不可逆动作需单独设计二次确认+审计+权限，本轮不做 |
| 导出/快照 vs 真删的文件级互斥 | DB 层用 purged_at 终态 + 管理面分开显示清理状态；文件系统无跨进程锁（单实例部署 R20） | 单实例下窗口极窄；多实例前必须补分布式锁/租约，届时连同导出一起改 |
| U-06 更新提示条 | 注入逻辑有单测/契约测试；asar 内可见性未真机验证 | 需打包版 + 真机截图确认 |
| 应用面 wasm E2E | `e2e-client.mjs` 目前零 wasm 断言 | 下一轮把"打开应用→骨架→加载→错误上报"接进现有 E2E |
| per-app 时间预算 | 明确不做（内存/时间预算保持全局控制台） | 进程级参数；若要做需单独设计 guest/wall/compile 的优先级 |
| 真机/生产演练 | 未做（三平台打包、真实 Electron、多实例、磁盘满、大库快照、备份回滚） | 需要 CI 打包产物与真机/演练环境；本环境只能做到源码+单测+真 PG |
| `rejectedByApp` | 只增不减（条数 ≤ 曾撞队列的应用数） | 有界；若要清理需设计"历史应用计数"语义，避免运维面数字突降 |
| 工作区提交 | 250+ 文件未提交（跨多条泳道） | 需要按生命周期/诊断/队列预算/客户端宿主/文档拆 commit 后提交 |

## 11. 本轮收尾门禁（2026-10-23 03:00 左右）

- `yarn check`：34/34 PASS；根守卫 17/17 PASS；迁移 0001–0089 / 81 个 sha256 对拍。
- server 真 PG 全量（tags）：serverstore / wasmapp 全包 / router / cmd/server / serverauth / limits / skillseed 全绿。
- `-race`：queue / applimits / readyz / serverstore purge+restore 并发用例通过。
- webadmin：960 用例（另加生命周期清理态用例后 54 在 apps-lifecycle 文件内）。
- 反证：第一轮 3 视角（P0=1 已修）、第二轮独立反证（P0=0，新 P1=1 已修）。
- 结论：**核心链路 P0/P1 已清零、门禁与 -race 通过**；上表取舍项与真机验证仍是"生产级"的剩余门槛。

## 12. 打包与真机验证进展（本轮）

- **Linux 打包成功**：`dist:linux` 产出 `ZeoKeel-Harness-2.9.1-x86_64.AppImage` 与 `.deb`
  （需把 `XDG_CACHE_HOME/ELECTRON_BUILDER_CACHE` 指到可写目录——沙箱 `/root/.cache` 只读）。
- **打包版客户端 E2E 全绿**：`e2e:client`（Xvfb + mock gateway + 打包产物）全部断言通过，
  报告 `packages/host/desktop/.e2e-report.md`。
- **注意（不能夸大）**：该 E2E 覆盖登录/侧栏/设置/账户/会话等客户端面，**仍未覆盖 WASM
  应用打开链路**（`e2e-client.mjs` 里 wasm 断言为 0）；Windows/macOS 打包、真实 Electron
  下应用窗口骨架/Sentry/存储清理、多实例与磁盘满演练仍未做。
- **提交**：本轮改动已提交 `102e1679c0 feat(wasm): production-grade hardening for the app platform`
  （257 文件；门禁在提交前全绿）。
