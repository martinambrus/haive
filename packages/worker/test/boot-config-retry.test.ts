import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

describe('worker boot against an unavailable configuration store', () => {
  it('retries bootstrap through retryWhileConfigUnavailable, before the step engine boots', () => {
    const call = source.search(
      /await retryWhileConfigUnavailable\(\s*'worker bootstrap',\s*bootstrap,?\s*\)/,
    );
    expect(call).toBeGreaterThan(-1);
    expect(source).not.toMatch(/await bootstrap\(\)/);
    expect(call).toBeLessThan(source.indexOf('bootStepEngine('));
  });
});

it('starts store repairs after ready and stops them with the other background tasks', () => {
  const start = source.indexOf(
    'const stopBackgroundDataMigrations = startBackgroundDataMigrations(getDb())',
  );
  expect(start).toBeGreaterThan(source.indexOf("logger.info('haive-worker ready')"));
  expect(source).toContain('stopBackgroundDataMigrations();');
});
