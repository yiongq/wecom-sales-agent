-- 03 的 RLS、触发器、purge_channel_inbox、改写 02 的两个清除与删除函数、授权与列级授权
-- （docs/architecture/03-channels-v2/spec.md「数据库」）。
-- 以 agent_owner 执行：表、函数的属主都是它，FORCE 之下它自己也受 RLS 约束。
-- 已提交的迁移永不修改；要改就写新迁移（scripts/check-migrations.ts 会查）。

-- ===== RLS：01 的模板，两张新表各一遍；豁免清单仍只有 auth_sessions =====
ALTER TABLE channel_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE channel_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON channel_accounts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE channel_inbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE channel_inbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON channel_inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- ===== 触发器：违反时一律 check_violation；报错里不带列的值（corp_id、open_kfid 不进日志） =====

-- 渠道账号的身份建好不改：换客服账号就是新建一行、停用旧的（R8、不变量 21）。updated_at 每次 UPDATE 由库写
CREATE FUNCTION channel_accounts_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.id_prefix IS DISTINCT FROM OLD.id_prefix
     OR NEW.corp_id IS DISTINCT FROM OLD.corp_id
     OR NEW.open_kfid IS DISTINCT FROM OLD.open_kfid THEN
    RAISE EXCEPTION 'channel_accounts: key、kind、id_prefix、corp_id、open_kfid 建好之后不可修改'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER channel_accounts_guard BEFORE UPDATE ON channel_accounts
  FOR EACH ROW EXECUTE FUNCTION channel_accounts_guard();
--> statement-breakpoint

-- 入站行：done、abandoned 之后任何 UPDATE 都报错（终态不回退、payload 不复活，不变量 8）；updated_at 每次 UPDATE 由库写
-- （清理按它删，agent_app 不能往回改）。仓储的 UPDATE 都按迁移表带了状态条件，正常不会碰到终态行
CREATE FUNCTION channel_inbox_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.state IN ('done', 'abandoned') THEN
    RAISE EXCEPTION 'channel_inbox: 已是 % 的入站行不能再改', OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER channel_inbox_guard BEFORE UPDATE ON channel_inbox
  FOR EACH ROW EXECUTE FUNCTION channel_inbox_guard();
--> statement-breakpoint

-- ===== 清除函数：沿用 02 的写法（属主 agent_owner、SECURITY DEFINER、search_path 钉死、表名全限定、调用者须已在
-- p_tenant 的 withTenant 事务里、p_now 与 now() 相差不超过 5 分钟、一天按 24 小时） =====

-- 只 GRANT 给 agent_app，由 02 的每日 retention_purge 任务一并调用。删 done、abandoned 且 updated_at 早于 p_now − 7 天的
-- 入站行；received_at 早于 p_now − 7 天还没结束的行记 abandoned（too_old）、payload 置空（客户原文不无限期留着）。
-- 先删后记：这次记成 abandoned 的行 updated_at 是现在，再留 7 天。返回两类条数之和
CREATE FUNCTION purge_channel_inbox(p_tenant uuid, p_now timestamptz) RETURNS int
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_deleted int;
  v_abandoned int;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'purge: 要在 p_tenant 的 withTenant 事务里调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > now() + interval '5 minutes' OR p_now < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'purge: p_now 与数据库时间相差超过 5 分钟' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.channel_inbox
   WHERE tenant_id = p_tenant
     AND state IN ('done', 'abandoned')
     AND updated_at < p_now - 7 * interval '24 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE public.channel_inbox
     SET state = 'abandoned', reason = 'too_old', payload = NULL
   WHERE tenant_id = p_tenant
     AND state IN ('received', 'recorded', 'replied')
     AND received_at < p_now - 7 * interval '24 hours';
  GET DIAGNOSTICS v_abandoned = ROW_COUNT;
  RETURN v_deleted + v_abandoned;
END;
$$;
--> statement-breakpoint

-- 02 的 purge_conversation：删除范围加 channel_inbox 里 conversation_id 是这个会话的行（任何状态，不变量 30）；其余与 0003 逐字相同
-- migration-allow: create-or-replace 删除范围加 channel_inbox，签名与权限不变，旧镜像照常调用
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

-- 02 的 erase_conversation：删除范围同上加 channel_inbox，返回值（与审计的 diff）多一项 inbox；其余与 0003 逐字相同
-- migration-allow: create-or-replace 删除范围加 channel_inbox，签名与权限不变，旧镜像照常调用
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
    'consents', v_consents, 'outboundSends', v_sends, 'orders', v_orders, 'jobs', v_jobs, 'inbox', v_inbox
  );
  INSERT INTO public.audit_log (tenant_id, actor_name, actor_kind, action, diff)
  VALUES (p_tenant, 'erase-conversation', 'platform', 'platform.erase', v_counts::jsonb || jsonb_build_object('reason', p_reason));
  RETURN v_counts;
END;
$$;
--> statement-breakpoint

-- ===== 授权（spec 的授权表）。没有任何角色对新表有 DELETE 或 TRUNCATE；agent_platform 对新表没有任何权限 =====
-- 默认权限（0001）已不给 PUBLIC 执行新函数；CREATE OR REPLACE 保留两个旧函数原有的属主与授权
GRANT EXECUTE ON FUNCTION purge_channel_inbox(uuid, timestamptz) TO agent_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON channel_accounts TO agent_app;
--> statement-breakpoint
-- 列级：kind、key、id_prefix、corp_id、open_kfid、tenant_id、id、created_at 应用一列都改不了（停用代替删除，R8）
GRANT UPDATE (name, status, secrets_ct, secrets_key_id, cursor, cursor_at, record_only_until, settings, updated_at)
  ON channel_accounts TO agent_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON channel_inbox TO agent_app;
