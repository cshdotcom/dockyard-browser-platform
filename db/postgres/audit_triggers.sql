-- ============================================================
-- Dockyard PostgreSQL 审计不可篡改触发器（r14）
--
-- 用途：数据库层强制 AuditLog / AuditLogArchive 只允许 INSERT：
--   · UPDATE → 拒绝（审计日志一经写入不可修改）
--   · DELETE → 拒绝（仅可经归档流程搬移；应用层无任何删除入口）
--   · TRUNCATE → 拒绝
-- 应用层（src/lib/audit.ts）同样只提供 writeAudit/insert；本触发器是
-- 第二道防线 —— 即使超级管理员直连数据库也无法篡改审计记录。
--
-- 应用方式（两种任选其一，效果相同）：
--   1. 自动：平台启动时 DB_PROVIDER=postgres 自动执行（docker/start.sh 调
--      scripts/db/apply-pg-triggers.ts，幂等 CREATE OR REPLACE）
--   2. 手工：psql -h <host> -U <user> -d <db> -f db/postgres/audit_triggers.sql
-- ============================================================

-- 审计主表：禁改禁删禁清空
CREATE OR REPLACE FUNCTION dockyard_audit_log_block_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog 表仅允许 INSERT（不可篡改审计）：尝试 % 被数据库层拒绝', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON "AuditLog";
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION dockyard_audit_log_block_mutate();

DROP TRIGGER IF EXISTS audit_log_no_delete ON "AuditLog";
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION dockyard_audit_log_block_mutate();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON "AuditLog";
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION dockyard_audit_log_block_mutate();

-- 审计归档表：同规格保护（归档记录同样不可篡改）
CREATE OR REPLACE FUNCTION dockyard_audit_archive_block_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLogArchive 表仅允许 INSERT（不可篡改归档）：尝试 % 被数据库层拒绝', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_archive_no_update ON "AuditLogArchive";
CREATE TRIGGER audit_archive_no_update
  BEFORE UPDATE ON "AuditLogArchive"
  FOR EACH ROW EXECUTE FUNCTION dockyard_audit_archive_block_mutate();

DROP TRIGGER IF EXISTS audit_archive_no_delete ON "AuditLogArchive";
CREATE TRIGGER audit_archive_no_delete
  BEFORE DELETE ON "AuditLogArchive"
  FOR EACH ROW EXECUTE FUNCTION dockyard_audit_archive_block_mutate();

DROP TRIGGER IF EXISTS audit_archive_no_truncate ON "AuditLogArchive";
CREATE TRIGGER audit_archive_no_truncate
  BEFORE TRUNCATE ON "AuditLogArchive"
  FOR EACH STATEMENT EXECUTE FUNCTION dockyard_audit_archive_block_mutate();
