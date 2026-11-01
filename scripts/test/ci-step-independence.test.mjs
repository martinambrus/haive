import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readWorkflow } from './workflow.mjs';
import { shellSource, swallowedFailure } from './shell-source.mjs';

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

const workflows = Object.fromEntries(
  [...new Set([...JOBS.map(({ file }) => file), 'release.yml'])].map((file) => [
    file,
    readWorkflow(file),
  ]),
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

// GitHub's named bash shell enables errexit; an explicit template must keep -e.
function checkShell(shell, scope) {
  assert.ok(
    shell === undefined ||
      [
        'bash',
        'bash -e {0}',
        'bash -eo pipefail {0}',
        'bash --noprofile --norc -eo pipefail {0}',
      ].includes(shell),
    `${scope} shell ${JSON.stringify(shell)} does not preserve the pinned bash errexit contract`,
  );
}

function checkJob(job, spec, workflow = workflows[spec.file]) {
  checkShell(workflow.defaults?.run?.shell, 'workflow');
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
  checkShell(job.defaults?.run?.shell, 'job');
  for (const step of steps) {
    checkShell(step.shell, label(step));
    const matched = swallowedFailure(step.run ?? '', { step: label(step) });
    assert.equal(
      matched,
      null,
      `${label(step)} swallows a command failure with ${JSON.stringify(matched)}`,
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
    assert.match(job['timeout-minutes'] ?? '', WHOLE_MINUTES, 'the job needs a whole-minute limit');
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
      assert.ok(
        Number(step['timeout-minutes']) < Number(job['timeout-minutes']),
        `${label(step)} needs a step limit below the job limit so a hang cannot consume the whole job`,
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
  ...['deleted', 'expression'].map((kind) => [
    `a whole-minute job limit ${kind}`,
    (job) => {
      if (kind === 'deleted') delete job['timeout-minutes'];
      else job['timeout-minutes'] = '${{ vars.LIMIT }}';
    },
    (spec) => spec.allStepsBounded && !spec.budget,
    /the job needs a whole-minute limit/,
  ]),

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
  ...['setup', 'check'].flatMap((kind) =>
    [0, 1].map((extra) => [
      `a ${kind} step limit ${extra ? 'above' : 'equal to'} its job limit`,
      (job, last) => {
        job.steps[kind === 'setup' ? 0 : last + 1]['timeout-minutes'] = String(
          Number(job['timeout-minutes']) + extra,
        );
      },
      (spec) => spec.allStepsBounded,
    ]),
  ),
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

    for (const [name, mutate, applies, expectedError] of MUTANTS) {
      if (applies && !applies(spec)) continue;
      it(`rejects ${name}`, () => {
        checkJob(job, spec);
        const mutant = structuredClone(job);
        mutate(
          mutant,
          mutant.steps.findIndex((step) => step.id === spec.prerequisite),
          spec,
        );
        assert.throws(() => checkJob(mutant, spec), expectedError ?? assert.AssertionError);
      });
    }
  });
}

function redisDatabases(step) {
  const texts = [
    ...Object.values(step.env ?? {}),
    shellSource(step.run ?? '', { step: label(step) }),
  ];
  return [
    ...new Set(
      texts.flatMap((text) =>
        [...text.matchAll(/rediss?:\/\/[^\s"'`\\;|&)]+/g)].map(([raw]) => {
          const path = new URL(raw).pathname.replace(/^\//, '');
          assert.match(path, /^\d*$/, `Redis database must be a literal number: ${raw}`);
          return String(Number(path || '0'));
        }),
      ),
    ),
  ];
}

function checkRedisIsolation(job) {
  const index = job.steps.findIndex((step) => gatedRows(step) !== null);
  assert.ok(index >= 0, 'no gated step');
  // The job-wide default (database 0 today) is also used by general smokes. Reserve it
  // once, alongside the gated databases; explicit later tests need their own databases.
  const gated = [...redisDatabases({ env: job.env }), ...redisDatabases(job.steps[index])];
  assert.ok(gated.length > 0, 'gated/job env must contain Redis databases');
  const used = new Map(gated.map((db) => [db, 'gated step or job env']));
  let laterCount = 0;
  for (const step of job.steps.slice(index + 1)) {
    const databases = redisDatabases(step);
    laterCount += databases.length;
    for (const db of databases) {
      assert.ok(!used.has(db), `${label(step)} shares Redis database ${db} with ${used.get(db)}`);
      used.set(db, label(step));
    }
  }
  assert.ok(laterCount > 0, 'later steps must contain Redis databases');
}

// Select by the GATED list and Redis env values, independent of display names.
function redisFixture(job) {
  const index = job.steps.findIndex((step) => gatedRows(step) !== null);
  const gated = job.steps[index];
  const later = job.steps
    .slice(index + 1)
    .filter((step) => Object.values(step.env ?? {}).some((url) => /^rediss?:\/\//.test(url)));
  const url = (step) => Object.values(step.env).find((value) => /^rediss?:\/\//.test(value));
  assert.ok(gated && later.length >= 2, 'the fixture needs gated and two later Redis steps');
  return { gated, later, url };
}

const REDIS_MUTANTS = [
  [
    'a later step reusing a gated database',
    (job) => {
      const { gated, later, url } = redisFixture(job);
      later[0].env.TEST_REDIS_URL = url(gated);
    },
  ],
  [
    'two later steps sharing a database',
    (job) => {
      const { later, url } = redisFixture(job);
      later[1].env.TEST_REDIS_URL = url(later[0]);
    },
  ],
  [
    'a later database also reserved in job env',
    (job) => {
      const { later, url } = redisFixture(job);
      job.env.SHARED_TEST_REDIS_URL = url(later[0]);
    },
  ],
  [
    'an inline run URL reusing a gated database',
    (job) => {
      const { gated, later, url } = redisFixture(job);
      later[0].run += `\nexport TEST_REDIS_URL='${url(gated)}'`;
    },
  ],
  [
    'an inline run URL reusing a later database',
    (job) => {
      const { later, url } = redisFixture(job);
      later[1].run += `\nexport TEST_REDIS_URL='${url(later[0])}'`;
    },
  ],
  [
    'a gated inline run URL reused by a later step',
    (job) => {
      const { gated, later, url } = redisFixture(job);
      const shared = url(gated);
      for (const [key, value] of Object.entries(gated.env)) {
        if (value === shared) delete gated.env[key];
      }
      gated.run += `\nexport TEST_REDIS_URL='${shared}'`;
      later[0].env.TEST_REDIS_URL = shared;
    },
  ],
  ...['', '/'].map((path) => [
    `an empty URL path (${JSON.stringify(path)}) reusing database 0`,
    (job) => {
      const { gated, later } = redisFixture(job);
      delete job.env.REDIS_URL;
      gated.env.TEST_REDIS_URL = `redis://localhost:6379${path}`;
      later[0].env.TEST_REDIS_URL = 'redis://localhost:6379/0';
    },
  ]),
];

describe('gated Redis isolation', () => {
  const job = workflows['ci.yml'].jobs.smokes;
  it('keeps later steps out of gated, job-wide and other later databases', () =>
    checkRedisIsolation(job));
  it('accepts distinct databases supplied by job env and inline run URLs', () => {
    const control = structuredClone(job);
    const { gated, later } = redisFixture(control);
    control.env.INTEGRATIONS_AUDIT_TEST_REDIS_URL = gated.env.INTEGRATIONS_AUDIT_TEST_REDIS_URL;
    delete gated.env.INTEGRATIONS_AUDIT_TEST_REDIS_URL;
    later[0].run += "\nexport EXTRA_REDIS_URL='redis://localhost:6379/1'";
    checkRedisIsolation(control);
  });
  it('reads omitted and slash-only paths as database 0', () => {
    for (const path of ['', '/']) {
      assert.deepEqual(redisDatabases({ env: { REDIS_URL: `redis://localhost:6379${path}` } }), [
        '0',
      ]);
      assert.deepEqual(
        redisDatabases({ run: `REDIS_URL="redis://localhost:6379${path}" pnpm test` }),
        ['0'],
      );
    }
  });
  it('ignores Redis URLs in whole-line comments, trailing comments and heredoc bodies', () => {
    const control = structuredClone(job);
    const { gated, later, url } = redisFixture(control);
    const shared = url(gated);
    later[0].run += `\n# was ${shared} before\npnpm test # was ${shared.replace('redis:', 'rediss:')} before\ncat <<'BODY'\n${shared}\nBODY`;
    checkRedisIsolation(control);
  });
  it('reads distinct rediss URLs in env and quoted inline commands', () => {
    assert.deepEqual(
      redisDatabases({
        env: { REDIS_URL: 'rediss://localhost:6379/1' },
        run: "export X='rediss://localhost:6379/2'",
      }),
      ['1', '2'],
    );
    const control = structuredClone(job);
    const { later } = redisFixture(control);
    later[0].run += "\nexport EXTRA_REDIS_URL='rediss://localhost:6379/1'";
    checkRedisIsolation(control);
  });
  for (const location of ['env', 'run']) {
    it(`rejects a rediss collision in ${location}`, () => {
      const mutant = structuredClone(job);
      const { gated, later, url } = redisFixture(mutant);
      const shared = url(gated).replace('redis:', 'rediss:');
      if (location === 'env') later[0].env.TEST_REDIS_URL = shared;
      else later[0].run += `\nexport TEST_REDIS_URL='${shared}'`;
      assert.throws(() => checkRedisIsolation(mutant), /shares Redis database/);
    });
  }
  for (const [name, mutate] of REDIS_MUTANTS) {
    it(`rejects ${name}`, () => {
      checkRedisIsolation(job);
      const mutant = structuredClone(job);
      mutate(mutant);
      assert.throws(() => checkRedisIsolation(mutant), assert.AssertionError);
    });
  }
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

// Exercise the real job rule, including shell data that looks like a success command.
describe('shell failure detection', () => {
  const spec = JOBS.find(({ id }) => id === 'smokes');
  const job = workflows[spec.file].jobs[spec.id];
  const withScript = (script) => {
    const control = structuredClone(job);
    const last = control.steps.findIndex((step) => step.id === spec.prerequisite);
    control.steps[last + 2].run = script;
    return control;
  };
  const accepted = [
    "cat <<'BODY'\nset +e\nBODY",
    "cat <<'BODY'\ntrue-positive.test.ts\nBODY",
    "cat <<-'BODY'\n\tset +e\n\tBODY",
    'cat <<"ONE" <<"TWO"\nset +e\nONE\n|| true\nTWO',
    'echo "ready; true"',
    'case "$v" in\ntrue) echo ready ;;\nesac',
    'if check; then\ntrue\nelse\necho ready\nfi',
    'if check\nthen\ntrue\nelse\necho ready\nfi',
    'node -e "const v = process.env.X || true"',
    'pnpm test # never add || true here',
    '# never add set +e here\npnpm test',
    '[ "$v" = "true" ]',
    "jq -e '.a == true'",
    'x=true',
    'while true; do echo ready; break; done',
    'pnpm test || exit 10',
    'pnpm test && true',
    'trueish',
    'echo x#tag',
    'echo "$(node -e \'const v = process.env.X || true\')"',
    "echo '$(pnpm test || true)'",
    'echo "\\$(pnpm test || true)"',
  ];
  for (const script of accepted) {
    it(`accepts shell data/control: ${JSON.stringify(script)}`, () =>
      checkJob(withScript(script), spec));
  }
  for (const [script, matched] of [
    ['pnpm test || true', '|| true'],
    ['pnpm test || :', '|| :'],
    ['pnpm test || exit 0', '|| exit 0'],
    ['pnpm test; true', 'true'],
    ['(pnpm test; true)', 'true'],
    ['pnpm test; true ignored', 'true'],
    ['echo "$(pnpm test || true)"', '|| true'],
    ['echo "$(echo \'ready)\'; pnpm test || true)"', '|| true'],
    ['echo `pnpm test || true`', '|| true'],
    ['pnpm test\ntrue', 'true'],
    ['set +e\npnpm test', 'set +e'],
    ['pnpm test || \\\n true', '|| true'],
    ['echo "ready"; pnpm test || true # ignore', '|| true'],
    ["cat <<'BODY'\nset +e\nBODY\npnpm test || true", '|| true'],
  ]) {
    it(`rejects shell failure mask: ${JSON.stringify(script)}`, () => {
      assert.throws(
        () => checkJob(withScript(script), spec),
        (error) => {
          assert.ok(error instanceof assert.AssertionError);
          assert.ok(error.message.includes(JSON.stringify(matched)), error.message);
          return true;
        },
      );
    });
  }
});

describe('explicit shell errexit', () => {
  for (const spec of JOBS) {
    for (const scope of ['workflow', 'job', 'step']) {
      for (const shell of [
        'bash',
        'bash -e {0}',
        'bash -eo pipefail {0}',
        'bash --noprofile --norc -eo pipefail {0}',
        'bash -o pipefail {0}',
        'bash --noprofile --norc -o pipefail {0}',
        'sh',
        'python',
        'bash {0}',
        'bash --noprofile {0}',
      ]) {
        const allowed = [
          'bash',
          'bash -e {0}',
          'bash -eo pipefail {0}',
          'bash --noprofile --norc -eo pipefail {0}',
        ].includes(shell);
        it(`${allowed ? 'accepts' : 'rejects'} ${spec.id} ${scope} shell ${shell}`, () => {
          const workflow = structuredClone(workflows[spec.file]);
          const job = workflow.jobs[spec.id];
          if (scope === 'workflow') workflow.defaults = { run: { shell } };
          else if (scope === 'job') job.defaults = { run: { shell } };
          else {
            const last = job.steps.findIndex((step) => step.id === spec.prerequisite);
            job.steps[last + 1].shell = shell;
          }
          if (allowed) checkJob(job, spec, workflow);
          else
            assert.throws(
              () => checkJob(job, spec, workflow),
              (error) => {
                assert.ok(error instanceof assert.AssertionError);
                assert.ok(error.message.includes(JSON.stringify(shell)), error.message);
                return true;
              },
            );
        });
      }
    }
  }
});
