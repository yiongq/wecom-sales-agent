-- 01 的 RLS、触发器、认证函数与授权（docs/architecture/01-pg-config-console/spec.md「数据库」）。
-- 以 agent_owner 执行：表、函数的属主都是它，FORCE 之下它自己也受 RLS 约束。
-- 已提交的迁移永不修改；要改就写新迁移（scripts/check-migrations.ts 会查）。

-- ===== 默认权限：此后 agent_owner 建的函数都不对 PUBLIC 开放 EXECUTE，认证函数再逐个授权 =====
-- migration-allow: revoke 新库第一次收紧函数的默认 EXECUTE，放在建任何函数之前，不影响已有对象
ALTER DEFAULT PRIVILEGES FOR ROLE agent_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- ===== RLS：public 里所有带 tenant_id 的表都套这个模板，豁免清单只有 auth_sessions（登录时还不知道租户） =====
-- 没设租户时 current_setting 返回 NULL 或空串，NULLIF 之后是 NULL，策略对任何行都不成立：读到 0 行、写入被拒
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sop_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sop_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sop_versions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON catalog_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- ===== 触发器：违反时一律 check_violation =====

-- 新版本行只有两种来路：后台新建的草稿；导入、回滚、启动重渲染直接写入的已发布版本
CREATE FUNCTION sop_versions_guard_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (NEW.status = 'draft' AND NEW.source = 'console' AND NEW.version_no IS NULL)
     OR (NEW.status = 'published' AND NEW.source IN ('import', 'rollback', 'rerender')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sop_versions: 新行只能是后台草稿（draft/console，无版本号），或 import/rollback/rerender 的已发布版本；收到 status=%, source=%',
    NEW.status, NEW.source
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sop_versions_guard_insert BEFORE INSERT ON sop_versions
  FOR EACH ROW EXECUTE FUNCTION sop_versions_guard_insert();
--> statement-breakpoint

-- 已发布的版本不可变：只允许 draft→draft、draft→published、draft→discarded、published→archived，
-- 离开 draft 之后除 status 以外一个字节都不许动
CREATE FUNCTION sop_versions_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_by_name IS DISTINCT FROM OLD.created_by_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sop_versions: id、tenant_id、pack_id、source、created_* 不可修改'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('draft', 'published', 'discarded'))
          OR (OLD.status = 'published' AND NEW.status = 'archived')) THEN
    RAISE EXCEPTION 'sop_versions: 不允许的状态迁移 % → %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version_no IS DISTINCT FROM OLD.version_no
     AND NOT (OLD.status = 'draft' AND NEW.status = 'published' AND OLD.version_no IS NULL) THEN
    RAISE EXCEPTION 'sop_versions: version_no 只能在 draft → published 时赋值一次'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft' THEN
    IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'sop_versions: % 的版本除 status 外不可修改', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    NEW.rev := OLD.rev + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sop_versions_guard_update BEFORE UPDATE ON sop_versions
  FOR EACH ROW EXECUTE FUNCTION sop_versions_guard_update();
--> statement-breakpoint

-- 条目的身份与位置不可变；上架之后不能回到 draft（已发出的方案书会 404）。计价字段的锁定是 v0 的临时策略，在服务端做
CREATE FUNCTION catalog_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.ord IS DISTINCT FROM OLD.ord THEN
    RAISE EXCEPTION 'catalog_items: id、tenant_id、kind、code、ord 不可修改'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'active' AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'catalog_items: 已上架的条目不能回到 %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.rev := OLD.rev + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_items_guard BEFORE UPDATE ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION catalog_items_guard();
--> statement-breakpoint

-- ===== 认证函数：agent_app 对 users、memberships、auth_sessions 没有任何表权限，只能经这五个函数 =====
-- 属主 agent_owner，SECURITY DEFINER；search_path 把 pg_temp 显式放在最后，函数体里的表名一律全限定，
-- 调用方建的同名临时表遮蔽不了它们。带 p_tenant 的四个函数：记下 app.tenant_id 的原值，原值非空且不是 p_tenant 就报错；
-- 否则在事务内设成 p_tenant（FORCE 之下属主也要有租户才读得到 memberships），返回前恢复原值。

