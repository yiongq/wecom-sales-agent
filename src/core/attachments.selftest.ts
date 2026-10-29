import assert from 'node:assert/strict';
import {
  ATTACHMENT_CLASSES,
  ATTACHMENT_HARD_MAX_BYTES,
  IMAGE_MAX_BYTES,
  SHEET_MAX_BYTES,
  attachmentCrc32,
  classifyAttachment,
  sniffAttachment,
  stripImageMetadata,
} from './attachments.js';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed++;
  console.log(`✓ ${name}`);
}
function zip(names: string[], total?: number): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n);
    centrals.push(central, n);
    offset += local.length + n.length;
  }
  const directory = Buffer.concat(centrals);
  const padding = Buffer.alloc(Math.max(0, (total ?? 0) - offset - directory.length - 22));
  offset += padding.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, padding, directory, end]);
}
function cfb(names: string[], version = 3): Buffer {
  const size = version === 3 ? 512 : 4096;
  const b = Buffer.alloc(size * 3);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(b);
  b.writeUInt16LE(version, 26);
  b.writeUInt16LE(0xfffe, 28);
  b.writeUInt16LE(version === 3 ? 9 : 12, 30);
  b.writeUInt16LE(6, 32);
  b.writeUInt32LE(1, 44);
  b.writeUInt32LE(1, 48);
  b.writeUInt32LE(4096, 56);
  b.writeUInt32LE(0xfffffffe, 60);
  b.writeUInt32LE(0xfffffffe, 68);
  b.fill(0xff, 76, 512);
  b.writeUInt32LE(0, 76);
  b.fill(0xff, size, 2 * size);
  b.writeUInt32LE(0xfffffffd, size);
  b.writeUInt32LE(0xfffffffe, size + 4);
  for (const [i, name] of ['Root Entry', ...names].entries()) {
    const at = 2 * size + i * 128;
    Buffer.from(name + String.fromCharCode(0), 'utf16le').copy(b, at);
    b.writeUInt16LE((name.length + 1) * 2, at + 64);
    b[at + 66] = i === 0 ? 5 : 2;
  }
  return b;
}
function segment(marker: number, text: string): Buffer {
  const data = Buffer.from(text);
  const head = Buffer.from([255, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}
// 独立 CRC 实现与标准已知向量核对，避免只拿生产函数造样本又验证自己。
function crc(bytes: Buffer): number {
  let n = -1;
  for (const b of bytes) {
    n ^= b;
    for (let bit = 0; bit < 8; bit++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
  }
  return ~n >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(body));
  return Buffer.concat([head, body, tail]);
}
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpegSignature = Buffer.from('ffd8ff', 'hex');

test('R1 七类、内容优先与白名单 MIME', () => {
  const samples = [
    [pngSignature, 'bad.xlsx', undefined, 'image', 'image/png'],
    [jpegSignature, 'bad.csv', undefined, 'image', 'image/jpeg'],
    [zip(['xl/workbook.xml']), 'bad.jpg', undefined, 'sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    [Buffer.from('型号,数量\nA,2'), 'a.CSV', undefined, 'sheet', 'text/csv'],
    [cfb(['Workbook']), 'a.xls', undefined, 'legacy_sheet', 'application/vnd.ms-excel'],
    [cfb(['EncryptedPackage']), null, undefined, 'locked_sheet', 'application/octet-stream'],
    [Buffer.from('%PDF-1.7'), null, undefined, 'drawing', 'application/pdf'],
    [pngSignature, null, 'video', 'video', 'application/octet-stream'],
    [Buffer.from([0, 255]), null, undefined, 'other', 'application/octet-stream'],
  ] as const;
  const classes = new Set<string>();
  for (const [b, name, msgtype, cls, mime] of samples) {
    assert.deepEqual(classifyAttachment(b, name, msgtype), { cls, mime });
    classes.add(cls);
  }
  assert.deepEqual([...classes].sort(), [...ATTACHMENT_CLASSES].sort());
  assert.equal(classifyAttachment(Buffer.from('a,b'), 'a.txt').cls, 'other');
  assert.equal(classifyAttachment(Buffer.from([0xff]), 'a.csv').cls, 'other');
  assert.equal(classifyAttachment(zip(['word/document.xml']), 'a.xlsx').cls, 'other');
});

test('R1 图片 8 MiB / 表格 2 MiB：下界、等界、上界', () => {
  for (const delta of [-1, 0, 1]) {
    for (const magic of [pngSignature, jpegSignature]) {
      const b = Buffer.alloc(IMAGE_MAX_BYTES + delta);
      magic.copy(b);
      assert.equal(classifyAttachment(b).cls, delta > 0 ? 'other' : 'image');
    }
    assert.equal(classifyAttachment(zip(['xl/workbook.xml'], SHEET_MAX_BYTES + delta)).cls, delta > 0 ? 'other' : 'sheet');
    assert.equal(classifyAttachment(Buffer.alloc(SHEET_MAX_BYTES + delta, 65), 'a.csv').cls, delta > 0 ? 'other' : 'sheet');
  }
});

test('R1 加密、宏优先、Workbook / Book、CFB v4、doc / ppt 与坏目录', () => {
  assert.equal(classifyAttachment(zip(['xl/workbook.xml', 'xl/vbaProject.bin'])).cls, 'locked_sheet');
  assert.equal(classifyAttachment(zip(['xl/vbaProject.bin'])).cls, 'locked_sheet');
  assert.equal(classifyAttachment(zip(['xl/vbaProject.bin'], SHEET_MAX_BYTES + 1)).cls, 'other', '超限 ZIP 与早判一致');
  assert.equal(classifyAttachment(cfb(['Workbook', 'EncryptedPackage'])).cls, 'locked_sheet');
  assert.equal(classifyAttachment(cfb(['Book'], 4)).cls, 'legacy_sheet');
  for (const name of ['WordDocument', 'PowerPoint Document']) assert.equal(classifyAttachment(cfb([name]), 'a.xls').cls, 'other');
  const cycle = cfb(['Workbook']);
  cycle.writeUInt32LE(1, 516);
  assert.equal(classifyAttachment(cycle).cls, 'other');
  const fake = cfb(['Workbook']);
  fake[2 * 512 + 128 + 66] = 1;
  assert.equal(classifyAttachment(fake).cls, 'other', '同名 storage 不是 stream');
  assert.equal(classifyAttachment(cfb(['Workbook']).subarray(0, 1000)).cls, 'other');
});

test('R1 PDF / DWG / DXF / STEP / IGES，不信扩展名', () => {
  for (const [text, mime] of [
    ['%PDF-1.7', 'application/pdf'],
    ['AC1027', 'image/vnd.dwg'],
    ['0\nSECTION\n2\nHEADER', 'image/vnd.dxf'],
    [' \t\r\n0\r\n  SECTION\r\n', 'image/vnd.dxf'],
    ['ISO-10303-21;\nHEADER;', 'model/step'],
    [' '.repeat(72) + 'S      1', 'model/iges'],
  ]) {
    assert.deepEqual(classifyAttachment(Buffer.from(text!), 'a.csv'), { cls: 'drawing', mime });
    assert.equal(sniffAttachment(Buffer.from(text!), SHEET_MAX_BYTES + 1).tooLarge, false, '大图纸照样读完、转顾问');
    assert.equal(sniffAttachment(Buffer.from(text!), ATTACHMENT_HARD_MAX_BYTES + 1).tooLarge, true);
    assert.equal(sniffAttachment(Buffer.from(text!), 100).kind, 'drawing');
  }
  const bigPdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(SHEET_MAX_BYTES + 1, 32)]);
  assert.equal(classifyAttachment(bigPdf).cls, 'drawing');
  assert.equal(classifyAttachment(Buffer.from('0\nSECTIONAL')).cls, 'other');
  assert.equal(classifyAttachment(Buffer.from(' '.repeat(71) + 'S')).cls, 'other');
});

test('R2 sniff 六类、声明大小超限与 64 KiB 分片字符', () => {
  const samples = [
    [pngSignature, 'image'],
    [jpegSignature, 'image'],
    [zip([]), 'zip'],
    [zip(['xl/workbook.xml']), 'zip'],
    [cfb(['EncryptedPackage']), 'cfb'],
    [Buffer.from('%PDF-1.7'), 'drawing'],
    [Buffer.from('a,b'), 'text'],
    [Buffer.from([0xff, 0x00]), 'unknown'],
  ] as const;
  for (const [bytes, kind] of samples) {
    const maxBytes =
      kind === 'image' ? IMAGE_MAX_BYTES : kind === 'drawing' || kind === 'cfb' ? ATTACHMENT_HARD_MAX_BYTES : SHEET_MAX_BYTES;
    for (const delta of [-1, 0, 1]) assert.deepEqual(sniffAttachment(bytes, maxBytes + delta), { kind, maxBytes, tooLarge: delta > 0 });
    assert.equal(sniffAttachment(bytes, null).tooLarge, false);
  }
  const split = Buffer.concat([Buffer.alloc(65535, 65), Buffer.from('中')]);
  assert.equal(sniffAttachment(split, split.length).kind, 'text');
  assert.equal(sniffAttachment(Buffer.from([0xd6, 0xd0, 0x2c, 0xca, 0xfd]), 5).kind, 'text');
  assert.equal(sniffAttachment(Buffer.alloc(SHEET_MAX_BYTES + 1, 65), null).tooLarge, true);
});

test('R4 JPEG 删除全部 APP1（Exif / XMP），保留段链、熵编码与多扫描', () => {
  const soi = Buffer.from([255, 216]);
  const eoi = Buffer.from([255, 217]);
  const app0 = segment(224, 'JFIF');
  const table = segment(219, 'table');
  const scan = segment(218, 'scan');
  const entropy = Buffer.from([20, 255, 0, 40, 255, 208, 50]);
  const keep = Buffer.concat([soi, app0, table, scan, entropy, scan, entropy, eoi]);
  const input = Buffer.concat([
    soi,
    segment(225, 'Exif: GPS Orientation'),
    app0,
    segment(225, 'XMP: location'),
    table,
    scan,
    entropy,
    segment(225, 'XMP between scans'),
    scan,
    entropy,
    eoi,
  ]);
  const before = Buffer.from(input);
  const result = stripImageMetadata(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.bytes, keep);
    assert.deepEqual(stripImageMetadata(result.bytes), result);
  }
  assert.deepEqual(input, before);
  for (const broken of [
    input.subarray(0, -1),
    Buffer.concat([input, Buffer.from('trailing')]),
    Buffer.from('ffd8ffe10001ffd9', 'hex'),
    Buffer.from('ffd8ff00', 'hex'),
  ])
    assert.deepEqual(stripImageMetadata(broken), { ok: false });
});

