import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  RELEASE_BUNDLE_FILES,
  releaseBundleEnvSchema,
} from '../../packages/shared/src/release/manifest.ts';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

// Deliberately recognise the installers' small assignment grammar, not arbitrary shell/PowerShell.
// Count every call too: a refactor outside that grammar fails visibly rather than losing a key.
function generatedKeys(source, callPattern, callName, envPattern) {
  const calls = [...source.matchAll(callPattern)];
  const callLines = source
    .split('\n')
    .filter(
      (line) =>
        !/^\s*(#|function\s)/.test(line) &&
        !line.trimStart().startsWith(`${callName}()`) &&
        line.includes(callName),
    );
  assert.equal(calls.length, callLines.length, `unparsed ${callName} call; update the extractor`);
  assert.ok(calls.length > 0, `locate ${callName} calls`);
  const keys = new Map();
  for (const [, variable, count] of calls) {
    const assignments = [...source.matchAll(envPattern)].filter(
      (match) => match[2].toLowerCase() === variable.toLowerCase(),
    );
    assert.equal(assignments.length, 1, `one .env assignment for generated variable ${variable}`);
    const key = assignments[0][1];
    assert.ok(!keys.has(key), `duplicate generated key ${key}`);
    keys.set(key, Number(count));
  }
  return Object.fromEntries([...keys].sort(([a], [b]) => a.localeCompare(b)));
}

test('bundle env declares every installer-generated key with its safe generation policy', () => {
  const shell = generatedKeys(
    read('install/install.sh'),
    /^\s*([A-Z_][A-Z0-9_]*)=\$\(rand_hex (\d+)\)\s*$/gm,
    'rand_hex',
    /^([A-Z_][A-Z0-9_]*)=\$\{([A-Z_][A-Z0-9_]*)\}$/gm,
  );
  const powershell = generatedKeys(
    read('install/install.ps1'),
    /^\s*\$(\w+)\s*=\s*New-HexSecret (\d+)\s*$/gim,
    'New-HexSecret',
    /^\s*"([A-Z_][A-Z0-9_]*)=\$(\w+)"\s*$/gm,
  );
  assert.deepEqual(shell, {
    CONFIG_ENCRYPTION_KEY: 32,
    JWT_SECRET: 32,
    MAILPIT_UI_PASSWORD: 24,
    POSTGRES_PASSWORD: 16,
  });
  assert.deepEqual(powershell, shell, 'both installers must generate the same sizes');
  const env = releaseBundleEnvSchema.parse(JSON.parse(read('install/bundle-env.json')));
  assert.deepEqual(env.map(({ key }) => key).sort(), Object.keys(shell));
  for (const entry of env) {
    if (entry.key === 'MAILPIT_UI_PASSWORD') {
      assert.equal(entry.generate, 'hex');
      assert.equal(entry.bytes, shell[entry.key]);
    } else {
      assert.equal(entry.generate, 'never', `${entry.key} is already in use`);
      assert.ok(!Object.hasOwn(entry, 'bytes'), 'never keys must not declare generation bytes');
    }
  }
});

test('every key the bundle may generate is consumed by an allowed compose file', () => {
  const env = releaseBundleEnvSchema.parse(JSON.parse(read('install/bundle-env.json')));
  const compose = RELEASE_BUNDLE_FILES.map(read).join('\n');
  for (const { key, generate } of env) {
    if (generate === 'hex')
      assert.ok(
        compose.includes('${' + key + '}') || compose.includes('${' + key + ':'),
        `${key} is referenced`,
      );
  }
});
