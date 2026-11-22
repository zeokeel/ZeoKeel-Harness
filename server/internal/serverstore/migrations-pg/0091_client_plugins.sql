-- 0091: 全员客户端插件目录（2026-11-22）。
--
-- 企业统一分发的最小面：管理员在 webadmin 上传一个 DSH bundle 的 .tgz，
-- 所有登录的桌面客户端从 bootstrap 拿到清单后自行下载、校验、安装。
-- 本表刻意没有按人/部门分配，也没有版本历史：同一 id 再上传即覆盖，
-- 但 version 必须变化（同版本同内容客户端会跳过，覆盖会造成"永远装不上"）。
--
-- content 走 bytea（典型 UI bundle 约 2.3MB；上限由 handler 的 MaxBytesReader 兜住）。
-- 回滚口径：删 version=91 行 + 换旧镜像；DDL 留着对旧二进制无影响
-- （旧二进制不读本表；bootstrap 的 plugins 字段对旧客户端是未知字段）。
CREATE TABLE IF NOT EXISTS client_plugins (
  id            text PRIMARY KEY,
  package_name  text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  description   text NOT NULL DEFAULT '',
  version       text NOT NULL,
  sha256        text NOT NULL,
  size          bigint NOT NULL,
  content       bytea NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  updated_by    text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
