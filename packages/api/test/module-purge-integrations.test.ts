import { describe, expect, it } from 'vitest';
import { parseProviderId, parseCategoryId } from '@haive/shared/modularity';
import { moduleIntegrationIdPattern } from '../src/modules/purge-integrations.js';

describe('persisted module integration ownership', () => {
  it.each(['foo', 'foo-bar', '0foo'])(
    'matches the existing provider/category grammar for %s after uninstall',
    (moduleId) => {
      const matches = new RegExp(moduleIntegrationIdPattern(moduleId));
      for (const value of [
        `module.${moduleId}.account`,
        `module.${moduleId}.a_b-2`,
        `module.${moduleId}.0`,
        `module.${moduleId}.`,
        `module.${moduleId}.Bad`,
        `module.${moduleId}._bad`,
        `module.${moduleId}.a.extra`,
        `module.${moduleId}bar.account`,
        `module.${moduleId}-bar.account`,
        `module.${moduleId}.account\n`,
        'github',
        'forge',
        'module.other.account',
      ]) {
        for (const parse of [parseProviderId, parseCategoryId]) {
          const parsed = parse(value);
          expect(matches.test(value), value).toBe(
            parsed?.kind === 'module' && parsed.moduleId === moduleId,
          );
        }
      }
    },
  );

  it.each(['', 'foo.bar', 'foo_bar', 'foo*', 'Afoo', 'foo\n'])(
    'refuses an invalid module id %j',
    (id) => {
      expect(() => moduleIntegrationIdPattern(id)).toThrow('Invalid module id');
    },
  );
});
