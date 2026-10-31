import { queryOptions } from '@tanstack/react-query';
import { settingsQueryKey, type Me, type SettingsResponses } from '../../../src/shared/console-api.js';
import { api, unwrap } from '../api.js';

type ReadPage = Exclude<keyof SettingsResponses, 'usage'>;
export function settingsQuery<P extends ReadPage>(me: Me, page: P) {
  return queryOptions({
    // 协调者修正冻结说明：租户键取真实 /me.tenantSlug，不新增 DTO 字段。
    queryKey: settingsQueryKey(me.tenantSlug, me.userId, page),
    queryFn: async ({ signal }): Promise<SettingsResponses[P]> => {
      const options = { init: { signal, cache: 'no-store' as const } };
      const data =
        page === 'organization'
          ? await unwrap(api.settings.organization.$get({}, options))
          : page === 'members'
            ? await unwrap(api.settings.members.$get({}, options))
            : page === 'channels'
              ? await unwrap(api.settings.channels.$get({}, options))
              : await unwrap(api.settings.onboarding.$get({}, options));
      return data as SettingsResponses[P];
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
}
