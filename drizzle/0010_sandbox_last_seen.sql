-- R12 闲置回收重启后沿用登录会话的最后访问时间；不开放登录表或令牌。
CREATE FUNCTION public.sandbox_last_seen()
RETURNS TABLE (tenant_id uuid, last_seen_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.id, coalesce(max(s.last_seen_at), t.created_at)
  FROM public.tenants t LEFT JOIN public.auth_sessions s ON s.tenant_id = t.id
  WHERE t.kind = 'sandbox'
  GROUP BY t.id, t.created_at;
$$;
--> statement-breakpoint
-- migration-allow: revoke 新函数只向应用开放沙箱访问时间，不向 PUBLIC 开放
REVOKE ALL ON FUNCTION public.sandbox_last_seen() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.sandbox_last_seen() TO agent_app;
