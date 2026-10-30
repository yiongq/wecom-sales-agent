// 12 R13：合成附件样本、v2 与模拟客户的附件字段、识别准确率脚本的评分与预算。不调用任何模型（含真实的和本机脚本服务）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyAttachment, readZipDirectory, stripImageMetadata } from '../src/core/attachments.js';
import { readSheet } from '../src/core/sheet-read.js';
import { FIXTURE_DIR, FIXTURE_NAME, fixtureBytes, placeholderOf, readTruth, type TruthEntry } from './sim/attachment-fixtures.js';
import { loadGoals, validateGoal } from './sim/goals.js';
import { Meter, type SimDeps } from './sim/runner.js';
import type { SimTurn } from './sim/judge.js';
import { startFakeModel } from './v2/fake-model.js';
import { loadCases, runCaseV2 } from './v2/run.js';
import { validateCase } from './v2/schema.js';
import { measure, parseArgs, parseListReply, scoreRows, summarize, table } from './attachment-accuracy.js';

let passed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

const truth = readTruth();
const files = fs.readdirSync(FIXTURE_DIR).filter((name) => !name.startsWith('.') && !['README.md', 'truth.json', 'gen'].includes(name));
const catalog = JSON.parse(fs.readFileSync('data/packs/industrial/catalog/part.json', 'utf8')) as { partNo: string; aliases: string[] }[];

await test('样本清单：文件与 truth.json 一一对应，单个 ≤ 100 KB、合计 ≤ 600 KB，文件名合规，不含大图与 21 MB 文件', () => {
  assert.deepEqual(files.toSorted(), Object.keys(truth).toSorted());
  let total = 0;
  for (const name of files) {
    assert.match(name, FIXTURE_NAME);
    const size = fixtureBytes(name).length;
    assert.ok(size <= 100 * 1024, `${name} ${size}`);
    total += size;
  }
  assert.ok(total <= 600 * 1024, `合计 ${total}`);
  // 两个超限样本只在步骤 0 的本机测试里用过，不进仓库
  assert.ok(files.every((name) => !/big|oversize|21mb/i.test(name)));
  assert.throws(() => fixtureBytes('../README.md'));
  assert.throws(() => fixtureBytes('no-such-file.png'));
});

await test('判类：每个样本按内容判出 truth.json 里写的类别，图片自身不带元数据', () => {
  for (const name of files) {
    const bytes = fixtureBytes(name);
    assert.equal(classifyAttachment(bytes, name).cls, truth[name]!.class, name);
    if (truth[name]!.class === 'image') {
      const stripped = stripImageMetadata(bytes);
      assert.ok(stripped.ok && stripped.bytes.length === bytes.length, `${name} 不该带 EXIF / 文本块`);
    }
  }
  assert.equal(placeholderOf('image'), '[图片]');
  assert.equal(placeholderOf('sheet'), '[文件]');
  assert.equal(placeholderOf('drawing'), '[文件]');
});

await test('真值：图片带类型与行，型号是清洗后不变的串，且是库里的型号、库里型号的前缀或故意不在库里的 ZZ9999', () => {
  const known = catalog.flatMap((part) => [part.partNo, ...part.aliases]);
  let rows = 0;
  for (const [name, entry] of Object.entries(truth) as [string, TruthEntry][]) {
    if (entry.class === 'image') assert.ok(entry.kind && entry.lines?.length, name);
    for (const line of entry.lines ?? []) {
      rows++;
      assert.match(line.partNo, /^[A-Za-z0-9][A-Za-z0-9 ×\-_/]{0,31}$/u, `${name} ${line.partNo}`);
      assert.ok(!line.partNo.includes('//'));
      assert.ok(line.partNo === 'ZZ9999' || known.some((k) => k.startsWith(line.partNo)), `${name} ${line.partNo}`);
      assert.ok(line.qty === null || (Number.isInteger(line.qty) && line.qty > 0), `${name} ${line.partNo}`);
    }
  }
  assert.ok(rows > 60);
  // 铭牌没有数量
  assert.deepEqual(truth['nameplate.jpg']!.lines, [{ partNo: '6208-2RS', qty: null }]);
});

