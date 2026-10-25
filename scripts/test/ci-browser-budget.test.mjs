import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parsers } from 'prettier/plugins/yaml';

const command = 'pnpm exec playwright test -c tests/e2e/harness/web-runtime/web-runtime.config.ts';

// Use the YAML parser already declared through Prettier, so indentation, comments and unrelated
// job names cannot satisfy the checks. Keep scalars as strings, including numeric YAML values.
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

function required(jobOrStep) {
  assert.equal(jobOrStep.if, undefined, 'browser coverage must not be conditionally skipped');
  assert.ok(
    jobOrStep['continue-on-error'] === undefined || jobOrStep['continue-on-error'] === 'false',
    'browser failure must fail CI',
  );
}

function checkBrowserBudget(ci) {
  assert.ok(ci.on.pull_request, 'browser job must run for pull requests');
  const lint = ci.jobs['lint-typecheck-test'];
  const browser = ci.jobs['browser-runtime'];
  assert.ok(browser, 'browser coverage needs its own job budget');
  assert.notEqual(browser, lint);
  required(browser);
  assert.equal(browser.needs, undefined, 'browser setup must not consume the lint job budget');
  assert.equal(lint['timeout-minutes'], '20', 'preserve the existing lint budget');
  assert.ok(Number(browser['timeout-minutes']) > 0 && Number(browser['timeout-minutes']) <= 20);
  assert.ok(
    !lint.steps.some((step) => step.run?.includes('playwright')),
    'keep browser setup out of lint',
  );

  const steps = browser.steps;
  const index = (predicate, message) => {
    const i = steps.findIndex(predicate);
    assert.ok(i >= 0, message);
    required(steps[i]);
    return i;
  };
  const checkout = index(
    (step) => /^actions\/checkout@[a-f\d]{40}$/.test(step.uses),
    'checkout is required',
  );
  const pnpm = index(
    (step) => /^pnpm\/action-setup@[a-f\d]{40}$/.test(step.uses),
    'pnpm setup is required',
  );
  const node = index(
    (step) => /^actions\/setup-node@[a-f\d]{40}$/.test(step.uses),
    'Node setup is required',
  );
  assert.equal(steps[node].with['node-version'], '26');
  assert.equal(steps[node].with.cache, 'pnpm');
  const install = index(
    (step) => step.run === 'pnpm install --frozen-lockfile',
    'workspace dependencies are required',
  );
  const chromium = index(
    (step) => step.run === 'pnpm exec playwright install --with-deps chromium',
    'browser and OS dependencies are required',
  );
  const test = index(
    (step) => step.run === command,
    'actual isolated browser invocation is required',
  );
  assert.ok(
    checkout < pnpm && pnpm < node && node < install && install < chromium && chromium < test,
  );
  assert.equal(
    Object.values(ci.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.run === command).length,
    1,
  );
}

describe('isolated browser CI budget', () => {
  it('runs browser coverage as a mandatory PR job without starving the existing lint gates', () => {
    checkBrowserBudget(workflow);
  });

  for (const [name, mutate] of [
    [
      'missing browser invocation',
      (job) => {
        job.steps = job.steps.filter((step) => step.run !== command);
      },
    ],
    [
      'missing browser OS dependencies',
      (job) => {
        job.steps = job.steps.filter((step) => !step.run?.includes('install --with-deps'));
      },
    ],
    [
      'missing Node setup',
      (job) => {
        job.steps = job.steps.filter((step) => !step.uses?.startsWith('actions/setup-node@'));
      },
    ],
    [
      'non-gating browser failures',
      (job) => {
        job['continue-on-error'] = 'true';
      },
    ],
    [
      'skipped browser job',
      (job) => {
        job.if = 'false';
      },
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const mutant = structuredClone(workflow);
      assert.ok(mutant.jobs['browser-runtime'], 'browser coverage needs its own job budget');
      mutate(mutant.jobs['browser-runtime']);
      assert.throws(() => checkBrowserBudget(mutant));
    });
  }
});
