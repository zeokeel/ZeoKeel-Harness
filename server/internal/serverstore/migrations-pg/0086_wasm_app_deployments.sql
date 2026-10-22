-- 0086: WASM 应用平台生命周期重设计（Cloudflare Workers 式「不可变版本 + 不可变部署 +
-- 指针回滚」，设计契约 docs/planning/2026-10-22-wasm-lifecycle-redesign.md §4）。
--
-- 背景（审计 2026-10-22 C-01/C-02/C-03/C-04/A8）：
--   * 生效版本此前是**隐式推导**（max(id) approved），既没有部署历史也无法回滚；
--   * 冻结/退役承诺的「只读快照 + 90 天保留 + 到期真删」没有任何执行者；
--   * 审核驳回/作者撤回没有终态，pending 行永久积压。
-- 本迁移只加**数据面**：部署历史表（不可变、追加式）、apps 上的部署指针与退役时间线列、
-- 版本状态机补 withdrawn。执行面（Go wasi32 + wazero）一字未动。
--
-- 幂等纪律（与 0080/0081/0082/0085 同口径）：本文件必须可重放 —— 测试夹具会把库退回
-- 0080 之前再整段重放，而那只删版本行、不删后加列/表。因此：
--   * 列一律 `ADD COLUMN IF NOT EXISTS`；
--   * CHECK 约束先 `DROP CONSTRAINT IF EXISTS` 再建（PG 对约束没有 IF NOT EXISTS）；
--   * 表/索引 `IF NOT EXISTS`；
--   * 回填两条语句都以 `NOT EXISTS` 为判据（第二次执行零行）。
-- 判据：migration_0086_test.go 的「回填恰好一条/重复执行 OK/CHECK 生效」。

-- 1) apps：部署指针 + 退役/快照/清理时间线
--
-- current_deployment_id 是**历史链指针**（= 最近一次真正生效的部署行 id）。
-- 运行期唯一真源仍然是 current_release_id（这一点本设计不改：执行面每请求读它），
-- current_deployment_id 只回答"谁在什么时候把哪一版放上线"。
--
-- snapshot_at/snapshot_path/snapshot_error：冻结/删除期的只读快照状态。
--   * snapshot_at 非空 = 快照**成功**落盘（这是真删的前置条件，见 §5.5）；
--   * snapshot_error 非空 = 最近一次快照失败的原因（不阻断冻结，但阻断 purge）。
-- purge_after：可真删时刻（冻结时刻 + limits.RetirementSnapshotRetentionDays）。
-- purged_at：真删完成（数据目录已删；apps/releases/deployments 元数据留作审计 tombstone）。
ALTER TABLE apps ADD COLUMN IF NOT EXISTS current_deployment_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS snapshot_at           TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS snapshot_path         TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS snapshot_error        TEXT NOT NULL DEFAULT '';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS purge_after           TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS purged_at             TIMESTAMPTZ;

COMMENT ON COLUMN apps.current_deployment_id IS
    '最近一次生效部署的 wasm_app_deployments.id（0 = 迁移前的存量应用或从未部署）；运行期仍读 current_release_id';
COMMENT ON COLUMN apps.snapshot_at IS
    '只读快照成功落盘的时刻（NULL = 没有快照；真删必须要求非 NULL，fail-closed）';
COMMENT ON COLUMN apps.snapshot_error IS
    '最近一次快照失败的原因（空串 = 无失败）；不阻断冻结，但阻断真删';
COMMENT ON COLUMN apps.purge_after IS
    '可真删时刻 = 冻结时刻 + 保留期；删除动作会补冻结时刻，因此删除后恒非 NULL';
COMMENT ON COLUMN apps.purged_at IS
    '真删完成时刻（数据目录已删；元数据与部署历史保留作审计 tombstone）';

-- 2) 版本状态机补 withdrawn（作者撤回：字节释放、版本号永久占用）
--
-- 0048/0053 的内联 CHECK 由 PG 自动命名为 app_releases_status_check（实测确认）。
-- 这里的 DROP+ADD 是唯一改写点：`status IN (...)` 多一个值属于**放宽**，存量行不会失效。
ALTER TABLE app_releases DROP CONSTRAINT IF EXISTS app_releases_status_check;
ALTER TABLE app_releases ADD CONSTRAINT app_releases_status_check
  CHECK (status IN ('pending','approved','rejected','withdrawn'));

