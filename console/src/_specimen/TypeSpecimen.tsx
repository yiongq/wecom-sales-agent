// P 页「字体与标点」（spec「字体与标点样张」，设计系统 P 页）：路由 /_specimen/type，只在 VITE_SPECIMEN=1 的构建里注册。
// 用生产的字体文件和全局样式渲染，所以它就是上线效果的验收样张（spec 验收 7、8）。
// 字重样例「销售话术 Sales v2」和「有 1 个问题要改」那行反例故意手打了空格，这个目录不受 spec 不变量 9 的扫描
import { CloseOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cjk } from '../typography.js';
import { Frame, Section } from './Frame.js';

const WEIGHT_SAMPLE = ['销售话术 Sales v2', '2,303 / 2,658字', '企微客户', 'A01'];

/** 设计系统 §2.3 的 10 级字阶，每级配一句真实文案 */
const SCALE: ReadonlyArray<{ name: string; size: string; style: CSSProperties; sample: ReactNode }> = [
  {
    name: 'badge',
    size: '12/16',
    style: {},
    sample: (
      <span className="spec-controls">
        <span className="spec-badge spec-badge-solid">2</span>
        <span className="spec-badge spec-badge-soft">2</span>
      </span>
    ),
  },
  { name: 'meta', size: '13/20', style: { fontSize: 13, lineHeight: '20px' }, sample: cjk(['线上v2', '老板发布于9月25日 18:30']) },
  { name: 'code', size: '12.5/20', style: { fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: '20px' }, sample: 'r-sichuan-lux' },
  { name: 'body', size: '14/22', style: { fontSize: 14, lineHeight: '22px' }, sample: cjk(['企微客户', 'F01', '2条消息']) },
  {
    name: 'reading',
    size: '16/28',
    style: { fontSize: 16, lineHeight: '28px' },
    sample: cjk('空手反问是最差的回应——客户要的是选项，不是问卷。'),
  },
  { name: 'card-title', size: '15/22', style: { fontSize: 15, lineHeight: '22px', fontWeight: 600 }, sample: '上架前检查' },
  { name: 'section', size: '16/24', style: { fontSize: 16, lineHeight: '24px', fontWeight: 600 }, sample: '需要你处理' },
  { name: 'page-title', size: '24/32', style: { fontSize: 24, lineHeight: '32px', fontWeight: 600 }, sample: '销售话术' },
  {
    name: 'kpi',
    size: '28/36',
    style: { fontSize: 28, lineHeight: '36px', fontWeight: 600, letterSpacing: '-0.025em' },
    sample: '207,440',
  },
  { name: 'display', size: '36/44', style: { fontSize: 36, lineHeight: '44px', fontWeight: 600 }, sample: '云途定制旅行' },
];

const NUMBERS = ['13', '2', '1', '43', '13,800', '42,800', '207,440'];

/**
 * 真实文案，各画「不挤压」与「本规范」两行。数组的各段之间是 Sep。前三组是设计系统 P 页列的；
 * 第四组补一处「）、」：spec 验收 7 要在这一页上量它，前三组里没有
 */
const SQUEEZE: ReadonlyArray<string | readonly string[]> = [
  ['改了2节（话术原则、异议处理）', '有1个问题要改'],
  '客户答「可以」「好」，你还得再问一遍',
  '（「不用倒时差、带娃能玩水」「想找个安静的地方过纪念日」）',
  '先问人数（大人、小孩）、日期和预算',
];

const DASHES: ReadonlyArray<readonly [string, string]> = [
  ['省略号', '想了解…吗'],
  ['两个连用', '客户只会答「可以」……'],
  ['破折号', '——对，就是这条'],
  ['空值', '最后一天可以写「—（返程）」'],
];

const LICENSES = `${import.meta.env.BASE_URL}licenses/`;

/**
 * 样例加上渲染后实测的宽度（getBoundingClientRect）。字体换上来时宽度会变，用 ResizeObserver 跟着重量：
 * WebKit 里 document.fonts.ready 早于字体生效，只在它之后量一次会量到系统字体的宽度
 */
function Measured({ className = '', children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <span ref={ref} className={`spec-sample ${className}`}>
        {children}
      </span>
      <span className="spec-width">{width === null ? '—' : `${width.toFixed(2)}px`}</span>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="spec-row">
      <span className="spec-label">{label}</span>
      {children}
    </div>
  );
}

export function TypeSpecimen() {
  return (
    <Frame title="字体与标点样张">
      <div className="spec-cols">
        <div>
          <Section title="字体与字重">
            <div className="spec-stack">
              {[400, 500, 600].map((w) => (
                <div key={w}>
                  <div className="spec-note">Geist · Noto Sans SC · {w}</div>
                  <div style={{ fontSize: 16, lineHeight: '24px', fontWeight: w }}>{cjk(WEIGHT_SAMPLE)}</div>
                </div>
              ))}
            </div>
          </Section>
          <Section title="字阶">
            <div className="spec-stack">
              {SCALE.map((l) => (
                <div key={l.name} className="spec-scale">
                  <span className="spec-note">
                    {l.name} {l.size}
                  </span>
                  <span style={l.style}>{l.sample}</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="数字">
            <div className="spec-numbers">
              <div>
                {NUMBERS.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </div>
              <span className="spec-note">tabular-nums</span>
            </div>
          </Section>
        </div>
        <div>
          <Section title="标点挤压">
            <div className="spec-stack">
              {SQUEEZE.map((g) => (
                <div key={typeof g === 'string' ? g : g.join('·')}>
                  <Row label="不挤压">
                    <Measured className="spec-space-all">{cjk(g, false)}</Measured>
                  </Row>
                  <Row label="本规范">
                    <Measured>{cjk(g)}</Measured>
                  </Row>
                </div>
              ))}
            </div>
          </Section>
          <Section title="省略号与破折号">
            {DASHES.map(([label, text]) => (
              <Row key={label} label={label}>
                <span className="spec-sample">{cjk(text)}</span>
              </Row>
            ))}
            <Row label="反例">
              <span className="spec-sample">
                <span lang="en">search…</span> <span className="spec-danger">不要这样：lang="en" 会把省略号换成西文字形，落到基线上</span>
              </span>
            </Row>
          </Section>
          <Section title="间隔号与中西间距">
            <Row label="间隔号">
              <span className="spec-sample">{cjk(['企微客户', 'A01', '7条消息'])}</span>
            </Row>
            <Row label="本规范">
              <span className="spec-sample">有1个问题要改</span>
            </Row>
            <Row label="不要这样">
              <span className="spec-sample">有 1 个问题要改</span>
            </Row>
          </Section>
          <Section title="关于弹窗样张">
            <div className="spec-modal">
              <div className="spec-modal-head">关于</div>
              <Button type="text" size="small" className="spec-modal-close" aria-label="关闭" icon={<CloseOutlined />} />
              <div className="spec-modal-body">
                <p>
                  {cjk('字体：Geist、Geist Mono（Vercel），思源黑体Noto Sans SC（Adobe、Google）。都按SIL Open Font License 1.1使用。')}
                </p>
                <p>{cjk('图标：Lucide（ISC许可）。')}</p>
                <div className="spec-modal-links">
                  <a href={`${LICENSES}OFL-Geist.txt`} target="_blank" rel="noreferrer">
                    查看字体许可
                  </a>
                  <a href={`${LICENSES}lucide-ISC.txt`} target="_blank" rel="noreferrer">
                    查看图标许可
                  </a>
                </div>
              </div>
              <div className="spec-modal-foot">
                <Button>关闭</Button>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </Frame>
  );
}
