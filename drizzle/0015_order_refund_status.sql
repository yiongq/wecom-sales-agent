-- migration-allow: drop 放宽 CHECK：先删再加，旧镜像写入的四个值仍合法
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
--> statement-breakpoint
-- migration-allow: add-check 只是多两个合法值，已有行全部满足
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending_payment','paid','cancelled','superseded','refund_pending','refunded'));
--> statement-breakpoint
-- migration-allow: add-check 新状态才受约束，已有行全部满足
ALTER TABLE orders ADD CONSTRAINT orders_refund_paid_check
  CHECK (status NOT IN ('refund_pending','refunded') OR paid_at IS NOT NULL);
--> statement-breakpoint
-- migration-allow: create-or-replace orders_guard 加 refunded 之后 status 不变，原有两条原样
CREATE OR REPLACE FUNCTION orders_guard() RETURNS trigger
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
  IF OLD.status = 'refunded' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'orders: refunded 之后 status 不能再变'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
