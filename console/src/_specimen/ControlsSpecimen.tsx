// 控件样张（spec「字体与标点样张」）：路由 /_specimen，只在 VITE_SPECIMEN=1 的构建里注册，给两套主题的对比度审计用
// （spec 验收 2：悬停、焦点由走查脚本操作）。控件都是主题接好之后的 antd 原件；Status、ConfirmDanger 等通用部件做好后加进来
import { Alert, Button, Checkbox, Pagination, Segmented, Switch, Tabs } from 'antd';
import { Frame, Section } from './Frame.js';

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '已上架' },
  { key: 'draft', label: '草稿' },
];

export function ControlsSpecimen() {
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
          <Button color="default" variant="solid">
            发布
          </Button>
          <Button>保存草稿</Button>
          <Button type="text">取消</Button>
          <Button type="link">查看改动</Button>
          <Button color="default" variant="solid" disabled>
            发布
          </Button>
          <Button disabled>保存草稿</Button>
        </div>
      </Section>
    </Frame>
  );
}
