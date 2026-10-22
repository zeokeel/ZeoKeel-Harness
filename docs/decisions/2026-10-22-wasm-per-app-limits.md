# 限流默认值与 per-app 覆盖（2026-10-22）

- 状态：**已实施**
- 背景：2026-10-22 功能合理性审计的 **A11**（单用户单应用默认串行）与 **C-09**（只有一套全局旋钮，
  异常应用只能整体冻结，没有"单独限流/降额"档）。
- 用户口径（本轮）：**默认值按合理性取，管理员后台可以随时修改**。

## 1. 全局默认：`user_per_app_running` 1 → 2

### 为什么是 2

- **1 的代价落在最正常的用法上**：前端 `Promise.all([...])` 两个请求、页面初始化同时取
  "列表 + 当前用户配置"、应用内 AI 的一次读 + 一次写 —— 都合法，却因为单用户单应用只允许
  1 个在跑而**串行**；排队时间还计入 60 s 端到端墙钟（A11 的现场形态）。
- **2 不改变任何内存/容量账**：实例池乘数是 `max_instances`（全局 32），
  `app_running=4`、`user_global_running=4` 一个都不动；2 ≤ 4 ⇒ 单用户仍占不满一个应用的槽位，
  两个用户即可填满 4 个读槽。
- **不取 4 的理由**：4 会让单个用户可以占满整个应用的并发（4/4），"每用户上限"就退化成
  "和没有一样"；运营要放大是显式动作（全局控制台或 per-app 覆盖），不该是默认。
- **小机器档位自洽**：`FromProfile` 的 `clampCrossField()` 会把 `user_per_app_running`
  压到 `app_running` 之内（small 档全是 3 或更小），默认值改动不漏出非法组合。

### 管理员可改

已有控制台字段 `user_per_app_running`（`settings.wasm.limits`）保持不变：即时生效（`applimits.Validate`
保存即下发），范围 1–`app_running`，无需重启、无需重建镜像。

## 2. 新增：per-app 限流覆盖

### 2.1 模型

- 新增表 `wasm_app_limits`（迁移 **0087**）：
  `app_id TEXT PRIMARY KEY` + 四个**可空**整数
  （`app_running` / `app_queue` / `user_per_app_running` / `user_per_app_queued`）
  + `updated_at` / `updated_by`。
- **NULL = 继承全局**；非空 = 该应用的显式覆盖。没有覆盖行与"四列全 NULL"同义（读取时归一）。
- 生效值 = `全局 Limits` 复制后套用非空覆盖，然后**复用 `applimits.Validate()`**：
  这样 per-app 组合与全局保存走同一份判据（含 `user_per_app_running ≤ app_running`、
  `user_per_app_queued ≤ app_queue`、`app_running ≤ max_instances` 等），不产生第二套规则。
- 边界取向：**允许高于全局**（管理员显式动作），但**不得超过绝对上界**（`max_instances` /
  `MaxAppQueue` 等）；响应里给出 `exceeds_global: true` 的显式提示，UI 在保存前确认
  "该应用会比其他应用占用更多槽位"。审计记录实际值。

### 2.2 生效点（只有一处真源）

- `queue.Scheduler` 增加 per-app 覆盖表（内存）：`SetAppLimitOverride(appID, *AppOverride)` /
  `SetAppLimitOverrides(map)`；准入与唤醒时按 `effectiveOptionsLocked(appID)` 取该应用的四个值，
  其余字段（全局并发/墙钟）仍用全局。
- 保存路径（管理 API）在同一个请求里：落库 → 更新 Scheduler → 写审计；
  启动路径从库加载全部覆盖并在队列启动前套用。
- **不做**：per-app 内存上限、per-app 时间预算（全局控制台已有；per-app 只做并发/队列四轴，
  避免把"实例内存/编译预算"这种进程级参数做成按应用分叉）。

### 2.3 API（管理面，cookie 会话 + RBAC）

