-- 沙箱计数日期由应用在事务内传入 todayIso()；旧调用方回落生产镜像相同的时区。
-- migration-allow: create-or-replace 协调者裁决日计数统一本地日期；签名、授权、租户校验与删除顺序不变
CREATE OR REPLACE FUNCTION sandbox_tenant_create(p_slug text, p_template uuid, p_brand json, p_token_hash bytea, p_ip inet, p_user_agent text)
  RETURNS TABLE (o_tenant uuid, o_user uuid, o_expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
  v_pack text;
BEGIN
  IF coalesce(v_orig, '') <> '' THEN
    RAISE EXCEPTION 'sandbox: 开通须在未设租户的事务里' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_slug IS NULL OR p_slug NOT LIKE 'sbx-%' THEN
    RAISE EXCEPTION 'sandbox: slug 须以 sbx- 开头' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT t.pack_id INTO v_pack FROM public.tenants t
    WHERE t.id = p_template AND t.kind = 'standard' AND t.status <> 'suspended' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sandbox: 模板须是未停用的 standard 租户' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  o_expires_at := now() + interval '24 hours';
  INSERT INTO public.tenants (slug, name, pack_id, brand, kind, expires_at, template_tenant_id)
    VALUES (p_slug, '体验沙箱', v_pack, p_brand, 'sandbox', o_expires_at, p_template) RETURNING id INTO o_tenant;
  PERFORM set_config('app.tenant_id', o_tenant::text, true);
  INSERT INTO public.users (email, display_name, password_hash)
    VALUES (p_slug || '@sandbox.invalid', '体验访客', 'sandbox-disabled') RETURNING id INTO o_user;
  INSERT INTO public.memberships (tenant_id, user_id, role) VALUES (o_tenant, o_user, 'owner');
  INSERT INTO public.auth_sessions (token_hash, tenant_id, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (p_token_hash, o_tenant, o_user, now(), now(), o_expires_at, p_ip, p_user_agent);
  INSERT INTO public.sandbox_pool_daily (day, provisioned) VALUES (coalesce(nullif(current_setting('app.sandbox_day', true), '')::date, (now() AT TIME ZONE 'Asia/Shanghai')::date), 1)
    ON CONFLICT (day) DO UPDATE SET provisioned = public.sandbox_pool_daily.provisioned + 1;
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
-- migration-allow: create-or-replace 协调者裁决日计数统一本地日期；签名、授权、租户校验与删除顺序不变
CREATE OR REPLACE FUNCTION sandbox_tenant_purge(p_tenant uuid) RETURNS json
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_expires timestamptz;
  v_slug text;
  v_users uuid[];
  v_n bigint;
  v_counts jsonb := '{}'::jsonb;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'sandbox: purge 须在 p_tenant 的 withTenant 事务里' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t.kind, t.expires_at, t.slug INTO v_kind, v_expires, v_slug
    FROM public.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN '{}'::json; END IF;
  IF v_kind <> 'sandbox' THEN
    RAISE EXCEPTION 'sandbox: standard 租户不可用沙箱函数' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_expires > now() THEN
    RAISE EXCEPTION 'sandbox: 只能删除已到期沙箱' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 合成用户按唯一邮箱找到，成员已被移除时也能清掉；跨租户引用会由外键拒绝、整笔回滚。
  SELECT coalesce(array_agg(u.id), '{}'::uuid[]) INTO v_users FROM public.users u WHERE u.email = v_slug || '@sandbox.invalid';
  INSERT INTO public.sandbox_pool_daily (day, calls, cost_milli)
    SELECT day, sum(calls), sum(cost_milli_cny) FROM public.usage_daily WHERE tenant_id = p_tenant GROUP BY day
    ON CONFLICT (day) DO UPDATE SET calls = public.sandbox_pool_daily.calls + excluded.calls,
      cost_milli = public.sandbox_pool_daily.cost_milli + excluded.cost_milli;
  INSERT INTO public.sandbox_pool_daily (day, purged) VALUES (coalesce(nullif(current_setting('app.sandbox_day', true), '')::date, (now() AT TIME ZONE 'Asia/Shanghai')::date), 1)
    ON CONFLICT (day) DO UPDATE SET purged = public.sandbox_pool_daily.purged + 1;
  DELETE FROM public.channel_inbox WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('channel_inbox', v_n);
  DELETE FROM public.outbound_sends WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('outbound_sends', v_n);
  DELETE FROM public.guard_events WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('guard_events', v_n);
  DELETE FROM public.turn_traces WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('turn_traces', v_n);
  DELETE FROM public.messages WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('messages', v_n);
  DELETE FROM public.consents WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('consents', v_n);
  DELETE FROM public.orders WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('orders', v_n);
  DELETE FROM public.conversations WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('conversations', v_n);
  DELETE FROM public.jobs WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('jobs', v_n);
  DELETE FROM public.catalog_item_versions WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('catalog_item_versions', v_n);
  DELETE FROM public.catalog_items WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('catalog_items', v_n);
  DELETE FROM public.sop_versions WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('sop_versions', v_n);
  DELETE FROM public.quick_replies WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('quick_replies', v_n);
  DELETE FROM public.privacy_notices WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('privacy_notices', v_n);
  DELETE FROM public.usage_daily WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('usage_daily', v_n);
  DELETE FROM public.sandbox_wechat WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('sandbox_wechat', v_n);
  DELETE FROM public.channel_accounts WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('channel_accounts', v_n);
  DELETE FROM public.audit_log WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('audit_log', v_n);
  DELETE FROM public.auth_sessions WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('auth_sessions', v_n);
  DELETE FROM public.memberships WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('memberships', v_n);
  SELECT count(*) INTO v_n FROM public.channel_inbox WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 channel_inbox' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.outbound_sends WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 outbound_sends' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.guard_events WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 guard_events' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.turn_traces WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 turn_traces' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.messages WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 messages' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.consents WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 consents' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.orders WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 orders' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.conversations WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 conversations' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.jobs WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 jobs' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.catalog_item_versions WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 catalog_item_versions' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.catalog_items WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 catalog_items' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.sop_versions WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 sop_versions' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.quick_replies WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 quick_replies' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.privacy_notices WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 privacy_notices' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.usage_daily WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 usage_daily' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.sandbox_wechat WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 sandbox_wechat' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.channel_accounts WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 channel_accounts' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.audit_log WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 audit_log' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.auth_sessions WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 auth_sessions' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.memberships WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 memberships' USING ERRCODE = 'check_violation'; END IF;
  DELETE FROM public.users WHERE id = ANY(v_users);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('users', v_n);
  DELETE FROM public.tenants WHERE id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('tenants', v_n);
  IF EXISTS (SELECT 1 FROM public.users WHERE id = ANY(v_users))
     OR EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'sandbox: purge 剩余用户或租户' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_counts::json;
END;
$$;
