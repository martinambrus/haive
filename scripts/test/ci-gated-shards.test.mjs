import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { GATED_BUDGET, minimumLimits, suggestedShards } from '../lib/ci-gated-budget.mjs';
import { readGated } from '../lib/ci-gated.mjs';
import { readWorkflow } from './workflow.mjs';

const workflow = readWorkflow('ci.yml');
function checkMatrix(job) {
  assert.equal(job.strategy?.['fail-fast'], 'false', 'a failed shard must not cancel another');
  assert.deepEqual(
    job.strategy.matrix,
    {
      shard: Array.from({ length: GATED_BUDGET.shards }, (_, index) => String(index + 1)),
    },
    'every planned shard runs once',
  );
  assert.equal(job.name, 'Postgres-gated tests (shard ${{ matrix.shard }})');
  const step = job.steps.find((candidate) => /<<'GATED'/.test(candidate.run ?? ''));
  assert.equal(step.env.GATED_SHARD, '${{ matrix.shard }}');
  assert.equal(step.env.GATED_SHARDS, '${{ strategy.job-total }}');
}
function checkAggregate(job) {
  assert.ok(job, 'the aggregate must preserve the public check');
  assert.equal(job.name, 'Postgres-gated tests');
  assert.deepEqual(job.needs, ['postgres-gated']);
  assert.equal(job.if, '${{ always() }}', 'a skipped shard must fail the aggregate');
  assert.equal(job['timeout-minutes'], '2');
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.steps.length, 1);
  const [step] = job.steps;
  assert.equal(step.env.RESULT, '${{ needs.postgres-gated.result }}');
  assert.equal(step.if, undefined);
  assert.equal(step['continue-on-error'], undefined);
  assert.equal(step['timeout-minutes'], '1');
  for (const result of ['success', 'failure', 'skipped', 'cancelled']) {
    const out = spawnSync('bash', ['-e', '-c', step.run], {
      env: { ...process.env, RESULT: result },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ifError(out.error);
    assert.equal(out.status === 0, result === 'success', `aggregate result ${result}`);
  }
}

describe('gated CI shards', () => {
  const job = workflow.jobs['postgres-gated'];
  it('runs every planned shard without cancelling its siblings', () => checkMatrix(job));
  it('derives the shard count from modelled row time and keeps per-shard headroom', () => {
    const rows = readGated().rows.length;
    // Do not force a matrix edit while consuming the headroom bought by the last raise.
    const needed = suggestedShards(
      Math.max(1, rows - GATED_BUDGET.rowHeadroom * GATED_BUDGET.shards),
    );
    assert.ok(
      GATED_BUDGET.shards >= needed,
      `${rows} gated rows need ${needed} shards: add matrix legs to postgres-gated in ci.yml and raise GATED_BUDGET.shards to ${needed}`,
    );
    const largest = Math.ceil(rows / GATED_BUDGET.shards);
    const current = minimumLimits(largest, GATED_BUDGET);
    const withHeadroom = minimumLimits(largest + GATED_BUDGET.rowHeadroom, GATED_BUDGET);
    // Headroom is a raise target, not a requirement that would consume a row on every list edit.
    assert.ok(
      withHeadroom.jobMinutes * 60 <=
        2 * (GATED_BUDGET.outsideGatedSeconds + largest * GATED_BUDGET.secondsPerRow),
    );
    const step = job.steps.find((candidate) => /<<'GATED'/.test(candidate.run ?? ''));
    assert.ok(Number(step['timeout-minutes']) >= current.stepMinutes);
    assert.ok(Number(job['timeout-minutes']) >= current.jobMinutes);
  });

  for (const change of ['missing', 'duplicate', 'fail-fast']) {
    it(`rejects ${change} shards`, () => {
      const copy = structuredClone(job);
      if (change === 'missing') copy.strategy.matrix.shard.pop();
      else if (change === 'duplicate') copy.strategy.matrix.shard.push('2');
      else copy.strategy['fail-fast'] = 'true';
      assert.throws(() => checkMatrix(copy), assert.AssertionError);
    });
  }
  it('keeps a public aggregate that fails on non-success', () =>
    checkAggregate(workflow.jobs['postgres-gated-result']));
  it('rejects an aggregate that skips or masks failures', () => {
    const aggregate = workflow.jobs['postgres-gated-result'];
    assert.ok(aggregate);
    for (const mutate of [
      (copy) => delete copy.if,
      (copy) => copy.needs.pop(),
      (copy) => {
        copy.steps[0].run = 'exit 0';
      },
      (copy) => {
        copy.steps[0].run = 'exit 1';
      },
      (copy) => {
        copy.steps[0]['continue-on-error'] = 'true';
      },
    ]) {
      const copy = structuredClone(aggregate);
      mutate(copy);
      assert.throws(() => checkAggregate(copy), assert.AssertionError);
    }
  });
});
