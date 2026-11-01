-- 15 R6：只读成员投影。token hash 以 64 位小写 hex 传入，不接受调用方自报 actor/role。
CREATE FUNCTION public.console_members_read(p_tenant uuid, p_token_hash text)
RETURNS TABLE (user_id uuid, display_name text, email text, role text, disabled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
  v_now timestamptz := statement_timestamp();
BEGIN
  IF coalesce(v_orig, '') <> '' AND lower(v_orig) <> p_tenant::text THEN
    RAISE EXCEPTION 'members: 当前事务已设为别的租户' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_tenant IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  IF EXISTS (
    SELECT 1 FROM public.auth_sessions s
    JOIN public.users u ON u.id=s.user_id AND u.disabled_at IS NULL
    JOIN public.memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
    JOIN public.tenants t ON t.id=s.tenant_id
    WHERE s.tenant_id=p_tenant AND s.token_hash=decode(p_token_hash, 'hex')
      AND s.expires_at >= v_now AND s.last_seen_at >= v_now - interval '12 hours'
      AND m.role IN ('owner','admin') AND t.kind='standard' AND t.status <> 'suspended'
  ) THEN
    RETURN QUERY
      SELECT u.id,u.display_name,u.email,m.role,(u.disabled_at IS NOT NULL)
      FROM public.memberships m JOIN public.users u ON u.id=m.user_id
      WHERE m.tenant_id=p_tenant ORDER BY lower(u.email),u.id;
  END IF;
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
END;
$$;
--> statement-breakpoint
-- migration-allow: revoke 新增 SECURITY DEFINER 函数不向 PUBLIC 或平台角色开放，既有权限不变。
REVOKE ALL ON FUNCTION public.console_members_read(uuid,text) FROM PUBLIC, agent_platform;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.console_members_read(uuid,text) TO agent_app;
