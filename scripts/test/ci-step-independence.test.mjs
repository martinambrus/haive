import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    id: 'compose-boot',
    prerequisite: 'runtime',
    cleanup: ['always()', 'failure()', 'always()'],
    setup: [
      'actions/checkout',
      'Seed .env for compose',
      'Pull registry images',
      'Build compose images',
      'Start infrastructure',
      'Wait for postgres + redis health',
      'Apply database migrations (runs again under `up`, proving idempotence)',
      'Start api (populates shared node_modules volume)',
      'Probe api /health',
      'runtime',
    ],
  },
  {
    file: 'ci.yml',
    id: 'smokes',
    allStepsBounded: true,
    prerequisite: 'migrate',
    // Every check is cut by its own time limit (see RUN_SMOKES), not only by the job's.
    bounded: true,
    // MEASURED, volatile (59 green runs from 2026-10-30 through main run 41198565486): a green run
    // spent at most 907 s outside the gated step, which took about 7.5 s a row of its GATED list
    // on the slowest runners. A green run is modelled as that: 907 s plus 7.5 s a row. The job's
    // limit keeps `marginSeconds` over it, so that a slower runner does not cancel a green run, and
    // stays within twice it, so that a hung run still ends soon. A check that hangs to its limit
    // leaves the checks after it room: its limit on top of everything else a green run spends
    // (907 s for the gated step, a whole green run for any other check). The gated step's limit
    // stays `slowRunnerFactor` times its modelled time. The list keeps growing, so these fail at a
    // row count: measure again, then raise the limits or split the gated tests into their own job.
    // Only the list is modelled: the 907 s grew from 629 s in the week to 2026-10-31 (the worker
    // smokes and the auth throttle script), so measure it again whenever a green run nears the limit.
    budget: {
      outsideGatedSeconds: 907,
      secondsPerRow: 7.5,
      slowRunnerFactor: 1.5,
      marginSeconds: 600,
    },
    // The setup in order, ending at the step with the id above. A check placed in it would stop
    // all the others when it failed, so a new setup step is added here on purpose.
    setup: [
      'actions/checkout',
      'Setup pnpm',
      'Setup Node.js',
      'Install dependencies',
      'Build shared + database',
      'Configure redis maxmemory-policy',
      'migrate',
    ],
  },
  {
    file: 'ci.yml',
    id: 'schema-parity',
    allStepsBounded: true,
    prerequisite: 'build',
    setup: ['actions/checkout', 'Setup pnpm', 'Setup Node.js', 'Install dependencies', 'build'],
  },
  {
    file: 'ci.yml',
    id: 'production-images',
    allStepsBounded: true,
    prerequisite: 'build',
    // The checks run on the web leg of the matrix only; the worker leg is the build alone.
    leg: "matrix.service == 'web'",
    setup: ['actions/checkout', 'build'],
  },
  {
    file: 'platform-checks.yml',
    id: 'macos-preflight',
    allStepsBounded: true,
    prerequisite: 'checkout',
    setup: ['checkout'],
  },
];

// A smoke:ci chain is bounded by scripts/run-smokes.mjs, which gives each smoke its own limit and
// names the one that hangs. Any other check of a bounded job needs a timeout-minutes, or one hung
// check burns the job's whole limit and cancels every check after it.
const RUN_SMOKES = /^pnpm --filter @haive\/[\w-]+ smoke:ci$/;
const WHOLE_MINUTES = /^[1-9]\d*$/;

// The rows of the GATED list of a check that holds one, or null.
const gatedRows = (check) => {
  const list = /<<'GATED'\n([\s\S]+?)\nGATED(?:\n|$)/.exec(check.run ?? '')?.[1];
  return list === undefined ? null : list.split('\n').filter(Boolean).length;
};

