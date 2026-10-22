-- 应用库里的扩展（docs/architecture/07-knowledge-aftersales/spec.md R12）。
-- 不放在迁移里：vector 不是 trusted 扩展，agent_owner 不是超级用户，执行 CREATE EXTENSION 会报 "Must be superuser"
-- （第 0.3 步在 pgvector/pgvector:pg17 上实测）。迁移 0016 的 DO 块在扩展可用但没装时会报错停下，写明要先执行本文件。
--
-- 连的是应用库，不是 postgres 维护库：extensions.sh 用超级用户 -d <应用库> 执行它。可以重复执行。
-- 新库初始化时 compose 把 extensions.sh 挂成 /docker-entrypoint-initdb.d/20-extensions.sh，排在建库的 10-roles.sh 之后；
-- 现有线上库在第一次部署含迁移 0016 的版本之前，由 owner 手工执行一次（README「部署」一节）。
-- 扩展装在 public：迁移里的 halfvec 列类型不带 schema 前缀（ADR-001 决策 7）。
-- src/db/db.selftest.ts 的真实 Postgres 部分读同一个文件逐行执行，所以：每条语句占一行，不用 psql 变量。
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
