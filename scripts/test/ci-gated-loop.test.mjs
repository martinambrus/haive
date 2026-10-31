import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readWorkflow } from './workflow.mjs';

const listPattern = /<<'GATED'\n([\s\S]+?)\nGATED(?:\n|$)/;
const gatedStep = readWorkflow('ci.yml').jobs.smokes.steps.find((step) =>
  listPattern.test(step.run ?? ''),
);
assert.ok(gatedStep, 'ci.yml must contain a step with a GATED list');
const fullScript = gatedStep.run;
function fixture(script, full = false) {
  const list = listPattern.exec(script)?.[1];
  assert.ok(list, 'gated harness: missing GATED list and target row');
  const rows = list.split('\n').filter(Boolean);
  assert.ok(rows.length >= 3, 'gated harness: needs three GATED rows including a target row');
  const target = rows[0].split(/\s+/);
  assert.equal(target.length, 5, 'gated harness: target row needs pkg, file, var, db and server');
  const [, file, , db] = target;
  assert.ok(file && db, 'gated harness: missing target file or database');
  const selected = [];
  for (const row of rows) {
    const columns = row.split(/\s+/);
    if (
      full ||
      !selected.some((chosen) => {
        const prior = chosen.split(/\s+/);
        return prior[1] === columns[1] || prior[3] === columns[3];
      })
    )
      selected.push(row);
    if (!full && selected.length === 3) break;
  }
  assert.ok(selected.length >= 3, 'gated harness: needs three distinct files and databases');
  return { script: script.replace(list, selected.join('\n')), rows: selected.length, file, db };
}
const small = fixture(fullScript);