-- 3) 部署历史（不可变、追加式；**不加外键**：真删后历史仍要留）
--
-- 为什么不加外键（与 app_releases 的区别）：版本行在真删（purge）后仍保留（tombstone），
-- 但部署历史是**独立的事实记录**——"谁在何时把哪一版上线"不应该因为任何行被物理删除
-- 而消失。外键会带来两类错误形态：ON DELETE CASCADE（历史被连带删掉）与
-- ON DELETE RESTRICT（purge 删不掉版本行）。两种都与"历史永不删除"冲突。
--
-- kind 的取值即语义：
--   publish  = 审核关闭时发布成功 / 作者显式部署**最新** approved 版本；
--   review   = 管理员审批通过（部署 max(id) approved；审批更旧版本不降级）；
--   rollback = 显式部署一个**非最新** approved 版本（不重审、不重传）；
--   seed     = 内置演示应用播种；
--   legacy   = 迁移回填（存量应用补一条历史）。
-- actor_role：owner | super_admin | admin_session | system | seed | legacy。
CREATE TABLE IF NOT EXISTS wasm_app_deployments (
  id          BIGSERIAL PRIMARY KEY,
  app_id      TEXT NOT NULL,
  release_id  BIGINT NOT NULL,
  version     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('publish','review','rollback','seed','legacy')),
  actor       TEXT NOT NULL DEFAULT '',
  actor_role  TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE wasm_app_deployments IS
    '不可变部署历史（设计 2026-10-22 §3.3）：追加式，永不删除（真删也不删）；无外键，避免被级联删除或阻塞 purge';
CREATE INDEX IF NOT EXISTS idx_wasm_app_deployments_app
  ON wasm_app_deployments(app_id, id DESC);

-- 4) 回填：每个 current_release_id>0 的存量应用补一条 legacy 部署并指过去
--
-- 判据是**每应用至多一条**：`NOT EXISTS (… d.app_id = a.app_id)`。这一条同时承担两件事：
--   * 首次执行时"恰好一条/应用"（设计 §9.1 的验收判据）；
--   * 重放时零行（不会因为重复执行而追加第二条 legacy）。
-- created_at 取 COALESCE(updated_at, now())：让历史行落在应用"最后被改动"的时刻附近，
-- 而不是迁移时刻（否则所有存量应用看起来像是在迁移那一刻被同时部署的）。
INSERT INTO wasm_app_deployments (app_id, release_id, version, kind, actor_role, message, created_at)
SELECT a.app_id, r.id, r.version, 'legacy', 'legacy', '迁移回填（0086）', COALESCE(a.updated_at, now())
FROM apps a JOIN app_releases r ON r.id = a.current_release_id
WHERE a.kind = 'wasm_app' AND a.current_release_id > 0
  AND NOT EXISTS (SELECT 1 FROM wasm_app_deployments d WHERE d.app_id = a.app_id);

-- 指针回填的取法有三条硬要求（2026-10-22 反证审计 7e 的修正）：
--   ① **最近一条**（`ORDER BY app_id, id DESC`）—— 此前是默认升序即取**最早**一条，
--      与 current_deployment_id 的语义（"最近一次生效部署"）相反；重放时会把它指回
--      建库时的第一条。
--   ② **不碰已真删的应用**（`purged_at IS NULL`）：MarkWasmAppPurged 会刻意清零指针，
--      重放把指针指回去等于让"数据已清除"的应用又"看起来有生效版本"。
--   ③ **只写 0 值**（`current_deployment_id = 0`）：手工修过的指针（运维/回滚补数）不得
--      被迁移覆盖 —— 迁移是补齐缺失信息，不是重新裁决现状。
UPDATE apps a SET current_deployment_id = d.id
FROM (SELECT DISTINCT ON (app_id) id, app_id FROM wasm_app_deployments ORDER BY app_id, id DESC) d
WHERE a.kind='wasm_app' AND a.app_id = d.app_id AND a.current_deployment_id = 0
  AND a.purged_at IS NULL;
