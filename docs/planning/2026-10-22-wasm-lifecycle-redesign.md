# WASM 应用平台生命周期重设计（对齐 Cloudflare Workers 模型）

- 日期：2026-10-22
- 状态：**设计定稿，实施中**（目标版本 v2.10 系列；本文是实施契约，代码以本文为准）
- 基线：`master` @ `1143238ca9`（`release: v2.9.1`）
- 触发：2026-10-22 功能合理性审计（`docs/planning/2026-10-22-wasm-feature-rationality-audit.md`）
  + 用户要求：「整体生命周期不太好，参考 Cloudflare Workers 那种设计；但运行时必须是 WASM」
- **硬约束（不可协商）**：执行面**仍然是 WASM**（Go `wasm32-wasip1` + 现有 wazero 沙箱、
  现有 ABI/宿主调用/隔离模型）。本设计**只借 CF 的版本与部署语义**，不引入 V8 isolate、
  不换成容器、不改应用的执行方式与安全边界。
- 参考（外部资料只作设计参照，不作为本仓规范）：
  - [Cloudflare Workers · Versions & Deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)
  - [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
  - [Gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)

## 0. 一句话

现在只有「版本（release）」，没有「部署（deployment）」：**生效版本 = 最新 approved 的隐式推导**，
于是没有回滚、没有部署历史、没有明确的"谁在什么时候把哪一版放上线"，冻结/删除的承诺也没有执行者。
重设计把 CF Workers 的两层模型搬过来，**仍然跑 WASM**：

- **Version（版本）= 不可变的 wasm 制品 + 随包配置**（现有 `app_releases`，补齐状态机）；
- **Deployment（部署）= 把某个 version 指为线上版本的一次不可变动作**（新表，含 actor/角色/原因）；
- **Current = 最新一次 deployment 的指针**（`apps.current_release_id` 仍是运行期唯一真源，
  新增 `apps.current_deployment_id` 作为历史链指针）；
- **回滚 = 用旧 version 再部署一次**（不重传、不重审、追加一条 deployment，历史不改写）；
- **冻结 → 只读快照 → 保留期 → 真删** 由真正的后台作业执行，并登记进调度状态表。

## 1. 现状与病根（证据见审计汇总）

| 病根 | 现状 | 后果 |
| --- | --- | --- |
| 生效版本是隐式推导 | `serverstore.LatestApprovedWasmReleaseMeta`；`api/admin.go:672-676` | 管理员不能退回旧版、不能撤掉坏版本；只能整体下架/冻结 |
| 没有部署历史 | `apps.current_release_id` 只有当前值 | 回答不了「谁在何时把哪一版上线」；回滚无落点 |
| 冻结/退役承诺无执行者 | `api/read.go:929/933`、`api/release.go:25/229-230` 自认未实现 | 冻结=永久封存；UI/审计链/limits 表四处假承诺（C-01） |
| 删除不可恢复、无管理动作 | `serverstore/wasmapps.go:644`（无 restore）、管理面 18 条无 delete/restore/export | C-04/C-02 |
| 审核驳回/撤回无终态 | 驳回=版本号永久烧掉；pending 无撤回/清理 | C-08/A8 |

## 2. CF Workers → 本平台映射

| CF Workers | 本平台（保持 WASM） | 说明 |
| --- | --- | --- |
| Worker | App（`apps.kind='wasm_app'`） | 长期身份；`app_id` 不可改名 |
| Version（不可变，可只上传不部署） | Release（`app_releases`，archive=wasm 字节） | 已存在；补 `withdrawn` 终态 |
| Deployment（把 version 指为线上） | **新增 `wasm_app_deployments`** | 不可变、追加式、含 actor/角色/原因 |
| Deployment history / `wrangler deployments list` | 部署历史端点 + 管理端/作者端列表 | 新 |
| `wrangler rollback [version]` | `POST …/deployments {version}`（kind=rollback） | 用旧版本重新部署，不重审 |
| Version 不可变、版本号不复用 | 版本号永久占位（现状已如此） | 明确写进作者文档：**驳回/撤回/删除都占号** |
| Worker 删除 → 版本与部署清理 | 软删 → 快照 → 保留期 → 真删（tombstone 保留） | 合规需要保留期，与 CF 直接删不同；本平台明确区分 |
| Gradual deployment（百分比） | **本阶段不做**（列为后续） | 需要请求级分流；与现有单槽并发模型要先拍板 |

## 3. 状态机

### 3.1 应用（App）

```
                 publish/unpublish                freeze
  active(在线) ⇄ unpublished(下架) ───────────────▶ frozen(冻结，停止服务 + 快照 + 保留期)
      │                │                                │
      │ delete         │ delete                         │ delete / 保留期
      ▼                ▼                                ▼
  deleted(软删，可恢复) ──────── restore ──────▶ frozen? / unpublished（不自动上架）
      │
      │ purge_after 到期 + 快照存在
      ▼
  purged(真删完成：制品/应用库/资源/快照已删；apps/releases/deployments 元数据留作审计 tombstone)
```

- 线上服务判定（运行期）：`enabled=1 AND frozen_at IS NULL AND deleted_at IS NULL AND purged_at IS NULL`；
  其中任一不满足即 404（现有 `app_frozen`/已删语义不变）。
- `purged` 之后：restore/export 数据面一律 410 `APP_PURGED`；控制面元数据导出仍可用（说明已清除）。

### 3.2 版本（Release）

```
upload ──▶ pending ──approve──▶ approved ──deploy──▶ (线上/历史)
              │  │
              │  └─withdraw──▶ withdrawn（作者撤回；字节释放；版本号永久占用）
              └─reject──────▶ rejected（版本号永久占用；必须升版本号重发）
```

- `approved` 是**可部署**状态，不等于线上（CF 语义）。
- `withdrawn` 是新增终态：仅 pending 可撤回；写入 `deleted_at`? **不写**——保留行与版本号占位，
  只清 `archive`、`size=0`、`status='withdrawn'`、`reason='作者撤回'`。
- `rejected` 维持现状（永久占用）；审批驳回的 UI 必须提示影响面（A8）。

### 3.3 部署（Deployment，不可变）

| kind | 触发 | 规则 |
| --- | --- | --- |
| `publish` | 审核关闭时发布成功 / 作者显式部署最新 approved | 目标 = 最新 approved 时为 `publish` |
| `review` | 管理员审批通过 | 部署**最新 approved**（保持现有 `max(id) approved` 语义）；审批更旧版本不降级 |
| `rollback` | 作者/管理员显式部署一个非最新 approved 版本 | 不重审、不重传；旧版本必须仍 approved 且有字节（或快照期可读） |
| `seed` | 内置演示应用播种 | 与 `publish` 同语义，来源可辨 |
| `legacy` | 迁移回填 | 只为存量应用补一条历史，`actor=''`、`actor_role='legacy'` |

不变量：
- 只有 `approved` 版本可被部署；`pending/rejected/withdrawn` 一律 409 `RELEASE_NOT_DEPLOYABLE`。
- 冻结/删除/清除的应用不可部署（409 `APP_FROZEN` / 404）。
- 部署目标是当前版本 → 200 `changed:false`（幂等，不追加历史、不写审计）。
- 每次真正变更：一个事务内（`SELECT … FOR UPDATE` apps 行）插 deployment + 更新
  `current_release_id`/`current_deployment_id` + 投影（title/config_json/purpose/data_sensitivity）+
  写审计 `wasm_app_deploy`（detail 含 `deployment_id/version/kind/actor_role`）。
- 部署历史**永不删除**（真删也不删）。

## 4. 数据模型（迁移 `0086_wasm_app_deployments.sql`）

```sql
-- 1) apps：部署指针 + 退役/快照/清理时间线
ALTER TABLE apps ADD COLUMN IF NOT EXISTS current_deployment_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS snapshot_at           TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS snapshot_path         TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS snapshot_error        TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS purge_after           TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS purged_at             TIMESTAMPTZ;

-- 2) 版本状态机补 withdrawn
ALTER TABLE app_releases DROP CONSTRAINT IF EXISTS app_releases_status_check;
ALTER TABLE app_releases ADD CONSTRAINT app_releases_status_check
  CHECK (status IN ('pending','approved','rejected','withdrawn'));

-- 3) 部署历史（不可变、追加式；**不加外键**：真删后历史仍要留）
CREATE TABLE IF NOT EXISTS wasm_app_deployments (
  id          BIGSERIAL PRIMARY KEY,
  app_id      TEXT NOT NULL,
  release_id  BIGINT NOT NULL,
  version     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('publish','review','rollback','seed','legacy')),
  actor       TEXT NOT NULL DEFAULT '',
  actor_role  TEXT NOT NULL DEFAULT '',  -- owner | super_admin | admin_session | system | seed | legacy
  message     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wasm_app_deployments_app
  ON wasm_app_deployments(app_id, id DESC);

-- 4) 回填：每个 current_release_id>0 的存量应用补一条 legacy 部署并指过去（幂等）
INSERT INTO wasm_app_deployments (app_id, release_id, version, kind, actor_role, message, created_at)
SELECT a.app_id, r.id, r.version, 'legacy', 'legacy', '迁移回填（0086）', COALESCE(a.updated_at, now())
FROM apps a JOIN app_releases r ON r.id = a.current_release_id
WHERE a.kind = 'wasm_app' AND a.current_release_id > 0
  AND NOT EXISTS (SELECT 1 FROM wasm_app_deployments d WHERE d.app_id = a.app_id);
UPDATE apps a SET current_deployment_id = d.id
FROM (SELECT DISTINCT ON (app_id) id, app_id FROM wasm_app_deployments ORDER BY app_id, id) d
WHERE a.kind='wasm_app' AND a.app_id = d.app_id AND a.current_deployment_id = 0;
```

迁移纪律：追加 `0086`；**必须**同步 `server/internal/serverstore/migrations-checksums.json`
（`node scripts/check-migration-range.mjs --print-checksums > …` 的同一算法），否则
`TestMigrationChecksumsMatchJSRegistry` 红。

## 5. 语义细则（实现必须逐条覆盖）

### 5.1 部署 / 回滚
- 事务内 `SELECT … FROM apps WHERE kind='wasm_app' AND app_id=$1 FOR UPDATE`；404 if missing。
- `deleted_at`/`frozen_at` 非空 → 409（错误码 `APP_DELETED` / `APP_FROZEN`）。
- release 必须存在且 `status='approved'`；`archive IS NULL` 且非冻结/删除期 → 409
  `RELEASE_BYTES_RELEASED`（存量软删已释放字节的版本不可再部署）。
- kind 判定：`releaseID == latestApprovedID ? 'publish' : 'rollback'`。
- 投影与 `current_release_id` 同步更新（复用现有 `syncAppProjection` 的字段语义，但**目标版本是本次
  deployment 的版本**，不再自行取 max approved；审批路径仍取 max approved）。
- 审计：员工面 `actor_role=owner` / 超管兜底 `super_admin`；管理面 `admin_session`；播种 `seed`。
- 幂等：目标 == 当前 → `changed:false`，**不**插入历史、不写审计。

### 5.2 审批（review）
- approve：`SetReleaseStatusForReview(approved)` → 若**本次被批准的版本**比当前部署版本新，则部署
  **它**（kind='review'，actor=审批管理员，role=admin_session）；比当前旧/相等则只标记通过、
  **不部署**（不降级、也不跳到别的版本）。
  - 2026-10-22 终轮反证订正：旧语义是"部署 `max(id) approved`"，于是回滚到 v1 之后审批一个
    无关/更旧的 pending 版本，会把线上静默推回最新版本（回滚被撤销）。审批的目标只能是
    "这一个版本"；"新"按 **SemVer**（`util.CompareSemVer`）比较，不能按 release 行 id
    （行 id 只反映落库顺序：回滚到 3.0.0 后补交 0.9.0，id 更大但版本更旧）。
- reject：保持现状；返回/审计明写「版本号永久占用，重发需升版本号」（A8）。

### 5.3 撤回（withdraw）
- `POST …/releases/:version/withdraw`：仅 `pending` 且属本人（或超管）；事务内
  `status='withdrawn', archive=NULL, size=0, reason='作者撤回'`；写审计 `wasm_app_release_withdraw`。
- 非 pending → 409 `RELEASE_NOT_PENDING`；版本号永久占位（文档/UI 明写）。

### 5.4 冻结 / 快照
- 冻结：`frozen_at=now`、`enabled=0`、`purge_after=frozen_at+RetirementSnapshotRetentionDays`（90d）；
  **立即**尝试快照（失败不阻断冻结，但 `snapshot_error` 落库、调度器重试；**快照成功前禁止 purge**）。
- 快照内容（目录 `<data_root>/apps/<app_id>/snapshots/<RFC3339>/`）：
  `export.json`（现有控制面导出体 + lifecycle 字段）+ `app.db`（`VACUUM INTO` 只读快照）。
  成功：`snapshot_at/path` 落库；失败：`snapshot_error`，重试。
- 解冻：清 `frozen_at/purge_after/snapshot_*`，并**尽力删除**快照目录；不自动上架。
- 快照与导出共用同一实现（`internal/wasmapp/lifecycle` 包），避免两份口径。

### 5.5 删除 / 恢复 / 真删
- 删除（作者或管理员）：
  1. 若未冻结：先冻结（同一时刻）+ 先做快照；**快照失败 = 删除失败**（fail-closed，返回可操作错误）。
  2. 软删（现有 `SoftDeleteWasmApp` 释放 archive 字节）+ 记 `deleted_at`、`purge_after`；
  3. 审计 `wasm_app_delete`（detail 含保留期、快照路径、actor_role）。
- 恢复（作者或管理员，`POST …/restore`）：
  - `purged_at` 非空 → 410 `APP_PURGED`；
  - 清 `deleted_at/frozen_at`，`enabled=0`（**不自动上架**），保留 `purge_after`? 清空；
  - 写审计 `wasm_app_restore`（actor_role 可辨）。
- 真删（scheduler，每日 tick）：
  - 条件：`kind='wasm_app' AND deleted_at IS NOT NULL AND purged_at IS NULL AND purge_after <= now`；
  - **必须** `snapshot_at IS NOT NULL`，否则本轮跳过并记错误（不删数据）；
  - `os.RemoveAll(<data_root>/apps/<app_id>)`（db/assets/snapshots 一并删）；`purged_at=now`、
    `enabled=0`、清 `current_release_id/current_deployment_id` 指针（历史行保留）；
  - 审计 `wasm_app_purge`（`actor='system'`，detail 含 app_id、删除路径、时间）；
  - 自记账 `Runs()/Errors()/LastRunAt()`，登记进 `cmd/server/scheduler_status.go`（名字 `wasm_retirement`）。

### 5.6 导出（管理员与作者）
- `GET …/export`（现有 JSON 控制面）增加 `?database=1&assets=1`：
  - JSON 保留（默认，向后兼容），`lifecycle` 段补 `frozen_at/deleted_at/purge_after/purged_at/snapshot_at`；
  - `database=1` → `application/zip`：`export.json` + `app.db`（VACUUM INTO 快照）；
  - `assets=1` → zip 内再加 `assets/<release_id>/…`（从磁盘现有资源目录复制；已清理由 `purged` 决定）；
  - 每次导出写审计 `wasm_app_export`（detail 含 `database/assets/actor_role`、**不含行内容**）。
- 管理面新增同名端点（cookie 会话 + `capability:read`），审计记 `admin_session`。

### 5.7 待审队列
- `GET /admin/wasm-apps/releases/pending`：跨应用清单（app_id/title/version/publisher/age/current_version），
  管理端页头徽标可点直达；处置复用现有 approve/reject。
- 关闭审核开关时，提示「现有 N 个 pending 将失去意义」并给出清理动作（可选：`purge-stale` 标 `withdrawn`，
  reason='审核关闭后清理'，需管理员显式确认）。

## 6. API 契约（新增/变更；路径前缀省略）

### 6.1 员工面（Bearer，owner 或 super_admin）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/client/v2/apps/wasm/:app_id/deployments` | 部署历史（含 current 标记） |
| POST | `/api/client/v2/apps/wasm/:app_id/deployments` | body `{version,message?}`：部署/回滚 |
| POST | `/api/client/v2/apps/wasm/:app_id/releases/:version/withdraw` | 撤回 pending |
| POST | `/api/client/v2/apps/wasm/:app_id/restore` | 恢复软删（未 purge） |
| GET | `/api/client/v2/apps/wasm/:app_id/export?database=1&assets=1` | 导出（JSON 或 zip） |

### 6.2 管理面（cookie 会话 + RBAC）
| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/server/admin/wasm-apps/releases/pending` | read | 跨应用待审清单 |
| GET | `/api/server/admin/wasm-apps/:app_id/deployments` | read | 部署历史 |
| POST | `/api/server/admin/wasm-apps/:app_id/deployments` | write | 部署/回滚 |
| POST | `/api/server/admin/wasm-apps/:app_id/restore` | write | 恢复 |
| DELETE | `/api/server/admin/wasm-apps/:app_id` | write | 删除（软删 + 快照） |
| GET | `/api/server/admin/wasm-apps/:app_id/export` | read | 导出（同员工面参数） |

统一信封：成功 `{...}`；失败沿用 `{"error":{"code","message","hint","details"}}`。
错误码新增：`RELEASE_NOT_DEPLOYABLE`、`RELEASE_NOT_PENDING`、`APP_FROZEN`、`APP_DELETED`、
`APP_PURGED`、`RELEASE_BYTES_RELEASED`。

路由注意：管理面静态段 `releases/pending` 必须在 `/:app_id` 通配之前注册；把新顶层静态段
（`releases`/`deployments`）登记进 `WasmAppIDReservedSegments` 与 `wasm_appid_route_test.go` 的派生集合。

## 7. Webadmin（管理台）契约

- 应用行操作：`部署/回滚`（版本选择器：只列 approved，标当前/最新）、`删除`、`恢复`（已删除行）、
  `导出`（JSON / 含数据 / 含资源）。
- 详情抽屉新增「部署历史」：id/version/kind/actor/actor_role/created_at/current 标记；
  「生命周期」块：frozen_at / deleted_at / purge_after / snapshot_at / purged_at。
- 待审队列：页头徽标可点 → 待审清单（跨应用、内联通过/拒绝、理由必填）。
- 冻结确认框文案改为**真实语义**：快照是否已生成、`purge_after` 具体日期；已 purge 的应用显示
  「数据已清除，不可恢复」。
- 「已删除」行只保留只读详情 + 恢复 + 导出；其余动作不渲染（C-11）。
- 测试：上述交互的行为级用例；冻结文案与后端真实语义对拍（禁止再出现"后台任务"未实现的措辞）。

## 8. 客户端（作者/员工）契约

- 应用详情「版本历史」增加：`设为此版本（回滚）`（仅 approved、非当前）、`撤回`（仅 pending）。
- 部署历史只读列表（最近 N 条 + 当前版本）。
- 发新版：`firstRelease` 由 `current_version` 推导；本地版本递增校验 + 「建议下一版」；
  数据敏感度/用途/负责人默认沿用上次（F-02/F-03）。
- 应用窗口错误页加动作槽（重试/重新登录），`version-unverified` 显示提示条（F-04）。
- 下架/冻结/删除/恢复后清理应用 origin 浏览器存储（F-07，精确到 app origin）。
- 详情页应用 AI 面板：补宿主本机路由或降级 UI（F-01，必须带可达性判据）。
- 应用中心入口与「更多」浮层（F-10）本阶段只记录，不改导航结构（等产品拍板）。

## 9. 测试与验收（每条都要能被变异打红）

1. 迁移：0086 幂等重放；回填恰好一条 legacy/应用；`withdrawn` CHECK 生效；checksums 对拍。
2. 部署：非 approved 409；frozen/deleted 409；幂等 changed=false；成功插历史+更新投影+审计；
   回滚到旧 approved 后 `current_release_id` 与 `/request` 生效版本一致（行为级：请求打到旧版本资源）。
3. 审批：approve 部署 max approved；更旧版本审批不降级；reject 提示占号。
4. 撤回：pending→withdrawn、字节释放、版本号仍占位、非 pending 409；作者不能撤他人版本。
5. 快照/冻结：冻结后快照落盘且 DB 记录；快照失败不 purge；解冻清状态不自动上架。
6. 删除/恢复：删除前必须快照；恢复后不自动上架、可再 publish；purged 后 restore 410。
7. 真删：只有 `purge_after<=now AND deleted AND snapshot_at NOT NULL` 才删；数据目录消失、
   元数据/部署历史保留、审计一条；调度器 Runs/Errors/LastRunAt 可读；登记进 scheduler_status。
8. 导出：JSON 兼容；`database=1` zip 含可打开的 app.db；`assets=1` 含资源；审计不含行内容。
9. 路由/鉴权矩阵：员工面 owner/非 owner/超管；管理面 read/write 权限；静态段不被 `:app_id` 遮蔽。
10. 反向验证（子代理执行）：删掉 `status='approved'` 判据、`purge_after` 判据、快照前置条件、
    审计 actor_role 任一条，对应用例必须红（不许改测试来变绿）。

## 10. 非目标 / 后续

- **不做**渐进式部署（百分比分流 / canary）：先解决"有没有部署概念"；百分比需要请求级分流与
  单槽并发模型一起拍板。
- **不做**多环境（staging/production）：CF 的 environments 语义留待后续；本平台仍是单环境 + 审核开关。
- **不改**执行面：仍 Go→WASM、wazero、现有 ABI/上限/宿主调用；本文所有新能力都只围绕制品与指针。
- 应用改名仍不支持（CF 语义：Worker 名即身份）。

## 11. 实施拆分（写作用域，互不重叠）

| 泳道 | 写作用域 | 内容 |
| --- | --- | --- |
| **L**（服务端生命周期，Lead/主实现） | `server/internal/serverstore/**`、`server/internal/wasmapp/api/**`、`server/internal/wasmapp/lifecycle/**`（新）、`server/internal/router/**`、`server/cmd/server/**` | 迁移 0086、部署/回滚/撤回/恢复/导出/待审、快照+真删调度器、审计、路由与测试 |
| **W**（webadmin） | `server/webadmin/src/**`（应用中心相关）、`server/webadmin/package.json` 不动 | 动作、部署历史、生命周期、待审队列、文案对拍、测试 |
| **C**（客户端/宿主） | `packages/client/wasm-apps/**`、`packages/host/wasm-apps-host/**`、`packages/host/desktop/src/**`、`packages/host/enterprise/src/**` | F-01/F-02/F-03/F-04/F-07 + 部署历史/回滚/撤回 UI |
| **A**（作者/运行时反馈，第二轮） | `server/internal/wasmapp/{appserver,queue,appcfg,events,diag}`、`server/internal/limits/**`、`server/internal/wasmapp/assets/**`、`server/skills/app-builder/**`、相关 docs | A1–A11（诊断丢弃、编译排队、白名单提示、响应上限文案、驳回提示、单一真源、文档） |

顺序：L 与 W/C 可并行（API 契约以本文 §6 为准）；A 在 L 合并后开始（避免 `api/read.go` 冲突）。
每批完成后必须跑：`cd server && go build ./... && go test ./internal/serverstore/ ./internal/wasmapp/... ./internal/router/`
（定向包）、`cd server/webadmin && npx vitest run src/pages/app-center`、客户端两包 `yarn test`；
最后统一跑 `corepack yarn check`（或 `check:fast`）与 `node scripts/check-migration-range.mjs`。

## 12. 认账

- 本文借用了 CF 的**概念与语义**，但部署记录、保留期、tombstone 的具体形态是本平台按合规需求定的；
  与 CF 不完全一致之处已在 §2/§10 写明。
- 快照与真删涉及真实磁盘操作，实施必须带临时目录测试；生产环境首次上线前需要一次
  「冻结→快照→恢复→删除→真删」的端到端演练（不在本设计内，列入发布检查单）。

## 13. 实施记录与决策（2026-10-22，第一/二轮）

### 13.1 已落地（均有行为级用例；详见 `temp/wasm-audit-2026-10-22/` 的 lane 报告）

- **迁移 0086**：`wasm_app_deployments`（不可变、无外键）+ apps 六列（`current_deployment_id` /
  `snapshot_at/path/error` / `purge_after` / `purged_at`）+ `app_releases.status` 补 `withdrawn`
  + 存量 legacy 回填（每应用至多一条、重放零行）；`migrations-checksums.json` 与文档区间同步。
- **serverstore**：`DeployWasmRelease`（FOR UPDATE、终态/approved/字节三重判据、幂等、kind 判定、
  指针+投影单事务）、部署历史、撤回、恢复、purge 候选/blocked、快照记录、待审队列/计数。
  publish / approve / appseed 全部收敛到部署事务，`SetWasmAppCurrentRelease` 无生产调用点。
- **lifecycle 包**：快照（`export.json` + `VACUUM INTO app.db`）、JSON/zip 导出、真删的唯一磁盘实现。
- **retirement 调度器**：`wasm_retirement` 每日 tick，先补快照 → 只删 `deleted + 到期 + snapshot_at 非空`
  → `purged_at` + 清指针 + `system` 审计 + 自记账，已登记进调度状态表。
- **API**：员工面 deployments GET/POST、withdraw、restore；管理面 pending/deployments/deploy/restore/
  DELETE/export；六个生命周期错误码；每写动作审计含 `deployment_id/version/kind/actor_role`。
- **管理台**：部署/回滚、删除、恢复、导出、部署历史、生命周期块、跨应用待审队列、冻结/删除回执
  改为真实语义（快照是清理前置、`purge_after` 具体日期、purged 不可恢复）。
- **客户端**：F-01（详情页 AI 走宿主本机路由，与协议 handler 共用同一 `handleAiChat`）、F-02/F-03/F-04/F-07、
  回滚/撤回/部署历史 UI；`data_sensitivity` 作者目录字段对拍与预填。
- **作者反馈**：`MODULE_LOAD_QUEUED`（平台排队不再报成"请求取消"）、响应体三层上限文案、
  资源路径上限单一真源、作者文档路径与编号修正。

### 13.2 实施中的决策（与本文原文的偏差；均为 fail-closed 方向）

1. **`assets=1` 只打包现存历史资源目录**：2026-09-20 起随包资源在内存直出、磁盘通常没有
   `assets/`；zip 不伪造空目录，`export.database.included` 按事实写。
2. **purged 后数据面导出 410**：`?database=1|?assets=1` 对 purged 应用回 `APP_PURGED`；
   不带参数的 JSON 控制面导出仍 200（§3.1「控制面元数据导出仍可用」）。
3. **调度器 `Errors` = 失败/被跳过的应用数**（Runs = 轮数），类型注释已写明 —— 比"按轮"多保留
   "哪个应用删不掉"的读数。
4. **快照失败重试**：按 §5.4 每轮先补快照再判真删；重试仍失败则不删并计错误。
5. **审批遇冻结应用**：状态落库成功、部署被 409 `APP_FROZEN` 拒，响应带可操作 hint
   （解冻后重试幂等），不谎报"已生效"。
6. **员工面对已删除应用的部署**回 409 `APP_DELETED`（§5.1），其余写动作仍 404（不泄露存在性）。
7. **管理面不提供 withdraw 端点**（§6.2 未列）：管理面用 reject 处置，作者撤回走员工面。
8. **冻结/解冻不清客户端浏览器存储**（第二轮反证后的产品口径）：冻结 = 只读快照、数据保留；
   清理只发生在**下架/删除**（且必须在服务端确认状态真的变化时）。打开失败 404/410 仍清理。
   本文 §5.4 未定义客户端存储，此项以审计 R-02 与客户端文案「数据仍然保留」为准。
9. **待审数单一真源**：徽标与跨应用队列都用「排除已删除/已清除应用」的待审集合；队列 `total`
   用 `COUNT(*)`（不是本页行数），避免 200 硬上限造成两数分叉。
10. **AI 桥本机路由体量**：`bodyLimit` 覆盖 `64 条 × 16 KiB + JSON 信封`（不是恰好 1 MiB），
    避免合法请求在 413 处失败。
11. **审批只部署"本次批准的版本"**（终轮反证）：比当前部署版本新才上线，否则只标记通过；
    与"部署 max approved"相比，回滚不会被一次无关审批静默撤销；`/open` 同样按部署指针报版本。
12. **作者 `data_sensitivity`**：服务端按 isOwner 下发；客户端目录行解析、表单预填、发新版
    「留空 = 省略 = 沿用」；`CATALOG_ROW_AUTHOR_FIELDS` 已加入对拍。

### 13.3 验证基线（2026-10-22 实跑）

- 服务端：`go build ./...`（含 `-tags=apps`）；`go test ./internal/serverstore/ ./internal/wasmapp/... ./internal/router/ ./cmd/server/`
  真 PG 全绿；`check-migration-range.mjs`（0001–0086，78 文件 checksum 对拍）与 `check-no-real-domains.mjs` 通过。
- 管理台：`tsc --noEmit` + `vitest run`（54 files / 830 tests）全绿。
- 客户端：两包 typecheck + test（500 / 432）全绿；enterprise 路由表对拍、desktop runner 对拍通过。
- 全仓门禁：`corepack yarn check` = **planned 34 / executed 34 / 34 通过**（17 个 workspace 包 + 17 条根守卫，含 wasm-client-only、migration-range、doc-claims、no-real-domains）；`check-root-guards` 17/17 PASS。
- 独立反证：`refute-client.md` / `refute-webadmin.md`（以及最终轮的服务端反证）逐条给断言判定、
  假绿清单与变异命令；发现项在第二轮修复。
