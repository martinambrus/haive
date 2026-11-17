import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readWorkflow } from './workflow.mjs';

const root = new URL('../../', import.meta.url).pathname;

test('module CI uses the real dev installer and refuses dirty, invalid and unsupported runs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'haive-module-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, 'haive');
  const run = (cmd, args, options = {}) =>
    spawnSync(cmd, args, { cwd: checkout, encoding: 'utf8', ...options });
  const clone = spawnSync('git', ['clone', '--quiet', '--local', '--shared', root, checkout], {
    encoding: 'utf8',
  });
  assert.equal(clone.status, 0, clone.stderr);
  // Overlay the script under test so this also works before the implementation commit.
  copyFileSync(join(root, 'scripts/module-ci.sh'), join(checkout, 'scripts/module-ci.sh'));
  assert.equal(run('git', ['add', 'scripts/module-ci.sh']).status, 0);
  const commit = (message) => {
    const result = run('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=CI control',
      '-c',
      'user.email=ci@example.test',
      'commit',
      '--quiet',
      '-m',
      message,
    ]);
    assert.equal(result.status, 0, result.stderr);
  };
  if (run('git', ['diff', '--cached', '--quiet']).status !== 0) commit('Fixture script');
  const sha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.jsonl');
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env node
const {appendFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args)+'\\n');
if (args[0] === 'install') process.exit(0);
const command = args[0] === 'module'
  ? [process.execPath, ['scripts/module.mjs', ...args.slice(1)], process.cwd()]
  : [process.execPath, [args.at(-1)+'.cjs'], process.cwd()+'/external-modules/ci-stub'];
const result = spawnSync(command[0], command[1], {cwd:command[2], stdio:'inherit'});
process.exit(result.status ?? 1);
`,
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log };
  const invoke = (id = 'ci-stub', ref = sha, extra = {}) =>
    run('bash', ['scripts/module-ci.sh', id, ref], { env: { ...env, ...extra } });
  const put = (path, value) => writeFileSync(join(checkout, path), value);
  mkdirSync(join(checkout, 'modules/ci-stub'));
  put(
    'modules/ci-stub/package.json',
    JSON.stringify({
      name: '@haive-module/ci-stub',
      version: '0.0.0',
      exports: { './manifest': './dist/manifest.js' },
      scripts: { build: 'node build.cjs', typecheck: 'node typecheck.cjs', test: 'node test.cjs' },
    }),
  );
  put(
    'modules/ci-stub/build.cjs',
    "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/manifest.js','export default {};');",
  );
  put(
    'modules/ci-stub/typecheck.cjs',
    "require('node:assert/strict').ok(require('node:fs').existsSync('dist/manifest.js'));",
  );
  put(
    'modules/ci-stub/test.cjs',
    "require('node:assert/strict').ok(require('node:fs').existsSync('dist/manifest.js')); if(process.env.DIRTY) require('node:fs').appendFileSync('../../package.json','\\n'); if(process.env.FAIL_TEST) process.exit(7);",
  );
  const green = invoke();
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /haive tree is clean/);
  assert.equal(run('git', ['status', '--porcelain']).stdout, '');
  assert.match(
    readFileSync(join(checkout, 'packages/api/src/modules.generated.ts'), 'utf8'),
    /@haive-module\/ci-stub/,
  );
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['module', 'add', 'ci-stub']);
  assert.ok(calls.some((args) => args[0] === 'install' && args.includes('--frozen-lockfile')));
  assert.deepEqual(
    calls.slice(-3).map((args) => args.at(-1)),
    ['build', 'typecheck', 'test'],
  );
  const dirty = invoke(undefined, undefined, { DIRTY: '1' });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /haive tree is dirty/);
  assert.equal(run('git', ['restore', 'package.json']).status, 0);
  assert.notEqual(invoke(undefined, undefined, { FAIL_TEST: '1' }).status, 0);
  for (const id of ['../escape', '/absolute', 'Bad', '-start', 'a_b', 'a'.repeat(24), 'a\n']) {
    const invalid = invoke(id);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid module-id/);
  }
  assert.notEqual(invoke('ci-stub', 'main').status, 0);
  assert.equal(run('git', ['tag', 'ci-control']).status, 0);
  assert.equal(
    run('bash', ['scripts/module-ci.sh', 'ci-stub', 'ci-control', '--check'], { env }).status,
    0,
  );
  // A Git error must not masquerade as an empty, clean status.
  const git = run('sh', ['-c', 'command -v git']).stdout.trim();
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = status ]; then exit 1; fi\nexec "${git}" "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  const unreadable = invoke();
  assert.notEqual(unreadable.status, 0);
  assert.match(unreadable.stderr, /could not inspect haive tree/);
  rmSync(join(bin, 'git'));
  // Structural old-ref regression: the ignored external tree is required by #1179.
  put('.gitignore', 'node_modules/\ndist/\n');
  assert.equal(run('git', ['add', '.gitignore']).status, 0);
  commit('Fixture without external dev-install feature');
  const old = invoke('ci-stub', run('git', ['rev-parse', 'HEAD']).stdout.trim());
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /haive-ref lacks the external-module dev install/);
});

test('module CI workflow checks caller source without persisted credentials and pins actions', () => {
  const ci = readWorkflow('module-ci.yml');
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const inputs = ci.on.workflow_call.inputs;
  assert.equal(inputs['module-id'].required, 'true');
  assert.equal(inputs['haive-ref'].required, 'true');
  assert.equal(inputs['haive-ref'].default, undefined);
  const steps = ci.jobs.check.steps;
  const actions = steps.filter((step) => step.uses);
  for (const action of actions) assert.match(action.uses, /@[a-f0-9]{40}$/);
  const caller = actions.find((step) => step.with?.repository === '${{ github.repository }}');
  assert.equal(caller.with.token, '${{ github.token }}');
  assert.equal(caller.with['persist-credentials'], 'false');
  assert.equal(caller.with.path, 'haive/modules/${{ inputs.module-id }}');
  assert.ok(steps.findIndex((step) => step.run?.includes('--check')) < steps.indexOf(caller));
});

test('shell module-id rule equals the shared contract', () => {
  const moduleIds = readFileSync(join(root, 'packages/shared/src/modularity/module-id.ts'), 'utf8');
  const max = Number(/MODULE_ID_MAX_LENGTH = (\d+);/.exec(moduleIds)?.[1]);
  const source = /MODULE_ID_PATTERN_SOURCE = `([^`]+)`/.exec(moduleIds)?.[1];
  const pattern = source.replace('${MODULE_ID_MAX_LENGTH - 1}', String(max - 1));
  const shell = readFileSync(join(root, 'scripts/module-ci.sh'), 'utf8');
  assert.equal(/\[\[ \$module_id =~ (\S+) \]\]/.exec(shell)?.[1], `^${pattern}$`);
});
