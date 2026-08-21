import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';

// The project's own facet set, which the global-scope filter matches an item against.
// Mocked rather than seeded because resolveTaskFacets reads two step outputs from a
// real task row; the predicate under test here is the facet comparison, not that read.
const resolveTaskFacets = vi.hoisted(() => vi.fn());
vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveTaskFacets };
});
import {
  augmentPromptWithLearnedGuidance,
  isStepGuidanceEnabled,
} from '../src/step-engine/guidance-context.js';

const TASK_ID = '33333333-3333-3333-3333-333333333333';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_REPO_ID = '44444444-4444-4444-4444-444444444444';
const STEP_ID = '07-phase-2-implement';
const PROMPT = 'Implement the change described in the spec.';

interface Row {
  scope: 'repo' | 'global';
  repositoryId: string | null;
  facets: Record<string, string[]>;
  guidance: string;
}

/** Stand-in for the two db.query.*.findFirst calls plus the one select chain
 *  augmentPromptWithLearnedGuidance makes. `rows` is what the select resolves to;
 *  passing a thrown error instead exercises the fail-soft path. */
function fakeDb(opts: {
  repositoryId?: string | null;
  stepGuidanceEnabled?: boolean;
  rows?: Row[] | Error;
}): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => {
      if (opts.rows instanceof Error) return Promise.reject(opts.rows);
      return Promise.resolve(opts.rows ?? []);
    },
  };
  return {
    query: {
      tasks: {
        findFirst: () =>
          Promise.resolve(
            opts.repositoryId === undefined
              ? { repositoryId: REPO_ID }
              : { repositoryId: opts.repositoryId },
          ),
      },
      repositories: {
        findFirst: () => Promise.resolve({ stepGuidanceEnabled: opts.stepGuidanceEnabled ?? true }),
      },
    },
    select: () => chain,
  } as unknown as Database;
}

const DRUPAL_PROJECT = {
  framework: ['drupal'],
  frameworkMajor: ['11'],
  language: ['php'],
  phpMajor: ['8'],
  nodeMajor: [],
  database: ['mariadb'],
  dbMajor: ['10'],
  packages: [],
  tags: [],
};

beforeEach(() => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  resolveTaskFacets.mockResolvedValue(DRUPAL_PROJECT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('augmentPromptWithLearnedGuidance', () => {
  // The rollback contract: with the switch off, every prompt is byte-identical to a
  // pre-feature run. That is the only reason flipping the admin toggle needs no deploy.
  it('returns the prompt byte-identical when the global switch is off', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const out = await augmentPromptWithLearnedGuidance(fakeDb({}), TASK_ID, STEP_ID, PROMPT);
    expect(out).toBe(PROMPT);
  });

  it('returns the prompt byte-identical when the repository opted out', async () => {
    const db = fakeDb({ stepGuidanceEnabled: false, rows: [repoRow('never injected')] });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toBe(PROMPT);
  });

  it('returns the prompt byte-identical when no rows match', async () => {
    expect(
      await augmentPromptWithLearnedGuidance(fakeDb({ rows: [] }), TASK_ID, STEP_ID, PROMPT),
    ).toBe(PROMPT);
  });

  it('returns the prompt byte-identical when the query throws', async () => {
    const db = fakeDb({ rows: new Error('relation "step_guidance" does not exist') });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toBe(PROMPT);
  });

  it('appends matching repo guidance without touching the original prompt text', async () => {
    const db = fakeDb({ rows: [repoRow('Name the target directory explicitly.')] });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    expect(out.startsWith(PROMPT)).toBe(true);
    expect(out).toContain('Name the target directory explicitly.');
    expect(out).toContain('## Learned guidance for this step');
  });

  it('does not inject a repo item belonging to a different repository', async () => {
    const db = fakeDb({
      rows: [{ scope: 'repo', repositoryId: OTHER_REPO_ID, facets: {}, guidance: 'other repo' }],
    });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toBe(PROMPT);
  });

  it('caps at 5 items even when more are active', async () => {
    const db = fakeDb({ rows: Array.from({ length: 9 }, (_, i) => repoRow(`item ${i}`)) });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    expect(out.match(/^- item \d$/gm)).toHaveLength(5);
  });

  it('caps the appended block at 1500 characters', async () => {
    const db = fakeDb({ rows: Array.from({ length: 5 }, () => repoRow('y'.repeat(400))) });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    const block = out.slice(PROMPT.length);
    // Header lines sit outside the item budget; the ITEM lines are what is capped.
    const itemChars = (block.match(/^- y+$/gm) ?? []).join('\n').length;
    expect(itemChars).toBeLessThanOrEqual(1500);
    expect(out.match(/^- y+$/gm)!.length).toBeLessThan(5);
  });
});

describe('global scope facet matching', () => {
  it('injects a global item whose facets overlap the project stack', async () => {
    const db = fakeDb({
      rows: [globalRow({ framework: ['drupal'], frameworkMajor: ['11'] }, 'drupal-wide lesson')],
    });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toContain(
      'drupal-wide lesson',
    );
  });

  it('does not inject a global item whose facets do not overlap', async () => {
    const db = fakeDb({ rows: [globalRow({ framework: ['laravel'] }, 'laravel lesson')] });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toBe(PROMPT);
  });

  it('does not inject a global item pinned to a different framework major', async () => {
    const db = fakeDb({
      rows: [globalRow({ framework: ['drupal'], frameworkMajor: ['10'] }, 'drupal 10 lesson')],
    });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toBe(PROMPT);
  });

  it('injects an unfaceted global item (an unconstrained dimension is universal)', async () => {
    // The global KB's own rule, via the same predicate, so the two cannot drift apart.
    const db = fakeDb({ rows: [globalRow({}, 'applies anywhere')] });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toContain(
      'applies anywhere',
    );
  });
});

describe('isStepGuidanceEnabled', () => {
  it('is decided by the global switch alone for a task with no repository', async () => {
    expect(await isStepGuidanceEnabled(fakeDb({ repositoryId: null }), TASK_ID)).toBe(true);
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    expect(await isStepGuidanceEnabled(fakeDb({ repositoryId: null }), TASK_ID)).toBe(false);
  });

  it('is false when the repo opted out even with the global switch on', async () => {
    expect(await isStepGuidanceEnabled(fakeDb({ stepGuidanceEnabled: false }), TASK_ID)).toBe(
      false,
    );
  });

  it('answers false rather than throwing when the config read fails', async () => {
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(new Error('redis down'));
    expect(await isStepGuidanceEnabled(fakeDb({}), TASK_ID)).toBe(false);
  });
});

function repoRow(guidance: string): Row {
  return { scope: 'repo', repositoryId: REPO_ID, facets: {}, guidance };
}

function globalRow(facets: Record<string, string[]>, guidance: string): Row {
  return { scope: 'global', repositoryId: null, facets, guidance };
}
