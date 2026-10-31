import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parsers } from 'prettier/plugins/yaml';

// A step with no `if` carries an implicit success(): it is skipped once ANY step before it failed.
// In the smokes job that let one red check hide every check after it. So the job is setup, then
// checks. Every setup step keeps the default condition, so a failed one stops everything after it
// and the last one succeeds only if all of them did. Every check runs on GUARD: after a failed
// sibling, but not after a failed setup step or in a cancelled run, and it never names a sibling.
const PREREQUISITE = 'migrate';
const GUARD = `\${{ !cancelled() && steps.${PREREQUISITE}.conclusion == 'success' }}`;
// The setup in order, ending at the step with the id above. A check placed in it would stop all
// the others when it failed, so a new setup step is added here on purpose.
const SETUP = [
  'actions/checkout',
  'Setup pnpm',
  'Setup Node.js',
  'Install dependencies',
  'Build shared + database',
  'Configure redis maxmemory-policy',
  'Apply database migrations',
];

// The YAML parser declared through Prettier, as ci-browser-budget.test.mjs reads it, so
// indentation and comments cannot satisfy the checks. Scalars stay strings.
function value(node) {
  if (!node) return null;
  if ('value' in node) return node.value;
  if (node.type === 'mapping') {
    const entries = node.children.map((item) => item.children.map(value));
    assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, 'duplicate YAML key');
    return Object.fromEntries(entries);
  }
  if (node.type === 'sequence' || node.type === 'flowSequence') return node.children.map(value);
  assert.equal(node.children.length, 1, `unsupported YAML node ${node.type}`);
  return value(node.children[0]);
}

const ast = parsers.yaml.parse(
  readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
);
const workflow = value(ast.children[0].children.find((node) => node.type === 'documentBody'));

const label = (node) => node.name ?? node.uses?.split('@')[0];

function checkSmokesJob(job) {
  const { steps } = job;
  // A failure that does not fail its step leaves the job green, or lets the checks run after it.
  const swallowing = [job, ...steps].filter(
    (node) => (node['continue-on-error'] ?? 'false') !== 'false',
  );
  assert.equal(
    swallowing.length,
    0,
    `continue-on-error hides a failure: ${swallowing.map(label).join('; ')}`,
  );
  const last = steps.findIndex((step) => step.id === PREREQUISITE);
  assert.ok(last >= 0, `no step has id ${PREREQUISITE}, which every check names`);
  const setup = steps.slice(0, last + 1);
  assert.deepEqual(
    setup.map(label),
    SETUP,
    `the setup is ${SETUP.join('; ')}, ending at the step with id ${PREREQUISITE}; it is ${setup.map(label).join('; ')}`,
  );
  const setupWithIf = setup.filter((step) => step.if !== undefined);
  assert.equal(
    setupWithIf.length,
    0,
    `a setup step keeps the default condition, or its failure no longer stops the checks: ${setupWithIf.map(label).join('; ')}`,
  );
  const checks = steps.slice(last + 1);
  assert.ok(checks.length > 0, 'the job has no check after its setup');
  const notGuarded = checks.filter((step) => step.if !== GUARD);
  assert.equal(
    notGuarded.length,
    0,
    `a check runs on ${GUARD}, so that a failed sibling neither skips it nor does it wait on one: ${notGuarded.map(label).join('; ')}`,
  );
}

describe('the smokes job in ci.yml', () => {
  it('runs every check after the setup whatever the other checks did', () => {
    assert.ok(workflow.jobs.smokes, 'ci.yml has no smokes job');
    checkSmokesJob(workflow.jobs.smokes);
  });

  for (const [name, mutate] of [
    [
      'a check without a guard',
      ({ steps }, last) => {
        delete steps[last + 1].if;
      },
    ],
    [
      'a new check added without a guard',
      ({ steps }) => {
        steps.push({ name: 'New check', run: 'true' });
      },
    ],
    [
      'a guard without !cancelled()',
      ({ steps }, last) => {
        steps[last + 1].if = GUARD.replace('!cancelled() && ', '');
      },
    ],
    [
      'always() in place of !cancelled()',
      ({ steps }, last) => {
        steps[last + 1].if = GUARD.replace('!cancelled()', 'always()');
      },
    ],
    [
      'a guard that ignores the setup',
      ({ steps }, last) => {
        steps[last + 1].if = '${{ !cancelled() }}';
      },
    ],
    [
      'a check that waits on a sibling check',
      ({ steps }, last) => {
        steps[last + 1].id = 'first-check';
        steps[last + 2].if = "${{ !cancelled() && steps.first-check.conclusion != 'skipped' }}";
      },
    ],
    [
      'a mistyped prerequisite id',
      ({ steps }, last) => {
        steps[last + 1].if = GUARD.replace(PREREQUISITE, 'migrat');
      },
    ],
    [
      'a status that never matches',
      ({ steps }, last) => {
        steps[last + 1].if = GUARD.replace("'success'", "'success '");
      },
    ],
    [
      'a setup step that runs after a failure',
      ({ steps }, last) => {
        steps[last - 1].if = '${{ !cancelled() }}';
      },
    ],
    [
      'a check moved above the setup end',
      ({ steps }, last) => {
        const [check] = steps.splice(last + 1, 1);
        delete check.if;
        steps.splice(last, 0, check);
      },
    ],
    [
      'a new check inserted in the setup',
      ({ steps }, last) => {
        steps.splice(last, 0, { name: 'New check', run: 'true' });
      },
    ],
    [
      'the prerequisite id moved onto a check',
      ({ steps }, last) => {
        delete steps[last].id;
        steps[last + 1].id = PREREQUISITE;
        delete steps[last + 1].if;
      },
    ],
    [
      'a setup that ends in no step with the prerequisite id',
      ({ steps }, last) => {
        delete steps[last].id;
      },
    ],
    [
      'no check after the setup',
      ({ steps }, last) => {
        steps.splice(last + 1);
      },
    ],
    [
      'a check whose failure leaves the step green',
      ({ steps }, last) => {
        steps[last + 1]['continue-on-error'] = 'true';
      },
    ],
    [
      'a job whose failure leaves it green',
      (job) => {
        job['continue-on-error'] = 'true';
      },
    ],
  ]) {
    it(`rejects ${name}`, () => {
      checkSmokesJob(workflow.jobs.smokes);
      const mutant = structuredClone(workflow.jobs.smokes);
      mutate(
        mutant,
        mutant.steps.findIndex((step) => step.id === PREREQUISITE),
      );
      assert.throws(() => checkSmokesJob(mutant), assert.AssertionError);
    });
  }
});
