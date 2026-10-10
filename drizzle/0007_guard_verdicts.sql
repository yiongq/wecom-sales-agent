ALTER TABLE "turn_traces" ADD COLUMN "guard_verdicts" json;
--> statement-breakpoint
-- 04 R8：继承 02 表级 SELECT、INSERT；显式列级声明便于审查。agent_app 无 UPDATE、DELETE，agent_platform 无权限。
GRANT SELECT (guard_verdicts), INSERT (guard_verdicts) ON turn_traces TO agent_app;
