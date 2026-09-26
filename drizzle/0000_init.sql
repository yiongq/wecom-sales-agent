CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_name" text,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"diff" jsonb,
	"ip" "inet",
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_kind_check" CHECK ("audit_log"."actor_kind" IN ('user', 'system', 'platform'))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text,
	CONSTRAINT "auth_sessions_token_hash_check" CHECK (octet_length("auth_sessions"."token_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"ord" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payload" json NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"updated_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_tenant_kind_code_uq" UNIQUE("tenant_id","kind","code"),
	CONSTRAINT "catalog_items_tenant_kind_ord_uq" UNIQUE("tenant_id","kind","ord"),
	CONSTRAINT "catalog_items_kind_check" CHECK ("catalog_items"."kind" IN ('route', 'hotel')),
	CONSTRAINT "catalog_items_code_check" CHECK ("catalog_items"."code" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "catalog_items_status_check" CHECK ("catalog_items"."status" IN ('draft', 'active')),
	CONSTRAINT "catalog_items_payload_check" CHECK (json_typeof("catalog_items"."payload") = 'object' AND coalesce("catalog_items"."payload"->>'id' = "catalog_items"."code", false))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" IN ('owner', 'admin', 'supervisor', 'agent', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "sop_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_no" integer,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"pack_id" text NOT NULL,
	"sections" jsonb NOT NULL,
	"based_on" uuid,
	"rev" integer DEFAULT 1 NOT NULL,
	"rendered_prompt" text,
	"prompt_hash" text,
	"tools_hash" text,
	"prefix_hash" text,
	"sop_hash" text,
	"render_inputs" jsonb,
	"change_note" text,
	"created_by" uuid,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_by_name" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "sop_versions_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "sop_versions_tenant_id_version_no_uq" UNIQUE("tenant_id","version_no"),
	CONSTRAINT "sop_versions_version_no_check" CHECK ("sop_versions"."version_no" > 0),
	CONSTRAINT "sop_versions_status_check" CHECK ("sop_versions"."status" IN ('draft', 'published', 'archived', 'discarded')),
	CONSTRAINT "sop_versions_source_check" CHECK ("sop_versions"."source" IN ('import', 'console', 'rollback', 'rerender')),
	CONSTRAINT "sop_versions_prompt_hash_check" CHECK ("sop_versions"."prompt_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sop_versions_tools_hash_check" CHECK ("sop_versions"."tools_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sop_versions_prefix_hash_check" CHECK ("sop_versions"."prefix_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sop_versions_sop_hash_check" CHECK ("sop_versions"."sop_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sop_versions_version_no_iff_released" CHECK (("sop_versions"."status" IN ('published', 'archived')) = ("sop_versions"."version_no" IS NOT NULL)),
	CONSTRAINT "sop_versions_prompt_iff_released" CHECK (("sop_versions"."status" IN ('published', 'archived')) = ("sop_versions"."rendered_prompt" IS NOT NULL)),
	CONSTRAINT "sop_versions_render_all_or_none" CHECK (num_nulls("sop_versions"."rendered_prompt", "sop_versions"."prompt_hash", "sop_versions"."tools_hash", "sop_versions"."prefix_hash", "sop_versions"."sop_hash", "sop_versions"."render_inputs") IN (0, 6)),
	CONSTRAINT "sop_versions_prompt_hash_matches" CHECK ("sop_versions"."prompt_hash" IS NULL OR "sop_versions"."prompt_hash" = encode(sha256(convert_to("sop_versions"."rendered_prompt", 'UTF8')), 'hex')),
	CONSTRAINT "sop_versions_prefix_hash_matches" CHECK ("sop_versions"."prefix_hash" IS NULL OR "sop_versions"."prefix_hash" = encode(sha256(convert_to("sop_versions"."tools_hash" || "sop_versions"."prompt_hash", 'UTF8')), 'hex'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"pack_id" text NOT NULL,
	"locale" text DEFAULT 'zh-CN' NOT NULL,
	"region" text DEFAULT 'CN' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_slug_check" CHECK ("tenants"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" IN ('trial', 'active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_versions" ADD CONSTRAINT "sop_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_versions" ADD CONSTRAINT "sop_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_versions" ADD CONSTRAINT "sop_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_versions" ADD CONSTRAINT "sop_versions_based_on_fk" FOREIGN KEY ("tenant_id","based_on") REFERENCES "public"."sop_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_by_tenant" ON "audit_log" USING btree ("tenant_id","id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "auth_sessions_by_user" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sop_one_published" ON "sop_versions" USING btree ("tenant_id") WHERE "sop_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "sop_one_draft" ON "sop_versions" USING btree ("tenant_id") WHERE "sop_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));