await test('表格：能读的样本读出的行与真值一致，超限的判 too_large，压缩炸弹是几 KB 的包、解压超 5 MiB', () => {
  for (const [name, entry] of Object.entries(truth)) {
    if (entry.class !== 'sheet') continue;
    const read = readSheet(fixtureBytes(name), name);
    if (name === 'rfq-201-rows.xlsx' || name === 'rfq-zipbomb.xlsx') {
      assert.deepEqual(read, { ok: false, reason: 'too_large' }, name);
      continue;
    }
    assert.ok(read.ok, name);
    const rows = read.sheets.flatMap((sheet) => sheet.rows);
    for (const line of entry.lines ?? []) {
      const row = rows.find((cells) => cells.includes(line.partNo));
      assert.ok(row, `${name} ${line.partNo}`);
      if (line.qty !== null) assert.ok(row.includes(String(line.qty)), `${name} ${line.partNo} ${line.qty}`);
      else assert.ok(!row.some((cell) => /^\d+$/.test(cell) && Number(cell) > 12), `${name} ${line.partNo} 数量应读不出`);
    }
  }
  const sheets = (name: string) => (readSheet(fixtureBytes(name), name) as Extract<ReturnType<typeof readSheet>, { ok: true }>).sheets;
  assert.equal(sheets('rfq-two-sheets.xlsx').length, 2);
  assert.equal(sheets('rfq-31-rows.xlsx')[0]!.rows.length, 32);
  const bomb = fixtureBytes('rfq-zipbomb.xlsx');
  assert.ok(bomb.length < 10 * 1024);
  assert.ok(readZipDirectory(bomb).some((entry) => entry.size > 5 * 1024 * 1024));
  assert.ok(readZipDirectory(fixtureBytes('rfq-macro.xlsm')).some((entry) => entry.name === 'xl/vbaProject.bin'));
  // GB18030 的 CSV 没有 BOM，不是合法的 UTF-8
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(fixtureBytes('rfq-gb18030.csv')));
});

await test('样本、生成脚本与 README 里没有本机绝对路径', () => {
  const texts = [
    path.join(FIXTURE_DIR, 'README.md'),
    path.join(FIXTURE_DIR, 'truth.json'),
    ...fs.readdirSync(path.join(FIXTURE_DIR, 'gen')).map((name) => path.join(FIXTURE_DIR, 'gen', name)),
  ];
  assert.ok(texts.length >= 4);
  for (const file of texts) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\/Users\/|\/private\/|\/home\/\w|[A-Za-z]:\\/, file);
});

await test('v2 与目标里引用的样本都存在，v2 附件用例的 vision 只出现在图片轮', () => {
  const cases = loadCases(path.resolve('eval/cases-v2'));
  const attached = cases.flatMap((c) => c.turns.filter((t) => t.attach).map((t) => ({ id: c.id, turn: t })));
  assert.ok(attached.length >= 20);
  for (const { id, turn } of attached) {
    const name = turn.attach!.file;
    assert.ok(files.includes(name), `${id} ${name}`);
    assert.equal(turn.vision !== undefined && truth[name]!.class !== 'image', false, `${id}: vision 写在了非图片轮`);
  }
});

await test('v2 schema：say 与 attach 有且只有一个，vision 只能跟 attach，文件名不带路径，attach 不收未知字段', () => {
  const turn = { expect: {} };
  const make = (turns: unknown[]) => ({ version: 2, id: 'attach-schema', desc: '', tags: [], pack: 'industrial', turns });
  validateCase(
    make([
      { ...turn, say: '你好' },
      { ...turn, attach: { file: 'rfq-small.xlsx' } },
      { ...turn, attach: { file: 'nameplate.jpg', name: '铭牌.jpg' }, vision: { kind: 'list' } },
    ]),
  );
  for (const bad of [
    { ...turn },
    { ...turn, say: '你好', attach: { file: 'rfq-small.xlsx' } },
    { ...turn, say: '你好', vision: {} },
    { ...turn, attach: { file: '../README.md' } },
    { ...turn, attach: { file: 'sub/a.png' } },
    { ...turn, attach: { file: 'a.png', size: 1 } },
    { ...turn, attach: { file: '' } },
  ])
    assert.throws(() => validateCase(make([bad])));
});

