import { describe, expect, it } from 'vitest';
import { createTaskRequestSchema } from '../src/schemas/tasks.js';

const base = { type: 'workflow', title: 'Title', description: 'Description' };
const pick = { categoryId: 'forge', connectionId: '00000000-0000-4000-8000-000000000001' };
describe('task integration choices at the request boundary', () => {
  it('retains an explicit account choice', () => {
    expect(createTaskRequestSchema.parse({ ...base, integrationChoices: [pick] })).toMatchObject({
      integrationChoices: [pick],
    });
  });
  it.each([
    null,
    {},
    'forge',
    [{ ...pick, connectionId: 2 }],
    [{ ...pick, categoryId: true }],
    [{ ...pick, remember: true }],
    [pick, pick],
    Array.from({ length: 65 }, (_, n) => ({ ...pick, categoryId: `module.fixture.cat${n}` })),
  ])('refuses malformed, duplicate or oversized choices %#', (integrationChoices) => {
    expect(createTaskRequestSchema.safeParse({ ...base, integrationChoices }).success).toBe(false);
  });
});
