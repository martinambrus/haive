import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swallowedFailure } from './shell-source.mjs';
import { readWorkflow } from './workflow.mjs';

const workflow = readWorkflow('ci.yml');

function checkMatrix(ci) {
  const lint = ci.jobs['lint-typecheck-test'];
  const unit = ci.jobs['unit-tests'];
  assert.ok(unit, 'unit tests need their own matrix job');
  assert.equal(lint.name, 'Lint, Typecheck, Scripts');
  assert.equal(lint['timeout-minutes'], '20');
  assert.equal(unit['timeout-minutes'], '20');
  assert.equal(unit.needs, undefined);
  assert.equal(unit.if, undefined);
  assert.equal(unit['continue-on-error'], undefined);
  assert.equal(unit.strategy['fail-fast'], 'false');
  assert.deepEqual(unit.strategy.matrix, {
    include: [
      { name: 'worker 1/2', filter: '@haive/worker', shard: '1/2' },
      { name: 'worker 2/2', filter: '@haive/worker', shard: '2/2' },
      { name: 'other packages', filter: '!@haive/worker', shard: '' },
    ],
  });
  assert.equal(unit.name, 'Unit tests (${{ matrix.name }})');
  // Checkout, pnpm, Node, install, and the shared + database build: shared's own tests import
  // its subpath exports from dist, which test's ^build does not produce.
  assert.deepEqual(unit.steps.slice(0, 5), lint.steps.slice(0, 5));
  assert.match(lint.steps[4].run, /pnpm --filter @haive\/shared build/);
  const tests = unit.steps.find((step) => step.id === 'tests');
  assert.ok(tests);
  assert.equal(swallowedFailure(tests.run), null);
  assert.equal(tests.if, undefined);
  assert.equal(tests['continue-on-error'], undefined);
  assert.deepEqual(tests.env, {
    TEST_FILTER: '${{ matrix.filter }}',
    TEST_SHARD: '${{ matrix.shard }}',
  });
  assert.match(tests.run, /args=\(\)/);
  assert.match(tests.run, /args\+=\("--shard=\$TEST_SHARD"\)/);
  assert.match(tests.run, /pnpm exec turbo run test --filter="\$TEST_FILTER" --force --/);
  assert.match(
    tests.run,
    /--reporter=default --reporter=json --outputFile\.json=\.turbo\/unit-tests\.json "\$\{args\[@\]\}"/,
  );
  assert.ok(!lint.steps.some((step) => step.run === 'pnpm test'));
  for (const command of ['pnpm format:check', 'pnpm typecheck', 'pnpm test:scripts'])
    assert.ok(
      lint.steps.some((step) => step.run === command),
      command,
    );
  const summary = unit.steps.at(-1);
  assert.equal(
    summary.if,
    "${{ !cancelled() && (steps.tests.outcome == 'success' || steps.tests.outcome == 'failure') }}",
  );
  assert.equal(summary.run, 'node scripts/slow-test-summary.mjs >> "$GITHUB_STEP_SUMMARY"');
  assert.ok(unit.steps.indexOf(tests) < unit.steps.indexOf(summary));
}

describe('unit test matrix', () => {
  it('partitions the workspace without dropping future packages and preserves the lint gates', () =>
    checkMatrix(workflow));
  for (const [name, mutate] of [
    ['a missing worker shard', (job) => job.strategy.matrix.include.shift()],
    [
      'a static non-worker package list',
      (job) => {
        job.strategy.matrix.include[2].filter = '@haive/api';
      },
    ],
    [
      'raised job limit',
      (job) => {
        job['timeout-minutes'] = '30';
      },
    ],
    [
      'fail-fast cancellation',
      (job) => {
        job.strategy['fail-fast'] = 'true';
      },
    ],
    [
      'test failures hidden',
      (job) => {
        job.steps.find((step) => step.id === 'tests')['continue-on-error'] = 'true';
      },
    ],
    [
      'cached tests without timing reports',
      (job) => {
        const step = job.steps.find((step) => step.id === 'tests');
        step.run = step.run.replace('--force ', '');
      },
    ],
    [
      'missing summary after failure',
      (job) => {
        delete job.steps.at(-1).if;
      },
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const mutant = structuredClone(workflow);
      assert.ok(mutant.jobs['unit-tests']);
      mutate(mutant.jobs['unit-tests']);
      assert.throws(() => checkMatrix(mutant));
    });
  }
});

it('forwards each matrix selection and preserves a test runner failure', (t) => {
  const job = workflow.jobs['unit-tests'];
  assert.ok(job);
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'pnpm'),
    `#!/bin/sh
printf '%s\\n' "$@"
exit "$TEST_EXIT"
`,
    { mode: 0o755 },
  );
  for (const leg of job.strategy.matrix.include) {
    for (const exit of [0, 7]) {
      const result = spawnSync(
        'bash',
        ['-e', '-c', job.steps.find((step) => step.id === 'tests').run],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            TEST_FILTER: leg.filter,
            TEST_SHARD: leg.shard,
            TEST_EXIT: String(exit),
          },
        },
      );
      assert.equal(result.status, exit, result.stderr);
      assert.deepEqual(result.stdout.trim().split('\n'), [
        'exec',
        'turbo',
        'run',
        'test',
        `--filter=${leg.filter}`,
        '--force',
        '--',
        '--reporter=default',
        '--reporter=json',
        '--outputFile.json=.turbo/unit-tests.json',
        ...(leg.shard ? [`--shard=${leg.shard}`] : []),
      ]);
    }
  }
});
