ALTER TABLE "tenants" ADD COLUMN "brand" json;
--> statement-breakpoint
-- 04 R4、R6：平台只多获 brand 列的 UPDATE；agent_app 仍只读 tenants。
GRANT UPDATE (brand) ON tenants TO agent_platform;
