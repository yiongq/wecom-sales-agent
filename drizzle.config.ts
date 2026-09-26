// drizzle-kit 只用来从 src/db/schema.ts 生成迁移 SQL（`pnpm db:generate`），不连库。
// RLS、触发器、认证函数和授权写在 custom 迁移里：`pnpm db:generate --custom --name <名字>` 生成空文件再手写。
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
