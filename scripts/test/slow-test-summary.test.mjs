import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { renderSlowTests } from '../slow-test-summary.mjs';

it('ranks the slowest 15 files across package reports, using file wall time', () => {
  const results = Array.from({ length: 20 }, (_, i) => ({
    name: `/repo/packages/worker/test/file-${i}.test.ts`,
    startTime: 1000,
    endTime: 1000 + i * 1000,
    assertionResults: [{ duration: 999999 }],
  }));
  const output = renderSlowTests(
    [{ testResults: results.slice(0, 10) }, { testResults: results.slice(10) }],
    '/repo',
  );
  const rows = output.split('\n').filter((line) => line.startsWith('| packages/'));
  assert.equal(rows.length, 15);
  assert.match(rows[0], /file-19\.test\.ts.*19\.000/);
  assert.match(rows.at(-1), /file-5\.test\.ts.*5\.000/);
  assert.doesNotMatch(output, /file-4\.test|999999/);
});

it('escapes filenames and ignores absent or invalid timestamps', () => {
  const output = renderSlowTests(
    [
      {
        testResults: [
          { name: '/repo/a|`<b>\n.test.ts', startTime: 10, endTime: 11 },
          { name: '/repo/pending', startTime: 0, endTime: 0 },
          { name: '/repo/missing' },
          { name: '/repo/reversed', startTime: 10, endTime: 9 },
        ],
      },
    ],
    '/repo',
  );
  assert.match(output, /a&#124;&#96;&lt;b&gt; \.test\.ts/);
  assert.doesNotMatch(output, /pending|missing|reversed/);
});

it('reports an empty run without failing', () => {
  assert.match(renderSlowTests([], '/repo'), /No test file timings/);
});

it('discovers package reports, skips node_modules and handles incomplete reports without gating', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'slow-test-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [dir, contents] of [
    [
      'packages/new-package/.turbo',
      JSON.stringify({
        testResults: [
          {
            name: join(root, 'packages/new-package/test/slow.test.ts'),
            startTime: 1,
            endTime: 90001,
          },
        ],
      }),
    ],
    ['modules/new-module/.turbo', '{incomplete'],
    [
      'node_modules/unused/.turbo',
      JSON.stringify({ testResults: [{ name: 'ignored', startTime: 1, endTime: 999999 }] }),
    ],
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'unit-tests.json'), contents);
  }
  const result = spawnSync(
    process.execPath,
    [new URL('../slow-test-summary.mjs', import.meta.url).pathname],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /packages\/new-package\/test\/slow.test.ts.*90\.000/);
  assert.doesNotMatch(result.stdout, /ignored/);
  assert.match(result.stderr, /Could not read.*new-module/);
});