function runGated(t, mode, script = small.script) {
  const selected = fixture(script, true);
  const dir = mkdtempSync(join(tmpdir(), 'haive-gated-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = (name, source) =>
    writeFileSync(
      join(dir, name),
      `#!/bin/bash
has_arg() {
  local expected="$1"; shift
  for arg in "$@"; do
    if [[ "$arg" == "$expected" ]]; then return 0; fi
  done
  return 1
}
` + source,
      { mode: 0o755 },
    );
  stub(
    'docker',
    `
if has_arg -tAc "$@"; then
  if [[ "$MODE" == probe ]] && has_arg "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" "$@"; then exit 3; fi
  if [[ "$MODE" == create ]] && has_arg "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" "$@"; then exit 0; fi
  echo 1
fi
if [[ "$MODE" == create ]] && has_arg "CREATE DATABASE $TARGET_DB" "$@"; then exit 4; fi
`,
  );
  stub(
    'pnpm',
    `
if [[ "$MODE" == migrate && "$DATABASE_URL" == */$TARGET_DB ]] && has_arg @haive/database "$@" && has_arg migrate "$@"; then exit 5; fi
if has_arg exec "$@" && has_arg vitest "$@" && has_arg run "$@"; then
  passed=1; pending=0; todo=0
  if has_arg "$TARGET_FILE" "$@"; then
    case "$MODE" in pending) pending=1 ;; todo) todo=1 ;; empty) passed=0 ;; esac
  fi
  echo "$*" >> "$CALLS"
  for arg in "$@"; do
    case "$arg" in --outputFile.json=*)
      printf '{"numPassedTests":%s,"numFailedTests":0,"numPendingTests":%s,"numTodoTests":%s}' "$passed" "$pending" "$todo" > "\${arg#*=}" ;;
    esac
  done
  if [[ "$MODE" == vitest ]] && has_arg "$TARGET_FILE" "$@"; then exit 7; fi
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
      TARGET_DB: selected.db,
      TARGET_FILE: selected.file,
    },
    encoding: 'utf8',
    timeout: 10_000 + selected.rows * 2_000,
  });
  assert.ifError(out.error);
  return {
    ...out,
    selected,
    calls: existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '',
    output: out.stdout + out.stderr,
  };
}

function checkGatedPass(out) {
  assert.equal(out.status, 0, out.output);
  assert.doesNotMatch(out.output, /::error::/);
  assert.equal(out.calls.trim().split('\n').length, out.selected.rows);
}

function checkGatedFailure(out) {
  assert.equal(out.status, 1, out.output);
  assert.ok(out.output.includes(`::error::${out.selected.file} failed`), out.output);
  assert.equal(out.calls.trim().split('\n').length, out.selected.rows);
}

describe('the gated loop verdict', () => {
  it('passes without error annotations when every row passes', (t) => {
    checkGatedPass(runGated(t, 'pass', fullScript));
  });
  it('fails and annotates a failing vitest call while running all later rows', (t) => {
    checkGatedFailure(runGated(t, 'vitest'));
  });
  it('rejects a deleted verdict', (t) => {
    const script = small.script.replace(/^exit "\$failed"$/m, '');
    assert.notEqual(script, small.script, 'the mutant must remove the verdict');
    assert.throws(() => checkGatedFailure(runGated(t, 'vitest', script)), assert.AssertionError);
  });
  it('rejects an unconditional failure verdict', (t) => {
    const script = small.script.replace(/^exit "\$failed"$/m, 'exit 1');
    assert.notEqual(script, small.script, 'the mutant must replace the verdict');
    assert.throws(() => checkGatedPass(runGated(t, 'pass', script)), assert.AssertionError);
  });
});

describe('the gated database probe', () => {
  it('annotates a failed probe, counts the row failed and runs all later rows', (t) => {
    const out = runGated(t, 'probe');
    assert.equal(out.status, 1, out.output);
    assert.ok(
      out.output.includes(
        `::error::database probe failed for ${out.selected.file} (${out.selected.db})`,
      ),
      out.output,
    );
    assert.equal(out.calls.trim().split('\n').length, out.selected.rows - 1);
    assert.ok(!out.calls.includes(out.selected.file), out.calls);
  });
});

const GATED_GUARD_CASES = [
  ['pending', 'did not run in full', 'r.numPendingTests > 0', 'false'],
  ['todo', 'did not run in full', 'r.numTodoTests > 0', 'false'],
  ['empty', 'did not run in full', '!(r.numPassedTests > 0)', 'false'],
  [
    'create',
    `could not create ${small.db}`,
    '|| { echo "::error::could not create $db"; failed=1; echo "::endgroup::"; continue; }',
    '|| :',
  ],
  [
    'migrate',
    `migrate failed for ${small.db}`,
    '|| { echo "::error::migrate failed for $db"; failed=1; echo "::endgroup::"; continue; }',
    '|| :',
  ],
];

function checkGatedGuard(out, mode, annotation) {
  assert.equal(out.status, 1, out.output);
  assert.ok(
    out.output.includes(
      `::error::${mode === 'create' || mode === 'migrate' ? '' : `${out.selected.file} `}${annotation}`,
    ),
    out.output,
  );
  const skipsRow = mode === 'create' || mode === 'migrate';
  assert.equal(out.calls.trim().split('\n').length, out.selected.rows - Number(skipsRow));
  if (skipsRow) assert.ok(!out.calls.includes(out.selected.file), out.calls);
}

describe('the gated row guards', () => {
  for (const [mode, annotation, before, after] of GATED_GUARD_CASES) {
    it(`counts ${mode} as a failure, annotates it and runs later rows`, (t) => {
      checkGatedGuard(runGated(t, mode), mode, annotation);
    });
    it(`rejects a disabled ${mode} guard`, (t) => {
      const script = small.script.replace(before, after);
      assert.notEqual(script, small.script, 'the mutant must disable its guard');
      assert.throws(
        () => checkGatedGuard(runGated(t, mode, script), mode, annotation),
        assert.AssertionError,
      );
    });
  }
  it('rejects a report failure that exits before the later rows', (t) => {
    const script = small.script.replace("' || failed=1", "'");
    assert.notEqual(script, small.script, 'the mutant must remove report failure accumulation');
    assert.throws(
      () => checkGatedGuard(runGated(t, 'pending', script), 'pending', 'did not run in full'),
      assert.AssertionError,
    );
  });
});

describe('gated harness fixtures', () => {
  it('uses three parsed rows and derives its target after a rename', (t) => {
    assert.equal(small.rows, 3);
    const renamed = small.script
      .replaceAll(small.file, 'test/renamed-target.test.ts')
      .replaceAll(small.db, 'renamed_target_db');
    const out = runGated(t, 'vitest', renamed);
    assert.equal(out.selected.file, 'test/renamed-target.test.ts');
    assert.equal(out.selected.db, 'renamed_target_db');
    checkGatedFailure(out);
  });
  it('explains a missing target row', () => {
    assert.throws(() => fixture('echo no-list'), /missing GATED list and target row/);
    assert.throws(() => fixture("done <<'GATED'\nGATED\n"), /missing GATED list and target row/);
    assert.throws(() => fixture("done <<'GATED'\none\ntwo\nthree\nGATED\n"), /target row needs/);
  });
});

describe('independent gated harness targets (item 9)', () => {
  it('selects three distinct files and databases when the first rows share either', (t) => {
    const list = listPattern.exec(fullScript)[1];
    const [first] = list.split('\n');
    const sameDatabase = first.replace(small.file, small.file + '.another');
    const sameFile = first.replace(small.db, small.db + '_another');
    const selected = fixture(
      fullScript.replace(list, [first, sameDatabase, sameFile, list].join('\n')),
    );
    const rows = listPattern
      .exec(selected.script)[1]
      .split('\n')
      .map((row) => row.split(/\s+/));
    assert.equal(new Set(rows.map((row) => row[1])).size, 3);
    assert.equal(new Set(rows.map((row) => row[3])).size, 3);
    const out = runGated(t, 'probe', selected.script);
    assert.equal(out.status, 1, out.output);
    assert.equal(out.calls.trim().split('\n').length, 2, out.output);
  });
  for (const mode of ['probe', 'create', 'migrate', 'vitest', 'pending', 'todo', 'empty']) {
    it(`matches exact target arguments in ${mode} mode`, (t) => {
      const rows = listPattern.exec(small.script)[1].split('\n');
      const columns = rows[1].split(/\s+/);
      columns[1] = small.file + '.suffix';
      columns[3] = small.db + '_suffix';
      rows[1] = columns.join(' ');
      const script = small.script.replace(listPattern.exec(small.script)[1], rows.join('\n'));
      const out = runGated(t, mode, script);
      assert.equal(out.status, 1, out.output);
      assert.equal((out.output.match(/::error::/g) ?? []).length, 1, out.output);
      assert.equal(
        out.calls.trim().split('\n').length,
        mode === 'probe' || mode === 'create' || mode === 'migrate' ? 2 : 3,
        out.output,
      );
    });
  }
});
