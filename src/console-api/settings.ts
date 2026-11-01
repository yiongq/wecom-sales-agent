// 15 R4–R9：只有 GET，无配置写入。身份由父路由认证和 Host 决定，数据库函数再次检查失权竞态。
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { AuthedUser } from '../auth/session.js';
import { currentCatalog, currentTenant, currentSop, configRuntime } from '../config/source.js';
import { brandSnapshot } from '../config/hashes.js';
import { withTenant, type Tx } from '../db/client.js';
import { readConsoleChannels, readConsoleInbound, readConsoleMembers, readConsoleOrganization } from '../db/repo/console-settings.js';
import { installedChannelAccounts, loadedChannels } from '../channels/registry.js';
import { isEnabled } from '../channels/accounts.js';
import { currentRuntime } from '../tenancy/runtime.js';
import { profile } from '../profile.js';
import { ONBOARDING_HREFS, SETTINGS_ROLES, type ChannelView, type MemberView, type OnboardingView } from '../shared/console-api.js';

type SettingsEnv = { Variables: { user: AuthedUser | null; token: string | null; settingsMembers: MemberView[] } };
const read = <T>(user: AuthedUser, fn: (tx: Tx) => Promise<T>) =>
  withTenant(
    configRuntime().db,
    { tenantId: user.tenantId, actor: { kind: 'user', userId: user.userId, name: user.displayName, ip: null, role: user.role } },
    fn,
    { readOnly: true },
  );

async function channels(user: AuthedUser): Promise<ChannelView[]> {
  const { rows, inbound } = await read(user, async (tx) => ({
    rows: await readConsoleChannels(tx),
    inbound: await readConsoleInbound(tx),
  }));
  const rt = currentRuntime();
  const installed = installedChannelAccounts();
  const loaded = loadedChannels();
  for (const a of installed)
    if (a.source === 'env')
      rows.push({
        accountId: null,
        key: a.key,
        name: a.name,
        kind: 'wecom',
        source: 'env',
        enabled: a.status === 'active',
        loaded: loaded.has(a.id) && isEnabled(a),
        blockedByProfile: false,
        credentialsConfigured: true,
        callbackPath: '/wecom/callback',
        lastInboundAt: null,
      });
  return rows.map((row) => {
    const a = installed.find((v) => row.source === v.source && (row.source === 'env' ? row.key === v.key : row.accountId === v.id));
    return {
      ...row,
      loaded: !!a && loaded.has(a.id) && isEnabled(a),
      blockedByProfile: row.kind === 'web' && !rt.flags.web_channel,
      lastInboundAt: inbound.get(row.accountId) ?? (a?.wecom?.idPrefix === 'wecom:' ? inbound.get(null) : undefined) ?? null,
    };
  });
}

export function createSettingsApi() {
  return new Hono<SettingsEnv>()
    .use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      const user = c.var.user;
      if (!user)
        return c.json(
          { error: profile().flags.anon_readonly_admin ? 'forbidden' : 'unauthorized' },
          profile().flags.anon_readonly_admin ? 403 : 401,
        );
      if (currentRuntime().kind !== 'standard' || !SETTINGS_ROLES.some((r) => r === user.role) || user.tenantId !== currentRuntime().id)
        return c.json({ error: 'forbidden' }, 403);
      if (['tenantId', 'tenant_id', 'actor', 'role'].some((k) => c.req.query(k) !== undefined)) return c.json({ error: 'forbidden' }, 403);
      const members = await read(user, (tx) => readConsoleMembers(tx, createHash('sha256').update(c.var.token!).digest('hex')));
      if (!members.some((m) => m.userId === user.userId && !m.disabled && SETTINGS_ROLES.some((r) => r === m.role)))
        return c.json({ error: 'forbidden' }, 403);
      c.set('settingsMembers', members);
      return next();
    })
    .get('/organization', async (c) => {
      const org = await read(c.var.user!, readConsoleOrganization);
      const published = currentSop();
      return c.json(
        {
          ...org.view,
          publishedBrandName: published.brand?.brandName ?? null,
          pendingBrandChange: brandSnapshot(org.brand).brandHash !== published.brandHash,
        },
        200,
      );
    })
    .get('/members', (c) => c.json({ items: c.var.settingsMembers }, 200))
    .get('/channels', async (c) => c.json({ items: await channels(c.var.user!) }, 200))
    .get('/onboarding', async (c) => {
      const channel = await channels(c.var.user!);
      const pack = currentTenant().pack;
      const kind = pack.nav.entities.find((k) => pack.entities.some((e) => e.kind === k));
      const catalog = currentCatalog();
      const hasCatalog = pack.entities.some((e) => (catalog.items[e.kind]?.length ?? 0) > 0);
      const doneChannel = channel.some((a) => a.kind === 'wecom' && a.loaded && a.lastInboundAt !== null);
      const steps: OnboardingView['steps'] = [
        {
          key: 'team',
          state: c.var.settingsMembers.filter((m) => !m.disabled).length > 1 ? 'done' : 'todo',
          href: ONBOARDING_HREFS.team,
          reason: '成员由平台开通',
        },
        {
          key: 'catalog',
          state: hasCatalog ? 'done' : kind ? 'todo' : 'blocked',
          href: kind ? `/console/catalog/${encodeURIComponent(kind)}` : ONBOARDING_HREFS.sop,
          ...(!kind ? { reason: '当前行业包没有产品库入口，请联系平台' } : {}),
        },
        { key: 'sop', state: currentSop().versionId ? 'done' : 'todo', href: ONBOARDING_HREFS.sop },
        {
          key: 'channel',
          state: doneChannel ? 'done' : channel.some((a) => a.kind === 'wecom' && a.loaded) ? 'todo' : 'blocked',
          href: ONBOARDING_HREFS.channel,
          ...(!doneChannel ? { reason: '请联系平台配置接入，并通过微信发送消息验证' } : {}),
        },
      ];
      return c.json({ steps } satisfies OnboardingView, 200);
    })
    .onError((_error, c) => c.json({ error: 'internal' }, 500));
}