// What a green run of the job is modelled to take: everything outside the gated step, plus
// secondsPerRow for each row of the list that step loops over.
function model(checks, { outsideGatedSeconds, secondsPerRow }) {
  const gatedChecks = checks.filter((check) => gatedRows(check) !== null);
  assert.equal(gatedChecks.length, 1, "the job has exactly one check with a <<'GATED' list");
  const [gated] = gatedChecks;
  const rows = gatedRows(gated);
  return {
    gated,
    rows,
    gatedSeconds: rows * secondsPerRow,
    greenSeconds: outsideGatedSeconds + rows * secondsPerRow,
  };
}

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
  [...new Set([...JOBS.map(({ file }) => file), 'release.yml'])].map((file) => {
    const ast = parsers.yaml.parse(
      readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'),
    );
    return [file, value(ast.children[0].children.find((node) => node.type === 'documentBody'))];
  }),
);

const label = (node) => node.id ?? node.name ?? node.uses?.split('@')[0];

// Floors retain slack above the latest measured maxima: worker smokes 624 s (at least 1.25x),
// throttle 144 s (at least 1.5x), Docker builds 93 s (cold cache/retries), other steps 14 s.
function minimumMinutes(step) {
  const run = step.run?.trim() ?? '';
  if (run === 'pnpm --filter @haive/worker smoke:ci') return 13;
  if (/\bdocker build\b/.test(run)) return 5;
  if (run.includes('test/auth-throttle.test.ts')) return 4;
  return 2;
}

function checkJob(job, spec, workflow = workflows[spec.file]) {
  assert.equal(
    workflow.defaults?.run?.shell,
    undefined,
    'a workflow shell overrides runner errexit',
  );
  const steps = spec.cleanup ? job.steps.slice(0, -spec.cleanup.length) : job.steps;
  if (spec.cleanup) {
    assert.deepEqual(
      job.steps.slice(-spec.cleanup.length).map((step) => step.if),
      spec.cleanup,
      'diagnostics and cleanup keep their always()/failure() conditions',
    );
  }
  const expected = guard(spec);
  assert.equal(job.if, undefined, 'a job condition can skip all checks green');
  assert.equal(job.defaults?.run?.shell, undefined, 'a job shell overrides runner errexit');
  for (const step of steps) {
    assert.equal(step.shell, undefined, `${label(step)} overrides runner errexit`);
    const script = (step.run ?? '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(
      script,
      /\|\|\s*(?:\\\s*)?(?:true\b|:(?:\s|$)|exit\s+0(?:\s|;|$))/,
      `${label(step)} swallows a command failure`,
    );
    assert.doesNotMatch(
      script,
      /(?:^|[;\n])\s*(?:true\b|set\s+\+e(?:\s|;|$))/,
      `${label(step)} hides failures with a success command or disabled errexit`,
    );
  }
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
    assert.equal(job.strategy?.['fail-fast'], 'false', 'matrix fail-fast cancels unrelated legs');
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
  if (spec.bounded) {
    // A limit that is there has to be readable; without one the check has to be a smoke:ci chain.
    const unbounded = checks.filter((step) =>
      step['timeout-minutes'] === undefined
        ? !RUN_SMOKES.test(step.run?.trim() ?? '')
        : !WHOLE_MINUTES.test(step['timeout-minutes']),
    );
    assert.equal(
      unbounded.length,
      0,
      `a check is a smoke:ci chain or has a timeout-minutes of whole minutes, so that a hang ends it and not the job: ${unbounded.map(label).join('; ')}`,
    );
  }
  if (spec.allStepsBounded) {
    for (const step of steps) {
      assert.match(
        step['timeout-minutes'] ?? '',
        WHOLE_MINUTES,
        `${step.id ?? label(step)} needs a timeout-minutes of whole minutes`,
      );
      assert.ok(
        Number(step['timeout-minutes']) >= minimumMinutes(step),
        `${label(step)} needs at least ${minimumMinutes(step)} minutes above measured runtimes`,
      );
    }
  }
  if (spec.budget) {
    const { outsideGatedSeconds, slowRunnerFactor, marginSeconds } = spec.budget;
    const { gated, rows, gatedSeconds, greenSeconds } = model(checks, spec.budget);
    assert.match(
      job['timeout-minutes'] ?? '',
      WHOLE_MINUTES,
      'the job has a timeout-minutes of whole minutes, or it runs for the default six hours',
    );
    const limit = Number(job['timeout-minutes']) * 60;
    assert.ok(
      limit >= greenSeconds + marginSeconds,
      `the job's limit of ${limit} s leaves ${limit - greenSeconds} s over a green run (${greenSeconds} s modelled for ${rows} gated rows), not the ${marginSeconds} s a slower runner needs`,
    );
    assert.ok(
      limit <= 2 * greenSeconds,
      `the job's limit of ${limit} s is over twice a green run (${greenSeconds} s modelled), so a hung run would be cancelled late`,
    );
    const crowding = checks.filter(
      (check) =>
        check['timeout-minutes'] !== undefined &&
        limit <
          (check === gated ? outsideGatedSeconds : greenSeconds) +
            Number(check['timeout-minutes']) * 60,
    );
    assert.equal(
      crowding.length,
      0,
      `a check that runs to its limit leaves the checks after it too little of the job's ${limit} s: ${crowding.map(label).join('; ')}`,
    );
    assert.ok(
      Number(gated['timeout-minutes']) * 60 >= slowRunnerFactor * gatedSeconds,
      `the gated step's limit of ${Number(gated['timeout-minutes']) * 60} s is under ${slowRunnerFactor} times the ${gatedSeconds} s its ${rows} rows are modelled to take, so a slower runner would end a green run`,
    );
  }
}

