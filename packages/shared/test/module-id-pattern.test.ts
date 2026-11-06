import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MODULE_ID_PATTERN,
  MODULE_ID_PATTERN_SOURCE,
  MODULE_ID_MAX_LENGTH,
  moduleManifestSchema,
  modulePackageId,
} from '../src/modularity/index.js';

describe('module id contract', () => {
  it.each(['alpha', '0', 'a-b', 'a'.repeat(23), '', '-bad', 'Bad', 'a_b', 'a'.repeat(24)])(
    'agrees for the manifest and both package names: %j',
    (id) => {
      const valid = MODULE_ID_PATTERN.test(id);
      expect(
        moduleManifestSchema.safeParse({ id, name: 'Test', version: '1', schemaVersion: 1 })
          .success,
      ).toBe(valid);
      for (const prefix of ['@haive/module-', '@haive-module/'])
        expect(modulePackageId(prefix + id)).toBe(valid ? id : null);
    },
  );
  it('keeps the database identifier length bound', () => {
    expect(MODULE_ID_PATTERN.test('a'.repeat(MODULE_ID_MAX_LENGTH))).toBe(true);
    expect(MODULE_ID_PATTERN.test('a'.repeat(MODULE_ID_MAX_LENGTH + 1))).toBe(false);
  });
  // Scripts run before shared is built. Database cannot import shared, which depends on it.
  // Pin every intentional literal, including the builder's embedded Python staging pattern.
  it.each([
    ['scripts/gen-modules.mjs', 1],
    ['scripts/module.mjs', 1],
    ['scripts/channel-gate.mjs', 1],
    ['scripts/own-module-builder.mjs', 4],
    ['packages/database/migrations/0221_module_sources.sql', 1],
    ['packages/database/src/schema/module-sources.ts', 1],
  ] as const)('pins the literal copies in %s', (file, copies) => {
    const text = readFileSync(new URL('../../../' + file, import.meta.url), 'utf8');
    expect(text.split(MODULE_ID_PATTERN_SOURCE).length - 1).toBe(copies);
  });
});
