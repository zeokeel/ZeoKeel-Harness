-- 0089：诊断的版本维度。
--
-- 背景（2026-10-22 生产级评审 · 应用开发者视角 D-02）：`wasm_call_events` 只记 app_id，
-- 不记"这次失败是哪个版本"。版本在执行路径上就在手边（serve.go 的 rel.Version），
-- 但诊断无法回答"回滚后有没有止血/新版本是不是更差"，与设计 §4.9「诊断回答版本是哪个」
-- 直接冲突。
--
-- 语义：
--   - `version` 是**请求实际执行的那个版本**（app_releases.version），不是"最新版本"；
--     老数据一律空串（无法追溯，不伪装成某个版本）。
--   - 保留期清理与按 app 查询不变；新增 (app_id, version, created_at) 索引供按版本聚合。
ALTER TABLE wasm_call_events ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_wasm_call_events_app_version
    ON wasm_call_events (app_id, version, created_at DESC);
