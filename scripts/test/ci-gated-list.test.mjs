import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readWorkflow } from './workflow.mjs';
import { readGated } from '../lib/ci-gated.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Follow the value the guard reads, rather than guessing from SQL or suite wording.
function gatedEnvironment(source) {
  const ast = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const values = new Map();
  const guards = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      // Every declaration of a name, so a shadowing one inside a test cannot hide the guard's.
      values.set(node.name.text, [...(values.get(node.name.text) ?? []), node.initializer]);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['skipIf', 'runIf'].includes(node.expression.name.text)
    ) {
      let receiver = node.expression.expression;
      while (ts.isPropertyAccessExpression(receiver)) receiver = receiver.expression;
      if (ts.isIdentifier(receiver) && ['describe', 'it', 'test'].includes(receiver.text))
        guards.push(...node.arguments);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const env = new Set();
  const seen = new Set();
  const trace = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      node.expression.name.text === 'env'
    ) {
      const name = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) env.add(name.text);
    }
    if (ts.isIdentifier(node)) (values.get(node.text) ?? []).forEach(trace);
    ts.forEachChild(node, trace);
  };
  guards.forEach(trace);
  return [...env].sort();
}

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.next', '.turbo'].includes(entry.name)) return [];
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(file);
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

const gatedFiles = testFiles(join(root, 'packages'))
  .filter((file) => gatedEnvironment(readFileSync(file, 'utf8')).length > 0)
  .map((file) => file.slice(root.length))
  .sort();

// These files already run with their guard's URL in independent CI steps.
const exemptions = {
  'packages/worker/test/exec-core-boundary-mounts.test.ts':
    'compose-boot runs the snapshot mount control inside the worker image after a bounded sandbox image wait.',
  'packages/api/test/auth-throttle.test.ts': 'smokes runs the auth throttle Redis check.',
  'packages/shared/test/rag-sync-lock.test.ts': 'smokes runs the RAG sync lock Redis check.',
  'packages/shared/test/encryption-key-boot-redis.test.ts':
    'smokes runs the boot encryption key Redis check.',
  'packages/shared/test/private-endpoint-seed-store.test.ts':
    'smokes runs the private endpoint seed Redis check.',
  'packages/worker/test/advance-dedup-redis.test.ts':
    'smokes runs the recovery re-drive Redis check.',
  'packages/worker/test/cli-job-retention.test.ts': 'smokes runs the CLI retention Redis check.',
  'packages/worker/test/module-activation-watch.test.ts':
    'smokes runs the module activation Redis check.',
  'packages/worker/test/refresh-rebuild-retries.test.ts':
    'smokes runs the repository refresh Redis check.',
  'packages/worker/src/queues/cli-exec/agent-lease.test.ts':
    'smokes runs the agent pool Redis check.',
  'packages/worker/test/module-source-pin.test.ts':
    'smokes runs it inside the built worker image with its Docker opt-in set.',
};

const gated = readGated();
const listedFiles = gated.rows.map(({ pkg, file }) => `packages/${pkg}/${file}`).sort();