test('R4 PNG 删除 eXIf / tEXt / iTXt / zTXt，保留原块与 CRC；坏结构失败', () => {
  assert.equal(crc(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(attachmentCrc32(Buffer.from('123456789')), 0xcbf43926);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const kept = [
    chunk('IHDR', ihdr),
    chunk('gAMA', Buffer.from([0, 0, 177, 143])),
    chunk('IDAT', Buffer.from([1, 2, 3])),
    chunk('IEND', Buffer.alloc(0)),
  ];
  const input = Buffer.concat([
    pngSignature,
    kept[0]!,
    ...['eXIf', 'tEXt', 'iTXt', 'zTXt'].map((type) => chunk(type, Buffer.from('GPS'))),
    ...kept.slice(1),
  ]);
  const result = stripImageMetadata(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.bytes, Buffer.concat([pngSignature, ...kept]));
    const b = Buffer.from(result.bytes);
    for (let at = 8; at < b.length;) {
      const end = at + 12 + b.readUInt32BE(at);
      assert.equal(crc(b.subarray(at + 4, end - 4)), b.readUInt32BE(end - 4));
      at = end;
    }
  }
  const badCrc = Buffer.from(input);
  badCrc[29] = badCrc[29]! ^ 1;
  const badLength = Buffer.from(input);
  badLength.writeUInt32BE(0xffffffff, 8);
  for (const b of [badCrc, badLength, input.subarray(0, -1), Buffer.concat([input, Buffer.from('x')]), pngSignature])
    assert.deepEqual(stripImageMetadata(b), { ok: false });
});

test('R1 / R4 坏结构与截断不抛异常', () => {
  for (const valid of [zip(['xl/workbook.xml']), cfb(['Book']), pngSignature, jpegSignature]) {
    for (let n = 0; n < valid.length; n += 7) {
      assert.doesNotThrow(() => classifyAttachment(valid.subarray(0, n), 'a.xlsx'));
      assert.doesNotThrow(() => stripImageMetadata(valid.subarray(0, n)));
    }
  }
});
console.log(`attachments: ${passed} blocks passed`);