CREATE FUNCTION auth_login_lookup(p_tenant uuid, p_email text)
  RETURNS TABLE (o_user_id uuid, o_password_hash text, o_role text, o_display_name text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
BEGIN
  IF coalesce(v_orig, '') <> '' AND lower(v_orig) <> p_tenant::text THEN
    RAISE EXCEPTION 'auth: 当前事务已设为别的租户' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  -- 只返回本租户的成员、未停用的账号；租户已停用时返回空
  RETURN QUERY
    SELECT u.id, u.password_hash, m.role, u.display_name
      FROM public.users u
      JOIN public.memberships m ON m.user_id = u.id AND m.tenant_id = p_tenant
      JOIN public.tenants t ON t.id = p_tenant
     WHERE lower(u.email) = lower(p_email)
       AND u.disabled_at IS NULL
       AND t.status <> 'suspended';
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION auth_session_create(
  p_tenant uuid, p_token_hash bytea, p_user_id uuid, p_now timestamptz, p_ip inet, p_user_agent text
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
BEGIN
  IF coalesce(v_orig, '') <> '' AND lower(v_orig) <> p_tenant::text THEN
    RAISE EXCEPTION 'auth: 当前事务已设为别的租户' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  -- 绝对期限写成 168 小时而不是 7 days：timestamptz 加「天」按调用方的时区算日历天，跨夏令时会差一小时
  -- 顺手清掉该用户已经失效的会话（过了绝对期限，或空闲超过 12 小时）
  DELETE FROM public.auth_sessions
   WHERE user_id = p_user_id
     AND (expires_at < p_now OR last_seen_at < p_now - interval '12 hours');
  INSERT INTO public.auth_sessions (token_hash, tenant_id, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
  VALUES (p_token_hash, p_tenant, p_user_id, p_now, p_now, p_now + interval '168 hours', p_ip, p_user_agent);
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION auth_session_touch(p_tenant uuid, p_token_hash bytea, p_now timestamptz)
  RETURNS TABLE (o_user_id uuid, o_role text, o_display_name text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
  v_tenant uuid;
  v_user uuid;
  v_last timestamptz;
  v_expires timestamptz;
BEGIN
  IF coalesce(v_orig, '') <> '' AND lower(v_orig) <> p_tenant::text THEN
    RAISE EXCEPTION 'auth: 当前事务已设为别的租户' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT s.tenant_id, s.user_id, s.last_seen_at, s.expires_at
    INTO v_tenant, v_user, v_last, v_expires
    FROM public.auth_sessions s
   WHERE s.token_hash = p_token_hash
     FOR UPDATE;
  -- 别的租户的会话：只返回空，不碰它
  IF FOUND AND v_tenant = p_tenant THEN
    IF p_now - v_last > interval '12 hours' OR p_now > v_expires THEN
      -- 空闲超过 12 小时或过了绝对期限：删行并返回空
      DELETE FROM public.auth_sessions WHERE token_hash = p_token_hash;
    ELSE
      -- 账号已停用、已不是成员、租户已停用：只返回空
      RETURN QUERY
        SELECT u.id, m.role, u.display_name
          FROM public.users u
          JOIN public.memberships m ON m.user_id = u.id AND m.tenant_id = p_tenant
          JOIN public.tenants t ON t.id = p_tenant
         WHERE u.id = v_user
           AND u.disabled_at IS NULL
           AND t.status <> 'suspended';
      -- 距上次超过 1 分钟才写 last_seen_at，避免每个请求都写一次
      IF FOUND AND p_now - v_last > interval '1 minute' THEN
        UPDATE public.auth_sessions SET last_seen_at = p_now WHERE token_hash = p_token_hash;
      END IF;
    END IF;
  END IF;
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
END;
$$;
--> statement-breakpoint

-- 登出：会话表不带 RLS，按 token 删，不需要租户
CREATE FUNCTION auth_session_delete(p_token_hash bytea) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  DELETE FROM public.auth_sessions WHERE token_hash = p_token_hash;
$$;
--> statement-breakpoint

-- 登录成功时把旧参数的哈希升级成新参数；库里的哈希仍等于 p_old_hash 才替换，不覆盖并发的改口令
CREATE FUNCTION auth_password_rehash(p_tenant uuid, p_user_id uuid, p_old_hash text, p_new_hash text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
  v_ok boolean;
BEGIN
  IF coalesce(v_orig, '') <> '' AND lower(v_orig) <> p_tenant::text THEN
    RAISE EXCEPTION 'auth: 当前事务已设为别的租户' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  UPDATE public.users u
     SET password_hash = p_new_hash
   WHERE u.id = p_user_id
     AND u.password_hash = p_old_hash
     AND u.disabled_at IS NULL
     AND EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = p_tenant AND m.user_id = p_user_id);
  v_ok := FOUND;
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
  RETURN v_ok;
END;
$$;
--> statement-breakpoint

-- ===== 授权（spec「各角色对各表的期望」）。agent_owner 是属主，不需要授权 =====
GRANT USAGE ON SCHEMA public TO agent_app, agent_platform;
--> statement-breakpoint
GRANT SELECT ON tenants TO agent_app;
--> statement-breakpoint
-- 没有 DELETE：已发布版本与已上架条目都不删
GRANT SELECT, INSERT, UPDATE ON sop_versions, catalog_items TO agent_app;
--> statement-breakpoint
-- 审计只追加：没有 UPDATE / DELETE
GRANT SELECT, INSERT ON audit_log TO agent_app, agent_platform;
--> statement-breakpoint
GRANT SELECT, INSERT ON tenants TO agent_platform;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON users TO agent_platform;
--> statement-breakpoint
-- 受 RLS，要经 withTenant
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO agent_platform;
--> statement-breakpoint
-- 改口令、停用、移除成员时吊销会话
GRANT SELECT, DELETE ON auth_sessions TO agent_platform;
--> statement-breakpoint
-- 应用启动时核对迁移（spec「迁移纪律」），只读
GRANT USAGE ON SCHEMA drizzle TO agent_app;
--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO agent_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  auth_login_lookup(uuid, text),
  auth_session_create(uuid, bytea, uuid, timestamptz, inet, text),
  auth_session_touch(uuid, bytea, timestamptz),
  auth_session_delete(bytea),
  auth_password_rehash(uuid, uuid, text, text)
TO agent_app;
