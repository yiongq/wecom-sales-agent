import { useQueryClient } from '@tanstack/react-query';
import { Button } from 'antd';
import type { ReactNode } from 'react';
import { HttpError } from '../api.js';
import { StateView } from '../parts/StateView.js';
import { retrySettings, useSettingsAccess } from './cache.js';

export function SettingsAccess({ identity, children }: { identity: string; children: ReactNode }) {
  const state = useSettingsAccess();
  const access = state.status;
  const qc = useQueryClient();
  if (state.identity !== identity) return <StateView pending />;
  if (access)
    return (
      <div className="settings-access">
        <StateView level={2} error={new HttpError(access, { error: access === 401 ? 'unauthorized' : 'forbidden' })} />
        {access === 403 && <Button onClick={() => retrySettings(qc)}>重新检查权限</Button>}
      </div>
    );
  return children;
}
