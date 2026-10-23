import { describe, expect, it } from 'vitest';
import { pauseParkMessage } from './pause.js';

describe('pauseParkMessage', () => {
  it.each(['task', 'global'] as const)(
    'never tells the reader to resume in the %s scope, since the plan chat and plan merge print it to a viewer who may be locked out',
    (scope) => {
      expect(pauseParkMessage(scope)).not.toMatch(/\bresume\b/i);
    },
  );

  it.each(['task', 'global'] as const)('still says the step is paused in the %s scope', (scope) => {
    expect(pauseParkMessage(scope)).toMatch(/^Paused/);
  });
});
