// 压测第 25 步「预载」：只做 initConfigFromEnv + initSessionStore，精确量「预载耗时」（R2），量完就退出。
// 不起 HTTP、不碰企微/模型：这是一个独立子进程，专门用来测启动时的分批预载，与「压测」一节的聊天场景分开跑
// （store.ts 的装载函数只能调一次，不能跟后面的场景共用一个进程）。
// 环境变量（由 scripts/load/run.ts 传入）：CONFIG_SOURCE=db、DATABASE_URL（agent_app）、SESSION_STORE=db、
// DEFAULT_TENANT_SLUG、DEPLOY_PROFILE、VAR_DIR。
// 输出：一行 JSON { preloadMs, ok } 到 stdout。

async function main(): Promise<void> {
  const { initConfigFromEnv, configRuntime } = await import('../../src/config/source.js');
  await initConfigFromEnv(process.env, (code) => {
    console.log(JSON.stringify({ ok: false, reason: `initConfig gracefulExit(${code})` }));
    process.exit(1);
  });
  const { initSessionStore, varDir, listSessions, isDemoClassId } = await import('../../src/store.js');
  const { db, tenantId, deps } = configRuntime();
  const t0 = Date.now();
  await initSessionStore({ db, tenantId, tenantSlug: deps.tenantSlug, varDir: varDir() });
  const preloadMs = Date.now() - t0;
  // 预载之后顺手数一遍：给「库里的消息数等于内存」的独立核对用（压测场景进程里独立统计的一份，这里是另一条路重建出来的）
  const real = listSessions().filter((s) => !isDemoClassId(s.id));
  const messages = real.reduce((n, s) => n + (Array.isArray(s.messages) ? s.messages.length : 0), 0);
  console.log(JSON.stringify({ ok: true, preloadMs, realSessions: real.length, messages }));
  process.exit(0);
}

main().catch((e: unknown) => {
  console.log(JSON.stringify({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
