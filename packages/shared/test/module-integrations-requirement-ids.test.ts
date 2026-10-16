import { describe, expect, it } from 'vitest';
import { integrationRequirementSchema, moduleManifestSchema } from '../src/modularity/index.js';
import { fixtureManifest, fixtureStep } from './module-integrations-fixtures.js';

const STEP = 'pull-sources';
const ID_PATH = 'composableSteps.0.integrations.0.id';

const parseWithId = (id: string) =>
  moduleManifestSchema.safeParse(
    fixtureManifest('fx', {
      composableSteps: [fixtureStep(STEP, [{ id, category: 'mail', access: 'read' }])],
    }),
  );

describe('the id of a composable step requirement in a module manifest', () => {
  it.each([
    ['starts with a digit', '9docs'],
    ['starts with a hyphen', '-docs'],
    ['has a capital letter', 'Docs'],
    ['is 17 characters long', 'a'.repeat(17)],
  ])('refuses an id that %s, with a message naming the step and the id', (_name, id) => {
    const result = parseWithId(id);

    expect(result.success, 'the manifest was accepted').toBe(false);
    const own = (result.error?.issues ?? [])
      .filter((issue) => issue.code === 'custom' && issue.path.join('.') === ID_PATH)
      .map((issue) => issue.message);
    expect(
      own.some((message) => message.includes(STEP) && message.includes(id)),
      `no message of its own at ${ID_PATH} names the step and the id: ${JSON.stringify(own)}`,
    ).toBe(true);
  });

  it.each(['docs-1', 'a', 'a'.repeat(16)])('accepts the id %s', (id) => {
    const result = parseWithId(id);

    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('leaves the shared requirement schema alone: core catalog entries and stored rows keep their ids', () => {
    for (const id of ['9docs', 'x'.repeat(40)]) {
      const requirement = { id, category: 'mail', access: 'read' };

      expect(integrationRequirementSchema.safeParse(requirement).success, id).toBe(true);
    }
  });
});
