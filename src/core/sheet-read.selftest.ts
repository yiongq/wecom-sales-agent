import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readSheet, type SheetRead } from './sheet-read.js';
import { SHEET_MAX_BYTES } from './attachments.js';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed++;
  console.log(`✓ ${name}`);
}
interface Part {
  name: string;
  data: string | Buffer;
  method?: number;
  flags?: number;
  declaredSize?: number;
  extra?: Buffer;
}
function crc(bytes: Buffer): number {
  let n = -1;
  for (const byte of bytes) {
    n ^= byte;
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
  }
  return ~n >>> 0;
}
function zip(parts: Part[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const { name, data, method = 8, flags = 0, declaredSize, extra = Buffer.alloc(0) } of parts) {
    const n = Buffer.from(name);
    const raw = Buffer.from(data);
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const checksum = crc(raw);
    const size = declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!(flags & 8)) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(n.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0);
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    localParts.push(local, n, extra, compressed, descriptor);
    centralParts.push(central, n, extra);
    offset += local.length + n.length + extra.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}
function sheet(body: string, merges = ''): string {
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData>${merges}</worksheet>`;
}
function cells(...values: string[]): string {
  return `<row r="1">${values.map((value, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`;
}
function book(sheets: { name: string; xml: string; state?: string; target?: string }[], shared?: string): Part[] {
  return [
    {
      name: 'xl/workbook.xml',
      data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i}"${s.state ? ` state="${s.state}"` : ''}/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${s.target ?? `worksheets/sheet${i}.xml`}"/>`).join('')}</Relationships>`,
    },
    ...(shared === undefined ? [] : [{ name: 'xl/sharedStrings.xml', data: shared }]),
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i}.xml`, data: s.xml })),
  ];
}
function workbook(body = cells('A', '2'), merges = ''): Part[] {
  return book([{ name: '清单', xml: sheet(body, merges) }]);
}
function success(result: SheetRead): Extract<SheetRead, { ok: true }> {
  assert.equal(result.ok, true);
  return result;
}
function failure(parts: Part[] | Buffer, reason: 'corrupt' | 'too_large' | 'encoding'): void {
  assert.deepEqual(readSheet(Buffer.isBuffer(parts) ? parts : zip(parts), 'a.xlsx'), { ok: false, reason });
}

test('R6 CSV UTF-8 / BOM / GB18030，RFC4180 与既有 parseCsv 语义', () => {
  const text = '型号,数量\r\n"A,B",2\r\n"a""b",3\n"多\n行",4\n,,\n';
  const want = [
    ['型号', '数量'],
    ['A,B', '2'],
    ['a"b', '3'],
    ['多\n行', '4'],
  ];
  for (const input of [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])])
    assert.deepEqual(success(readSheet(input, 'a.CSV')).sheets, [{ name: 'CSV', rows: want }]);
  const gb = Buffer.from([0xd0, 0xcd, 0xba, 0xc5, 0x2c, 0xca, 0xfd, 0xc1, 0xbf, 0x0a, 0x41, 0x2c, 0x32]);
  assert.deepEqual(success(readSheet(gb, 'a.csv')).sheets[0]!.rows, [
    ['型号', '数量'],
    ['A', '2'],
  ]);
  assert.deepEqual(success(readSheet(Buffer.alloc(0), 'a.csv')).sheets[0]!.rows, []);
  assert.deepEqual(success(readSheet(Buffer.from('PK,2'), 'a.csv')).sheets[0]!.rows, [['PK', '2']], 'PK 文本不是 ZIP 魔数');
});

test('R6 CSV 坏编码 / U+FFFD / 坏引号 / 类型伪装', () => {
  for (const b of [Buffer.from([0xff]), Buffer.from([0x81]), Buffer.from([0xef, 0xbf, 0xbd]), Buffer.from([0x84, 0x31, 0xa4, 0x37])])
    assert.deepEqual(readSheet(b, 'a.csv'), { ok: false, reason: 'encoding' });
  assert.deepEqual(readSheet(Buffer.from('"unclosed'), 'a.csv'), { ok: false, reason: 'corrupt' });
  assert.deepEqual(readSheet(Buffer.from('%PDF-1.7'), 'a.csv'), { ok: false, reason: 'corrupt' });
  assert.deepEqual(readSheet(Buffer.from('a,b'), 'a.txt'), { ok: false, reason: 'corrupt' });
  assert.deepEqual(success(readSheet(zip(workbook()), 'fake.jpg')).sheets[0]!.rows, [['A', '2']]);
});