await test('目标 schema：customerScript 的一轮可以是 { say?, attach }，attach 必须是样本文件名', () => {
  const base = {
    id: 'attach-goal',
    pack: 'industrial',
    persona: '客户',
    allowedTools: [],
    predicates: [{ kind: 'handoff', expected: true }],
    forbidden: [],
  };
  validateGoal(
    { ...base, customerScript: ['你好', { attach: 'drawing.pdf' }, { say: '这是图纸', attach: 'drawing.pdf' }] },
    'synthetic.json',
  );
  for (const bad of [{ attach: '../a.pdf' }, { say: '只有话' }, { attach: 'a.pdf', extra: 1 }, { say: '', attach: 'a.pdf' }, 1])
    assert.throws(() => validateGoal({ ...base, customerScript: [bad] }, 'synthetic.json'));
});

await test('v2 附件轮：写了 vision 的非图片轮、没有对应视觉请求的轮，以及不合格的 vision 都被指出来', async () => {
  const c = (turns: unknown[], id = 'attach-runner') =>
    validateCase({ version: 2, id, desc: '', tags: [], pack: 'industrial', fixtures: { now: '2026-10-10T12:00:00+08:00' }, turns });
  // 表格轮写了 vision：不会有视觉请求
  const sheet = await runCaseV2(c([{ attach: { file: 'rfq-small.xlsx' }, vision: { kind: 'list', lines: [] }, expect: {} }]));
  assert.equal(sheet.pass, false);
  assert.match(sheet.failures.join('\n'), /写了 vision，视觉请求 0 次/);
  // 图片轮 vision 过不了包的 schema：当没读出来，请打字
  const bad = await runCaseV2(
    c([
      { attach: { file: 'nameplate.jpg' }, vision: { kind: 'list' }, expect: { replyMatches: ['^请把型号数量打字发来$'], handoff: false } },
    ]),
  );
  assert.equal(bad.pass, true, bad.failures.join('\n'));
  // 图片轮没写 vision：走包给的缺省 mock，不发 HTTP
  const mock = await runCaseV2(c([{ attach: { file: 'nameplate.jpg' }, expect: { replyMatches: ['认出 1 行'] } }]));
  assert.equal(mock.pass, true, mock.failures.join('\n'));
  // 清单没有价格：期望里写「元」要失败
  const wrong = await runCaseV2(c([{ attach: { file: 'rfq-small.xlsx' }, expect: { replyMatches: ['元'] } }]));
  assert.equal(wrong.pass, false);
});

