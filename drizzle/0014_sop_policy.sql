-- 07 R1：可空以兼容旧镜像；已发布行的不可改触发器自动保护此列。
ALTER TABLE sop_versions ADD COLUMN policy json;