test('R6 XLSX 共享 / 内联富文本、数字原文、布尔、公式缓存 / 无缓存、日期序号', () => {
  const parts = book(
    [
      {
        name: '清单',
        xml: sheet(`<row r="1">
    <c r="A1" t="s"><v>0</v></c>
    <c r="B1" t="inlineStr"><is><r><t>6205</t></r><r><t>-2RS</t></r><rPh><t>忽略拼音</t></rPh></is></c>
    <c r="C1"><v>100</v></c><c r="D1" t="n"><v>100.00</v></c>
    <c r="E1" t="b"><v>1</v></c><c r="F1" t="b"><v>0</v></c>
    <c r="G1"><f>1+2</f><v>3</v></c><c r="H1"><f>1+2</f></c>
    <c r="I1" s="1"><v>45200</v></c><c r="J1" t="str"><f>"test"</f><v>缓存文字</v></c>
    </row>`),
      },
    ],
    '<sst><si><r><t>型</t></r><r><t>号</t></r><rPh><t>xinghao</t></rPh></si></sst>',
  );
  const want = [['型号', '6205-2RS', '100', '100.00', 'TRUE', 'FALSE', '3', '', '45200', '缓存文字']];
  for (const method of [0, 8]) assert.deepEqual(success(readSheet(zip(parts.map((p) => ({ ...p, method }))))).sheets[0]!.rows, want);
  assert.deepEqual(success(readSheet(zip(parts.map((p) => ({ ...p, flags: 8 }))))).sheets[0]!.rows, want, 'data descriptor');
});

test('R6 合并填满、隐藏 / veryHidden 跳过、多表与绝对部件路径', () => {
  const parts = book([
    {
      name: '一&amp;二',
      xml: sheet(cells('型号'), '<mergeCells><mergeCell ref="A1:C2"/></mergeCells>'),
      target: '/xl/worksheets/sheet0.xml',
    },
    { name: '隐藏', state: 'hidden', xml: '<!DOCTYPE evil><broken>' },
    { name: '很隐藏', state: 'veryHidden', xml: '<broken>' },
    { name: '第二表', xml: sheet('<row><c t="inlineStr"><is><t>数量</t></is></c><c><v>2</v></c></row>') },
  ]);
  const sheets = success(readSheet(zip(parts))).sheets;
  assert.deepEqual(sheets, [
    {
      name: '一&二',
      rows: [
        ['型号', '型号', '型号'],
        ['型号', '型号', '型号'],
      ],
    },
    { name: '第二表', rows: [['数量', '2']] },
  ]);
});

test('R6 重复工作表部件按解析路径拒绝，在展开单元格之前检查', () => {
  for (const target of ['worksheets/sheet0.xml', '/xl/worksheets/sheet0.xml', 'worksheets/../worksheets/sheet0.xml']) {
    const parts = book([
      { name: '第一张', xml: sheet(cells('A')) },
      { name: '不同表名', xml: sheet(cells('B')), target },
    ]);
    failure(parts, 'corrupt');
    // 若先展开第一张，就会先报 too_large，证明引用校验没有前置。
    parts[2]!.data = sheet('<row r="201"><c><v>1</v></c></row>');
    failure(parts, 'corrupt');
    parts[0]!.data = String(parts[0]!.data).replace('r:id="rId1"', 'r:id="rId0"');
    failure(parts, 'corrupt');
  }
});

test('R6 可见工作表 20 张正常、21 张在展开之前判 too_large，隐藏表不占名额', () => {
  const tables = Array.from({ length: 21 }, (_, i) => ({ name: `表${i}`, xml: sheet(cells(String(i))) }));
  const twenty = book(tables.slice(0, 20));
  assert.deepEqual(
    success(readSheet(zip(twenty))).sheets.map((s) => s.rows),
    tables.slice(0, 20).map((_, i) => [[String(i)]]),
  );
  failure(book(tables), 'too_large');
  const invalidFirst = book(tables);
  invalidFirst[2]!.data = '<broken>';
  failure(invalidFirst, 'too_large');
  assert.equal(success(readSheet(zip(book([...tables.slice(0, 20), { ...tables[20]!, state: 'hidden' }])))).sheets.length, 20);
});

test('R6 XML 五个预定义实体、数字引用、命名空间、注释与 CDATA', () => {
  const body =
    '<row><c t="inlineStr"><is><t>&amp;&lt;&gt;&quot;&apos;&#65;&#x4E2D;</t></is></c><c t="inlineStr"><is><t><![CDATA[A&B]]></t></is></c></row>';
  const parts = workbook(body);
  parts[2]!.data =
    '<?xml version="1.0"?><!--ok-->' +
    String(parts[2]!.data)
      .replaceAll('<row', '<x:row')
      .replaceAll('</row>', '</x:row>')
      .replace('<worksheet ', '<worksheet xmlns:x="urn:test" ');
  assert.deepEqual(success(readSheet(zip(parts))).sheets[0]!.rows, [['&<>"\'A中', 'A&B']]);
});

