-- 08 R9：知识块 source 存包内可检索的 kind，只放宽约束，保留现有块与向量。
-- migration-allow: drop 以格式约束替换枚举约束，不删除列或数据。
ALTER TABLE kb_chunks DROP CONSTRAINT kb_chunks_source_check;
--> statement-breakpoint
-- migration-allow: add-check 新格式包含原有 route，旧镜像的写入仍合法。
ALTER TABLE kb_chunks ADD CONSTRAINT kb_chunks_source_check
  CHECK (source ~ '^[a-z][a-z0-9_]{1,31}$');
