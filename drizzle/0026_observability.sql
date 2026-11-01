-- 17 R2/R3/R12：评分、摘要账本、延迟状态与采集证据；旧镜像不读新表。
CREATE TABLE public.turn_reviews (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  turn_id uuid NOT NULL,
  rating text NOT NULL CHECK (rating IN ('good', 'bad')),
  reason text CHECK (reason IN ('incorrect', 'missing', 'handoff', 'format', 'other')),
  reviewer_user_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, turn_id),
  CONSTRAINT turn_reviews_reason_rating_check CHECK ((rating = 'bad') = (reason IS NOT NULL)),
  CONSTRAINT turn_reviews_turn_fk FOREIGN KEY (tenant_id, turn_id)
    REFERENCES public.turn_traces(tenant_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX turn_reviews_rating_reason_idx ON public.turn_reviews(tenant_id, rating, reason);
--> statement-breakpoint
CREATE TABLE public.ops_daily_reports (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  day date NOT NULL,
  report_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'unknown', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
  next_attempt_at timestamptz,
  claim_token uuid,
  computed_at timestamptz,
  sent_at timestamptz,
  error_code text CHECK (error_code IN ('config_missing', 'rate_limited', 'sql_error', 'rejected', 'timeout', 'network', 'bad_response', 'server_error', 'redirect', 'restart_in_sending', 'commit_failed', 'deadline', 'suspended', 'disabled')),
  snapshot json,
  PRIMARY KEY (tenant_id, day)
);
--> statement-breakpoint
CREATE TABLE public.ops_latency_state (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id),
  last_window_end timestamptz,
  bad_streak integer NOT NULL DEFAULT 0 CHECK (bad_streak >= 0),
  good_streak integer NOT NULL DEFAULT 0 CHECK (good_streak >= 0),
  active boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  last_sent_at timestamptz,
  last_p90_ms integer CHECK (last_p90_ms >= 0),
  last_samples integer NOT NULL DEFAULT 0 CHECK (last_samples >= 0)
);
--> statement-breakpoint
CREATE TABLE public.ops_metric_coverage (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  day date NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  has_gap boolean NOT NULL DEFAULT false,
  has_deletion boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, day),
  CONSTRAINT ops_metric_coverage_window_check CHECK (last_seen_at >= first_seen_at)
);
--> statement-breakpoint
ALTER TABLE public.turn_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.turn_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.turn_reviews
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.turn_reviews TO agent_app;
--> statement-breakpoint
ALTER TABLE public.ops_daily_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ops_daily_reports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.ops_daily_reports
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ops_daily_reports TO agent_app;
--> statement-breakpoint
ALTER TABLE public.ops_latency_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ops_latency_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.ops_latency_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ops_latency_state TO agent_app;
--> statement-breakpoint
ALTER TABLE public.ops_metric_coverage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ops_metric_coverage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.ops_metric_coverage
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.ops_metric_coverage TO agent_app;
--> statement-breakpoint
-- migration-allow: drop 仅放宽 kind，旧镜像写入保持合法
ALTER TABLE public.jobs DROP CONSTRAINT jobs_kind_check;
--> statement-breakpoint
-- migration-allow: add-check 仅追加 ops_daily_digest，TS JobKind 在第 5 步扩展
ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('followup', 'handoff_notify', 'retention_purge', 'ops_daily_digest'));
--> statement-breakpoint
-- 内部函数：默认 ACL 与显式撤销均不允许应用/平台直接调用；仅清除函数属主可执行。
CREATE FUNCTION ops_coverage_mark_deleted(p_tenant uuid, p_at timestamptz[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'ops: 须在 p_tenant 的 withTenant 事务里调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.ops_metric_coverage c SET has_deletion = true
   WHERE c.tenant_id = p_tenant AND NOT c.has_deletion
     AND EXISTS (SELECT 1 FROM unnest(p_at) AS d(at)
       WHERE d.at BETWEEN c.first_seen_at - interval '2 minutes' AND c.last_seen_at + interval '2 minutes');
END;
$$;
--> statement-breakpoint
-- migration-allow: revoke 只收紧新内部函数，不影响旧镜像
REVOKE EXECUTE ON FUNCTION ops_coverage_mark_deleted(uuid, timestamptz[]) FROM PUBLIC, agent_app, agent_platform;
--> statement-breakpoint
-- migration-allow: create-or-replace purge_conversation 仅增补评分/coverage 清理，签名、权限与旧调用保持兼容
CREATE OR REPLACE FUNCTION purge_conversation(
  p_tenant uuid, p_id text, p_now timestamptz, p_expected_last_seq int, p_expected_updated_at timestamptz
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_last_seq int;
  v_updated_at timestamptz;
  v_paid boolean;
  v_days int;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'purge: 要在 p_tenant 的 withTenant 事务里调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > now() + interval '5 minutes' OR p_now < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'purge: p_now 与数据库时间相差超过 5 分钟' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.last_seq, c.updated_at INTO v_last_seq, v_updated_at
    FROM public.conversations c
   WHERE c.tenant_id = p_tenant AND c.id = p_id
     FOR UPDATE;
  IF NOT FOUND
     OR v_last_seq IS DISTINCT FROM p_expected_last_seq
     OR v_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN false;
  END IF;
  -- 作废、取消的订单写过 paid_at 也算客户
  v_paid := EXISTS (
    SELECT 1 FROM public.orders o WHERE o.tenant_id = p_tenant AND o.session_id = p_id AND o.paid_at IS NOT NULL
  );
  SELECT CASE WHEN v_paid THEN t.retention_customer_days ELSE t.retention_lead_days END INTO v_days
    FROM public.tenants t
   WHERE t.id = p_tenant;
  IF v_days IS NULL OR v_updated_at >= p_now - v_days * interval '24 hours' THEN
    RETURN false;
  END IF;
  -- 删除前留完整性标志，不保存任何源 id；已付订单仍去关联留存。
  PERFORM public.ops_coverage_mark_deleted(p_tenant, ARRAY(
    SELECT tt.started_at FROM public.turn_traces tt WHERE tt.tenant_id = p_tenant AND tt.conversation_id = p_id
    UNION ALL
    SELECT o.paid_at FROM public.orders o WHERE o.tenant_id = p_tenant AND o.session_id = p_id AND o.paid_at IS NOT NULL
  ));
  -- 先改订单：删掉会话之后外键已把 session_id 置空，就找不到它们了
  UPDATE public.orders
     SET session_id = NULL, data = (data::jsonb - 'sessionId')::json
   WHERE tenant_id = p_tenant AND session_id = p_id;
  DELETE FROM public.outbound_sends WHERE tenant_id = p_tenant AND conversation_id = p_id;
  DELETE FROM public.channel_inbox WHERE tenant_id = p_tenant AND conversation_id = p_id;
  DELETE FROM public.jobs WHERE tenant_id = p_tenant AND payload->>'sessionId' = p_id;
  DELETE FROM public.conversations WHERE tenant_id = p_tenant AND id = p_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- migration-allow: create-or-replace purge_expired_traces 仅增补评分/coverage 清理，签名、权限与旧调用保持兼容
CREATE OR REPLACE FUNCTION purge_expired_traces(p_tenant uuid, p_now timestamptz) RETURNS int
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_cutoff timestamptz;
  v_traces int;
  v_sends int;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'purge: 要在 p_tenant 的 withTenant 事务里调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > now() + interval '5 minutes' OR p_now < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'purge: p_now 与数据库时间相差超过 5 分钟' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT p_now - t.retention_trace_days * interval '24 hours' INTO v_cutoff
    FROM public.tenants t
   WHERE t.id = p_tenant;
  PERFORM public.ops_coverage_mark_deleted(p_tenant, ARRAY(
    SELECT tt.started_at FROM public.turn_traces tt WHERE tt.tenant_id = p_tenant AND tt.started_at < v_cutoff
  ));
  DELETE FROM public.turn_traces WHERE tenant_id = p_tenant AND started_at < v_cutoff;
  GET DIAGNOSTICS v_traces = ROW_COUNT;
  DELETE FROM public.outbound_sends s
   WHERE s.tenant_id = p_tenant
     AND s.sent_at < v_cutoff
     AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.tenant_id = p_tenant AND c.id = s.conversation_id);
  GET DIAGNOSTICS v_sends = ROW_COUNT;
  RETURN v_traces + v_sends;
END;
$$;
--> statement-breakpoint
-- migration-allow: create-or-replace erase_conversation 仅增补评分/coverage 清理，签名、权限与旧调用保持兼容
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
  v_reviews int;
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
  SELECT count(*) INTO v_reviews FROM public.turn_reviews r
    JOIN public.turn_traces tt ON tt.tenant_id = r.tenant_id AND tt.id = r.turn_id
   WHERE tt.tenant_id = p_tenant AND tt.conversation_id = p_id;
  -- 删除前留完整性标志，不保存任何源 id；已付订单仍去关联留存。
  PERFORM public.ops_coverage_mark_deleted(p_tenant, ARRAY(
    SELECT tt.started_at FROM public.turn_traces tt WHERE tt.tenant_id = p_tenant AND tt.conversation_id = p_id
    UNION ALL
    SELECT o.paid_at FROM public.orders o WHERE o.tenant_id = p_tenant AND o.session_id = p_id AND o.paid_at IS NOT NULL
  ));
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
    'consents', v_consents, 'outboundSends', v_sends, 'orders', v_orders, 'jobs', v_jobs, 'inbox', v_inbox, 'attachments', v_attachments, 'reviews', v_reviews
  );
  INSERT INTO public.audit_log (tenant_id, actor_name, actor_kind, action, diff)
  VALUES (p_tenant, 'erase-conversation', 'platform', 'platform.erase', v_counts::jsonb || jsonb_build_object('reason', p_reason));
  RETURN v_counts;
END;
$$;
--> statement-breakpoint
-- migration-allow: create-or-replace sandbox_tenant_purge 仅增补评分/coverage 清理，签名、权限与旧调用保持兼容
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
  DELETE FROM public.turn_reviews WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('turn_reviews', v_n);
  DELETE FROM public.ops_daily_reports WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('ops_daily_reports', v_n);
  DELETE FROM public.ops_latency_state WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('ops_latency_state', v_n);
  DELETE FROM public.ops_metric_coverage WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('ops_metric_coverage', v_n);
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
  DELETE FROM public.erp_item_links WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('erp_item_links', v_n);
  DELETE FROM public.erp_connectors WHERE tenant_id = p_tenant;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('erp_connectors', v_n);
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
  SELECT count(*) INTO v_n FROM public.turn_reviews WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 turn_reviews' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.ops_daily_reports WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 ops_daily_reports' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.ops_latency_state WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 ops_latency_state' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.ops_metric_coverage WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 ops_metric_coverage' USING ERRCODE = 'check_violation'; END IF;
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
  SELECT count(*) INTO v_n FROM public.erp_item_links WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 erp_item_links' USING ERRCODE = 'check_violation'; END IF;
  SELECT count(*) INTO v_n FROM public.erp_connectors WHERE tenant_id = p_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sandbox: purge 剩余 erp_connectors' USING ERRCODE = 'check_violation'; END IF;
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
-- 日期列不依赖部署 TZ；按 UTC 日期保守保留今天及前 N 日，最多多留一天，不少留。
CREATE FUNCTION purge_ops_data(p_tenant uuid, p_now timestamptz) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_days int;
  v_day date;
  v_n int;
  v_total int := 0;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'ops: 须在 p_tenant 的 withTenant 事务里调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > now() + interval '5 minutes' OR p_now < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'ops: p_now 与数据库时间相差超过 5 分钟' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT t.retention_trace_days INTO v_days FROM public.tenants t WHERE t.id = p_tenant;
  v_day := (p_now AT TIME ZONE 'UTC')::date;
  DELETE FROM public.ops_daily_reports WHERE tenant_id = p_tenant AND day < v_day - 35;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  UPDATE public.ops_daily_reports SET snapshot = NULL
   WHERE tenant_id = p_tenant AND snapshot IS NOT NULL AND day < v_day - least(35, v_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.ops_metric_coverage WHERE tenant_id = p_tenant AND day < v_day - least(30, v_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_total + v_n;
END;
$$;
--> statement-breakpoint
-- migration-allow: revoke 新清理函数仅授权 agent_app，旧镜像不调用
REVOKE EXECUTE ON FUNCTION purge_ops_data(uuid, timestamptz) FROM PUBLIC, agent_platform;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_ops_data(uuid, timestamptz) TO agent_app;