test('R6 XML 拒绝 DTD / ENTITY / 未知实体 / 坏结构 / 非法字符', () => {
  for (const body of [
    '<!DOCTYPE worksheet [<!ENTITY x "boom">]><worksheet/>',
    '<!ENTITY x SYSTEM "file:///never-read">',
    sheet(cells('&unknown;')),
    sheet(cells('&#0;')),
    sheet(cells('&#x110000;')),
    sheet(cells('&bare')),
    '<worksheet><sheetData></worksheet>',
    '<worksheet><sheetData/><sheetData/></worksheet>',
    sheet('<row r="1" r="2"/>'),
    sheet(cells(String.fromCharCode(0))),
    '<worksheet/><worksheet/>',
  ]) {
    const parts = workbook();
    parts[2]!.data = body;
    failure(parts, 'corrupt');
  }
  const parts = workbook();
  parts[0]!.data = '<!DOCTYPE workbook>' + parts[0]!.data;
  failure(parts, 'corrupt');
  const badShared = book([{ name: 'A', xml: sheet(cells('A')) }], '<sst><!ENTITY x "boom"></sst>');
  failure(badShared, 'corrupt');
});

test('R6 200 行 / 50 列边界、201 行 / 51 列失败，按最后非空格计算', () => {
  const at = (ref: string, value = '1') => `<row r="${ref.replace(/\D/g, '')}"><c r="${ref}"><v>${value}</v></c></row>`;
  const edge = success(readSheet(zip(workbook(at('AX200'))))).sheets[0]!.rows;
  assert.equal(edge.length, 200);
  assert.equal(edge[199]!.length, 50);
  assert.equal(edge[199]![49], '1');
  failure(workbook(at('A201')), 'too_large');
  failure(workbook(at('AY1')), 'too_large');
  assert.deepEqual(success(readSheet(zip(workbook(at('A1') + at('XFD1048576', ''))))).sheets[0]!.rows, [['1']]);
  failure(workbook(cells('A'), '<mergeCells><mergeCell ref="A1:AY1"/></mergeCells>'), 'too_large');
  failure(workbook(cells('A'), '<mergeCells><mergeCell ref="A1:A201"/></mergeCells>'), 'too_large');
  assert.deepEqual(
    success(readSheet(zip(workbook(cells('A'), '<mergeCells><mergeCell ref="B2:XFD1048576"/></mergeCells>')))).sheets[0]!.rows,
    [['A']],
  );
  for (const [text, ok] of [
    [Array.from({ length: 200 }, () => 'A').join('\n'), true],
    [Array.from({ length: 201 }, () => 'A').join('\n'), false],
    [Array.from({ length: 50 }, () => 'A').join(','), true],
    [Array.from({ length: 51 }, () => 'A').join(','), false],
    ['A' + ','.repeat(51) + '\n' + ','.repeat(51), true],
  ] as const) {
    const result = readSheet(Buffer.from(text), 'a.csv');
    assert.equal(result.ok, ok);
    if (!result.ok) assert.equal(result.reason, 'too_large');
  }
});

test('R6 单元格 200 字截断，UTF-16 代理对完整', () => {
  const value = String.fromCodePoint(0x1f600).repeat(201);
  for (const result of [
    readSheet(Buffer.from(value), 'a.csv'),
    readSheet(zip(workbook(cells(value)))),
    readSheet(zip(book([{ name: 'A', xml: sheet('<row><c t="s"><v>0</v></c></row>') }], `<sst><si><t>${value}</t></si></sst>`))),
  ]) {
    const cell = success(result).sheets[0]!.rows[0]![0]!;
    assert.equal([...cell].length, 200);
    assert.equal(cell, String.fromCodePoint(0x1f600).repeat(200));
  }
});

