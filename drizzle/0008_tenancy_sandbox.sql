CREATE TABLE "sandbox_pool_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"provisioned" integer DEFAULT 0 NOT NULL,
	"purged" integer DEFAULT 0 NOT NULL,
	"calls" bigint DEFAULT 0 NOT NULL,
	"cost_milli" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "sandbox_pool_daily_provisioned_check" CHECK ("sandbox_pool_daily"."provisioned" >= 0),
	CONSTRAINT "sandbox_pool_daily_purged_check" CHECK ("sandbox_pool_daily"."purged" >= 0),
	CONSTRAINT "sandbox_pool_daily_calls_check" CHECK ("sandbox_pool_daily"."calls" >= 0),
	CONSTRAINT "sandbox_pool_daily_cost_check" CHECK ("sandbox_pool_daily"."cost_milli" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sandbox_process_epoch" (
	"id" smallint PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	CONSTRAINT "sandbox_process_epoch_id_check" CHECK ("sandbox_process_epoch"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sandbox_wechat" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"link_token" text NOT NULL,
	"code_hash" "bytea",
	"code_expires_at" timestamp with time zone,
	"external_userid" text,
	"bound_at" timestamp with time zone,
	CONSTRAINT "sandbox_wechat_link_token_unique" UNIQUE("link_token"),
	CONSTRAINT "sandbox_wechat_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "sandbox_wechat_code_check" CHECK (("sandbox_wechat"."code_hash" IS NULL) = ("sandbox_wechat"."code_expires_at" IS NULL)),
	CONSTRAINT "sandbox_wechat_binding_check" CHECK (("sandbox_wechat"."external_userid" IS NULL) = ("sandbox_wechat"."bound_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sandbox_wecom_state" (
	"open_kfid" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"full_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "kind" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "template_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "public_host" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "llm_daily_alert_milli" bigint;--> statement-breakpoint
ALTER TABLE "sandbox_wechat" ADD CONSTRAINT "sandbox_wechat_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_template_tenant_id_tenants_id_fk" FOREIGN KEY ("template_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_public_host_uq" ON "tenants" USING btree ("public_host") WHERE "tenants"."public_host" IS NOT NULL;--> statement-breakpoint
-- migration-allow: add-check 新列可空或带默认，旧镜像不写这几列
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_kind_check" CHECK ("tenants"."kind" IN ('standard', 'sandbox'));--> statement-breakpoint
-- migration-allow: add-check 新列可空或带默认，旧镜像不写这几列
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_expiry_check" CHECK (("tenants"."kind" = 'sandbox') = ("tenants"."expires_at" IS NOT NULL));--> statement-breakpoint
-- migration-allow: add-check 新列可空或带默认，旧镜像不写这几列
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_sandbox_check" CHECK ("tenants"."kind" = 'standard' OR ("tenants"."public_host" IS NULL AND "tenants"."template_tenant_id" IS NOT NULL AND "tenants"."llm_daily_alert_milli" IS NULL));--> statement-breakpoint
-- migration-allow: add-check 新列可空或带默认，旧镜像不写这几列
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_public_host_check" CHECK ("tenants"."public_host" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$' AND length("tenants"."public_host") <= 253);--> statement-breakpoint
-- migration-allow: add-check 新列可空或带默认，旧镜像不写这几列
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_llm_daily_alert_check" CHECK ("tenants"."llm_daily_alert_milli" >= 0);
--> statement-breakpoint
-- 审计 action 为开放 text，无 CHECK 要修改：sandbox.create、sandbox.end、tenant.host_set、tenant.host_clear、
-- tenant.budget_set、tenant.budget_clear，由后续开通、结束与平台命令调用方在各自事务中写入。
-- 05：以 agent_owner 跑迁移；默认权限沿用 0001，PUBLIC 无函数执行权。
INSERT INTO public.sandbox_process_epoch (id, epoch) VALUES (1, 0);
--> statement-breakpoint
ALTER TABLE public.sandbox_wechat ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sandbox_wechat FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.sandbox_wechat
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

CREATE FUNCTION sandbox_tenant_create(p_slug text, p_template uuid, p_brand json, p_token_hash bytea, p_ip inet, p_user_agent text)
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
  INSERT INTO public.sandbox_pool_daily (day, provisioned) VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (day) DO UPDATE SET provisioned = public.sandbox_pool_daily.provisioned + 1;
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION sandbox_session_resolve(p_token_hash bytea)
  RETURNS TABLE (o_status text, o_tenant uuid, o_user uuid, o_role text, o_display_name text, o_expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
  v_tenant uuid;
  v_user uuid;
  v_kind text;
  v_expires timestamptz;
BEGIN
  SELECT s.tenant_id, s.user_id, t.kind, t.expires_at
    INTO v_tenant, v_user, v_kind, v_expires
    FROM public.auth_sessions s JOIN public.tenants t ON t.id = s.tenant_id
    WHERE s.token_hash = p_token_hash FOR UPDATE OF s;
  o_status := 'invalid';
  IF FOUND THEN
    IF v_kind <> 'sandbox' THEN
      RAISE EXCEPTION 'sandbox: standard 租户不可用沙箱函数' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF coalesce(v_orig, '') <> '' AND lower(v_orig) <> v_tenant::text THEN
      RAISE EXCEPTION 'sandbox: 当前事务已设为别的租户' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    IF v_expires <= now() THEN
      o_status := 'expired';
    ELSE
      SELECT m.role, u.display_name INTO o_role, o_display_name
        FROM public.memberships m JOIN public.users u ON u.id = m.user_id
        WHERE m.tenant_id = v_tenant AND m.user_id = v_user AND u.disabled_at IS NULL;
      IF FOUND THEN
        o_status := 'ok'; o_tenant := v_tenant; o_user := v_user; o_expires_at := v_expires;
        UPDATE public.auth_sessions SET last_seen_at = now() WHERE token_hash = p_token_hash;
      END IF;
    END IF;
    PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
  END IF;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION sandbox_tenant_expire(p_tenant uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_orig text := current_setting('app.tenant_id', true);
  v_kind text;
  v_expires timestamptz;
BEGIN
  SELECT t.kind, t.expires_at INTO v_kind, v_expires FROM public.tenants t WHERE t.id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_kind <> 'sandbox' THEN
    RAISE EXCEPTION 'sandbox: standard 租户不可用沙箱函数' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(v_orig, '') <> '' AND lower(v_orig) <> p_tenant::text THEN
    RAISE EXCEPTION 'sandbox: 当前事务已设为别的租户' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  IF v_expires > now() THEN
    UPDATE public.tenants SET expires_at = now() WHERE id = p_tenant;
  END IF;
  PERFORM set_config('app.tenant_id', coalesce(v_orig, ''), true);
  RETURN true;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION sandbox_tenant_purge(p_tenant uuid) RETURNS json
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
  INSERT INTO public.sandbox_pool_daily (day, purged) VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
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
--> statement-breakpoint

CREATE FUNCTION channel_accounts_sandbox_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = NEW.tenant_id AND t.kind = 'sandbox') THEN
    RAISE EXCEPTION 'channel_accounts: 沙箱租户不可建渠道账号' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER channel_accounts_sandbox_guard BEFORE INSERT ON public.channel_accounts
  FOR EACH ROW EXECUTE FUNCTION public.channel_accounts_sandbox_guard();
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sandbox_tenant_create(text, uuid, json, bytea, inet, text),
  sandbox_session_resolve(bytea), sandbox_tenant_expire(uuid), sandbox_tenant_purge(uuid) TO agent_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.sandbox_pool_daily, public.sandbox_wecom_state, public.sandbox_wechat TO agent_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON public.sandbox_process_epoch TO agent_app;
--> statement-breakpoint
GRANT UPDATE (public_host, llm_daily_alert_milli) ON public.tenants TO agent_platform;
