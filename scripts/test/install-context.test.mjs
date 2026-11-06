import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const source = readFileSync(
  join(process.env.HAIVE_TEST_INSTALLER_DIR || join(repo, 'install'), 'install.sh'),
  'utf8',
);
const command = source.indexOf("    CHANNEL_CONTEXT=$(LC_ALL=C awk '");
const start = source.indexOf("'\n", command) + 2;
const end = source.indexOf('\n    \' "$CHANNEL_USER_CONFIG/config.json"', start);
assert.ok(command >= 0 && start > command && end > start, 'locate the shipped context reader');
const reader = source.slice(start, end);

for (const [name, data, status, stdout] of [
  ['empty config', '', 0, ''],
  ['missing selection', '{"auths":{}}', 0, ''],
  ['no final newline', '{"currentContext":"remote"}', 0, '"remote"\n'],
  ['CRLF records', '{\r\n"currentContext": "remote"\r\n}\r\n', 0, '"remote"\n'],
  ['whitespace between tokens', '\n{\n"currentContext"\n:\n"remote"\n}\n', 0, '"remote"\n'],
  [
    'nested selection is ignored',
    '{"extra":[{"currentContext":"nested"}],"currentContext":"remote"}',
    0,
    '"remote"\n',
  ],
  ['first selection wins', '{"currentContext":"first","currentContext":"second"}', 0, '"first"\n'],
  [
    'escaped key is ignored',
    String.raw`{"current\u0043ontext":"other","currentContext":"remote"}`,
    0,
    '"remote"\n',
  ],
  [
    'selection retains escape spelling',
    String.raw`{"currentContext":"prefix\"middle\\\/\b\f\n\r\t\u0000\uAbCd suffix"}`,
    0,
    String.raw`"prefix\"middle\\\/\b\f\n\r\t\u0000\uAbCd suffix"` + '\n',
  ],
  // This reader copies the existing token; JSON validation belongs to Docker.
  ['selection crossing records', '{"currentContext":"ab\ncd"}', 0, '"ab\ncd"\n'],
  ['escape crossing records', '{"currentContext":"ab\\\nn"}', 0, '"ab\\\nn"\n'],
  [
    'long single-line config within the reader budget',
    JSON.stringify({ extra: 'x'.repeat(989000), currentContext: 'remote' }),
    0,
    '"remote"\n',
  ],
  [
    'long selected token retains every byte',
    JSON.stringify({ currentContext: 'x'.repeat(989000) }),
    0,
    '"' + 'x'.repeat(989000) + '"\n',
  ],
  [
    'escape and quote across scan windows',
    JSON.stringify({ extra: ('x'.repeat(4092) + '\\"').repeat(4), currentContext: 'remote' }),
    0,
    '"remote"\n',
  ],
  ['non-string selection', '{"currentContext":null}', 1, ''],
  ['unfinished selection', '{"currentContext":"abc', 1, ''],
  ['unfinished escape', '{"currentContext":"abc\\', 1, ''],
  [
    '990 KB newline-separated config within the reader budget',
    JSON.stringify({ extra: Array(39560).fill('x'.repeat(20)), currentContext: 'remote' })
      .replaceAll(',"', ',\n"')
      .replaceAll('",', '",\n'),
    0,
    '"remote"\n',
  ],
]) {
  test(`context reader preserves ${name}`, () => {
    const r = spawnSync('awk', [reader], {
      input: data,
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 3000,
    });
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.status, status, r.stderr);
    assert.equal(r.stdout, stdout);
  });
}
