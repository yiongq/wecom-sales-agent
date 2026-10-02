-- 02 的 RLS、外键、触发器、清除与删除函数、授权与条目版本回填（docs/architecture/02-conversations-workbench/spec.md「数据库」）。
-- 以 agent_owner 执行：表、函数的属主都是它，FORCE 之下它自己也受 RLS 约束。
-- 已提交的迁移永不修改；要改就写新迁移（scripts/check-migrations.ts 会查）。

-- ===== RLS：01 的模板，十二张新表各一遍；豁免清单仍只有 auth_sessions =====
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE turn_traces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE turn_traces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON turn_traces
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE guard_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE guard_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON guard_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE usage_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE usage_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON usage_daily
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE quick_replies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON quick_replies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE outbound_sends ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbound_sends FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbound_sends
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE catalog_item_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE catalog_item_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON catalog_item_versions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE privacy_notices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE privacy_notices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON privacy_notices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON consents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- ===== orders → conversations：drizzle 的外键动作不带列清单，普通 SET NULL 会把 tenant_id 也置空、违反 NOT NULL =====
ALTER TABLE orders ADD CONSTRAINT orders_session_fk FOREIGN KEY (tenant_id, session_id)
  REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (session_id);
--> statement-breakpoint

-- ===== 触发器：违反时一律 check_violation =====

-- 「最后动静」只进不退：保留期按它判，往回改不能让保留期内的会话提前到期；也不许写一个未来的时刻把它钉住。
-- 导入写入过去的时间不受影响
CREATE FUNCTION conversations_guard_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.updated_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'conversations: updated_at 不能晚于数据库时间 5 分钟以上（收到 %）', NEW.updated_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := greatest(OLD.updated_at, NEW.updated_at);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversations_guard_updated_at BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_guard_updated_at();
--> statement-breakpoint

-- 「客户」按会话名下有没有写过 paid_at 的订单判（保留期更长），清除函数的判断只看 agent_app 改不了的数据（R20）：
-- paid_at 写入之后不能改、不能清空；session_id 写入之后 agent_app 不能置空、不能改挂到别的会话（否则已付客户的会话
-- 就按线索的保留期提前清除）。清除与删除函数是 SECURITY DEFINER，外键的 SET NULL 动作以表的属主执行，两处的
-- current_user 都是 agent_owner，照常放行。从空写成某个会话可以；同值写回（upsert）不算改
CREATE FUNCTION orders_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at THEN
    RAISE EXCEPTION 'orders: paid_at 写入之后不能改、不能清空'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.session_id IS NOT NULL AND NEW.session_id IS DISTINCT FROM OLD.session_id AND current_user <> 'agent_owner' THEN
    RAISE EXCEPTION 'orders: session_id 写入之后只有清除与删除函数能改'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_guard BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guard();
--> statement-breakpoint

-- ===== 清除与删除函数：agent_app 对新表没有 DELETE，过了保留期的行只能经这几个函数删 =====
-- 属主 agent_owner，SECURITY DEFINER；search_path 把 pg_temp 显式放在最后，函数体里的表名一律全限定。
-- 与 01 的认证函数不同，调用者必须已在 p_tenant 的 withTenant 事务里：app.tenant_id 为空或不等于 p_tenant 就报错，
-- 没有「替调用者设租户」的分支。带 p_now 的三个：p_now 与 now() 相差超过 5 分钟就报错（不许传一个未来的「现在」）。
-- 保留期按 24 小时一天算，不随会话时区的夏令时变化（与 01 的会话期限同一写法）。

