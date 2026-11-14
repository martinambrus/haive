import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { makeTree } from './tree.mjs';

test('module lock refreshes the tracked public lock in an isolated public workspace', (t) => {
  const tree = makeTree(t);
  writeFileSync(
    join(dirname(tree.root), 'bin/pnpm'),
    '#!/bin/sh\n[ ! -d external-modules ] || exit 3\nprintf "refreshed public lock\\n" > pnpm-lock.yaml\n',
  );
  const result = tree.run('module.mjs', ['lock']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(tree.read('pnpm-lock.yaml'), 'refreshed public lock\n');
  assert.notEqual(tree.run('module.mjs', ['lock', 'unexpected']).status, 0);
});

test('failed public lock resolution leaves the tracked lock untouched', (t) => {
  const tree = makeTree(t);
  const before = tree.read('pnpm-lock.yaml');
  const result = tree.run('module.mjs', ['lock'], { STUB_PNPM_EXIT: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /public lock.*failed/);
  assert.equal(tree.read('pnpm-lock.yaml'), before);
});

test('module lock resolves without local clones, cleans scratch, then refreshes the local lock', (t) => {
  const tree = makeTree(t);
  mkdirSync(join(tree.root, 'external-modules/privateone'));
  const result = tree.run('module.mjs', ['lock']);
  assert.equal(result.status, 0, result.stderr);
  const calls = tree.pnpmCalls();
  assert.equal(calls.length, 2);
  const scratch = calls[0].slice(0, -' install --lockfile-only'.length);
  assert.notEqual(scratch, tree.root);
  assert.equal(existsSync(scratch), false);
  assert.equal(calls[1], `${tree.root} install --lockfile-only`);
});
