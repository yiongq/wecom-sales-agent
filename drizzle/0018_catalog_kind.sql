-- 08 R2：只放宽 kind 的取值，保留现有数据；包归属由应用层 assertKind 校验。
-- migration-allow: drop 以格式约束替换枚举约束，不删除列或数据。
ALTER TABLE catalog_items DROP CONSTRAINT catalog_items_kind_check;
--> statement-breakpoint
-- migration-allow: add-check 新格式包含原有 route、hotel，旧镜像的写入仍合法。
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_kind_check
  CHECK (kind ~ '^[a-z][a-z0-9_]{1,31}$');
