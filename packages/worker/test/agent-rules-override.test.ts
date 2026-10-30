import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { readAgentRulesOverrideRaw } from '../src/step-engine/_agent-rules-override.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const GONE = '00000000-0000-4000-8000-0000000000b2';

function world(stored: string | null) {
  const fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: '00000000-0000-4000-8000-0000000000a1',
    name: 'acme',
    agentRulesOverride: stored,
  });
  return fake;
}

describe('readAgentRulesOverrideRaw', () => {
  it.each([
    ['text', '- a rule'],
    ['the empty string', ''],
    ['whitespace', '  \n'],
    ['NULL', null],
  ])('reads %s exactly as it is stored', async (_name, stored) => {
    expect(await readAgentRulesOverrideRaw(world(stored).db as never, REPO)).toBe(stored);
  });

  it('reads a repository that is gone as NULL', async () => {
    expect(await readAgentRulesOverrideRaw(world('x').db as never, GONE)).toBeNull();
  });

  it('reads through a transaction handle', async () => {
    const fake = world('- in a transaction');
    const read = await fake.db.transaction((tx) => readAgentRulesOverrideRaw(tx as never, REPO));
    expect(read).toBe('- in a transaction');
  });
});
