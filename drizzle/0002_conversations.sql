CREATE TABLE "catalog_item_versions" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"payload" json NOT NULL,
	"source" text NOT NULL,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_item_versions_tenant_id_kind_code_version_pk" PRIMARY KEY("tenant_id","kind","code","version"),
	CONSTRAINT "catalog_item_versions_version_check" CHECK ("catalog_item_versions"."version" > 0),
	CONSTRAINT "catalog_item_versions_source_check" CHECK ("catalog_item_versions"."source" IN ('backfill', 'activate', 'console', 'fix'))
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"category" text NOT NULL,
	"decision" text NOT NULL,
	"notice_version" integer NOT NULL,
	"evidence" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "consents_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "consents_category_check" CHECK ("consents"."category" IN ('health', 'minor')),
	CONSTRAINT "consents_decision_check" CHECK ("consents"."decision" IN ('asked', 'granted', 'declined', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"ref" uuid DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"stage" text NOT NULL,
	"handed_over" boolean NOT NULL,
	"handoff_kind" text,
	"handoff_at" timestamp with time zone,
	"first_handoff_at" timestamp with time zone,
	"assignee_user_id" uuid,
	"assignee_name" text,
	"last_customer_at" timestamp with time zone,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"window_start_seq" integer DEFAULT 1 NOT NULL,
	"state" json NOT NULL,
	"flush_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "conversations_tenant_id_ref_uq" UNIQUE("tenant_id","ref"),
	CONSTRAINT "conversations_id_check" CHECK ("conversations"."id" !~ '^(sim-|wecom:cust_)' AND length("conversations"."id") BETWEEN 1 AND 200),
	CONSTRAINT "conversations_last_seq_check" CHECK ("conversations"."last_seq" >= 0),
	CONSTRAINT "conversations_window_start_seq_check" CHECK ("conversations"."window_start_seq" BETWEEN 1 AND "conversations"."last_seq" + 1),
	CONSTRAINT "conversations_state_check" CHECK (json_typeof("conversations"."state") = 'object' AND coalesce("conversations"."state"->>'id' = "conversations"."id", false))
);
--> statement-breakpoint
CREATE TABLE "guard_events" (
	"tenant_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"ord" smallint NOT NULL,
	"guard" text NOT NULL,
	"action" text NOT NULL,
	"removed" json NOT NULL,
	"added" json NOT NULL,
	CONSTRAINT "guard_events_tenant_id_turn_id_ord_pk" PRIMARY KEY("tenant_id","turn_id","ord"),
	CONSTRAINT "guard_events_guard_check" CHECK ("guard_events"."guard" ~ '^[a-z_]{2,40}$'),
	CONSTRAINT "guard_events_action_check" CHECK ("guard_events"."action" IN ('drop_sentence', 'replace', 'patch', 'append', 'strip', 'handoff'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"payload" json NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "jobs_kind_check" CHECK ("jobs"."kind" IN ('followup', 'handoff_notify', 'retention_purge')),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" IN ('pending', 'running', 'sending', 'done', 'failed', 'cancelled', 'abandoned')),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("jobs"."max_attempts" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"tenant_id" uuid NOT NULL,
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"author" text,
	"author_user_id" uuid,
	"author_name" text,
	"content" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"msgid" text,
	"turn_id" uuid,
	"extra" json,
	CONSTRAINT "messages_tenant_id_conversation_id_seq_pk" PRIMARY KEY("tenant_id","conversation_id","seq"),
	CONSTRAINT "messages_seq_check" CHECK ("messages"."seq" > 0),
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('customer', 'agent', 'system')),
	CONSTRAINT "messages_author_check" CHECK ("messages"."author" IN ('ai', 'human', 'followup')),
	CONSTRAINT "messages_author_role_check" CHECK ("messages"."role" = 'agent' OR "messages"."author" IS NULL),
	CONSTRAINT "messages_author_human_check" CHECK ("messages"."author" = 'human' OR ("messages"."author_user_id" IS NULL AND "messages"."author_name" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"tenant_id" uuid NOT NULL,
	"id" text NOT NULL,
	"session_id" text,
	"route_id" text NOT NULL,
	"status" text NOT NULL,
	"total_price" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"data" json NOT NULL,
	CONSTRAINT "orders_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "orders_id_check" CHECK ("orders"."id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" IN ('pending_payment', 'paid', 'cancelled', 'superseded')),
	CONSTRAINT "orders_total_price_check" CHECK ("orders"."total_price" >= 0),
	CONSTRAINT "orders_void_reason_check" CHECK ("orders"."void_reason" IN ('reset', 'resync')),
	CONSTRAINT "orders_data_check" CHECK (json_typeof("orders"."data") = 'object' AND coalesce("orders"."data"->>'id' = "orders"."id", false))
);
--> statement-breakpoint
CREATE TABLE "outbound_sends" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" text NOT NULL,
	"channel_msgid" text NOT NULL,
	"message_seq" integer,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"errcode" integer,
	"fail_type" integer,
	CONSTRAINT "outbound_sends_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "outbound_sends_tenant_id_channel_msgid_uq" UNIQUE("tenant_id","channel_msgid"),
	CONSTRAINT "outbound_sends_channel_msgid_check" CHECK (octet_length("outbound_sends"."channel_msgid") <= 32),
	CONSTRAINT "outbound_sends_kind_check" CHECK ("outbound_sends"."kind" IN ('ai', 'human', 'followup', 'notice', 'welcome', 'menu', 'card')),
	CONSTRAINT "outbound_sends_status_check" CHECK ("outbound_sends"."status" IN ('accepted', 'rejected', 'unknown', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "privacy_notices" (
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_name" text,
	CONSTRAINT "privacy_notices_tenant_id_version_pk" PRIMARY KEY("tenant_id","version"),
	CONSTRAINT "privacy_notices_version_check" CHECK ("privacy_notices"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ord" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"archived_at" timestamp with time zone,
	"updated_by_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_replies_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "quick_replies_title_check" CHECK (length("quick_replies"."title") BETWEEN 1 AND 20),
	CONSTRAINT "quick_replies_body_check" CHECK (length("quick_replies"."body") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "turn_traces" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"conversation_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"sop_version" integer,
	"prefix_hash" text NOT NULL,
	"catalog_versions" json NOT NULL,
	"stage_before" text,
	"stage_after" text,
	"draft" text,
	"final_text" text,
	"calls" json NOT NULL,
	"llm" json NOT NULL,
	"signals" json,
	CONSTRAINT "turn_traces_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "turn_traces_outcome_check" CHECK ("turn_traces"."outcome" IN ('replied', 'silent', 'handoff', 'deterministic', 'reset', 'budget', 'error')),
	CONSTRAINT "turn_traces_prefix_hash_check" CHECK ("turn_traces"."prefix_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"model" text NOT NULL,
	"purpose" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_milli_cny" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_tenant_id_day_model_purpose_pk" PRIMARY KEY("tenant_id","day","model","purpose"),
	CONSTRAINT "usage_daily_purpose_check" CHECK ("usage_daily"."purpose" IN ('chat', 'followup', 'insight', 'suggestion', 'draft', 'embedding'))
);
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention_lead_days" integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention_customer_days" integer DEFAULT 730 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "retention_trace_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_item_versions" ADD CONSTRAINT "catalog_item_versions_item_fk" FOREIGN KEY ("tenant_id","kind","code") REFERENCES "public"."catalog_items"("tenant_id","kind","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guard_events" ADD CONSTRAINT "guard_events_turn_fk" FOREIGN KEY ("tenant_id","turn_id") REFERENCES "public"."turn_traces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_notices" ADD CONSTRAINT "privacy_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_traces" ADD CONSTRAINT "turn_traces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_traces" ADD CONSTRAINT "turn_traces_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_by_updated" ON "conversations" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_open_uq" ON "jobs" USING btree ("tenant_id","dedupe_key") WHERE "jobs"."status" IN ('pending', 'running', 'sending');--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("tenant_id","run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "orders_by_status" ON "orders" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "outbound_sends_by_conv" ON "outbound_sends" USING btree ("tenant_id","conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "turn_traces_by_conv" ON "turn_traces" USING btree ("tenant_id","conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "turn_traces_by_time" ON "turn_traces" USING btree ("tenant_id","started_at");--> statement-breakpoint
-- migration-allow: add-check 新列带默认值且满足约束，旧镜像不写这几列
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_lead_days_check" CHECK ("tenants"."retention_lead_days" BETWEEN 7 AND 3650);--> statement-breakpoint
-- migration-allow: add-check 新列带默认值且满足约束，旧镜像不写这几列
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_customer_days_check" CHECK ("tenants"."retention_customer_days" BETWEEN 7 AND 3650);--> statement-breakpoint
-- migration-allow: add-check 新列带默认值且满足约束，旧镜像不写这几列
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_retention_trace_days_check" CHECK ("tenants"."retention_trace_days" BETWEEN 7 AND 3650);