await test('v2 假模型：视觉请求按 vision 回 JSON，不占脚本；带系统前缀、历史、工具、流式、非 data URL 图片、没写 vision 或次数不对都记成错误', async () => {
  const fake = await startFakeModel('fake-vision', { calls: new Map(), orders: () => [] });
  try {
    const post = async (body: unknown) =>
      (await (
        await fetch(`${fake.url}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as {
        choices: { message: { content: string } }[];
      };
    const image = (url: string) => [
      { type: 'text', text: '识别' },
      { type: 'image_url', image_url: { url } },
    ];
    const png = `data:image/png;base64,${'A'.repeat(120)}`;
    const good = { model: 'm', messages: [{ role: 'user', content: image(png) }] };
    // 正常：回 vision 的 JSON，一次，没有错误
    fake.begin(1, [], { kind: 'list', lines: [] });
    assert.deepEqual(JSON.parse((await post(good)).choices[0]!.message.content), { kind: 'list', lines: [] });
    fake.finish();
    assert.deepEqual(fake.errors, []);
    // 各种违例，每次都多出一条错误
    const bad: [string, unknown][] = [
      ['系统前缀', { ...good, messages: [{ role: 'system', content: '前缀' }, ...good.messages] }],
      ['工具', { ...good, tools: [] }],
      ['流式', { ...good, stream: true }],
      ['不是 data URL', { model: 'm', messages: [{ role: 'user', content: image('https://example.test/a.png') }] }],
      ['不是 png / jpeg', { model: 'm', messages: [{ role: 'user', content: image(`data:image/gif;base64,${'A'.repeat(120)}`) }] }],
    ];
    for (const [name, body] of bad) {
      const before = fake.errors.length;
      fake.begin(1, [], { kind: 'list', lines: [] });
      await post(body);
      assert.ok(fake.errors.length > before, name);
    }
    // 没写 vision 的视觉请求，与写了 vision 却没有请求
    let before = fake.errors.length;
    fake.begin(1, []);
    await post(good);
    assert.ok(fake.errors.length > before);
    before = fake.errors.length;
    fake.begin(1, [], { kind: 'list', lines: [] });
    fake.finish();
    assert.match(fake.errors.slice(before).join('\n'), /视觉请求 0 次/);
    before = fake.errors.length;
    fake.begin(1, [], { kind: 'list', lines: [] });
    await post(good);
    await post(good);
    fake.finish();
    assert.match(fake.errors.slice(before).join('\n'), /视觉请求 2 次/);
  } finally {
    await fake.close();
  }
});

const listReply = (lines: string[]) =>
  `从您发来的询价单里认出 ${lines.length} 行，请核对：\n${lines.join('\n')}\n回「确认」我按已匹配的行算价；要改哪行，回「第几行 型号 数量」；不要哪行，回「删第几行」。`;

await test('识别准确率：从代码渲染的清单里读出型号与数量，固定句与转顾问不是清单', () => {
  const reply = listReply([
    '1. 6205-2RS，100件，已匹配',
    '2. 6206，50件，待确认：库里有 6206-2RS，回「第2行 6206-2RS」选一个',
    '3. 6208-2RS，数量没认出，待确认：数量没认出，请补数量',
    '4. ZZ9999，5件，库里没找到，顾问会核对',
  ]);
  assert.deepEqual(parseListReply(reply), [
    { partNo: '6205-2RS', qty: 100 },
    { partNo: '6206', qty: 50 },
    { partNo: '6208-2RS', qty: null },
    { partNo: 'ZZ9999', qty: 5 },
  ]);
  for (const text of ['请把型号数量打字发来', '非标和来图加工需要顾问确认，我请顾问继续跟您核对。', '询价超过30行，我请顾问继续跟您核对。'])
    assert.equal(parseListReply(text), null);
});

await test('识别准确率：逐行对真值——型号错、数量错、漏行、多行各记一类，漏掉中间一行不连累后面', () => {
  const t = [
    { partNo: '6205-2RS', qty: 100 },
    { partNo: 'M8×30', qty: 200 },
    { partNo: 'HS-PV25', qty: 10 },
    { partNo: 'M10×45', qty: 500 },
  ];
  const zero = { partWrong: 0, missed: 0, extra: 0 };
  assert.deepEqual(scoreRows(t, t), { rows: 4, partRight: 4, qtyRight: 4, rowRight: 4, ...zero });
  // 型号错一个（HS-PV25 读成 HS-PV23），数量对
  assert.deepEqual(scoreRows(t, [t[0]!, t[1]!, { partNo: 'HS-PV23', qty: 10 }, t[3]!]), {
    rows: 4,
    partRight: 3,
    partWrong: 1,
    missed: 0,
    extra: 0,
    qtyRight: 4,
    rowRight: 3,
  });
  // 数量错一个
  assert.deepEqual(scoreRows(t, [t[0]!, { partNo: 'M8×30', qty: 20 }, t[2]!, t[3]!]), {
    rows: 4,
    partRight: 4,
    partWrong: 0,
    missed: 0,
    extra: 0,
    qtyRight: 3,
    rowRight: 3,
  });
  // 漏掉第二行：后面的行仍对得上
  assert.deepEqual(scoreRows(t, [t[0]!, t[2]!, t[3]!]), {
    rows: 4,
    partRight: 3,
    partWrong: 0,
    missed: 1,
    extra: 0,
    qtyRight: 3,
    rowRight: 3,
  });
  // 多出一行
  assert.deepEqual(scoreRows(t, [t[0]!, t[1]!, { partNo: 'ZZ9999', qty: 1 }, t[2]!, t[3]!]), {
    rows: 4,
    partRight: 4,
    partWrong: 0,
    missed: 0,
    extra: 1,
    qtyRight: 4,
    rowRight: 4,
  });
  // 一行也没读出来：全是漏行；铭牌的数量 null 对 null 算对
  assert.deepEqual(scoreRows(t, []), { rows: 4, partRight: 0, partWrong: 0, missed: 4, extra: 0, qtyRight: 0, rowRight: 0 });
  const plate = [{ partNo: '6208-2RS', qty: null }];
  assert.deepEqual(scoreRows(plate, plate), { rows: 1, partRight: 1, partWrong: 0, missed: 0, extra: 0, qtyRight: 1, rowRight: 1 });
  assert.equal(scoreRows(plate, [{ partNo: '6208-2RS', qty: 1 }]).qtyRight, 0);
});

/** 假引擎：每次收图回一份清单（可以故意读错），每次开销固定；全程没有任何网络与模型。 */
function fakeDeps(meter: Meter, perCall: number, reply: (file: string, call: number) => string) {
  const log = { started: 0, ended: 0, calls: [] as string[] };
  const deps: Pick<SimDeps, 'start' | 'sales' | 'end'> = {
    start: () => ({ id: `fake-${++log.started}`, initial: { orders: [], handedOver: false, handoff: null, stage: 'greeting' } }),
    async sales(_id, customer) {
      log.calls.push(customer.attach!);
      meter.add({ side: 'sales', model: 'fake', promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, cny: perCall });
      return {
        customer: { say: '[图片]', done: true },
        reply: reply(customer.attach!, log.calls.length),
        silent: false,
        trace: { durationMs: 1000 + log.calls.length * 100 },
      } as unknown as SimTurn;
    },
    async end() {
      log.ended++;
    },
  };
  return { deps, log };
}
const rendered = (file: string, drop = false) =>
  listReply(
    truth[file]!.lines!.filter((_, i) => !(drop && i === 0)).map(
      (l, i) => `${i + 1}. ${l.partNo}，${l.qty === null ? '数量没认出' : `${l.qty}件`}，已匹配`,
    ),
  );

await test('识别准确率：measure 逐样本逐次经引擎收图、对真值、记时延与费用，每次都结束会话', async () => {
  const meter = new Meter(10);
  const { deps, log } = fakeDeps(meter, 0.01, (file, call) =>
    call === 2 ? rendered(file, true) : call === 3 ? '请把型号数量打字发来' : rendered(file),
  );
  const result = await measure(deps, meter, ['list-screenshot.png', 'nameplate.jpg'], 2);
  assert.deepEqual(log.calls, ['list-screenshot.png', 'list-screenshot.png', 'nameplate.jpg', 'nameplate.jpg']);
  assert.equal(log.started, 4);
  assert.equal(log.ended, 4);
  assert.equal(result.budgetStopped, false);
  assert.deepEqual(
    result.records.map((r) => [r.file, r.run, r.list, r.score.missed, r.latencyMs]),
    [
      ['list-screenshot.png', 1, true, 0, 1100],
      ['list-screenshot.png', 2, true, 1, 1200],
      ['nameplate.jpg', 1, false, 1, 1300],
      ['nameplate.jpg', 2, true, 0, 1400],
    ],
  );
  assert.ok(result.records.every((r) => Math.abs(r.cny - 0.01) < 1e-12));
  const summary = summarize(result.records);
  assert.equal(summary.runs, 4);
  assert.equal(summary.notList, 1);
  assert.equal(summary.totals.rows, 8 + 8 + 1 + 1);
  assert.equal(summary.totals.missed, 2);
  assert.deepEqual(summary.latency, { p50: 1200, p90: 1400, max: 1400 });
  assert.ok(Math.abs(summary.cny - 0.04) < 1e-12);
  assert.match(table(result.records), /合计 \| 4 \| 16\/18/);
});

await test('识别准确率：到预算就停，没跑的次数在结果里列出，不再开新会话', async () => {
  const meter = new Meter(0.25);
  const { deps, log } = fakeDeps(meter, 0.1, (file) => rendered(file));
  const result = await measure(deps, meter, ['list-screenshot.png', 'nameplate.jpg', 'list-lowres.jpg'], 2);
  // 0.1 + 0.1 + 0.1 = 0.3 ≥ 0.25：第三次之后停
  assert.equal(log.calls.length, 3);
  assert.equal(log.started, 3);
  assert.equal(result.budgetStopped, true);
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.skipped, [
    { file: 'nameplate.jpg', run: 2 },
    { file: 'list-lowres.jpg', run: 1 },
    { file: 'list-lowres.jpg', run: 2 },
  ]);
  assert.throws(() => new Meter(0), /budget/);
});

await test('识别准确率：命令行必须带预算，样本只能是带行真值的图片，次数有上下限', () => {
  const images = Object.keys(truth).filter((name) => truth[name]!.class === 'image');
  assert.equal(images.length, 8);
  assert.throws(() => parseArgs([]), /--budget/);
  assert.throws(() => parseArgs(['--budget', '0']), /--budget/);
  assert.throws(() => parseArgs(['--budget', '-1']), /--budget/);
  assert.throws(() => parseArgs(['--budget', '1', '--runs', '0']), /--runs/);
  assert.throws(() => parseArgs(['--budget', '1', '--runs', '11']), /--runs/);
  assert.throws(() => parseArgs(['--budget', '1', '--files', 'rfq-small.xlsx']), /--files/);
  assert.throws(() => parseArgs(['--budget', '1', '--files', 'drawing.pdf']), /--files/);
  assert.throws(() => parseArgs(['--budget', '1', '--files', 'nope.png']), /--files/);
  assert.throws(() => parseArgs(['--budget', '1', '--bogus', 'x']), /参数错误/);
  const defaults = parseArgs(['--budget', '0.5']);
  assert.equal(defaults.budget, 0.5);
  assert.equal(defaults.runs, 3);
  assert.deepEqual(defaults.files.toSorted(), images.toSorted());
  assert.equal(defaults.report, 'var/eval-attachments/report.json');
  assert.deepEqual(parseArgs(['--budget', '1', '--runs', '2', '--files', 'nameplate.jpg,list-lowres.jpg', '--report', 'r.json']).files, [
    'nameplate.jpg',
    'list-lowres.jpg',
  ]);
});

// goals 目录里的附件目标引用的样本都在（工业闸的 3 个目标）
await test('工业闸的附件目标：引用的样本都在，且只用合成样本', async () => {
  const goals = await loadGoals('eval/sim/goals/industrial/quality');
  const attach = goals.filter((g) => g.customerScript?.some((turn) => typeof turn === 'object'));
  assert.deepEqual(attach.map((g) => g.id).toSorted(), [
    'industrial-attach-drawing',
    'industrial-attach-image-edit',
    'industrial-attach-sheet-confirm',
  ]);
  for (const goal of attach)
    for (const turn of goal.customerScript!)
      if (typeof turn === 'object') assert.ok(files.includes(turn.attach), `${goal.id} ${turn.attach}`);
});

console.log(
  `ATTACHMENTS SELFTEST PASS: ${passed} 组（样本清单与判类 / 真值 / 表格读取 / 路径 / v2 与目标 schema / v2 附件轮与假模型的视觉请求 / 准确率评分与预算）`,
);
