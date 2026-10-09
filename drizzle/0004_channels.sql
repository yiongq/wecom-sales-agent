CREATE TABLE "channel_accounts" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"id_prefix" text,
	"corp_id" text,
	"open_kfid" text,
	"secrets_ct" "bytea",
	"secrets_key_id" text,
	"cursor" text,
	"cursor_at" timestamp with time zone,
	"record_only_until" timestamp with time zone,
	"settings" json DEFAULT '{}'::json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_accounts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "channel_accounts_tenant_id_key_uq" UNIQUE("tenant_id","key"),
	CONSTRAINT "channel_accounts_tenant_id_id_prefix_uq" UNIQUE("tenant_id","id_prefix"),
	CONSTRAINT "channel_accounts_tenant_id_open_kfid_uq" UNIQUE("tenant_id","open_kfid"),
	CONSTRAINT "channel_accounts_key_check" CHECK ("channel_accounts"."key" ~ '^[a-z][a-z0-9-]{1,30}$'),
	CONSTRAINT "channel_accounts_kind_check" CHECK ("channel_accounts"."kind" IN ('wecom_kf', 'web')),
	CONSTRAINT "channel_accounts_name_check" CHECK (length("channel_accounts"."name") BETWEEN 1 AND 40),
	CONSTRAINT "channel_accounts_status_check" CHECK ("channel_accounts"."status" IN ('active', 'disabled', 'exported')),
	CONSTRAINT "channel_accounts_settings_check" CHECK (json_typeof("channel_accounts"."settings") = 'object'),
	CONSTRAINT "channel_accounts_wecom_check" CHECK ("channel_accounts"."kind" <> 'wecom_kf' OR (coalesce("channel_accounts"."id_prefix" IN ('wecom:', 'wecom:' || "channel_accounts"."key" || ':'), false) AND "channel_accounts"."corp_id" IS NOT NULL AND "channel_accounts"."open_kfid" IS NOT NULL AND "channel_accounts"."secrets_ct" IS NOT NULL AND "channel_accounts"."secrets_key_id" IS NOT NULL)),
	CONSTRAINT "channel_accounts_web_check" CHECK ("channel_accounts"."kind" <> 'web' OR ("channel_accounts"."id_prefix" IS NULL AND "channel_accounts"."corp_id" IS NULL AND "channel_accounts"."open_kfid" IS NULL AND "channel_accounts"."secrets_ct" IS NULL AND "channel_accounts"."cursor" IS NULL AND "channel_accounts"."record_only_until" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "channel_inbox" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ord" bigint GENERATED ALWAYS AS IDENTITY (sequence name "channel_inbox_ord_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" uuid NOT NULL,
	"msgid" text NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" text,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"message_seq" integer,
	"payload" json,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_inbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "channel_inbox_tenant_id_account_id_msgid_uq" UNIQUE("tenant_id","account_id","msgid"),
	CONSTRAINT "channel_inbox_msgid_check" CHECK (octet_length("channel_inbox"."msgid") BETWEEN 1 AND 128),
	CONSTRAINT "channel_inbox_kind_check" CHECK ("channel_inbox"."kind" IN ('message', 'menu_click', 'enter_session', 'send_fail', 'legacy')),
	CONSTRAINT "channel_inbox_state_check" CHECK ("channel_inbox"."state" IN ('received', 'recorded', 'replied', 'done', 'abandoned')),
	CONSTRAINT "channel_inbox_reason_check" CHECK ("channel_inbox"."reason" IN ('too_old', 'poison', 'cold_start', 'restore_cutoff', 'resync')),
	CONSTRAINT "channel_inbox_reason_iff_abandoned" CHECK (("channel_inbox"."state" = 'abandoned') = ("channel_inbox"."reason" IS NOT NULL)),
	CONSTRAINT "channel_inbox_payload_check" CHECK ("channel_inbox"."state" NOT IN ('done', 'abandoned') OR "channel_inbox"."payload" IS NULL),
	CONSTRAINT "channel_inbox_conversation_check" CHECK ("channel_inbox"."kind" = 'legacy' OR "channel_inbox"."conversation_id" IS NOT NULL)
);
--> statement-breakpoint
-- migration-allow: drop 放宽 status 的取值，旧镜像写的值都在新集合里
ALTER TABLE "outbound_sends" DROP CONSTRAINT "outbound_sends_status_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel_account_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN "inbox_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN "segment" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN "attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD COLUMN "payload" json;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_inbox" ADD CONSTRAINT "channel_inbox_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."channel_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_inbox_open" ON "channel_inbox" USING btree ("tenant_id","account_id","ord") WHERE "channel_inbox"."state" IN ('received', 'recorded', 'replied');--> statement-breakpoint
CREATE INDEX "channel_inbox_by_conv" ON "channel_inbox" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "channel_inbox_finished" ON "channel_inbox" USING btree ("tenant_id","updated_at") WHERE "channel_inbox"."state" IN ('done', 'abandoned');--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_account_fk" FOREIGN KEY ("tenant_id","channel_account_id") REFERENCES "public"."channel_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "public"."channel_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_sends_open" ON "outbound_sends" USING btree ("tenant_id","account_id") WHERE "outbound_sends"."status" IN ('pending', 'sending');--> statement-breakpoint
-- migration-allow: add-check 新列为空或取默认值，旧行都满足
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_payload_check" CHECK ("outbound_sends"."status" IN ('pending', 'sending') OR "outbound_sends"."payload" IS NULL);--> statement-breakpoint
-- migration-allow: add-check 放宽 status 的取值，旧镜像写的值都在新集合里
ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_status_check" CHECK ("outbound_sends"."status" IN ('pending', 'sending', 'accepted', 'rejected', 'unknown', 'failed', 'cancelled'));