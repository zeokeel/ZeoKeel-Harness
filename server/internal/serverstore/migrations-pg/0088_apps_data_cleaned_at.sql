-- 0088：真删（purge）两阶段化。
--
-- 背景（2026-10-22 生产级评审 · 管理员视角 P0）：旧实现先 RemoveAppData（删盘）再
-- MarkWasmAppPurged（置 purged_at），两步之间没有行锁、Mark 的 WHERE 也不校验
-- deleted_at；管理员在保留期刚过时点「恢复」可以拿到 200，随后 purge 把刚恢复的
-- 应用数据与快照一起删掉，且 purged_at 已置位 ⇒ 恢复/导出永久 410，不可逆。
--
-- 新语义（两阶段）：
--   1. 事务内 `SELECT … FOR UPDATE` 重校验资格（deleted_at 非空、purge_after 到期、
--      snapshot_at 非空、purged_at 为空），置 `purged_at`（终态：不可恢复）后提交；
--      restore 与它互斥：恢复先提交 ⇒ purge 重校验失败跳过；purge 先提交 ⇒ restore 410。
--   2. 数据目录清理单独记账 `data_cleaned_at`（purged 后异步/重试执行）——清理失败
--      不会被误报成"数据已清除"，下一轮调度器会重试并补审计。
--
-- 为什么不在同一事务里删盘再置 purged_at：磁盘删除可能很慢（大库/慢盘），把行锁
-- 持到删盘结束会阻塞恢复/导出；而"先置 purged_at 再删盘"的失败窗口是**可见且可重试**
-- 的（data_cleaned_at 为空 + 调度器日志），不会产生"恢复成功但数据没了"。
ALTER TABLE apps ADD COLUMN IF NOT EXISTS data_cleaned_at TIMESTAMPTZ;

-- 清理重试的取数口：只扫"已 purged 但数据目录还没清"的行。
CREATE INDEX IF NOT EXISTS idx_apps_purge_cleanup
    ON apps (purged_at)
    WHERE purged_at IS NOT NULL AND data_cleaned_at IS NULL;