| 方法 | 路径 | 权限 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/server/admin/wasm-apps/:app_id/limits` | `capability:read` | 返回 `{app_id, global:{四个全局值}, override:{四个值或 null}, effective:{四个生效值}, exceeds_global:{...}}` |
| PUT | `/api/server/admin/wasm-apps/:app_id/limits` | `capability:write` | body `{app_running?,app_queue?,user_per_app_running?,user_per_app_queued?}`；`null`/空对象 = 清空覆盖；返回同样的视图 + `changed` |
| DELETE | 同上（可选等价于 PUT null） | write | 清空覆盖 |

- 校验失败：400/422 `VALIDATION`，`details.field` 点名，hint 给"全局值是多少、允许范围是多少"。
- 未知顶层字段 fail-loud（与全局 limits 信封同一纪律）。
- 审计动作 `wasm_app_limits_change`：detail 含 app_id、四个覆盖值（`null` 表示恢复继承）、
  `actor`/`actor_role=admin_session`。清空也同样留痕。
- 应用不存在 / 已删除：404（写面不泄露存在性；已删除应用不能设覆盖）。

### 2.4 运行期行为

- 保存后**即时生效**：新准入立刻按新值判定；收紧不会打断已在跑的请求（只影响新准入），
  收紧后已在队列里的等待者**不丢**：继续按 FIFO 等待，直到有槽或撞上端到端墙钟（按现有 429 语义返回，不静默丢弃）。
- 应用被冻结/删除时覆盖行保留（恢复后仍生效）；purge 不删覆盖行（owner 元数据随 tombstone）。

### 2.5 管理台（webadmin）

- 应用详情抽屉新增「限流」块（与「生命周期」「数据」同级）：
  - 四行输入，占位符显示**全局默认值**；空 = 继承；「恢复默认」按钮清空；
  - 保存前展示 `effective` 与 `exceeds_global` 警告（超过全局值时需二次确认）；
  - 保存失败原样显示服务端信封；保存成功回读服务端视图（不乐观更新）。
- 列表行不新增列（避免把"例外"变成日常噪音）；详情里可见即可。

### 2.6 测试与判据（每条可变异打红）

1. 默认值：`applimits.Defaults().UserPerAppRunning == 2`；`limits.json`/`limits.md`/SKILL references
   由生成器重生成且逐字节门禁绿；small 档折叠后 `Validate()==nil`。
2. 存储：GET/PUT/清空/幂等；四列为 NULL 时归一为"无覆盖"；已删除应用 404。
3. 校验：`user_per_app_running > app_running` 拒；`app_running > max_instances` 拒；
   未知顶层字段拒；`null` 顶层清空；空对象 = 清空。
4. 生效：给应用 A 设 `app_running=1` ⇒ 同应用第 2 个并发请求排队（其他应用不受影响）；
   给应用 B 设 `app_running=4` 而全局 2 ⇒ B 能到 4、A 仍 1；删覆盖后回到全局。
   变异：删掉 `effectiveOptionsLocked` 的覆盖读取 ⇒ 用例红。
5. 审计：每次保存/清空一条 `wasm_app_limits_change`，detail 含覆盖值；无变化重复 PUT 不写审计（幂等）。
6. 启动：库里已有覆盖 ⇒ 装配后首次请求即按覆盖判定（不是等管理员再保存一次）。
7. 管理台：空显示全局默认；保存发对请求体；`exceeds_global` 警告出现；清空走 null；
   失败不乐观更新。

## 3. 不做什么

- 不做 per-app 内存/时间预算（进程级参数，保持全局控制台）。
- 不做"按应用自动限流/熔断"（需要请求分布建模；先给管理员手动档）。
- 不改 `user_global_running=4`、`app_running=4`、`app_queue=32` 的默认（现有理由仍成立）。

## 4. 实施记录（2026-10-22）

- **默认值**：`limits.UserPerAppRunning = 2`；`go generate ./internal/limits` 重生成
  `limits.json`/`limits.md` 与 `server/skills/app-builder/references/limits.md`；SKILL/作者手册/
  诊断参考同步（技能内容变 ⇒ SKILL 版本按纪律递增并登记摘要）。
- **取值形态**：内存/JSON 用 `limits.AppOverride`（四个 int，**0 = 继承**）；DB 用可空列
  （**NULL = 继承**），DAO 读取归一到 0；API 视图把 0 渲染成 `null`。
- **套用规则唯一实现**：`limits.Axes.Resolve`（`applimits.ApplyOverride` 与
  `queue.effectiveOptionsLocked` 同一份）：
  - 非 0 覆盖直接生效；
  - **继承的**子轴在父轴被收紧时向下钳（`app_running=1` ⇒ 继承来的 `user_per_app_running≥1`
    钳到 1、`app_queue=1` ⇒ 继承来的 `user_per_app_queued` 钳到 1）——
    这让"把某应用整体降成串行"成为一条合法且常用的覆盖；仅收紧、绝不放宽。
  - 显式给出非法组合（如 `user_per_app_running=3` 配 `app_running=2`）不钳，按 `Validate` 拒。
- **生效点**：`queue` 的 `canRunLocked` / `Acquire` 队列容量与用户占位 / `pumpAppLocked`
  全部改为按 `effectiveOptionsLocked(appID)`；`Release` 唤醒同源。收紧不打断在跑，
  放宽立即 pump（否则"改了没反应"）；清空覆盖立即回到全局。
- **API**：GET/PUT/DELETE `/api/server/admin/wasm-apps/:app_id/limits`（read/write），
  body `null`/`{}`/四键；响应 `{app_id, global, override, effective, exceeds_global, changed}`；
  幂等无变化不写审计；审计动作 `wasm_app_limits_change`（app 维度 + 四值与 null）。
- **启动**：`loadWasmAppLimitOverrides` 读全表、按**当前全局值**再校验（全局被调小后，
  旧覆盖可能已非法 ⇒ 跳过并 warn，该应用回到全局值），整表替换进调度器。
- **管理台**：应用详情「限流」块（占位符=全局默认、空=继承、恢复默认、有效值预览、
  超过全局二次确认、失败不乐观更新、已删除/已清除不发请求）；审计标签已登记。
- **运行期全局变化**：保存全局限制项时按新全局值重校验在册覆盖；非法条目从库删除并写
  `wasm_app_limits_change`（actor=system）审计，合法条目整表重新下发（反证 F-6）。
- **边界取向**：允许 per-app 高于全局（管理员显式动作 + UI 二次确认），但不超过绝对上界
  （`max_instances` / `MaxAppQueue`）；`exceeds_global` 如实下发。

## 5. 验证

- `go build ./...`（含 `-tags=skills,apps,connectors`）通过；`go vet` 通过；`gofmt` 干净。
- 定向（真 PG 15436 + `-tags=skills,apps,connectors`）：`serverstore`（0087/DAO，~460s）、
  `api`（GET/PUT/DELETE、鉴权、404、幂等、审计、0=继承、重复 PUT 自愈，~212s）、
  `applimits`/`queue`/`limits`/`skillseed`/`router`/`diag`/`cmd/server` 全绿。
- 反证后补的判据：放宽/清空覆盖**立刻唤醒**已排队者（删 `pumpAllLocked` 必红）、
  `PUT {"app_running":0}`=继承且全 0=清空、重复 PUT 在调度器漂移时重新下发、
  全局收紧后 `reconcileWasmAppLimitOverrides` 清库+审计、三条新路由的 read/write 级别。
- 前端：`tsc --noEmit` + 全量 vitest **57 文件 / 927 用例通过**。
- 全仓门禁：`corepack yarn check` = **planned 34 / executed 34 / 34 通过**
  （17 个 workspace 包 + 17 条根守卫）；`check-root-guards` 17/17 PASS。
- 迁移守卫：0001–0087 / 79 个文件 sha256 逐条对拍通过；文档区间、`doc-claims`、域名守卫通过。
