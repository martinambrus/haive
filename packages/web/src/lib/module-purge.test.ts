import { describe, expect, it } from 'vitest';
import { moduleIntegrationCountsCopy, validModulePurgePreview } from './module-purge';

const counts = {
  providerConfigs: 1,
  connections: 2,
  userSettings: 3,
  preferences: 4,
  taskChoices: 5,
  grants: 6,
};
describe('module purge confirmation', () => {
  it('names all counted data categories', () => {
    expect(moduleIntegrationCountsCopy(counts)).toBe(
      '1 provider configuration, 2 connected accounts, 3 user write settings, 4 saved account preferences, 5 task account overrides, 6 task or repository account grants',
    );
  });
  it('requires complete, nonnegative integer counts for the current target', () => {
    expect(validModulePurgePreview({ moduleId: 'foo', integrations: counts }, 'foo')).toBe(true);
    expect(validModulePurgePreview({ moduleId: 'foo', integrations: counts }, 'bar')).toBe(false);
    for (const key of Object.keys(counts)) {
      for (const value of [undefined, null, '0', -1, 0.5, NaN]) {
        const bad = { ...counts, [key]: value };
        expect(validModulePurgePreview({ moduleId: 'foo', integrations: bad }, 'foo')).toBe(false);
      }
    }
  });
});
