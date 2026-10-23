-- 07 R7–R10：异步发布闸；结果保留，运行中每租户至多一行。
CREATE TABLE public.sop_gate_runs (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL, draft_rev integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','done','error','abandoned')),
  verdict text CHECK (verdict IN ('pass','fail')), mock boolean NOT NULL,
  prompt_hash text NOT NULL, policy_hash text NOT NULL, draft_key text NOT NULL, baseline_key text NOT NULL,
  results json, cost_milli bigint NOT NULL DEFAULT 0, error text,
  created_by uuid REFERENCES public.users(id), created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,draft_id) REFERENCES public.sop_versions(tenant_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX sop_gate_one_active ON public.sop_gate_runs(tenant_id) WHERE status IN ('queued','running');
--> statement-breakpoint
ALTER TABLE public.sop_gate_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sop_gate_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sop_gate_runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.sop_gate_runs TO agent_app;
--> statement-breakpoint
-- migration-allow: drop 发布闸用量加 gate，先替换旧约束
ALTER TABLE public.usage_daily DROP CONSTRAINT usage_daily_purpose_check;
--> statement-breakpoint
-- migration-allow: add-check 原有用途不变，增加 gate
ALTER TABLE public.usage_daily ADD CONSTRAINT usage_daily_purpose_check CHECK (purpose IN ('chat','followup','insight','suggestion','draft','embedding','gate'));
--> statement-breakpoint
-- migration-allow: create-or-replace 删除清单增加 sop_gate_runs；0016 的 kb_chunks、kb_vectors 分支原样保留
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
  -- 07 R13：kb_vectors 只在 vector 扩展已装的库里有；先删向量（外键级联也会删，但要单独数），再删块
  IF to_regclass('public.kb_vectors') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.kb_vectors WHERE tenant_id = $1' USING p_tenant;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('kb_vectors', v_n);
  END IF;
  DELETE FROM public.kb_chunks WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('kb_chunks', v_n);
  DELETE FROM public.sop_gate_runs WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('sop_gate_runs', v_n);
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
  IF to_regclass('public.kb_vectors') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.kb_vectors WHERE tenant_id = $1' INTO v_n USING p_tenant;
    IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 kb_vectors' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  SELECT count(*) INTO v_n FROM public.kb_chunks WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 kb_chunks' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.sop_gate_runs WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 sop_gate_runs' USING ERRCODE = 'check_violation'; END IF;
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