-- 只 GRANT 给 agent_app。库里的 last_seq、updated_at 与两个预期值不符（清理时会话又有了动静）就返回 false；
-- 写过 paid_at 的会话按 retention_customer_days，否则按 retention_lead_days；updated_at 早于 p_now − 保留期才删：
-- 会话行（级联消息、trace、护栏事件、同意记录）、按 id 删发送账本，订单 session_id 置空并去掉 data 里的 sessionId；
-- 任务按 payload 里的 sessionId 删（任何状态：跟进的 dedupe_key 带着会话 id，验收 27 要库里搜不到 external_userid）
CREATE FUNCTION purge_conversation(
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
  DELETE FROM public.jobs WHERE tenant_id = p_tenant AND payload->>'sessionId' = p_id;
  DELETE FROM public.conversations WHERE tenant_id = p_tenant AND id = p_id;
  RETURN true;
END;
$$;
--> statement-breakpoint

-- 只 GRANT 给 agent_app。删 started_at 早于 p_now − retention_trace_days 的 trace（级联护栏事件），以及没有对应会话、
-- sent_at 同样过期的发送账本行（老客户进入会话但没说话）；返回两类删除条数之和
CREATE FUNCTION purge_expired_traces(p_tenant uuid, p_now timestamptz) RETURNS int
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

-- 只 GRANT 给 agent_app。删 finished_at 早于 p_now − 30 天的 done、cancelled、abandoned、failed 任务；返回删除条数
CREATE FUNCTION purge_finished_jobs(p_tenant uuid, p_now timestamptz) RETURNS int
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_jobs int;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'purge: 要在 p_tenant 的 withTenant 事务里调用' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_now IS NULL OR p_now > now() + interval '5 minutes' OR p_now < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'purge: p_now 与数据库时间相差超过 5 分钟' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.jobs
   WHERE tenant_id = p_tenant
     AND status IN ('done', 'cancelled', 'abandoned', 'failed')
     AND finished_at < p_now - 30 * interval '24 hours';
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  RETURN v_jobs;
END;
$$;
--> statement-breakpoint

-- 只 GRANT 给 agent_platform（R23 行权删除）。不看保留期；删除范围与 purge_conversation 相同；
-- 写一行 platform.erase 审计，diff 只有各类的条数与原因，不存会话 id；返回各类的条数
CREATE FUNCTION erase_conversation(p_tenant uuid, p_id text, p_reason text) RETURNS json
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
  DELETE FROM public.jobs WHERE tenant_id = p_tenant AND payload->>'sessionId' = p_id;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  DELETE FROM public.conversations WHERE tenant_id = p_tenant AND id = p_id;
  GET DIAGNOSTICS v_conversations = ROW_COUNT;
  v_counts := json_build_object(
    'conversations', v_conversations, 'messages', v_messages, 'traces', v_traces, 'guardEvents', v_guard_events,
    'consents', v_consents, 'outboundSends', v_sends, 'orders', v_orders, 'jobs', v_jobs
  );
  INSERT INTO public.audit_log (tenant_id, actor_name, actor_kind, action, diff)
  VALUES (p_tenant, 'erase-conversation', 'platform', 'platform.erase', v_counts::jsonb || jsonb_build_object('reason', p_reason));
  RETURN v_counts;
END;
$$;
--> statement-breakpoint

-- 默认权限（0001）已不给 PUBLIC 执行新函数；spec 要求对 PUBLIC 撤销，这里对四个函数显式再收一次
-- migration-allow: revoke 只收紧本迁移新建的四个函数，旧镜像不调用它们
REVOKE EXECUTE ON FUNCTION
  purge_conversation(uuid, text, timestamptz, int, timestamptz),
  purge_expired_traces(uuid, timestamptz),
  purge_finished_jobs(uuid, timestamptz),
  erase_conversation(uuid, text, text)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  purge_conversation(uuid, text, timestamptz, int, timestamptz),
  purge_expired_traces(uuid, timestamptz),
  purge_finished_jobs(uuid, timestamptz)
TO agent_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION erase_conversation(uuid, text, text) TO agent_platform;
--> statement-breakpoint

-- ===== 授权（spec 的授权表）。没有任何角色对新表有 DELETE 或 TRUNCATE =====
GRANT SELECT, INSERT, UPDATE ON conversations, orders TO agent_app;
--> statement-breakpoint
-- 只追加：消息、trace、护栏事件、同意记录、条目版本
GRANT SELECT, INSERT ON messages, turn_traces, guard_events, consents, catalog_item_versions TO agent_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON usage_daily, jobs, outbound_sends, quick_replies TO agent_app;
--> statement-breakpoint
-- 隐私说明由平台发布（privacy-publish），应用只读
GRANT SELECT ON privacy_notices TO agent_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON privacy_notices TO agent_platform;
--> statement-breakpoint
-- 保留期由平台设置（tenant-retention）：只有这三列，列级授权
GRANT UPDATE (retention_lead_days, retention_customer_days, retention_trace_days) ON tenants TO agent_platform;
--> statement-breakpoint

-- ===== 条目版本回填：每个 active 条目以当前 payload 写版本 1（source='backfill'）=====
-- FORCE 之下属主也只看得到当前租户的行：按租户 set_config（事务级）后 INSERT … SELECT，不用动态 EXECUTE；最后清回空
DO $$
DECLARE
  v_tenant uuid;
BEGIN
  FOR v_tenant IN SELECT t.id FROM public.tenants t ORDER BY t.id LOOP
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    INSERT INTO public.catalog_item_versions (tenant_id, kind, code, version, payload, source)
    SELECT i.tenant_id, i.kind, i.code, 1, i.payload, 'backfill'
      FROM public.catalog_items i
     WHERE i.tenant_id = v_tenant AND i.status = 'active'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END;
$$;
