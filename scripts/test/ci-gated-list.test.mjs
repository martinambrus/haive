import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readWorkflow } from './workflow.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Follow the value the guard reads, rather than guessing from SQL or suite wording.
function gatedEnvironment(source) {
  const ast = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const values = new Map();
  const guards = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      values.set(node.name.text, node.initializer);
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
    if (ts.isIdentifier(node)) trace(values.get(node.text));
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
  'packages/api/test/auth-throttle.test.ts': 'smokes runs the auth throttle Redis check.',
  'packages/shared/test/rag-sync-lock.test.ts': 'smokes runs the RAG sync lock Redis check.',
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
    'Docker opt-in control requires a built worker image; it is outside the store-backed list.',
};

const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const rows = /<<'GATED'\n([\s\S]+?)\n[ \t]*GATED\n/.exec(ci)?.[1];
assert.ok(rows, "ci.yml has no <<'GATED' list");
const listedFiles = rows
  .split('\n')
  .map((row) => row.trim().split(/\s+/))
  .map(([pkg, file]) => `packages/${pkg}/${file}`)
  .sort();

describe('environment guard discovery', () => {
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
      (file) => file !== 'packages/worker/test/module-source-pin.test.ts',
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
  });
});
