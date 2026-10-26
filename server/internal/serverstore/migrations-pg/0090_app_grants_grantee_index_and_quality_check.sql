-- 0090：能力中心 Wave2 的两条一致性判据（索引 + 取值域）。
--
-- 背景（2026-10-26 能力中心审计）：
--
-- F-18 `app_grants` 缺 grantee 侧索引。热路径 `AccessibleAppIDs`（apps.go）
-- 反查「某人 + 其部门链」可访问的 App：
--     WHERE kind = ? AND ((grantee_type = 'user'  AND lower(grantee) = lower(?))
--                      OR (grantee_type = 'group' AND lower(grantee) IN (…)))
-- 而 0053 只建了主键 `(kind, app_id, grantee_type, grantee)` —— 主键前缀是
-- (kind, app_id)，这个查询**完全用不上**，于是每次客户端拉目录都全表扫
-- app_grants（授权表随「逐用户/逐部门授权」线性增长，是最热的一张表）。
--
-- 必须建**表达式索引** `(grantee_type, lower(grantee))`：查询两侧都做了
-- lower() 归一（部门名大小写不敏感是 0017 的语义），普通列索引对
-- `lower(grantee) = …` 不可用。列序：grantee_type 低基数等值在前，lower(grantee)
-- 用于等值/IN 收窄。
-- 精确匹配路径（GetAppGrant 的 `grantee_type = ? AND grantee = ?`）由主键
-- (kind, app_id, grantee_type, grantee) 覆盖，不需要再加一条普通索引。
--
-- F-39 `quality` 无取值域约束：`app_releases.quality` 是 TEXT DEFAULT ''，而
-- 业务只认 ''（无标记）/ official / featured（0037 引入，二者互斥）。没有 CHECK
-- 时任何写入路径（`SetReleaseQuality`、投影回填、数据修复脚本）都能落任意字符串，
-- 管理端的「精选/官方」徽章判定（==featured / ==official）会静默不命中。
-- 用 `NOT VALID`：存量行不回溯校验（避免一次部署即因历史脏值失败），新写入
-- 与后续 UPDATE 立即受约束；清干净存量后可另起迁移 `VALIDATE CONSTRAINT`。
--
-- 注：本迁移与 0089 保持同一风格 —— 纯 DDL、IF NOT EXISTS 幂等、注释写「为什么」。

CREATE INDEX IF NOT EXISTS idx_app_grants_grantee_lower
    ON app_grants (grantee_type, lower(grantee));

ALTER TABLE app_releases
    DROP CONSTRAINT IF EXISTS app_releases_quality_check;

ALTER TABLE app_releases
    ADD CONSTRAINT app_releases_quality_check
    CHECK (quality IN ('', 'official', 'featured')) NOT VALID;
