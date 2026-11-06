import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const source = process.env.HAIVE_TEST_INSTALLER_DIR
  ? readFileSync(join(process.env.HAIVE_TEST_INSTALLER_DIR, 'install.sh'), 'utf8')
  : readFileSync(join(repo, 'install/install.sh'), 'utf8');
const command = source.indexOf('  if ! LC_ALL=C awk -v channel=');
const start = source.indexOf("'\n", command) + 2;
const end = source.indexOf('\n  \' "$CHANNEL_SCRATCH/release.json"', start);
assert.ok(command >= 0 && start > command && end > start, 'locate the shipped manifest reader');
const reader = source.slice(start, end);
const registry = '127.0.0.1:54321/vendor';
const images = Object.fromEntries(
  ['api', 'worker', 'web', 'builder'].map((host) => [
    host,
    `${registry}/haive-customer-${host}@sha256:${'a'.repeat(64)}`,
  ]),
);
const manifest = { channel: 'customer', version: '9.9.9', images };
const pins = ['api', 'worker', 'web'].map((host) => images[host]).join('\n') + '\n';
function read(data) {
  return spawnSync(
    'awk',
    ['-v', 'channel=customer', '-v', 'version=9.9.9', '-v', `registry=${registry}`, reader],
    { input: data, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 3000 },
  );
}
for (const [name, data] of [
  [
    'newlines between tokens and empty records',
    '\n\n' + JSON.stringify(manifest, null, 2) + '\n\n',
  ],
  ['CRLF records', JSON.stringify(manifest, null, 2).replaceAll('\n', '\r\n')],
  ['no final newline', JSON.stringify(manifest)],
  [
    'all escapes retain their original spelling',
    '{"extra":"prefix\\\"middle\\\\\\/\\b\\f\\n\\r\\t\\u0000\\uAbCd suffix",' +
      JSON.stringify(manifest).slice(1),
  ],
  [
    '990 KB newline-separated manifest within the reader budget',
    JSON.stringify({ ...manifest, extra: Array(41220).fill('x'.repeat(20)) }, null, 0)
      .replaceAll(',"', ',\n"')
      .replaceAll('",', '",\n') + '\n',
  ],
  [
    'long string within the reader budget',
    JSON.stringify({ ...manifest, extra: 'x'.repeat(989000) }),
  ],
  [
    'tokens crossing scan windows',
    JSON.stringify({
      ...manifest,
      extra: ('x'.repeat(4092) + '\\"').repeat(4),
      values: ['y'.repeat(4093), true, null, -1.25e12],
    }).replace('"values":', '"number":1' + '0'.repeat(9890) + ',"values":'),
  ],
  [
    'many escaped slices within the reader budget',
    JSON.stringify({ ...manifest, extra: 'x\n\\"'.repeat(120000) }),
  ],
]) {
  test(`manifest reader accepts ${name}`, () => {
    assert.ok(Buffer.byteLength(data) <= 1048576, 'exercise an installer-sized manifest');
    const r = read(data);
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, pins);
  });
}
for (const [name, extra] of [
  ['split string', '"ab\ncd"'],
  ['split escape', '"ab\\\nn"'],
  ['split unicode escape', '"ab\\u00\n00"'],
  ['split number', '1\n2'],
  ['split keyword', 'tr\nue'],
  ['unfinished string', '"abc'],
  ['unfinished escape', '"abc\\'],
  ['invalid escape', '"abc\\x"'],
  ['short unicode escape', '"abc\\u001"'],
  ['non-hex unicode escape', '"abc\\u00xz"'],
  ['literal tab in string', '"abc\tdef"'],
  ['literal carriage return in string', '"abc\rdef"'],
]) {
  test(`manifest reader rejects ${name}`, () => {
    const r = read('{"extra":' + extra + ',' + JSON.stringify(manifest).slice(1));
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, '');
  });
}
test('manifest reader rejects garbage after otherwise complete records', () => {
  const r = read(JSON.stringify(manifest) + '\n\nfalse\n');
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
});