// Each mutant breaks one rule of a job that passes, and checkJob has to refuse it. They are
// written against the position of the prerequisite step (last), so they fit every job above.
const MUTANTS = [
  [
    'a matrix defaulting to fail-fast',
    (job) => {
      delete job.strategy['fail-fast'];
    },
    (spec) => spec.leg !== undefined,
  ],
  [
    'a prerequisite id replaced with a different id',
    ({ steps }, last) => {
      steps[last].id = 'wrong-setup';
    },
  ],
  ...['0', '1'].map((limit) => [
    `a setup step limit below the floor (${limit})`,
    ({ steps }) => {
      steps[0]['timeout-minutes'] = limit;
    },
    (spec) => spec.allStepsBounded,
  ]),
  [
    'a worker smoke limit below measured slack',
    ({ steps }) => {
      steps.find((step) => step.run?.trim() === 'pnpm --filter @haive/worker smoke:ci')[
        'timeout-minutes'
      ] = '12';
    },
    (spec) => spec.id === 'smokes',
  ],
  [
    'an auth throttle limit below measured slack',
    ({ steps }) => {
      steps.find((step) => step.run?.includes('test/auth-throttle.test.ts'))['timeout-minutes'] =
        '3';
    },
    (spec) => spec.id === 'smokes',
  ],
  [
    'a Docker build limit below cold-cache slack',
    ({ steps }) => {
      steps.find((step) => /\bdocker build\b/.test(step.run ?? ''))['timeout-minutes'] = '4';
    },
    (spec) => ['schema-parity', 'production-images'].includes(spec.id),
  ],
  [
    'survivor: a check swallowing failure with || true',
    ({ steps }, last) => {
      const step = steps.slice(last + 1).find((step) => step.run && gatedRows(step) === null);
      step.run = `(${step.run.trim()}) || true`;
    },
  ],
  ...['|| :', '|| exit 0', '; true', '\nset +e'].map((suffix) => [
    `survivor: a check swallowing failure with ${suffix.trim()}`,
    ({ steps }, last) => {
      const step = steps.slice(last + 1).find((step) => step.run && gatedRows(step) === null);
      step.run = suffix.includes('set +e')
        ? `set +e\n${step.run}`
        : `(${step.run.trim()}) ${suffix}`;
    },
  ]),
  [
    'survivor: matrix fail-fast enabled',
    (job) => {
      job.strategy['fail-fast'] = 'true';
    },
    (spec) => spec.leg !== undefined,
  ],
  [
    'survivor: a job shell overriding runner errexit',
    (job) => {
      job.defaults = { run: { shell: 'bash {0}' } };
    },
  ],
  [
    'survivor: a check shell overriding runner errexit',
    ({ steps }, last) => {
      steps[last + 1].shell = 'bash {0}';
    },
  ],
  [
    'survivor: a job disabled with if false',
    (job) => {
      job.if = 'false';
    },
  ],
  ...['0', '1'].map((limit) => [
    `survivor: step limit below the floor (${limit})`,
    ({ steps }, last) => {
      steps[last + 1]['timeout-minutes'] = limit;
    },
    (spec) => spec.allStepsBounded && !spec.budget,
  ]),
  [
    'a setup step with no time limit',
    ({ steps }) => {
      delete steps[0]['timeout-minutes'];
    },
    (spec) => spec.allStepsBounded,
  ],
  [
    'a check with no explicit step limit',
    ({ steps }, last) => {
      delete steps[last + 1]['timeout-minutes'];
    },
    (spec) => spec.allStepsBounded,
  ],
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
  [
    'a check with no time limit',
    ({ steps }, last) => {
      delete steps.slice(last + 1).find((step) => step['timeout-minutes'] !== undefined)[
        'timeout-minutes'
      ];
    },
    (spec) => spec.bounded,
  ],
  ...['0', '-5', '2.5', 'five', '${{ vars.LIMIT }}'].map((limit) => [
    `a time limit of ${limit}`,
    ({ steps }, last) => {
      steps.slice(last + 1).find((step) => step['timeout-minutes'] !== undefined)[
        'timeout-minutes'
      ] = limit;
    },
    (spec) => spec.bounded,
  ]),
  [
    'a smoke chain with a time limit that is not whole minutes',
    ({ steps }, last) => {
      const chain = steps.slice(last + 1).find((step) => RUN_SMOKES.test(step.run?.trim() ?? ''));
      chain['timeout-minutes'] = '0';
    },
    (spec) => spec.bounded,
  ],
  ...[
    [
      'a job limit that leaves too little over a green run',
      ({ greenSeconds }, { marginSeconds }) => Math.ceil((greenSeconds + marginSeconds) / 60) - 1,
    ],
    [
      'a job limit above twice a green run',
      ({ greenSeconds }) => Math.floor((2 * greenSeconds) / 60) + 1,
    ],
    ['a job limit that is not whole minutes', () => '40.5'],
    ['a job limit that is an expression', () => '${{ vars.LIMIT }}'],
  ].map(([name, limit]) => [
    name,
    (job, last, spec) => {
      const modelled = model(job.steps.slice(last + 1), spec.budget);
      job['timeout-minutes'] = String(limit(modelled, spec.budget));
    },
    (spec) => spec.budget,
  ]),
  [
    'a job with no limit of its own',
    (job) => {
      delete job['timeout-minutes'];
    },
    (spec) => spec.budget,
  ],
  [
    'a gated step limit one minute over what the job limit absorbs',
    (job, last, spec) => {
      const { gated } = model(job.steps.slice(last + 1), spec.budget);
      const room = Number(job['timeout-minutes']) * 60 - spec.budget.outsideGatedSeconds;
      gated['timeout-minutes'] = String(Math.floor(room / 60) + 1);
    },
    (spec) => spec.budget,
  ],
  [
    'another check limit one minute over what the job limit absorbs',
    (job, last, spec) => {
      const checks = job.steps.slice(last + 1);
      const { gated, greenSeconds } = model(checks, spec.budget);
      const other = checks.find(
        (check) => check !== gated && check['timeout-minutes'] !== undefined,
      );
      other['timeout-minutes'] = String(
        Math.floor((Number(job['timeout-minutes']) * 60 - greenSeconds) / 60) + 1,
      );
    },
    (spec) => spec.budget,
  ],
  [
    'a job limit under the margin when no step limit crowds it',
    (job, last, spec) => {
      const checks = job.steps.slice(last + 1);
      const { gated, gatedSeconds, greenSeconds } = model(checks, spec.budget);
      for (const check of checks) {
        if (check['timeout-minutes'] !== undefined) check['timeout-minutes'] = '1';
      }
      gated['timeout-minutes'] = String(
        Math.ceil((spec.budget.slowRunnerFactor * gatedSeconds) / 60),
      );
      job['timeout-minutes'] = String(
        Math.ceil((greenSeconds + spec.budget.marginSeconds) / 60) - 1,
      );
    },
    (spec) => spec.budget,
  ],
  [
    'a second check with a GATED list',
    ({ steps }, last, spec) => {
      const { gated } = model(steps.slice(last + 1), spec.budget);
      steps.push({ ...gated, name: 'Second gated tests' });
    },
    (spec) => spec.budget,
  ],
  [
    'a gated step limit under its modelled time on a slower runner',
    (job, last, spec) => {
      const { gated, gatedSeconds } = model(job.steps.slice(last + 1), spec.budget);
      gated['timeout-minutes'] = String(
        Math.ceil((spec.budget.slowRunnerFactor * gatedSeconds) / 60) - 1,
      );
    },
    (spec) => spec.budget,
  ],
  [
    'a GATED list that has outgrown the step limit',
    (job, last, spec) => {
      const { gated, rows } = model(job.steps.slice(last + 1), spec.budget);
      const { secondsPerRow, slowRunnerFactor } = spec.budget;
      const capacity = Math.floor(
        (Number(gated['timeout-minutes']) * 60) / (slowRunnerFactor * secondsPerRow),
      );
      gated.run = gated.run.replace(
        /\nGATED(\n|$)/,
        `${'\nx'.repeat(capacity + 1 - rows)}\nGATED$1`,
      );
    },
    (spec) => spec.budget,
  ],
  [
    'a new check that is not a smoke chain and has no time limit',
    ({ steps }, last, spec) => {
      steps.push({
        name: 'New check',
        if: guard(spec),
        run: 'pnpm --filter @haive/api smoke:ci && sleep 9999',
      });
    },
    (spec) => spec.bounded,
  ],
];

