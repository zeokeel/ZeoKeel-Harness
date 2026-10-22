-- 0087: WASM 应用**应用级限流覆盖**（wasm_app_limits）
--
-- 背景（决策 docs/decisions/2026-10-22-wasm-per-app-limits.md §2）：平台此前只有一套
-- 全局旋钮（settings.wasm.limits），异常应用只能被整体冻结（freeze），没有"单独限流/
-- 降额"这一档。本迁移只加**数据面**：管理员可以为单个应用覆盖并发四轴
-- （app_running / app_queue / user_per_app_running / user_per_app_queued）。
--
-- 语义（三条，缺一条都会让"覆盖"变成第二个真源）：
--   * **NULL = 继承全局**；非空 = 该应用的显式覆盖。"没有这一行"与"四列全 NULL"
--     同义（读取时归一），因此清空覆盖 = 删行（DAO 负责，见 serverstore）。
--   * 生效值 = 全局 Limits 复制后套用非空覆盖，然后**复用 applimits.Validate()**
--     校验（per-app 组合与全局保存走同一份判据，不产生第二套规则）。
--   * 覆盖**允许高于全局**（管理员显式动作，响应里带 exceeds_global 提示），但不得
--     超过绝对上界；绝对上界的判据在 Go 侧（applimits.Validate / MaxAppQueue），
--     本表的 CHECK 只挡住"0 或负数"这类必然无意义的落库值。
--
-- 为什么**不加外键**到 apps：
--   * 应用被冻结/软删/真删（purge）时**覆盖行保留**（决策 §2.4：恢复后仍生效，
--     purge 不删覆盖行）—— 外键 ON DELETE CASCADE 会把覆盖连带删掉；
--   * ON DELETE RESTRICT 又会让 purge 删不掉应用行。两种都与"处置不丢配置"冲突。
--   写面"应用不存在/已删除 ⇒ 404"由管理 API 在**写之前**校验（fail-closed），
--   不靠数据库约束表达（约束表达不了"已删除"这种软状态）。
--
-- 幂等纪律（与 0080/0081/0082/0085/0086 同口径）：本文件必须可重放 —— 测试夹具会把
-- 库退回旧版本再整段重放，而那只删版本行、不删表。因此建表一律 `IF NOT EXISTS`，
-- 不加"先 DROP 再建"的形态（那会删掉管理员已经配置的覆盖）。
-- 判据：wasm_app_limits_test.go 的「重复执行 OK / NULL 与显式值共存 / CHECK 拒绝非正数」。
CREATE TABLE IF NOT EXISTS wasm_app_limits (
  -- app_id 是应用的域名标签（§4.1，小写、无首尾/连续连字符）；不做大小写归一化 ——
  -- 写入面统一走 registry.NormalizeAppID，落库值只有一种形态。
  app_id              TEXT PRIMARY KEY,
  -- 四个可空的覆盖轴：NULL = 继承全局（见上面的语义段）。
  app_running         INT CHECK (app_running IS NULL OR app_running > 0),
  app_queue           INT CHECK (app_queue IS NULL OR app_queue > 0),
  user_per_app_running INT CHECK (user_per_app_running IS NULL OR user_per_app_running > 0),
  user_per_app_queued INT CHECK (user_per_app_queued IS NULL OR user_per_app_queued > 0),
  -- updated_at / updated_by 是**运维证据**：回答"这个例外是谁什么时候放的"。
  -- 对应的审计（wasm_app_limits_change）带四值与 actor_role=admin_session；
  -- 两处都留是有意的 —— 审计表按保留期清理（默认 180 天），本表跟着配置一直活着。
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT NOT NULL DEFAULT ''
);

COMMENT ON TABLE wasm_app_limits IS
    'WASM 应用级限流覆盖：四个并发轴，NULL = 继承全局（settings.wasm.limits）；无行 = 全继承';
COMMENT ON COLUMN wasm_app_limits.app_id IS
    '应用域名标签（apps.app_id，小写）；无外键：冻结/删除时覆盖行保留（决策 §2.4）';
COMMENT ON COLUMN wasm_app_limits.app_running IS
    '单应用同时运行数覆盖（NULL = 继承全局 app_running）；允许高于全局，不得超过 max_instances';
COMMENT ON COLUMN wasm_app_limits.app_queue IS
    '单应用队列长度覆盖（NULL = 继承全局 app_queue）；绝对上界 MaxAppQueue 在 Go 侧判';
COMMENT ON COLUMN wasm_app_limits.user_per_app_running IS
    '单用户单应用在跑覆盖（NULL = 继承全局）；必须 ≤ 生效的 app_running（applimits.Validate 同源判据）';
COMMENT ON COLUMN wasm_app_limits.user_per_app_queued IS
    '单用户单应用排队覆盖（NULL = 继承全局）；必须 ≤ 生效的 app_queue';
COMMENT ON COLUMN wasm_app_limits.updated_at IS
    '最近一次写入覆盖（或清空覆盖）的时刻；清空 = 删行，所以这里只剩"当前有覆盖"的第一现场';
COMMENT ON COLUMN wasm_app_limits.updated_by IS
    '最近一次写入的管理员用户名（审计 wasm_app_limits_change 同源；空串 = 迁移/人工写入）';
