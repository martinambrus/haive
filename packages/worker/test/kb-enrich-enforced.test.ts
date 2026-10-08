import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const ENTRY = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000d1';
const T0 = new Date(Date.UTC(2026, 9, 3, 12, 0));

const h = vi.hoisted(() => ({ gdb: undefined as unknown }));

vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ db: h.gdb, settings: { namespace: 'default' } }),
}));

import { kbAuthorEnrichStep } from '../src/step-engine/steps/kb-author/01-enrich.js';

function setup(over: Record<string, unknown>) {
  const fake = createFakeDb({ tasks: schema.tasks, globalKbEntries });
  h.gdb = fake.db;
  fake.insert(schema.tasks, { id: TASK, metadata: { globalKbEntryId: ENTRY } });
  fake.insert(globalKbEntries, {
    id: ENTRY,
    namespace: 'default',
    title: 'Never inline SVG',
    seedText: 'notes',
    body: 'body',
    category: 'best_practice',
    facets: {},
    status: 'active',
    source: 'user',
    description: 'Reference a file instead.',
    updatedAt: T0,
    ...over,
  });
  const ctx = { db: fake.db, taskId: TASK, logger: { warn() {}, info() {} } } as never;
  const stored = () => fake.rows(globalKbEntries).find((r) => r.id === ENTRY)!;
  return { ctx, stored };
}

describe('the kb enrich step and an entry that is an enforced house rule', () => {
  beforeEach(() => {
    h.gdb = undefined;
  });

  it('still starts on a skeleton, which is what a first run is', async () => {
    const { ctx, stored } = setup({ status: 'skeleton' });

    const detected = await kbAuthorEnrichStep.detect!(ctx);

    expect(detected.entryId).toBe(ENTRY);
    expect(stored().status).toBe('enriching');
  });

  it('refuses an entry that carries an approval, and leaves it exactly as it was', async () => {
    const { ctx, stored } = setup({ enforce: { mode: 'always' }, enforcedHash: 'hr1:approved' });

    await expect(kbAuthorEnrichStep.detect!(ctx)).rejects.toThrow(/approval as a house rule/);

    expect(stored().status).toBe('active');
    expect(stored().enforcedHash).toBe('hr1:approved');
    expect(stored().updatedAt).toEqual(T0);
  });

  it('refuses it while an edit has lapsed the approval, which is still stored', async () => {
    const { ctx, stored } = setup({
      body: 'edited since',
      enforce: { mode: 'files', globs: ['**/*.twig'] },
      enforcedHash: 'hr1:approved-before-the-edit',
    });

    await expect(kbAuthorEnrichStep.detect!(ctx)).rejects.toThrow(/approval as a house rule/);

    expect(stored().status).toBe('active');
  });

  it('starts again on an entry whose approval has been cleared, though its last settings are kept', async () => {
    const { ctx, stored } = setup({
      status: 'draft',
      enforce: { mode: 'always' },
      enforcedHash: null,
    });

    await kbAuthorEnrichStep.detect!(ctx);

    expect(stored().status).toBe('enriching');
  });
});