for (const spec of JOBS) {
  describe(`the ${spec.id} job in ${spec.file}`, () => {
    const job = workflows[spec.file].jobs[spec.id];

    it('runs every check after the setup whatever the other checks did', () => {
      assert.ok(job, `${spec.file} has no ${spec.id} job`);
      checkJob(job, spec);
    });

    it('identifies the prerequisite by id when its display name changes', () => {
      const renamed = structuredClone(job);
      renamed.steps.find((step) => step.id === spec.prerequisite).name = 'Different wording';
      checkJob(renamed, spec);
    });

    it('rejects a workflow shell overriding runner errexit', () => {
      const mutant = structuredClone(workflows[spec.file]);
      mutant.defaults = { run: { shell: 'bash {0}' } };
      assert.throws(() => checkJob(mutant.jobs[spec.id], spec, mutant), assert.AssertionError);
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

// Run the workflow's actual script with the runner's implicit errexit. Only external tools are
// stubbed; its loop, reports and final verdict are the same code GitHub runs.
const gatedStep = () =>
  workflows['ci.yml'].jobs.smokes.steps.find((step) => gatedRows(step) !== null);
function runGated(t, mode, script = gatedStep().run) {
  const dir = mkdtempSync(join(tmpdir(), 'haive-gated-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = (name, source) =>
    writeFileSync(join(dir, name), '#!/bin/bash\n' + source, { mode: 0o755 });
  stub(
    'docker',
    `
if [[ "$*" == *"SELECT 1"* ]]; then
  if [[ "$MODE" == probe && "$*" == *"db_error_params_test"* ]]; then exit 3; fi
  if [[ "$MODE" == create && "$*" == *"db_error_params_test"* ]]; then exit 0; fi
  echo 1
fi
if [[ "$MODE" == create && "$*" == *"CREATE DATABASE db_error_params_test"* ]]; then exit 4; fi
`,
  );
  stub(
    'pnpm',
    `
if [[ "$MODE" == migrate && "$*" == *"@haive/database migrate"* && "$DATABASE_URL" == */db_error_params_test ]]; then exit 5; fi
if [[ "$*" == *"exec vitest run"* ]]; then
  passed=1; pending=0; todo=0
  if [[ "$*" == *"test/logger-db-error-params.test.ts"* ]]; then
    case "$MODE" in pending) pending=1 ;; todo) todo=1 ;; empty) passed=0 ;; esac
  fi
  echo "$*" >> "$CALLS"
  for arg in "$@"; do
    case "$arg" in --outputFile.json=*)
      printf '{"numPassedTests":%s,"numFailedTests":0,"numPendingTests":%s,"numTodoTests":%s}' "$passed" "$pending" "$todo" > "\${arg#*=}" ;;
    esac
  done
  if [[ "$MODE" == vitest && "$*" == *"test/logger-db-error-params.test.ts"* ]]; then exit 7; fi
fi
`,
  );
  stub(
    'node',
    `
if [[ "$1" != scripts/gen-modules.mjs ]]; then exec "$REAL_NODE" "$@"; fi
`,
  );
  const out = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: dir + ':' + process.env.PATH,
      REAL_NODE: process.execPath,
      RUNNER_TEMP: dir,
      PG_CONTAINER: 'postgres-stub',
      PGVECTOR_CONTAINER: 'pgvector-stub',
      CALLS: join(dir, 'calls'),
      MODE: mode,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(out.error);
  return {
    ...out,
    calls: existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '',
    output: out.stdout + out.stderr,
  };
}

function checkGatedPass(out) {
  assert.equal(out.status, 0, out.output);
  assert.doesNotMatch(out.output, /::error::/);
  assert.equal(out.calls.trim().split('\n').length, gatedRows(gatedStep()));
}

function checkGatedFailure(out) {
  assert.equal(out.status, 1, out.output);
  assert.match(out.output, /::error::test\/logger-db-error-params\.test\.ts failed/);
  assert.equal(out.calls.trim().split('\n').length, gatedRows(gatedStep()));
}

describe('the gated loop verdict', () => {
  it('passes without error annotations when every row passes', (t) => {
    checkGatedPass(runGated(t, 'pass'));
  });
  it('fails and annotates a failing vitest call while running all later rows', (t) => {
    checkGatedFailure(runGated(t, 'vitest'));
  });
  it('rejects a deleted verdict', (t) => {
    const script = gatedStep().run.replace(/^exit "\$failed"$/m, '');
    assert.notEqual(script, gatedStep().run, 'the mutant must remove the verdict');
    assert.throws(() => checkGatedFailure(runGated(t, 'vitest', script)), assert.AssertionError);
  });
  it('rejects an unconditional failure verdict', (t) => {
    const script = gatedStep().run.replace(/^exit "\$failed"$/m, 'exit 1');
    assert.notEqual(script, gatedStep().run, 'the mutant must replace the verdict');
    assert.throws(() => checkGatedPass(runGated(t, 'pass', script)), assert.AssertionError);
  });
});

describe('the gated database probe', () => {
  it('annotates a failed probe, counts the row failed and runs all later rows', (t) => {
    const out = runGated(t, 'probe');
    assert.equal(out.status, 1, out.output);
    assert.match(
      out.output,
      /::error::.*test\/logger-db-error-params\.test\.ts.*db_error_params_test/,
    );
    assert.equal(out.calls.trim().split('\n').length, gatedRows(gatedStep()) - 1);
    assert.doesNotMatch(out.calls, /test\/logger-db-error-params\.test\.ts/);
  });
});

const GATED_GUARD_CASES = [
  ['pending', 'did not run in full', 'r.numPendingTests > 0', 'false'],
  ['todo', 'did not run in full', 'r.numTodoTests > 0', 'false'],
  ['empty', 'did not run in full', '!(r.numPassedTests > 0)', 'false'],
  [
    'create',
    'could not create db_error_params_test',
    '|| { echo "::error::could not create $db"; failed=1; echo "::endgroup::"; continue; }',
    '|| :',
  ],
  [
    'migrate',
    'migrate failed for db_error_params_test',
    '|| { echo "::error::migrate failed for $db"; failed=1; echo "::endgroup::"; continue; }',
    '|| :',
  ],
];

function checkGatedGuard(out, mode, annotation) {
  assert.equal(out.status, 1, out.output);
  assert.ok(
    out.output.includes(
      `::error::${mode === 'create' || mode === 'migrate' ? '' : 'test/logger-db-error-params.test.ts '}${annotation}`,
    ),
    out.output,
  );
  const skipsRow = mode === 'create' || mode === 'migrate';
  assert.equal(out.calls.trim().split('\n').length, gatedRows(gatedStep()) - Number(skipsRow));
  if (skipsRow) assert.doesNotMatch(out.calls, /test\/logger-db-error-params\.test\.ts/);
}

describe('the gated row guards', () => {
  for (const [mode, annotation, before, after] of GATED_GUARD_CASES) {
    it(`counts ${mode} as a failure, annotates it and runs later rows`, (t) => {
      checkGatedGuard(runGated(t, mode), mode, annotation);
    });
    it(`rejects a disabled ${mode} guard`, (t) => {
      const script = gatedStep().run.replace(before, after);
      assert.notEqual(script, gatedStep().run, 'the mutant must disable its guard');
      assert.throws(
        () => checkGatedGuard(runGated(t, mode, script), mode, annotation),
        assert.AssertionError,
      );
    });
  }
  it('rejects a report failure that exits before the later rows', (t) => {
    const script = gatedStep().run.replace("' || failed=1", "'");
    assert.notEqual(script, gatedStep().run, 'the mutant must remove report failure accumulation');
    assert.throws(
      () => checkGatedGuard(runGated(t, 'pending', script), 'pending', 'did not run in full'),
      assert.AssertionError,
    );
  });
});

function checkRedisIsolation(job) {
  const index = job.steps.findIndex((step) => gatedRows(step) !== null);
  assert.ok(index >= 0, 'no gated step');
  const databases = (steps) =>
    steps.flatMap((step) =>
      Object.values(step.env ?? {})
        .filter((url) => url.startsWith('redis://'))
        .map((url) => new URL(url).pathname || '/0'),
    );
  const gated = databases([job.steps[index]]);
  const later = databases(job.steps.slice(index + 1));
  assert.ok(gated.length > 0 && later.length > 0, 'both sets must contain Redis databases');
  assert.deepEqual(
    later.filter((db) => gated.includes(db)),
    [],
    'later steps share a gated Redis database',
  );
}

describe('gated Redis isolation', () => {
  const job = workflows['ci.yml'].jobs.smokes;
  it('keeps later steps out of every gated Redis database', () => checkRedisIsolation(job));
  it('rejects a later step reusing a gated Redis database', () => {
    const mutant = structuredClone(job);
    const gated = mutant.steps.findIndex((step) => gatedRows(step) !== null);
    const later = mutant.steps.slice(gated + 1).find((step) => step.env);
    later.env = {
      TEST_REDIS_URL: Object.values(mutant.steps[gated].env).find((url) =>
        url.startsWith('redis://'),
      ),
    };
    assert.throws(() => checkRedisIsolation(mutant), assert.AssertionError);
  });
});

function checkReleaseLimits(workflow) {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.match(job['timeout-minutes'] ?? '', WHOLE_MINUTES, `${id} has no job limit`);
  }
  for (const [id, minutes] of Object.entries({ build: '40', merge: '10', release: '15' })) {
    assert.equal(
      workflow.jobs[id]?.['timeout-minutes'],
      minutes,
      `${id} keeps its measured budget`,
    );
  }
}

describe('release job limits', () => {
  const release = workflows['release.yml'];
  it('bounds every job holding the release concurrency group', () => checkReleaseLimits(release));
  for (const id of ['build', 'merge', 'release']) {
    it(`rejects an unbounded ${id} job`, () => {
      const mutant = structuredClone(release);
      delete mutant.jobs[id]['timeout-minutes'];
      assert.throws(() => checkReleaseLimits(mutant), assert.AssertionError);
    });
  }
  it('rejects a newly added job with no limit', () => {
    const mutant = structuredClone(release);
    mutant.jobs.new = { 'runs-on': 'ubuntu-latest', steps: [] };
    assert.throws(() => checkReleaseLimits(mutant), assert.AssertionError);
  });
});
