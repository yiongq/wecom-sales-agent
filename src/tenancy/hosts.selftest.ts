import assert from 'node:assert/strict';
import { normalizeHost } from './hosts.js';

const cases: [string, string | null][] = [
  ['EXAMPLE.INVALID:443', 'example.invalid'],
  ['Example.Invalid.:8080', 'example.invalid'],
  ['example.invalid.', 'example.invalid'],
  ['localhost:0', 'localhost'],
  ['127.0.0.1:3000', '127.0.0.1'],
  ['[2001:DB8::1]:443', '[2001:db8::1]'],
  ['[::1]', '[::1]'],
  ['[::ffff:192.0.2.1]:8080', '[::ffff:192.0.2.1]'],
  ['a'.repeat(63) + '.invalid', 'a'.repeat(63) + '.invalid'],
  ['', null],
  ['.', null],
  ['example.invalid..', null],
  ['example..invalid', null],
  ['-example.invalid', null],
  ['example-.invalid', null],
  ['exam_ple.invalid', null],
  ['example.invalid:65536', null],
  ['example.invalid:-1', null],
  ['example.invalid:abc', null],
  ['example.invalid:', null],
  ['example.invalid:443:80', null],
  [' example.invalid', null],
  ['example.invalid\r\n', null],
  ['https://example.invalid', null],
  ['example.invalid/path', null],
  ['example.invalid\\path', null],
  ['example.invalid?query', null],
  ['example.invalid#fragment', null],
  ['user@example.invalid', null],
  ['example.invalid,other.invalid', null],
  ['%65xample.invalid', null],
  ['例子.invalid', null],
  ['a'.repeat(64) + '.invalid', null],
  [Array(4).fill('a'.repeat(63)).join('.'), null],
  ['2001:db8::1', null],
  ['[not-ip]:443', null],
  ['[127.0.0.1]:443', null],
  ['[::1]:65536', null],
  ['[::1]:', null],
  ['[::1', null],
  ['[::1].', null],
  ['[fe80::1%eth0]', null],
];
for (const [raw, expected] of cases) {
  assert.equal(normalizeHost(raw), expected, JSON.stringify(raw));
  if (expected !== null) assert.equal(normalizeHost(expected), expected, '规范化幂等');
}
console.log(`HOSTS SELFTEST：${cases.length} 个表驱动用例通过`);
