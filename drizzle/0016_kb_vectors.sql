-- 07 R11–R13：线路块与向量进 Postgres（相似度仍在进程内算，不建 HNSW，每轮不查库）。
-- kb_chunks 可移植，PGlite 上也建；kb_vectors 要 pgvector 的 halfvec，只在 vector 扩展已装的库里建（下面的 DO 块）。
-- 派生数据：agent_app 有 SELECT / INSERT / UPDATE / DELETE，丢了可以按产品库重建。
-- 旧镜像不碰这两张表；回滚后它照旧读写 var/route-vectors.json。
CREATE TABLE "kb_chunks" (
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenants"("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	CONSTRAINT "kb_chunks_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "kb_chunks_tenant_id_source_ref_uq" UNIQUE("tenant_id","source","ref"),
	CONSTRAINT "kb_chunks_source_check" CHECK ("kb_chunks"."source" IN ('route')),
	CONSTRAINT "kb_chunks_body_hash_check" CHECK ("kb_chunks"."body_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.kb_chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.kb_chunks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_chunks TO agent_app;
--> statement-breakpoint

-- R12：扩展已装 → 建 kb_vectors；扩展可用但没装 → 报错停下（agent_owner 不是超级用户，建不了非 trusted 的 vector，
-- 第 0.3 步实测）；扩展根本不可用（PGlite）→ 跳过。DO 块里没有动态 SQL：halfvec 只在这个分支里才被解析。
-- 迁移整批在一个事务里，报错时本文件的其余语句一并回滚，部署停在切换之前。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector') THEN
    CREATE TABLE public.kb_vectors (
      tenant_id uuid NOT NULL,
      chunk_id uuid NOT NULL,
      model text NOT NULL,
      body_hash text NOT NULL,
      embedding halfvec(2048) NOT NULL,
      CONSTRAINT kb_vectors_tenant_id_chunk_id_model_pk PRIMARY KEY (tenant_id, chunk_id, model),
      CONSTRAINT kb_vectors_chunk_fk FOREIGN KEY (tenant_id, chunk_id) REFERENCES public.kb_chunks (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT kb_vectors_body_hash_check CHECK (body_hash ~ '^[0-9a-f]{64}$')
    );
    ALTER TABLE public.kb_vectors ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.kb_vectors FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON public.kb_vectors
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_vectors TO agent_app;
  ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'kb_vectors: 应用库里没有 vector 扩展，而 agent_owner 建不了它。先由超级用户在应用库里建 vector 扩展（连应用库执行 deploy/db-init/extensions.sql 里的语句），再重跑迁移'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$$;
--> statement-breakpoint

-- 05 R12 / 07 R13：sandbox_tenant_purge 的删除清单加 kb_chunks 与 kb_vectors。从 0011 的版本整段重写，其余原样：
-- 签名、属主、授权、租户校验、已到期检查、日计数、删除顺序和复数都不变；kb_vectors 用 to_regclass 判断后动态执行，PGlite 上跳过。
-- migration-allow: create-or-replace 删除清单加两张新表，其余与 0011 的版本逐行相同
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
