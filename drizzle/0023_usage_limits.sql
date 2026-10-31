-- 14 R2：NULL 不限，0 全拦；旧镜像不写新增列，保持原行为。
-- migration-allow: add-check 新列可空，旧镜像插入仍合法
ALTER TABLE public.tenants
  ADD COLUMN monthly_reply_quota integer CONSTRAINT tenants_monthly_reply_quota_check CHECK (monthly_reply_quota >= 0),
  ADD COLUMN llm_daily_cap_milli bigint CONSTRAINT tenants_llm_daily_cap_check CHECK (llm_daily_cap_milli >= 0),
  ADD CONSTRAINT tenants_limits_standard_only
    CHECK (kind = 'standard' OR (monthly_reply_quota IS NULL AND llm_daily_cap_milli IS NULL));
--> statement-breakpoint
-- migration-allow: drop 只放宽 purpose 值域，旧镜像的写入仍合法
ALTER TABLE public.usage_daily DROP CONSTRAINT usage_daily_purpose_check;
--> statement-breakpoint
-- migration-allow: add-check 保留全部旧值，仅增加零费用的 reply 计数
ALTER TABLE public.usage_daily ADD CONSTRAINT usage_daily_purpose_check
  CHECK (purpose IN ('chat', 'followup', 'insight', 'suggestion', 'draft', 'embedding', 'gate', 'vision', 'reply'));
--> statement-breakpoint
GRANT UPDATE (monthly_reply_quota, llm_daily_cap_milli, status) ON public.tenants TO agent_platform;
