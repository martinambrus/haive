import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const h = vi.hoisted(() => ({ gdb: undefined as unknown }));

vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveGlobalKbSettings: async () => ({ enabled: true, namespace: 'default' }),
    withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
      fn({ db: h.gdb, settings: { namespace: 'default' } }),
  };
});

import { globalKbReviewStep } from '../src/step-engine/steps/onboarding/09_6_5-global-kb-review.js';

const TASK = '00000000-0000-4000-8000-0000000000d1';
const OTHER_TASK = '00000000-0000-4000-8000-0000000000d2';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LINE_SEPARATOR = String.fromCharCode(0x2028);

interface Seed {
  title: string;
  category?: string;
  description?: string | null;
  status?: string;
  sourceTaskId?: string;
}

function setup(seeds: Seed[]) {
  const fake = createFakeDb({ globalKbEntries });
  h.gdb = fake.db;
  seeds.forEach((seed, i) => {
    fake.insert(globalKbEntries, {
      id: uuid(i + 1),
      namespace: 'default',
      body: 'body',
      facets: {},
      source: 'promoted',
      category: 'best_practice',
      status: 'draft',
      sourceTaskId: TASK,
      ...seed,
    });
  });
  return { db: fake.db, taskId: TASK, logger: { info() {}, warn() {} } } as never;
}

/** The draft lines of the review form, without the link that closes the section. */
function listOf(form: ReturnType<NonNullable<typeof globalKbReviewStep.form>>): string[] {
  const body = form?.infoSections?.[0]?.body ?? '';
  return body.split('\n\n')[0]!.split('\n');
}

describe('the global KB drafts review and descriptions', () => {
  beforeEach(() => {
    h.gdb = undefined;
  });

  it('lists a draft description beside its title and category', async () => {
    const ctx = setup([
      { title: 'Escape labels', description: 'Escape every interpolated label.' },
    ]);
    const detected = await globalKbReviewStep.detect!(ctx);

    expect(listOf(globalKbReviewStep.form!(ctx, detected))).toEqual([
      '- **Escape labels** _(best_practice)_ — Escape every interpolated label.',
    ]);
  });

  it('lists a draft without one exactly as before', async () => {
    const ctx = setup([
      { title: 'Never inline SVG', category: 'anti_pattern', description: null },
      { title: 'Blank one', description: ' \n ' },
    ]);
    const detected = await globalKbReviewStep.detect!(ctx);

    expect(listOf(globalKbReviewStep.form!(ctx, detected)).sort()).toEqual([
      '- **Blank one** _(best_practice)_',
      '- **Never inline SVG** _(anti_pattern)_',
    ]);
  });

  it('keeps a description on one line, so it cannot open another list item or a heading', async () => {
    const ctx = setup([
      {
        title: 'Escape labels',
        description: `Escape every label.\n\n- injected item\n# heading${LINE_SEPARATOR}tail`,
      },
      { title: 'Second', description: 'Second description.' },
    ]);
    const detected = await globalKbReviewStep.detect!(ctx);
    const lines = listOf(globalKbReviewStep.form!(ctx, detected));

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith('- **'))).toBe(true);
    expect(lines.find((line) => line.includes('Escape labels'))).toBe(
      '- **Escape labels** _(best_practice)_ — Escape every label. - injected item # heading tail',
    );
  });

  it('renders a payload stored before descriptions existed with titles only', () => {
    const detected = { drafts: [{ id: uuid(1), title: 'Old draft', category: 'general' }] };

    expect(listOf(globalKbReviewStep.form!({} as never, detected))).toEqual([
      '- **Old draft** _(general)_',
    ]);
  });

  it('still reads only the drafts this task promoted', async () => {
    const ctx = setup([
      { title: 'Mine', description: 'Mine.' },
      { title: 'Active', description: 'Active.', status: 'active' },
      { title: 'Other task', description: 'Other.', sourceTaskId: OTHER_TASK },
    ]);
    const detected = await globalKbReviewStep.detect!(ctx);

    expect(detected.drafts.map((d) => d.title)).toEqual(['Mine']);
  });
});
