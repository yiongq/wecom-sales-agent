// 回滚确认：版本历史的「以此版本回滚」和发布条的「回滚到v2」共用。还是 01 的做法（必填变更说明，一句说明），
// 第 7 步按 spec「回滚」重做（后果列表、与草稿有无交集、固定规则提示、差异、「为什么回滚」）。
// 成功以后刷新 /sop 与版本列表，toast 报新版本号；回滚后的新版本与目标版本的固定规则不同时，调用方用 rollbackNotice 写说明
import { useQueryClient } from '@tanstack/react-query';
import { Button, Descriptions, Input, Modal, Space } from 'antd';
import { useState } from 'react';
import type { RollbackResult, SopVersion } from '../../../src/shared/console-api.js';
import { api, unwrap } from '../api.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { toast } from '../parts/toast.js';

/** 回滚后的新版本与目标版本的固定规则不同（sameHashAsTarget 为 false）时的说明 */
export const rollbackNotice = (v: RollbackResult, target: Pick<SopVersion, 'versionNo'>): string | null =>
  v.sameHashAsTarget
    ? null
    : `v${target.versionNo}之后代码里的固定规则改过，固定规则节用的是现在的写法，所以v${v.versionNo}不会和v${target.versionNo}完全一样。`;

export function RollbackModal({
  target,
  onClose,
  onDone,
}: {
  target: SopVersion | null;
  onClose: () => void;
  onDone: (v: RollbackResult, target: SopVersion) => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const rollback = async (): Promise<void> => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const v = await unwrap(api.sop.versions[':id'].rollback.$post({ param: { id: target.id }, json: { changeNote: note } }));
      setNote('');
      onDone(v, target);
      await qc.invalidateQueries({ queryKey: ['sop'] });
      await qc.invalidateQueries({ queryKey: ['sop-versions'] });
      toast(`已回滚到v${target.versionNo}：新版本v${v.versionNo}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    setError(null);
    onClose();
  };

  return (
    <Modal
      destroyOnHidden
      open={!!target}
      title={`回滚到v${target?.versionNo ?? ''}`}
      onCancel={close}
      footer={
        <>
          <Button onClick={close}>再看看</Button>
          <PrimaryButton disabled={!note.trim()} loading={busy} onClick={() => void rollback()}>
            回滚到v{target?.versionNo ?? ''}
          </PrimaryButton>
        </>
      }
    >
      <Space orientation="vertical" style={{ width: '100%' }}>
        <Descriptions
          size="small"
          column={1}
          items={[{ label: '说明', children: '取这个版本的可编辑节、现在的固定规则节，生成并发布一个新版本；已有的草稿不动。' }]}
        />
        <Input.TextArea rows={3} placeholder="变更说明（必填）" value={note} onChange={(e) => setNote(e.target.value)} />
        {error !== null && <ErrorAlert error={error} />}
      </Space>
    </Modal>
  );
}