test('R6 ZIP 小包炸弹、实际解压 5 MiB 上限、声明大小不可信、内存有界', () => {
  const parts = workbook();
  parts[2]!.data = Buffer.alloc(32 * 1024 * 1024, 32);
  parts[2]!.declaredSize = 1;
  const bomb = zip(parts);
  assert.ok(bomb.length < 40 * 1024);
  const before = process.memoryUsage().rss;
  failure(bomb, 'too_large');
  assert.ok(process.memoryUsage().rss - before < 48 * 1024 * 1024, '解压在 5 MiB 截止，不分配完整炸弹');
  const base = sheet(cells('A'));
  for (const delta of [0, 1]) {
    const sample = workbook();
    sample[2]!.data = base + ' '.repeat(5 * 1024 * 1024 + delta - Buffer.byteLength(base));
    const result = readSheet(zip(sample));
    if (delta) assert.deepEqual(result, { ok: false, reason: 'too_large' });
    else assert.equal(result.ok, true);
  }
  const forged = workbook();
  forged[2]!.declaredSize = 1;
  failure(forged, 'corrupt');
});

test('R6 ZIP 合计解压 10 MiB、条目 200 / 201 与不读取无关部件', () => {
  const big = sheet(cells('A')) + ' '.repeat(4 * 1024 * 1024);
  failure(book([0, 1, 2].map((i) => ({ name: String(i), xml: big }))), 'too_large');
  assert.equal(readSheet(zip(book([0, 1].map((i) => ({ name: String(i), xml: big }))))).ok, true);
  for (const count of [200, 201]) {
    const parts = workbook();
    while (parts.length < count) parts.push({ name: `unused/${parts.length}`, data: '' });
    const result = readSheet(zip(parts));
    if (count === 200) assert.equal(result.ok, true);
    else assert.deepEqual(result, { ok: false, reason: 'too_large' });
  }
  const unused = workbook();
  unused.push({ name: 'xl/styles.xml', data: '<!DOCTYPE ignored>bad XML' });
  assert.equal(readSheet(zip(unused)).ok, true);
});

test('R6 ZIP 加密、宏、未知压缩、ZIP64、CRC、重复条目、截断与路径拒绝', () => {
  for (const flags of [1, 64, 8192]) {
    const parts = workbook();
    parts[2]!.flags = flags;
    failure(parts, 'corrupt');
  }
  const macro = workbook();
  macro.push({ name: 'xl/vbaProject.bin', data: 'fake' });
  failure(macro, 'corrupt');
  const method = workbook();
  method[2]!.method = 12;
  failure(method, 'corrupt');
  const zip64 = workbook();
  zip64[2]!.extra = Buffer.from([1, 0, 0, 0]);
  failure(zip64, 'corrupt');
  const sentinel = zip(workbook());
  sentinel.writeUInt16LE(0xffff, sentinel.length - 12);
  failure(sentinel, 'corrupt');
  const localZip64 = zip(workbook().map((p) => ({ ...p, flags: 8 })));
  localZip64.writeUInt32LE(0xffffffff, 18);
  failure(localZip64, 'corrupt');
  const descriptor = zip(workbook().map((p) => ({ ...p, flags: 8 })));
  const descriptorAt = descriptor.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  assert.ok(descriptorAt >= 0);
  descriptor[descriptorAt + 4] ^= 1;
  failure(descriptor, 'corrupt');
  const checksum = zip(workbook().map((p) => ({ ...p, method: 0 })));
  checksum[30 + Buffer.byteLength('xl/workbook.xml') + 2] ^= 1;
  failure(checksum, 'corrupt');
  const duplicate = workbook();
  duplicate.push(duplicate[0]!);
  failure(duplicate, 'corrupt');
  const valid = zip(workbook());
  for (const cut of [0, 1, 4, 29, valid.length - 22, valid.length - 1]) failure(valid.subarray(0, cut), 'corrupt');
  for (const target of ['../../evil.xml', 'https://example.invalid/a.xml', 'worksheets\\a.xml'])
    failure(book([{ name: 'A', xml: sheet(cells('A')), target }]), 'corrupt');
  const external = workbook();
  external[1]!.data = String(external[1]!.data).replace('Target=', 'TargetMode="External" Target=');
  failure(external, 'corrupt');
});

test('R6 文件 2 MiB 上下界、坏单元格与空值', () => {
  for (const delta of [-1, 0, 1]) {
    const result = readSheet(Buffer.alloc(SHEET_MAX_BYTES + delta, 65), 'a.csv');
    if (delta > 0) assert.deepEqual(result, { ok: false, reason: 'too_large' });
    else assert.equal(result.ok, true);
  }
  for (const body of [
    '<row><c t="s"><v>99</v></c></row>',
    '<row><c t="b"><v>2</v></c></row>',
    '<row><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>',
    '<row r="1"><c r="A2"><v>1</v></c></row>',
  ])
    failure(workbook(body), 'corrupt');
  assert.deepEqual(success(readSheet(zip(workbook('<row><c/><c><f>1+2</f></c></row>')))).sheets[0]!.rows, []);
});
console.log(`sheet-read: ${passed} blocks passed`);
