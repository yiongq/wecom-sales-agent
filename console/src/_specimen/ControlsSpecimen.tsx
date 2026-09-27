// 控件样张（spec「字体与标点样张」）：路由 /_specimen，只在 VITE_SPECIMEN=1 的构建里注册，给两套主题的对比度审计用
// （spec 验收 2：悬停、焦点由走查脚本操作）。antd 控件是主题接好之后的原件，下半页是第 2.3 步的通用部件：
// 各种 Status、ConfirmDanger（点按钮打开）、错误与空状态、技术详情、检查清单、保存条、成功 toast
import { SaveOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Pagination, Segmented, Switch, Tabs } from 'antd';
import { useState } from 'react';
import { HttpError } from '../api.js';
import { ActionBar } from '../parts/ActionBar.js';
import { CheckList } from '../parts/CheckList.js';
import { ConfirmDanger } from '../parts/ConfirmDanger.js';
import { ErrorAlert } from '../parts/ErrorAlert.js';
import { PrimaryButton } from '../parts/PrimaryButton.js';
import { EmptyBlock, StateView } from '../parts/StateView.js';
import { Status, type StatusKind } from '../parts/Status.js';
import { TechDetails } from '../parts/TechDetails.js';
import { toast } from '../parts/toast.js';
import { Frame, Section } from './Frame.js';

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '已上架' },
  { key: 'draft', label: '草稿' },
];

const STATUSES: readonly StatusKind[] = ['ai', 'human', 'paid', 'active', 'live', 'draft', 'readonly'];

const NETWORK = new TypeError('Failed to fetch');
const CONFLICT = new HttpError(409, { error: 'rev_conflict', detail: '草稿已被改过（rev 3 ≠ 2）' });
const FORBIDDEN = new HttpError(403, { error: 'forbidden', detail: '只有 owner 和 admin 能做这件事' });
const NOT_READY = new HttpError(503, { error: 'not_ready', detail: '配置还没装载好' });

export function ControlsSpecimen() {
  const [discarding, setDiscarding] = useState(false);
  return (
    <Frame title="控件样张">
      <Section title="页签">
        <Tabs defaultActiveKey="active" items={TABS} />
      </Section>
      <Section title="分页器">
        <Pagination defaultCurrent={3} total={120} showSizeChanger={false} />
      </Section>
      <Section title="分段控件">
        <Segmented options={TABS.map((t) => ({ value: t.key, label: t.label }))} defaultValue="active" />
      </Section>
      <Section title="复选框与开关">
        <div className="spec-controls">
          <Checkbox defaultChecked>国内</Checkbox>
          <Checkbox>境外</Checkbox>
          <Checkbox disabled>不可选</Checkbox>
          <Checkbox disabled defaultChecked>
            已锁定
          </Checkbox>
          <Switch defaultChecked aria-label="开" />
          <Switch aria-label="关" />
          <Switch disabled aria-label="不可用" />
        </div>
      </Section>
      <Section title="Alert">
        <div className="spec-stack">
          <Alert type="info" showIcon title="演示只读" description="登录之后才能编辑。" />
          <Alert type="success" showIcon title="检查通过" description="可以发布。" />
          <Alert type="warning" showIcon title="有1条建议没做" description="体力强度没填，不拦上架。" />
          <Alert type="error" showIcon title="没取到" description="服务暂时连不上，稍后重试。" />
        </div>
      </Section>
      <Section title="按钮">
        <div className="spec-controls">
          <PrimaryButton>发布</PrimaryButton>
          <Button>保存草稿</Button>
          <Button type="text">取消</Button>
          <Button type="link">查看改动</Button>
          <PrimaryButton blocked>发布…</PrimaryButton>
          <PrimaryButton disabled>发布</PrimaryButton>
          <Button disabled>保存草稿</Button>
        </div>
      </Section>
      <Section title="状态 Status">
        <div className="spec-controls">
          {STATUSES.map((k) => (
            <Status key={k} kind={k} />
          ))}
        </div>
      </Section>
      <Section title="危险确认 ConfirmDanger">
        <div className="spec-controls">
          <Button onClick={() => setDiscarding(true)}>丢弃草稿…</Button>
        </div>
        <ConfirmDanger
          open={discarding}
          title="丢弃草稿？"
          confirmText="丢弃草稿"
          cancelText="保留"
          onConfirm={() => setDiscarding(false)}
          onCancel={() => setDiscarding(false)}
        >
          草稿里2节改动（话术原则、异议处理）会丢掉，线上v2不受影响。这一步撤销不了。
        </ConfirmDanger>
      </Section>
      <Section title="出错与空状态">
        <div className="spec-stack">
          <StateView error={NETWORK} onRetry={() => undefined} />
          <StateView error={FORBIDDEN} onRetry={() => undefined} />
          <ErrorAlert error={CONFLICT} onReload={() => undefined} />
          <StateView error={NOT_READY} onRetry={() => undefined} />
          <EmptyBlock
            icon={<SaveOutlined />}
            title="从第一条线路开始"
            description="上架后，销售助手会向客户推荐它"
            action={<PrimaryButton>新建线路</PrimaryButton>}
          />
        </div>
      </Section>
      <Section title="技术详情">
        <TechDetails
          rows={[
            ['prompt', '6c202d633b60'],
            ['tools', '64c16fc8f464'],
          ]}
        />
      </Section>
      <Section title="检查清单 CheckList">
        <CheckList
          title="发布前检查"
          summary="6/7通过"
          meta="每次自动保存都会跑 · 上次14:05"
          items={[
            { key: 'structure', label: '结构完整', state: 'pass' },
            { key: 'phrase_forbidden', label: '没有禁用短语', state: 'fail', note: ['1处', '话术原则'], onClick: () => undefined },
            { key: 'intensity', label: '体力强度没填', state: 'warn', note: '不拦上架', onClick: () => undefined },
            { key: 'over_budget', label: '字数在额度内', state: 'pending' },
          ]}
        />
      </Section>
      <Section title="保存条 ActionBar 与成功 toast">
        <ActionBar label="保存" icon={<SaveOutlined />} summary="有2处改动" hint="住宿档次、行程亮点" note="销售助手下一条回复就用新内容">
          <Button type="text">放弃</Button>
          <PrimaryButton onClick={() => toast('已保存')}>保存并立即生效</PrimaryButton>
        </ActionBar>
      </Section>
    </Frame>
  );
}
