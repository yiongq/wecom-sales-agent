-- 集群级的角色与建库（docs/architecture/01-pg-config-console/spec.md「数据库 · 角色 / DDL」）。
-- 不放在迁移里：迁移以 agent_owner 执行，它建不了角色和库。01 不建扩展；03 用到 pgvector 时由超级用户建，
-- 要建在应用库里（roles.sh 连的是 postgres 维护库，届时得先切到 :"db_name"）。
--
-- roles.sh 在 db 首次初始化时执行它，之后也可以重复执行（轮换口令就是重跑一遍）：三个口令用 \getenv 从 db 容器的环境读入，
-- 库名经 -v db_name 传入；已存在的角色把行首的 CREATE ROLE 换成 ALTER ROLE（选项相同，只更新口令与属性），
-- 已存在的库跳过 CREATE DATABASE 那一行。src/db/db.selftest.ts 的真实 Postgres 部分读同一个文件，做同样的替换后逐行执行。
-- 所以：每条语句占一行；变量只用 :'owner_password'、:'app_password'、:'platform_password' 和 :"db_name" 四个。
-- agent_owner 比 spec 的 DDL 多写一个 NOCREATEDB：新建时本来就没有，写出来是为了重跑（ALTER ROLE）时也能纠正回来
CREATE ROLE agent_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'owner_password';
CREATE ROLE agent_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'app_password';
CREATE ROLE agent_platform LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD :'platform_password';
ALTER ROLE agent_app SET statement_timeout = '5s';
-- 不设 idle_session_timeout：租户锁的连接平时就是空闲的
ALTER ROLE agent_app SET idle_in_transaction_session_timeout = '10s';
CREATE DATABASE :"db_name" OWNER agent_owner ENCODING 'UTF8' TEMPLATE template0;
-- 库已存在时上一行被跳过：属主不对（例如误设了 POSTGRES_DB，entrypoint 以超级用户建了库）就在这里改回来
ALTER DATABASE :"db_name" OWNER TO agent_owner;
REVOKE CONNECT, TEMPORARY ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO agent_owner, agent_app, agent_platform;
