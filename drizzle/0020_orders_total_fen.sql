-- 08 R3：通用单的金额按整数分投影；旧版旅游单留空，不回填。
-- 0003 已给 agent_app 表级 SELECT、INSERT、UPDATE，新列自动包含在内，无须另加授权。
ALTER TABLE orders ADD COLUMN total_fen bigint;
--> statement-breakpoint
-- migration-allow: add-check 可空列的非负约束，已有旅游单的 NULL 仍合法。
ALTER TABLE orders ADD CONSTRAINT orders_total_fen_check
  CHECK (total_fen IS NULL OR total_fen >= 0);
--> statement-breakpoint
-- migration-allow: add-check 只约束 v2 通用单，已有旅游单不受影响。
ALTER TABLE orders ADD CONSTRAINT orders_line_total_fen_check
  CHECK ((data->>'v') IS DISTINCT FROM '2' OR (total_fen IS NOT NULL AND total_fen = (data->>'totalFen')::bigint));