// Inspect literals and URL pathname predicates without executing repository test code.
function rowRequirements(source, variable, db) {
  const ast = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(ast);
  const unwrap = (node) => {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node)
    )
      node = node.expression;
    return node;
  };
  const readsVariable = (node, seen = new Set()) => {
    node = unwrap(node);
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node) && declarations.has(node.text))
      return readsVariable(declarations.get(node.text), seen);
    if (node.getText(ast) === `process.env.${variable}`) return true;
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'URL')
      return (node.arguments ?? []).some((child) => readsVariable(child, seen));
    if (ts.isBinaryExpression(node))
      return readsVariable(node.left, seen) || readsVariable(node.right, seen);
    if (ts.isConditionalExpression(node))
      return readsVariable(node.whenTrue, seen) || readsVariable(node.whenFalse, seen);
    return false;
  };
  const pathname = (node, seen = new Set()) => {
    node = unwrap(node);
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isIdentifier(node) && declarations.has(node.text))
      return pathname(declarations.get(node.text), seen);
    if (ts.isConditionalExpression(node)) return pathname(node.whenTrue, seen);
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'pathname' &&
      readsVariable(node.expression)
    )
      return `/${db}`;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'slice' &&
      node.arguments.length === 1 &&
      ts.isNumericLiteral(node.arguments[0])
    ) {
      return pathname(node.expression.expression, seen)?.slice(Number(node.arguments[0].text));
    }
    return undefined;
  };
  const rules = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = unwrap(node.expression.expression);
      const method = node.expression.name.text;
      const [argument] = node.arguments;
      const path = pathname(receiver);
      if (
        path !== undefined &&
        ['startsWith', 'endsWith'].includes(method) &&
        argument &&
        ts.isStringLiteral(argument)
      )
        rules.push({ rule: node.getText(ast), ok: path[method](argument.text) });
      if (
        method === 'some' &&
        ts.isArrayLiteralExpression(receiver) &&
        receiver.elements.every(ts.isStringLiteral) &&
        argument &&
        ts.isArrowFunction(argument)
      ) {
        const body = unwrap(argument.body);
        if (
          ts.isCallExpression(body) &&
          ts.isPropertyAccessExpression(body.expression) &&
          body.expression.name.text === 'startsWith' &&
          body.arguments[0]?.getText(ast) === argument.parameters[0]?.name.getText(ast)
        ) {
          const value = pathname(body.expression.expression);
          if (value !== undefined)
            rules.push({
              rule: node.getText(ast),
              ok: receiver.elements.some((prefix) => value.startsWith(prefix.text)),
            });
        }
      }
      if (method === 'test' && ts.isRegularExpressionLiteral(receiver) && argument) {
        const value = pathname(argument);
        const match = /^\/(.*)\/([a-z]*)$/.exec(receiver.text);
        if (value !== undefined && match)
          rules.push({ rule: node.getText(ast), ok: new RegExp(match[1], match[2]).test(value) });
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind,
      )
    ) {
      for (const [left, right] of [
        [node.left, node.right],
        [node.right, node.left],
      ]) {
        const value = pathname(left);
        if (value !== undefined && ts.isStringLiteral(right))
          rules.push({ rule: node.getText(ast), ok: value === right.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return rules;
}

// These tests accept any admin database and create their own randomly named tables/stores.
// No source predicate constrains the CI connection database; still require a safe SQL identifier.
const unrestrictedDatabases = {
  'database/test/pg-transaction-fence.test.ts': 'creates randomly named tx_fence tables',
  'shared/test/create-database-race.test.ts': 'creates stores under a random install id',
  'shared/test/global-kb-identifier-tsv.test.ts': 'creates SCRATCH_DB from pid and time',
  'shared/test/global-kb-ensure-bound.test.ts': 'creates SCRATCH_DB from pid and time',
  'worker/test/rag-schema.test.ts': 'creates SCRATCH_DB from pid and time',
};

function checkRow(row) {
  const path = `packages/${row.pkg}/${row.file}`;
  assert.ok(gatedFiles.includes(path), `no environment-gated test file: ${path}`);
  const manifest = JSON.parse(
    readFileSync(join(root, 'packages', row.pkg, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, `@haive/${row.pkg}`, `${path}: package column`);
  const source = readFileSync(join(root, path), 'utf8');
  const env = gatedEnvironment(source);
  assert.ok(env.includes(row.var), `${path}: ${row.var} is not a guard environment variable`);
  for (const name of env.filter((name) => name !== row.var))
    assert.ok(gated.stepEnv[name], `${path}: missing additional guard environment ${name}`);
  assert.match(row.db, /^[a-z_][a-z0-9_]*$/, `${path}: unsafe database column`);
  const rules = rowRequirements(source, row.var, row.db);
  assert.ok(
    rules.length || unrestrictedDatabases[`${row.pkg}/${row.file}`],
    `${path}: no database predicate found; add a source-derived rule or reasoned exemption`,
  );
  for (const { rule, ok } of rules)
    assert.ok(ok, `${path}: database ${row.db} violates source predicate ${rule}`);
  // HAIVE_GKB's real-store suites require vector; T266 refuses the app's 5432 port.
  // Validate that routing decision against the test's source, then the declared service image.
  const alternatePort = /\[.*'5432'.*\]\.includes\(new URL\(url\)\.port\)/.test(source);
  const server = env.includes('HAIVE_GKB_TEST_DB_URL') || alternatePort ? 'pgvector' : 'pg';
  assert.equal(row.server, server, `${path}: image column disagrees with source requirements`);
  assert.equal(
    gated.services[server === 'pg' ? 'postgres' : server].image,
    server === 'pg' ? 'postgres:18-alpine' : 'pgvector/pgvector:pg18',
  );
}

// Each column is changed independently on a copy of a row that passes.
describe('all GATED row columns', () => {
  const row = gated.rows[0];
  it('matches every row against its test source', () => gated.rows.forEach(checkRow));
  it('honours the T266 prefix allowlist as well as its database regex', () => {
    const original = gated.rows.find(({ var: name }) => name === 'T266_DATABASE_URL');
    assert.ok(original);
    assert.throws(
      () => checkRow({ ...original, db: 'other_t266_ci' }),
      /violates source predicate/,
    );
  });

  it('rejects wrong env and image columns for every source, and wrong guarded databases', () => {
    for (const original of gated.rows) {
      for (const changed of [
        { ...original, var: 'WRONG_TEST_URL' },
        { ...original, server: original.server === 'pg' ? 'pgvector' : 'pg' },
        { ...original, db: 'unsafe-database' },
        ...(!unrestrictedDatabases[`${original.pkg}/${original.file}`]
          ? [{ ...original, db: 'wrong_database' }]
          : []),
      ])
        assert.throws(() => checkRow(changed), assert.AssertionError);
    }
  });

  for (const [column, value] of [
    ['pkg', 'missing-package'],
    ['file', 'test/missing.test.ts'],
    ['var', 'WRONG_TEST_URL'],
    ['db', 'wrong_database'],
    ['server', row.server === 'pg' ? 'pgvector' : 'pg'],
  ]) {
    it(`rejects an incorrect ${column} column`, () => {
      checkRow(row);
      assert.throws(() => checkRow({ ...row, [column]: value }), assert.AssertionError);
    });
  }
});

describe('environment guard discovery', () => {
  it('keeps the guard env when a test shadows its variable', () => {
    assert.deepEqual(
      gatedEnvironment(`
        const url = process.env.PG_URL;
        describe.skipIf(!url)('suite', () => {
          it('case', () => { const url = 'fixture'; });
        });
      `),
      ['PG_URL'],
    );
  });

  it('follows aliases, combined guards and direct env reads under test or src', () => {
    assert.deepEqual(
      gatedEnvironment(`
        const url = process.env.PG_URL;
        const alias = url;
        const redis = process.env['CACHE_URL'];
        describe.skipIf(!alias || !redis)('store', () => {});
        it.runIf(process.env.LOCAL_STORE)('direct', () => {});
      `),
      ['CACHE_URL', 'LOCAL_STORE', 'PG_URL'],
    );
  });
  it('ignores unrelated env reads and uid or tool gates', () => {
    assert.deepEqual(
      gatedEnvironment(`
        const url = process.env.UNRELATED_URL;
        describe.runIf(process.getuid?.() === 0)('root', () => {});
        it.skipIf(!have('unzip'))('tool', () => {});
      `),
      [],
    );
  });
});

describe('the environment-gated list in ci.yml', () => {
  it('lists every file exactly once', () => {
    assert.equal(new Set(listedFiles).size, listedFiles.length, 'duplicate GATED test row');
  });

  // The tests around this one each check a part of it; compared whole, a failure shows every difference.
  it('is exactly the gated test files that are not exempt', () => {
    assert.deepEqual(
      listedFiles,
      gatedFiles.filter((file) => !Object.hasOwn(exemptions, file)),
    );
  });

  it('has a row or an explicit exemption for every gated test file', () => {
    assert.deepEqual(
      gatedFiles.filter((file) => !listedFiles.includes(file) && !Object.hasOwn(exemptions, file)),
      [],
      'environment-gated test files with no GATED row or explicit exemption',
    );
  });

  it('has no stale rows or exemptions', () => {
    for (const file of [...listedFiles, ...Object.keys(exemptions)])
      assert.ok(gatedFiles.includes(file), `no environment-gated test file: ${file}`);
    for (const [file, reason] of Object.entries(exemptions)) {
      assert.ok(reason.trim(), `missing exemption reason: ${file}`);
      assert.ok(!listedFiles.includes(file), `exempt file duplicated in GATED: ${file}`);
    }
  });

  it('runs every exempt Redis file in an existing workflow with its guard environment', () => {
    const steps = readdirSync(join(root, '.github', 'workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .flatMap((name) => Object.values(readWorkflow(name).jobs))
      .flatMap((job) =>
        (job.steps ?? []).map((step) => ({ ...step, env: { ...job.env, ...step.env } })),
      );
    for (const file of Object.keys(exemptions).filter(
      (file) =>
        ![
          'packages/worker/test/module-source-pin.test.ts',
          'packages/worker/test/exec-core-boundary-mounts.test.ts',
        ].includes(file),
    )) {
      const [, pkg, ...rel] = file.split('/');
      const env = gatedEnvironment(readFileSync(join(root, file), 'utf8'));
      assert.ok(
        steps.some(
          (step) =>
            step.run?.includes(`--filter @haive/${pkg} exec vitest run ${rel.join('/')}`) &&
            env.every((name) => step.env?.[name]),
        ),
        `exempt file has no workflow invocation with its guard environment: ${file}`,
      );
    }
    // The Docker control runs through `docker run <image> ... vitest run`, not the pnpm filter.
    const pin = 'packages/worker/test/module-source-pin.test.ts';
    const pinEnv = gatedEnvironment(readFileSync(join(root, pin), 'utf8'));
    assert.ok(
      steps.some(
        (step) =>
          step.run?.includes('vitest run --root . test/module-source-pin.test.ts') &&
          // The test's guard demands exactly 'true'.
          pinEnv.every((name) => step.run.includes(`-e ${name}=true`)),
      ),
      `exempt file has no workflow invocation with its guard environment: ${pin}`,
    );
  });
});

it('runs the snapshot control in compose-boot with worker tooling, shared bind paths and an image wait', () => {
  const job = readWorkflow('ci.yml').jobs['compose-boot'];
  const step = job.steps.find((s) => s.name === 'Committed snapshot read-only mounts');
  assert.ok(step.run.includes('docker image inspect haive-cli-sandbox:latest'));
  assert.ok(step.run.includes('--volumes-from haive-worker'));
  assert.ok(step.run.includes('-e SNAPSHOT_SANDBOX_TEST_IMAGE=haive-cli-sandbox:latest'));
  assert.ok(step.run.includes('vitest run --root . test/exec-core-boundary-mounts.test.ts'));
  assert.ok(!step.run.includes('pnpm --filter'));
});
