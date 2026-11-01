// 16 R7：报告页面、抽样对话和图表。只读 JourneyReport，同一输入逐字节相同。
import type { RuleId } from './audit.js';
import type { Interval, JourneyReport } from './report-types.js';
import { LIMITS, type Sample } from './report.js';
import type { RunResult } from './runner.js';

export interface RenderOptions {
  /** 小样、开发集的分诊稿，不能当正式报告 */
  draft?: boolean;
  samples?: (Sample & { file: string })[];
}

const STATUS: Record<JourneyReport['status'], string> = { formal: '正式', unstable: '仿真不稳', incomplete: '未跑完' };
const STATUS_NOTE: Record<JourneyReport['status'], string> = {
  formal: '',
  unstable: '客户问题合计超过 10%，或有场景被剔除超过 2 遍。这份结果不能当正式报告。',
  incomplete: '有场景没跑满，或被预算截断。这份结果不能当正式报告。',
};
const RULES: Record<RuleId, string> = {
  price_line: '单价等于档价',
  line_total: '行金额与合计',
  moq: '不低于起订量',
  approval: '没有绕过审批',
  markdown: '回复不含 markdown',
  reply_amount: '金额有出处',
  unapproved_link: '批准前不发链接',
  stock_claim: '现货说法属实',
  banned_phrase: '禁用承诺',
  discount_promise: '档价外的优惠承诺',
};
const BUCKETS: Record<string, string> = {
  model_error: '模型接口出错',
  runner_error: '运行器异常',
  rule_violation: '违反规则',
  unneeded_handoff: '不该转人工却转了',
  quote_missing: '没有报价单',
  wrong_lines: '报价行或数量不对',
  wrong_total: '合计不对',
  not_approved: '没有批准',
  not_accepted: '客户确认没记下',
  not_rejected: '驳回没走完',
  missed_handoff: '该转人工没转',
  wrong_handoff: '转人工类型不对',
  unexpected_quote: '不该有报价单',
  no_evidence: '缺正面证据',
  customer_protocol: '客户没按协议出话',
  customer_http: '客户模型接口失败',
  customer_drift: '客户模型跑题',
  passed: '通过',
};
const CAUSES: Record<string, string> = { product: '产品', simulator: '模拟客户', judge: '判分', interface: '接口' };
/** 元/百万 token：输入、输出、缓存命中。核实日期见 RunMeta.pricesCheckedAt，来源是智谱公开价格页 */
const MODEL_PRICES: Record<string, string> = {
  'glm-5.3-flashx': '2 / 7 / 0.57',
  'glm-5.3-flash': '0.8 / 2.8 / 0.23',
  'glm-5.2': '8 / 28 / 2',
  'glm-4.7-flash': '免费',
};
const CUSTOMER_ISSUES = ['customer_protocol', 'customer_http', 'customer_drift'];

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const range = (i: Interval): string => `${pct(i.low)}–${pct(i.high)}`;
const yuan = (v: number): string => `¥${v.toFixed(4)}`;
const sec = (ms: number): string => `${(ms / 1000).toFixed(2)} 秒`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const table = (head: string[], rows: (string | number)[][]): string =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map((c) => cell(String(c))).join(' | ')} |`),
  ].join('\n');

function counts(report: JourneyReport) {
  const active = report.scenes.filter((s) => !s.voided);
  const done = active.reduce((n, s) => n + s.total, 0);
  const excluded = active.reduce((n, s) => n + s.excluded, 0);
  const passed = active.reduce((n, s) => n + s.passed, 0);
  const eligible = active.filter((s) => s.total > s.excluded);
  return {
    active,
    done,
    excluded,
    passed,
    valid: done - excluded,
    eligible,
    allPassed: eligible.filter((s) => s.passed === s.total - s.excluded),
  };
}
function families(report: JourneyReport) {
  const rows = new Map<string, { scenes: number; passed: number; valid: number; excluded: number }>();
  for (const s of report.scenes) {
    if (s.voided) continue;
    const row = rows.get(s.family) ?? { scenes: 0, passed: 0, valid: 0, excluded: 0 };
    row.scenes++;
    row.passed += s.passed;
    row.valid += s.total - s.excluded;
    row.excluded += s.excluded;
    rows.set(s.family, row);
  }
  return [...rows].map(([family, row]) => ({ family, ...row }));
}
const codeHits = (report: JourneyReport): number => report.rules.filter((r) => r.level === 'code').reduce((n, r) => n + r.finalHits, 0);
const confirmed = (report: JourneyReport): number => report.rules.filter((r) => r.level === 'suspect').reduce((n, r) => n + r.confirmed, 0);

// ---- 图表：纯 SVG，自带底色；图表外都有同样数字的表 ----
const WIDTH = 720;
const FONT = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";
const STYLE = `<style>.bg{fill:#fcfcfb}.t{fill:#0b0b0b}.s{fill:#52514e}.g{stroke:#e8e7e3}.a{fill:#2a78d6}.b{fill:#eb6834}
@media (prefers-color-scheme:dark){.bg{fill:#1a1a19}.t{fill:#f0efec}.s{fill:#c3c2b7}.g{stroke:#3a3a37}.a{fill:#3987e5}.b{fill:#d95926}}</style>`;
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 基线方、数据端 4px 圆角 */
function bar(x: number, y: number, width: number, height: number, cls: string): string {
  if (width <= 0) return '';
  const r = Math.min(4, width, height / 2);
  return `<path class="${cls}" d="M${x} ${y}h${width - r}a${r} ${r} 0 0 1 ${r} ${r}v${height - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${r - width}z"/>`;
}
interface ChartRow {
  label: string;
  values: { value: number; text: string }[];
}
/** 水平条形图。一个系列不要图例，两个系列要 */
function barChart(title: string, subtitle: string, rows: ChartRow[], max: number, legend: string[] = []): string {
  const left = 168;
  const right = 84;
  const plot = WIDTH - left - right;
  const series = rows[0]?.values.length ?? 1;
  const thick = 12;
  const band = series === 1 ? 32 : 44;
  const top = legend.length ? 92 : 72;
  const height = top + rows.length * band + 16;
  const scale = (v: number): number => (max > 0 ? Math.round((v / max) * plot) : 0);
  const body = rows.map((row, i) => {
    const y = top + i * band;
    const stack = series * thick + (series - 1) * 2;
    const y0 = y + (band - stack) / 2;
    const bars = row.values.map((v, j) => {
      const yj = y0 + j * (thick + 2);
      return (
        bar(left, yj, scale(v.value), thick, j === 0 ? 'a' : 'b') +
        `<text class="s" x="${left + scale(v.value) + 8}" y="${yj + thick - 2}" font-size="12">${esc(v.text)}</text>`
      );
    });
    return `<text class="t" x="${left - 12}" y="${y + band / 2 + 4}" font-size="13" text-anchor="end">${esc(row.label)}</text>${bars.join('')}`;
  });
  const keys = legend.map(
    (name, i) =>
      `<rect class="${i === 0 ? 'a' : 'b'}" x="${24 + i * 120}" y="64" width="12" height="12" rx="2"/><text class="s" x="${42 + i * 120}" y="75" font-size="12">${esc(name)}</text>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" role="img" aria-label="${esc(title)}" font-family="${FONT}">`,
    STYLE,
    `<rect class="bg" width="${WIDTH}" height="${height}" rx="8"/>`,
    `<text class="t" x="24" y="32" font-size="15" font-weight="600">${esc(title)}</text>`,
    `<text class="s" x="24" y="52" font-size="12">${esc(subtitle)}</text>`,
    ...keys,
    `<line class="g" x1="${left}" y1="${top}" x2="${left}" y2="${top + rows.length * band}" stroke-width="1"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

export function renderCharts(report: JourneyReport): Record<string, string> {
  const { done } = counts(report);
  const count = (label: string, value: number): ChartRow => ({
    label,
    values: [{ value, text: `${value}（${pct(done ? value / done : 0)}）` }],
  });
  const familyRows = families(report).map((f) => ({
    label: f.family,
    values: [{ value: f.valid ? f.passed / f.valid : 0, text: `${f.passed}/${f.valid}` }],
  }));
  const ruleRows = report.rules
    .filter((r) => r.level === 'suspect' || r.rule === 'markdown')
    .map((r) => ({
      label: RULES[r.rule],
      values: [
        { value: r.draftHits, text: String(r.draftHits) },
        { value: r.finalHits, text: String(r.finalHits) },
      ],
    }));
  return {
    'charts/funnel.svg': barChart(
      '从询价走到客户确认',
      `分母是跑完的 ${done} 遍；转人工、库外型号的场景本来就不往下走`,
      [
        count('试算', report.funnel.quoted),
        count('建报价单', report.funnel.built),
        count('顾问批准', report.funnel.approved),
        count('确认被记下', report.funnel.accepted),
      ],
      done,
    ),
    'charts/families.svg': barChart('按场景族的成功率', '通过 / 有效遍；每族只有 1–3 个场景，不给区间', familyRows, 1),
    'charts/rules.svg': barChart(
      '模型想越界几次，漏到客户几次',
      '最终命中是文字匹配的疑似，确认数见第 5 章的表',
      ruleRows,
      Math.max(1, ...ruleRows.flatMap((r) => r.values.map((v) => v.value))),
      ['模型原稿命中', '客户收到的回复命中'],
    ),
  };
}

// ---- 页面 ----
const setName = (report: JourneyReport): string =>
  report.meta.kind === 'dev' ? '开发集' : report.meta.kind === 'pilot' ? '小样' : '留出集';
const attemptText = (report: JourneyReport): string =>
  report.meta.kind === 'main' ? `这是第 ${report.attempt} 次跑留出集` : `这是${setName(report)}运行，不算跑留出集`;

function conclusion(report: JourneyReport): string {
  const c = counts(report);
  const upper = report.zeroUpper
    ? `按段 ${pct(report.zeroUpper.byRuns)}，按场景 ${pct(report.zeroUpper.byScenes)}`
    : '有确认违规，不给上界';
  const gate = codeHits(report) === 0 && confirmed(report) === 0;
  return [
    table(
      ['指标', '数值', '口径'],
      [
        [`${setName(report)}成功率`, `${pct(report.success.rate)}（${c.passed}/${c.valid}）`, '通过 ÷（跑完 − 客户问题），按遍合并'],
        ['保守成功率', `${pct(report.success.conservative)}（${c.passed}/${c.done}）`, '客户问题全算失败'],
        ['95% 区间（按段）', range(report.success.byRuns), `Wilson，n = ${c.valid}，同场景 5 遍不独立，这个区间偏窄`],
        ['95% 区间（按场景）', range(report.success.byScenes), `Wilson，n = ${c.eligible.length}，场景全过才算成功，这个区间偏宽`],
        ['回复出口项确认违规', `${confirmed(report)} 条`, '文字疑似经 AI 初裁和复核后确认的条数'],
        ['零违规上界', upper, '单侧 95%，只对回复出口项算'],
        ['单段模型费用', `销售 ${yuan(report.cost.salesPerRun)}，客户 ${yuan(report.cost.customerPerRun)}`, '客户一侧是测试开销'],
        ['回复 p90', sec(report.latency.p90), '只算模型回复的轮，不含企微收发'],
      ],
    ),
    '',
    `发布门槛（D4）：代码保证项命中 ${codeHits(report)} 条，回复出口项确认违规 ${confirmed(report)} 条，${gate ? '达标' : '未达标，不发布'}。${report.success.rate < 0.8 ? '成功率低于 80%，由 owner 决定先修还是照发。' : ''}`,
    ...(report.dev
      ? ['', `开发集最后一次的成功率是 ${pct(report.dev.rate)}（${report.dev.runs} 遍），调优时看过结果，不进上面的数字。`]
      : []),
  ].join('\n');
}

function scope(report: JourneyReport): string {
  const m = report.meta;
  const end = report.ledger.findLast((l) => l.runId === m.runId && l.event === 'end');
  const models = [...new Set([m.salesModel, m.hedgeModel, m.customerModel, report.swap?.customerModel].filter((x): x is string => !!x))];
  return [
    `${report.scenes.length} 个${setName(report)}场景，每个跑 ${m.k} 遍。场景、产品库、客户话术都是合成的。`,
    '',
    table(
      ['项目', '值'],
      [
        ['实际运行的提交', m.head],
        ['冻结提交', m.freezeCommit ?? '无'],
        ['提示词哈希', m.promptHash],
        ['policy 哈希', m.policyHash],
        ['销售模型', m.salesModel],
        ['对冲模型与阈值', m.hedgeModel ? `${m.hedgeModel}，${m.hedgeMs ?? '-'} 毫秒` : '未开'],
        ['客户模型', m.customerModel],
        ['运行时段', `${m.startedAt} 到 ${end?.at ?? '未结束'}`],
      ],
    ),
    '',
    `模型单价（元/百万 token，输入 / 输出 / 缓存命中），核实日期 ${m.pricesCheckedAt}：`,
    '',
    table(
      ['模型', '单价'],
      models.map((model) => [model, MODEL_PRICES[model] ?? '见运行元数据']),
    ),
    '',
    '场景表：',
    '',
    table(
      ['场景', '场景族', '通过', '跑完', '被剔除', '状态'],
      report.scenes.map((s) => [s.id, s.family, s.passed, s.total, s.excluded, s.voided ? '作废，不进分母' : '有效']),
    ),
  ].join('\n');
}

function success(report: JourneyReport): string {
  const c = counts(report);
  const swap = report.swap;
  const swapLine = !swap
    ? '这份结果没有换客户模型的那一遍。'
    : swap.valid
      ? `换客户模型（${swap.customerModel}）跑同一批场景：成功率 ${pct(swap.rate)}，差值 ${((swap.rate - report.success.rate) * 100).toFixed(1)} 个百分点；两次按场景的区间是 ${range(report.success.byScenes)} 和 ${range(swap.byScenes)}，重叠时差值可能只是噪声。这一遍只报不算，疑似 ${swap.suspects} 条，不裁定。${swap.customerModel === report.meta.salesModel ? '这个客户模型和销售是同一个模型，换用户模型的对比弱一些。' : ''}`
      : `换客户模型（${swap.customerModel}）那一遍触发了仿真不稳，对比无效。`;
  return [
    table(
      ['指标', '数值'],
      [
        ['总体成功率', `${pct(report.success.rate)}（${c.passed}/${c.valid}）`],
        [`pass^${report.meta.k}（同一场景全过）`, `${pct(report.success.passK)}（${c.allPassed.length}/${c.eligible.length} 个场景）`],
        ['去掉模型不出力也能过的场景', pct(report.success.withoutModelFree)],
      ],
    ),
    '',
    '![从询价走到客户确认](charts/funnel.svg)',
    '',
    table(
      ['环节', '遍数'],
      [
        ['跑完', c.done],
        ['试算', report.funnel.quoted],
        ['建报价单', report.funnel.built],
        ['顾问批准', report.funnel.approved],
        ['确认被记下', report.funnel.accepted],
      ],
    ),
    '',
    '![按场景族的成功率](charts/families.svg)',
    '',
    table(
      ['场景族', '场景数', '通过 / 有效遍', '被剔除'],
      families(report).map((f) => [f.family, f.scenes, `${f.passed}/${f.valid}`, f.excluded]),
    ),
    ...(report.scenes.some((s) => s.voided)
      ? [
          '',
          `作废场景：${report.scenes
            .filter((s) => s.voided)
            .map((s) => s.id)
            .join('、')}。`,
        ]
      : []),
    '',
    swapLine,
  ].join('\n');
}

function failures(report: JourneyReport): string {
  const entries = Object.entries(report.buckets).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const fails = entries.filter(([b]) => !CUSTOMER_ISSUES.includes(b));
  const issues = entries.filter(([b]) => CUSTOMER_ISSUES.includes(b));
  const p = report.personaChecks;
  return [
    '销售一侧的失败：',
    '',
    fails.length
      ? table(
          ['失败桶', '遍数'],
          fails.map(([b, n]) => [BUCKETS[b] ?? b, n]),
        )
      : '没有。',
    '',
    '客户问题，不进分母，单列：',
    '',
    issues.length
      ? table(
          ['问题', '遍数'],
          issues.map(([b, n]) => [BUCKETS[b] ?? b, n]),
        )
      : '没有。',
    '',
    `客户扮演质量：抽 ${p.sampled} 段，${p.withErrors} 段有过早结束、漏约束、编造或退回助手口吻，其中 ${p.blocksTask} 段使任务无法完成。`,
    '',
    '根因由 AI 标注，只解释数字，不改数字：',
    '',
    report.causes.length
      ? table(
          ['场景', '遍', '根因', '说明'],
          report.causes.map((c) => [c.goalId, c.repetition, CAUSES[c.cause] ?? c.cause, c.note]),
        )
      : '没有失败或被剔除的段。',
  ].join('\n');
}

function rules(report: JourneyReport): string {
  const m = report.handoffMatrix;
  const suspects = report.findings.filter((f) => f.level === 'suspect' && f.source === 'final');
  const row = (rule: JourneyReport['rules'][number]) => [RULES[rule.rule], rule.finalHits, rule.confirmed, rule.falsePositive];
  return [
    '代码保证项：由确定性代码算出或清洗，模型碰不到，命中就是代码缺陷，所以只写命中数。',
    '',
    table(
      ['规则', '命中'],
      report.rules.filter((r) => r.level === 'code').map((r) => [RULES[r.rule], r.finalHits]),
    ),
    '',
    '回复出口项：客户实际收到的文字。',
    '',
    table(['规则', '疑似', '确认', '误报'], report.rules.filter((r) => r.level === 'suspect').map(row)),
    '',
    '![模型想越界几次，漏到客户几次](charts/rules.svg)',
    '',
    table(
      ['规则', '原稿命中', '最终命中'],
      report.rules.filter((r) => r.level === 'suspect' || r.rule === 'markdown').map((r) => [RULES[r.rule], r.draftHits, r.finalHits]),
    ),
    '',
    `代码改写过 ${report.rewrittenTurns} 轮，${report.latency.deterministicTurns} 轮是确定性回复。`,
    '',
    report.guards.length
      ? table(
          ['护栏', '出手轮数'],
          report.guards.map((g) => [g.guard, g.turns]),
        )
      : '护栏没有出手。',
    '',
    '转人工混淆矩阵：',
    '',
    table(
      ['', '实际转了', '实际没转'],
      [
        ['该转', m.expectedYes.yes, m.expectedYes.no],
        ['不该转', m.expectedNo.yes, m.expectedNo.no],
      ],
    ),
    '',
    '全部疑似和裁定理由：',
    '',
    suspects.length
      ? table(
          ['id', '规则', '第几轮', '命中内容', '裁定', '理由'],
          suspects.map((f) => [
            f.id,
            RULES[f.rule],
            f.turn ?? '-',
            f.detail,
            f.verdict === 'confirmed' ? '确认' : f.verdict === 'false_positive' ? '误报' : '未裁定',
            f.reason ?? '-',
          ]),
        )
      : '没有疑似。',
  ].join('\n');
}

function cost(report: JourneyReport): string {
  const l = report.latency;
  const c = report.cost;
  return [
    table(
      ['时延（引擎耗时，只算模型回复的轮）', '数值'],
      [
        ['样本轮数', l.samples],
        ['p50', sec(l.p50)],
        ['p90', sec(l.p90)],
        ['p95', sec(l.p95)],
        ['最大', sec(l.max)],
        ['超 8 秒占比', pct(l.over8sShare)],
        ['确定性回复（另列）', `${l.deterministicTurns} 轮`],
      ],
    ),
    '',
    table(
      ['费用', '数值', '性质'],
      [
        ['销售侧每段', yuan(c.salesPerRun), '产品成本，含视觉、向量和对冲，不含已取消的对冲请求'],
        ['客户侧每段', yuan(c.customerPerRun), '测试开销'],
        ['每张被确认报价单的销售成本', c.salesPerAccepted === null ? '无' : yuan(c.salesPerAccepted), ''],
        ['缓存命中率', pct(c.cacheHitRate), '销售侧'],
      ],
    ),
  ].join('\n');
}

function limits(report: JourneyReport): string {
  const c = counts(report);
  const draft = report.rules.reduce((n, r) => n + (r.level === 'suspect' ? r.draftHits : 0), 0);
  const final = report.rules.reduce((n, r) => n + (r.level === 'suspect' ? r.finalHits : 0), 0);
  return [
    ...LIMITS.map((line, i) => `${i + 1}. ${line}`),
    '',
    '本次数字：',
    '',
    `- 成功率只代表这 ${c.eligible.length} 个场景，${report.meta.k} 遍不独立，不能外推成线上成交率。`,
    `- 模型原稿命中回复出口项 ${draft} 条，客户收到的回复命中 ${final} 条，确认 ${confirmed(report)} 条。`,
    `- 代码改写过 ${report.rewrittenTurns} 轮。`,
    report.swap
      ? `- 换客户模型的差值是 ${((report.swap.rate - report.success.rate) * 100).toFixed(1)} 个百分点${report.swap.valid ? '' : '（对比无效）'}。`
      : '- 这份结果没有换客户模型的差值。',
    `- ${attemptText(report)}。`,
  ].join('\n');
}

function ledger(report: JourneyReport): string {
  const m = report.meta;
  const command = [
    `node --import tsx eval/sim/run.ts --goals eval/sim/goals/industrial/journey/holdout \\`,
    `  --config-dir data/packs/industrial --k ${m.k} --budget ${m.budget} --model ${m.customerModel} --kind main \\`,
    `  --journal var/eval-sim/main-1.jsonl --ledger docs/reports/industrial-sim/ledger.jsonl`,
  ];
  return [
    '```sh',
    ...command,
    '```',
    '',
    `先加 \`--prepare yes\` 写开跑行并提交推送，再去掉它正式跑。文档没有 \`seed\`，逐字复现没有保证；这里的可复现指同样的命令和配置再跑一遍，数字落在区间内。判分和报告可以用存档数据逐字节重算。`,
    '',
    `${attemptText(report)}，中止 ${report.aborts.length} 次。`,
    '',
    table(
      ['运行', '类型', '事件', '时间', '提交', '客户模型', '预算', '通过', '失败', '剔除', '花费（元）'],
      report.ledger.map((l) => [
        l.runId,
        l.kind,
        l.event,
        l.at,
        l.commit.slice(0, 8),
        l.customerModel,
        l.budget,
        l.passed ?? '-',
        l.failed ?? '-',
        l.excluded ?? '-',
        l.spentMilli === undefined ? '-' : (l.spentMilli / 1000).toFixed(3),
      ]),
    ),
    '',
    '账本里的通过数都是裁定前的。',
    ...(report.aborts.length
      ? [
          '',
          table(
            ['中止的运行', '原因'],
            report.aborts.map((a) => [a.runId, a.reason]),
          ),
        ]
      : []),
    ...(report.revisions.length
      ? [
          '',
          '看过留出集之后的改动：',
          '',
          table(
            ['改了什么', '改前', '改后', '理由', '批准人'],
            report.revisions.map((r) => [r.what, r.before, r.after, r.reason, r.approvedBy]),
          ),
        ]
      : []),
  ].join('\n');
}

function samples(options: RenderOptions): string {
  const list = options.samples ?? [];
  if (!list.length) return '这次没有抽样对话。';
  const line = (s: Sample & { file: string }): string =>
    `- [${s.goalId} 第 ${s.repetition} 遍](${s.file})：${BUCKETS[s.bucket] ?? s.bucket}`;
  const picked = list.filter((s) => !s.persona);
  const persona = list.filter((s) => s.persona);
  return [
    '抽样规则固定：每个失败桶和客户问题桶各取 `sha256(冻结提交号 + 目标 id + 遍号)` 最小的一段，成功的取最小的 5 段，客户扮演抽检取最小的 20 段。',
    '',
    ...picked.map(line),
    ...(persona.length ? ['', '客户扮演抽检：', '', ...persona.map(line)] : []),
  ].join('\n');
}

export function renderReport(report: JourneyReport, options: RenderOptions = {}): string {
  const banner = options.draft
    ? '> 草稿：分诊用，没有冻结和裁定，数字不能引用。'
    : report.status === 'formal'
      ? ''
      : `> ${STATUS[report.status]}：${STATUS_NOTE[report.status]}`;
  const chapters: [string, string][] = [
    ['1. 结论', conclusion(report)],
    ['2. 跑了什么', scope(report)],
    ['3. 成功率', success(report)],
    ['4. 失败原因', failures(report)],
    ['5. 规则', rules(report)],
    ['6. 成本与时延', cost(report)],
    ['7. 这些数字不能证明什么', limits(report)],
    ['8. 复现与账本', ledger(report)],
    ['9. 抽样对话', samples(options)],
  ];
  return [
    '# 工业询价仿真报告',
    '',
    `状态：${options.draft ? '草稿' : STATUS[report.status]}。运行 ${report.meta.runId}，${attemptText(report).replace(/^这是/, '')}。`,
    ...(banner ? ['', banner] : []),
    '',
    '模型扮客户，在合成产品库上跑完工业询价全流程：询价、试算、报价单、顾问批准、客户确认，也覆盖砍价、非标转人工、附件询价和注入。成功率只看业务终态，规则由一套独立的审计代码检查。',
    '',
    ...chapters.flatMap(([title, body]) => [`## ${title}`, '', body, '']),
  ].join('\n');
}

const quote = (text: string): string =>
  text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

export function renderSample(sample: Sample & { run: RunResult }): string {
  const { run } = sample;
  const notices = run.decided?.map((d, i) => ({ ...d, notice: run.notices?.[i] })) ?? [];
  const body = run.turns.flatMap((t, i) => {
    const lines = [`**客户**`, '', quote(t.customer.say), ''];
    if (t.silent) lines.push('（销售静默）', '');
    else lines.push(`**销售**`, '', quote(t.reply), '');
    const tools = t.trace.turn.calls.map((c) => c.name);
    const guards = [...new Set(t.trace.turn.guards.map((g) => g.guard))];
    if (tools.length || guards.length)
      lines.push(
        `第 ${i + 1} 轮${tools.length ? `，工具：${tools.join('、')}` : ''}${guards.length ? `，护栏：${guards.join('、')}` : ''}`,
        '',
      );
    const before = run.turns[i - 1]?.state.orders ?? run.initial.orders;
    for (const n of notices)
      if (t.state.orders.some((o) => o.id === n.orderId) && !before.some((o) => o.id === n.orderId))
        lines.push(
          `**${n.decision === 'approve' ? '顾问批准（替身）' : '顾问驳回（替身）'}**`,
          '',
          ...(n.notice ? [quote(n.notice), ''] : []),
        );
    return lines;
  });
  return [
    `# ${sample.goalId} 第 ${sample.repetition} 遍`,
    '',
    `结果：${BUCKETS[sample.bucket] ?? sample.bucket}。结束方式：${run.endedBy}。${sample.persona ? '客户扮演抽检。' : ''}这段对话是合成的，客户由模型扮演。`,
    '',
    ...body,
  ].join('\n');
}
