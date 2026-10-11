-- 05 R9 开工期澄清：只允许应用初始化沙箱隐私说明，standard 的只读权限不变。
CREATE FUNCTION public.sandbox_privacy_seed(p_tenant uuid, p_body text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
  v_kind text;
BEGIN
  SELECT t.kind INTO v_kind FROM public.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND OR v_kind <> 'sandbox' THEN
    RAISE EXCEPTION 'sandbox: 隐私说明只能初始化沙箱租户' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(v_orig, '') <> '' AND lower(v_orig) <> p_tenant::text THEN
    RAISE EXCEPTION 'sandbox: 当前事务已设为别的租户' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  IF EXISTS (SELECT 1 FROM public.privacy_notices WHERE tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'sandbox: 已有隐私说明，不可重复初始化' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.privacy_notices (tenant_id, version, body, published_at, published_by_name)
    VALUES (p_tenant, 1, p_body, now(), NULL);
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
END;
$$;
--> statement-breakpoint
-- 迁移以 agent_owner 执行，其默认权限已撤回 PUBLIC 的函数执行权。
GRANT EXECUTE ON FUNCTION public.sandbox_privacy_seed(uuid, text) TO agent_app;
