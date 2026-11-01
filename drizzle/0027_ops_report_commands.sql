-- 17 R7/R12：只开放给隔离的平台进程；不保存正文、slug 或外部地址。
CREATE FUNCTION public.ops_report_retry(p_tenant uuid, p_day date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_report uuid;
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'tenant_context_mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id=p_tenant AND kind='standard') THEN
    RAISE EXCEPTION 'standard_tenant_required';
  END IF;
  UPDATE public.ops_daily_reports SET status='pending', resend_count=resend_count+1,
    attempts=0, claim_token=NULL, next_attempt_at=NULL, error_code=NULL
    WHERE tenant_id=p_tenant AND day=p_day AND status IN ('unknown','failed') RETURNING report_id INTO v_report;
  IF v_report IS NULL THEN RAISE EXCEPTION 'report_not_retryable'; END IF;
  UPDATE public.jobs SET status='cancelled', finished_at=now()
    WHERE tenant_id=p_tenant AND kind='ops_daily_digest' AND dedupe_key='ops_daily_digest:'||p_day::text
      AND status IN ('pending','running','sending');
  INSERT INTO public.jobs(tenant_id,kind,dedupe_key,run_at,payload,max_attempts)
    VALUES(p_tenant,'ops_daily_digest','ops_daily_digest:'||p_day::text,now(),json_build_object('day',p_day::text),10);
  INSERT INTO public.audit_log(tenant_id,actor_kind,actor_name,action,diff)
    VALUES(p_tenant,'platform','ops-report','ops_report.retry',json_build_object('day',p_day,'report_id',v_report));
END $$;
--> statement-breakpoint
-- migration-allow: revoke 新增函数禁止 PUBLIC 和应用身份执行，既有权限不变。
REVOKE ALL ON FUNCTION public.ops_report_retry(uuid,date) FROM PUBLIC, agent_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ops_report_retry(uuid,date) TO agent_platform;
--> statement-breakpoint
CREATE FUNCTION public.ops_report_prepare_rollback(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_tenant IS NULL OR NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'tenant_context_mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id=p_tenant AND kind='standard') THEN
    RAISE EXCEPTION 'standard_tenant_required';
  END IF;
  UPDATE public.jobs SET status='cancelled', finished_at=now()
    WHERE tenant_id=p_tenant AND kind='ops_daily_digest' AND status IN ('pending','running','sending');
  UPDATE public.ops_daily_reports SET status='unknown', error_code='restart_in_sending', claim_token=NULL
    WHERE tenant_id=p_tenant AND status='sending';
  INSERT INTO public.audit_log(tenant_id,actor_kind,actor_name,action,diff)
    VALUES(p_tenant,'platform','ops-report','ops_report.prepare_rollback','{}');
END $$;
--> statement-breakpoint
-- migration-allow: revoke 新增函数禁止 PUBLIC 和应用身份执行，既有权限不变。
REVOKE ALL ON FUNCTION public.ops_report_prepare_rollback(uuid) FROM PUBLIC, agent_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ops_report_prepare_rollback(uuid) TO agent_platform;
