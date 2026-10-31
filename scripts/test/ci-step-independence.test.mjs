import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parsers } from 'prettier/plugins/yaml';

// A step with no `if` carries an implicit success(): it is skipped once ANY step before it failed.
// In the smokes job that let one red check hide every check after it, and the same shape sat in
// schema-parity, in the web leg of production-images and in macos-preflight. So each of these jobs
// is setup, then checks. Every setup step keeps the default condition, so a failed one stops
// everything after it and the last one succeeds only if all of them did. Every check runs on the
// job's guard: after a failed sibling, but not after a failed setup step or in a cancelled run,
// and it never names a sibling.
const JOBS = [
  {
    file: 'ci.yml',
    id: 'smokes',
    prerequisite: 'migrate',
    // The setup in order, ending at the step with the id above. A check placed in it would stop
    // all the others when it failed, so a new setup step is added here on purpose.
    setup: [
      'actions/checkout',
      'Setup pnpm',
      'Setup Node.js',
      'Install dependencies',
      'Build shared + database',
      'Configure redis maxmemory-policy',
      'Apply database migrations',
    ],
  },
  {
    file: 'ci.yml',
    id: 'schema-parity',
    prerequisite: 'build',
    setup: [
      'actions/checkout',
      'Setup pnpm',
      'Setup Node.js',
      'Install dependencies',
      'Build shared + database',
    ],
  },
  {
    file: 'ci.yml',
    id: 'production-images',
    prerequisite: 'build',
    // The checks run on the web leg of the matrix only; the worker leg is the build alone.
    leg: "matrix.service == 'web'",
    setup: ['actions/checkout', 'Build the production stage'],
  },
  {
    file: 'platform-checks.yml',
    id: 'macos-preflight',
    prerequisite: 'checkout',
    setup: ['actions/checkout'],
  },
];

const guard = ({ prerequisite, leg }) =>
  `\${{ !cancelled() && steps.${prerequisite}.conclusion == 'success'${leg ? ` && ${leg}` : ''} }}`;

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

const workflows = Object.fromEntries(
  [...new Set(JOBS.map(({ file }) => file))].map((file) => {
    const ast = parsers.yaml.parse(
      readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'),
    );
    return [file, value(ast.children[0].children.find((node) => node.type === 'documentBody'))];
  }),
);

const label = (node) => node.name ?? node.uses?.split('@')[0];

function checkJob(job, spec) {
  const { steps } = job;
  const expected = guard(spec);
  // A failure that does not fail its step leaves the job green, or lets the checks run after it.
  const swallowing = [job, ...steps].filter(
    (node) => (node['continue-on-error'] ?? 'false') !== 'false',
  );
  assert.equal(
    swallowing.length,
    0,
    `continue-on-error hides a failure: ${swallowing.map(label).join('; ')}`,
  );
  if (spec.leg) {
    // The checks of a matrix leg never run, and the job stays green, when the matrix loses it.
    const [, key, leg] = /^matrix\.(\w+) == '([^']+)'$/.exec(spec.leg);
    assert.ok(
      job.strategy?.matrix?.[key]?.includes(leg),
      `the matrix has no ${key} ${leg}, so the checks that run on it never do`,
    );
    assert.equal(
      job.strategy.matrix.exclude,
      undefined,
      `a matrix exclude can drop the ${key} ${leg} leg, whose checks then never run`,
    );
  }
  const last = steps.findIndex((step) => step.id === spec.prerequisite);
  assert.ok(last >= 0, `no step has id ${spec.prerequisite}, which every check names`);
  const setup = steps.slice(0, last + 1);
  assert.deepEqual(
    setup.map(label),
    spec.setup,
    `the setup is ${spec.setup.join('; ')}, ending at the step with id ${spec.prerequisite}; it is ${setup.map(label).join('; ')}`,
  );
  const setupWithIf = setup.filter((step) => step.if !== undefined);
  assert.equal(
    setupWithIf.length,
    0,
    `a setup step keeps the default condition, or its failure no longer stops the checks: ${setupWithIf.map(label).join('; ')}`,
  );
  const checks = steps.slice(last + 1);
  assert.ok(checks.length > 0, 'the job has no check after its setup');
  const notGuarded = checks.filter((step) => step.if !== expected);
  assert.equal(
    notGuarded.length,
    0,
    `a check runs on ${expected}, so that a failed sibling neither skips it nor does it wait on one: ${notGuarded.map(label).join('; ')}`,
  );
}

// Each mutant breaks one rule of a job that passes, and checkJob has to refuse it. They are
// written against the position of the prerequisite step (last), so they fit every job above.
const MUTANTS = [
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
    ({ steps }, last, spec) => {
      steps[last + 1].if = guard(spec).replace('!cancelled() && ', '');
    },
  ],
  [
    'always() in place of !cancelled()',
    ({ steps }, last, spec) => {
      steps[last + 1].if = guard(spec).replace('!cancelled()', 'always()');
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
    ({ steps }, last, spec) => {
      steps[last + 1].if = guard(spec).replace(spec.prerequisite, spec.prerequisite.slice(0, -1));
    },
  ],
  [
    'a status that never matches',
    ({ steps }, last, spec) => {
      steps[last + 1].if = guard(spec).replace("'success'", "'success '");
    },
  ],
  [
    'a guard that drops the matrix leg',
    ({ steps }, last, spec) => {
      steps[last + 1].if = guard(spec).replace(` && ${spec.leg}`, '');
    },
    (spec) => spec.leg !== undefined,
  ],
  [
    'a matrix without the leg the checks run on',
    ({ strategy }, _last, spec) => {
      const [, key, leg] = /^matrix\.(\w+) == '([^']+)'$/.exec(spec.leg);
      strategy.matrix[key] = strategy.matrix[key].filter((value) => value !== leg);
    },
    (spec) => spec.leg !== undefined,
  ],
  [
    'a matrix that excludes the leg the checks run on',
    ({ strategy }, _last, spec) => {
      const [, key, leg] = /^matrix\.(\w+) == '([^']+)'$/.exec(spec.leg);
      strategy.matrix.exclude = [{ [key]: leg }];
    },
    (spec) => spec.leg !== undefined,
  ],
  [
    'a setup step that runs after a failure',
    ({ steps }, last) => {
      steps[Math.max(last - 1, 0)].if = '${{ !cancelled() }}';
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
    ({ steps }, last, spec) => {
      delete steps[last].id;
      steps[last + 1].id = spec.prerequisite;
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
];

for (const spec of JOBS) {
  describe(`the ${spec.id} job in ${spec.file}`, () => {
    const job = workflows[spec.file].jobs[spec.id];

    it('runs every check after the setup whatever the other checks did', () => {
      assert.ok(job, `${spec.file} has no ${spec.id} job`);
      checkJob(job, spec);
    });

    for (const [name, mutate, applies] of MUTANTS) {
      if (applies && !applies(spec)) continue;
      it(`rejects ${name}`, () => {
        checkJob(job, spec);
        const mutant = structuredClone(job);
        mutate(
          mutant,
          mutant.steps.findIndex((step) => step.id === spec.prerequisite),
          spec,
        );
        assert.throws(() => checkJob(mutant, spec), assert.AssertionError);
      });
    }
  });
}
