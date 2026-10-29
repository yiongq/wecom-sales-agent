-- 12 R4：附件随会话保存、删除；原件保留 30 天。
CREATE TABLE public.attachments (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  id text NOT NULL,
  conversation_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('wecom', 'web')),
  source_key text NOT NULL,
  cls text NOT NULL CHECK (cls IN ('image', 'sheet', 'legacy_sheet', 'locked_sheet', 'drawing', 'video', 'other')),
  mime text NOT NULL,
  name text,
  size bigint NOT NULL CHECK (size >= 0),
  sha256 text,
  bytes bytea,
  intake_id text,
  result json,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel, source_key),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES public.conversations(tenant_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX attachments_conversation_idx ON public.attachments(tenant_id, conversation_id);
--> statement-breakpoint
CREATE INDEX attachments_created_idx ON public.attachments(tenant_id, created_at);
--> statement-breakpoint
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.attachments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON public.attachments TO agent_app;
--> statement-breakpoint
GRANT UPDATE (intake_id, result) ON public.attachments TO agent_app;
--> statement-breakpoint
-- migration-allow: drop 只放宽，旧镜像的写入仍合法
ALTER TABLE public.usage_daily DROP CONSTRAINT usage_daily_purpose_check;
--> statement-breakpoint
-- migration-allow: add-check 只放宽，旧镜像的写入仍合法
ALTER TABLE public.usage_daily ADD CONSTRAINT usage_daily_purpose_check CHECK (purpose IN ('chat','followup','insight','suggestion','draft','embedding','gate','vision'));
--> statement-breakpoint
-- migration-allow: create-or-replace 返回附件计数；其余权限、签名与行为不变
CREATE OR REPLACE FUNCTION erase_conversation(p_tenant uuid, p_id text, p_reason text) RETURNS json
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_conversations int;
  v_messages int;
  v_traces int;
  v_guard_events int;
  v_consents int;
  v_sends int;
  v_inbox int;
  v_orders int;
  v_jobs int;
  v_counts json;
  v_attachments int;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'erase: 要在 p_tenant 的 withTenant 事务里调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'erase: 要写明原因' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- 先锁会话行再数：级联删掉的几类只能在删之前数
  PERFORM 1 FROM public.conversations c WHERE c.tenant_id = p_tenant AND c.id = p_id FOR UPDATE;
  SELECT count(*) INTO v_messages FROM public.messages m WHERE m.tenant_id = p_tenant AND m.conversation_id = p_id;
  SELECT count(*) INTO v_traces FROM public.turn_traces tt WHERE tt.tenant_id = p_tenant AND tt.conversation_id = p_id;
  SELECT count(*) INTO v_guard_events
    FROM public.guard_events g
    JOIN public.turn_traces tt ON tt.tenant_id = g.tenant_id AND tt.id = g.turn_id
   WHERE tt.tenant_id = p_tenant AND tt.conversation_id = p_id;
  SELECT count(*) INTO v_consents FROM public.consents s WHERE s.tenant_id = p_tenant AND s.conversation_id = p_id;
  SELECT count(*) INTO v_attachments FROM public.attachments a WHERE a.tenant_id = p_tenant AND a.conversation_id = p_id;
  UPDATE public.orders
     SET session_id = NULL, data = (data::jsonb - 'sessionId')::json
   WHERE tenant_id = p_tenant AND session_id = p_id;
  GET DIAGNOSTICS v_orders = ROW_COUNT;
  DELETE FROM public.outbound_sends WHERE tenant_id = p_tenant AND conversation_id = p_id;
  GET DIAGNOSTICS v_sends = ROW_COUNT;
  DELETE FROM public.channel_inbox WHERE tenant_id = p_tenant AND conversation_id = p_id;
  GET DIAGNOSTICS v_inbox = ROW_COUNT;
  DELETE FROM public.jobs WHERE tenant_id = p_tenant AND payload->>'sessionId' = p_id;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  DELETE FROM public.conversations WHERE tenant_id = p_tenant AND id = p_id;
  GET DIAGNOSTICS v_conversations = ROW_COUNT;
  v_counts := json_build_object(
    'conversations', v_conversations, 'messages', v_messages, 'traces', v_traces, 'guardEvents', v_guard_events,
    'consents', v_consents, 'outboundSends', v_sends, 'orders', v_orders, 'jobs', v_jobs, 'inbox', v_inbox, 'attachments', v_attachments
  );
  INSERT INTO public.audit_log (tenant_id, actor_name, actor_kind, action, diff)
  VALUES (p_tenant, 'erase-conversation', 'platform', 'platform.erase', v_counts::jsonb || jsonb_build_object('reason', p_reason));
  RETURN v_counts;
END;
$$;
--> statement-breakpoint
-- migration-allow: create-or-replace 在 0017 的删除与核对清单加入附件，其余原样
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
  DELETE FROM public.attachments WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('attachments', v_n);
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
  SELECT count(*) INTO v_n FROM public.attachments WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 attachments' USING ERRCODE = 'check_violation'; END IF;
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
--> statement-breakpoint
CREATE FUNCTION purge_attachment_bytes(p_tenant uuid, p_now timestamptz) RETURNS int
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_n int;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'purge: 要在 p_tenant 的 withTenant 事务里调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > now() + interval '5 minutes' OR p_now < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'purge: p_now 与数据库时间相差超过 5 分钟' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.attachments SET bytes = NULL
   WHERE tenant_id = p_tenant AND created_at < p_now - interval '30 days' AND bytes IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
--> statement-breakpoint
-- migration-allow: revoke 清理函数只能由 agent_app 在本租户事务调用
REVOKE ALL ON FUNCTION purge_attachment_bytes(uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_attachment_bytes(uuid, timestamptz) TO agent_app;
