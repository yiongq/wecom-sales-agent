import { SETTINGS_ROLES, type Me } from '../../../src/shared/console-api.js';
import type { Viewer } from '../viewer.js';

export const canReadSettings = (v: Viewer | undefined): boolean =>
  v?.kind === 'member' && !v.me.sandbox && SETTINGS_ROLES.some((role) => role === v.me.role);
export const settingsIdentity = (me: Me): string => `${me.tenantSlug}/${me.userId}/${me.role}`;
export const SETTINGS_PAGES = { organization: '企业', members: '成员', channels: '接入', usage: '用量' } as const;
export type SettingsPageKey = keyof typeof SETTINGS_PAGES;
