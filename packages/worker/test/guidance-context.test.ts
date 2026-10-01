import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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

// The module's own log line, which is the only trace a drop leaves when nothing is shown.
const logInfo = vi.hoisted(() => vi.fn());
vi.mock('@haive/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared')>();
  const child = { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { ...real, logger: { ...real.logger, child: () => child } };
});
import {
  augmentPromptWithLearnedGuidance,
  guidanceOmissionNotice,
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

interface Capture {
  where?: SQL;
  orderBy?: SQL[];
}

/** Stand-in for the two db.query.*.findFirst calls plus the one select chain
 *  augmentPromptWithLearnedGuidance makes. `rows` is what the select resolves to;
 *  passing a thrown error instead exercises the fail-soft path. `capture` receives the
 *  query's WHERE and ORDER BY, which this stand-in does not apply. */
function fakeDb(opts: {
  repositoryId?: string | null;
  stepGuidanceEnabled?: boolean;
  rows?: Row[] | Error;
  capture?: Capture;
}): Database {
  const chain = {
    from: () => chain,
    where: (where: SQL) => {
      if (opts.capture) opts.capture.where = where;
      return chain;
    },
    orderBy: (...orderBy: SQL[]) => {
      if (opts.capture) opts.capture.orderBy = orderBy;
      return chain;
    },
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
  logInfo.mockClear();
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

  it('caps at 5 items even when more are active, and says how many it is not showing', async () => {
    const db = fakeDb({ rows: Array.from({ length: 9 }, (_, i) => repoRow(`item ${i}`)) });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    expect(out.match(/^- item \d$/gm)).toHaveLength(5);
    // Without this line the block reads as the complete list — the one thing AGENTS.md forbids
    // of a bounded block, and what the task ledger and loadPriorFixContext both state.
    expect(out).toContain('(4 more approved lessons not shown');
    // Last line, and NOT a `- ` entry: every bullet in this block is one whole lesson.
    const lines = out.trimEnd().split('\n');
    expect(lines[lines.length - 1]!.startsWith('(')).toBe(true);
    expect(out.match(/^- /gm)).toHaveLength(5);
  });

  it('caps the appended block at 1500 characters, and says what the cap cost', async () => {
    const db = fakeDb({ rows: Array.from({ length: 5 }, () => repoRow('y'.repeat(400))) });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    const block = out.slice(PROMPT.length);
    // Header lines sit outside the item budget; the ITEM lines are what is capped.
    const itemChars = (block.match(/^- y+$/gm) ?? []).join('\n').length;
    expect(itemChars).toBeLessThanOrEqual(1500);
    const shown = out.match(/^- y+$/gm)!.length;
    expect(shown).toBeLessThan(5);
    // The LENGTH cap drops silently too, so it is disclosed on the same terms as the count cap.
    expect(out).toContain(`(${5 - shown} more approved lesson`);
  });

  it('says nothing when it showed everything', async () => {
    const db = fakeDb({ rows: Array.from({ length: 5 }, (_, i) => repoRow(`item ${i}`)) });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    expect(out.match(/^- item \d$/gm)).toHaveLength(5);
    expect(out).not.toContain('not shown');
  });

  it('calls the count a floor when the scan itself filled up', async () => {
    // 100 rows is SCAN_LIMIT: the corpus may hold more that would have been eligible, so the
    // number this block dropped is a floor rather than the total.
    const db = fakeDb({ rows: Array.from({ length: 100 }, (_, i) => repoRow(`item ${i}`)) });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    expect(out).toContain('(at least 95 more approved lessons not shown');
  });

  it('calls it a floor even when the filtering leaves few eligible rows', async () => {
    // The FETCH is what the limit cuts, and facet matching runs after it, so a saturated scan
    // whose rows are mostly another stack's is still saturated. Keying this on the eligible
    // count instead would promise an exact "1 more" while the corpus may hold others past the
    // limit — the very thing this notice exists to stop.
    const db = fakeDb({
      rows: [
        ...Array.from({ length: 6 }, (_, i) => repoRow(`mine ${i}`)),
        ...Array.from({ length: 94 }, () => globalRow({ framework: ['laravel'] }, 'other stack')),
      ],
    });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    expect(out.match(/^- mine \d$/gm)).toHaveLength(5);
    expect(out).toContain('(at least 1 more approved lesson not shown');
  });

  it('still speaks when a saturated scan showed everything it read', async () => {
    // Five survivors fit the block whole, so nothing READ was dropped — but the rows past the
    // limit were never read, and silence there would present the block as the complete list.
    const db = fakeDb({
      rows: [
        ...Array.from({ length: 5 }, (_, i) => repoRow(`mine ${i}`)),
        ...Array.from({ length: 95 }, () => globalRow({ framework: ['laravel'] }, 'other stack')),
      ],
    });
    const out = await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    expect(out.match(/^- mine \d$/gm)).toHaveLength(5);
    expect(out).toContain('(possibly more approved lessons not shown');
    const lines = out.trimEnd().split('\n');
    expect(lines[lines.length - 1]!.startsWith('(possibly more')).toBe(true);
  });

  it('logs a saturated scan that left nothing to show, and leaves the prompt as built', async () => {
    // No lesson survived the facet match, so there is no list to misread; the log is the trace.
    const db = fakeDb({
      rows: Array.from({ length: 100 }, () => globalRow({ framework: ['laravel'] }, 'other stack')),
    });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toBe(PROMPT);
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ omitted: 0, shown: 0, scanSaturated: true }),
      expect.any(String),
    );
  });

  it('logs a lesson too long to show, and leaves the prompt as built', async () => {
    const db = fakeDb({ rows: [repoRow('z'.repeat(1600))] });
    expect(await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT)).toBe(PROMPT);
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ omitted: 1, shown: 0, scanSaturated: false }),
      expect.any(String),
    );
  });
});

describe('guidanceOmissionNotice', () => {
  it('reads as one lesson when exactly one went, saturated or not', () => {
    expect(guidanceOmissionNotice(1, false)).toContain('1 more approved lesson not shown');
    expect(guidanceOmissionNotice(1, false)).not.toContain('lessons');
    expect(guidanceOmissionNotice(1, true)).toContain('at least 1 more approved lesson not shown');
  });

  it('has nothing to say only when nothing was dropped and the scan did not fill', () => {
    expect(guidanceOmissionNotice(0, false)).toBeNull();
    expect(guidanceOmissionNotice(0, true)).toContain('(possibly more approved lessons not shown');
  });

  it('names what survives rather than what went', () => {
    // The order IS the selection rule, so "the ones you cannot see rank below these" is the
    // half that helps; a bare count would not say which end was kept.
    expect(guidanceOmissionNotice(3, false)).toContain(
      "the repository's own and the most-observed",
    );
  });
});

describe('the scan', () => {
  // The limit is applied in SQL, so a scope filtered only afterwards lets another repository's
  // lessons, or higher-ranked global ones, fill all 100 rows and leave this repository's unread.
  it("reads this repository's own lessons and global ones, its own first", async () => {
    const capture: Capture = {};
    await augmentPromptWithLearnedGuidance(fakeDb({ rows: [], capture }), TASK_ID, STEP_ID, PROMPT);
    const dialect = new PgDialect();
    const where = dialect.sqlToQuery(capture.where!);
    expect(where.sql).toMatch(/"repository_id" = \$\d+/);
    expect(where.params).toContain(REPO_ID);
    expect(where.params).toContain('global');
    const first = dialect.sqlToQuery(capture.orderBy![0]!);
    expect(first.sql).toMatch(/"scope" = \$\d+ desc$/);
    expect(first.params).toEqual(['repo']);
  });

  it('reads global lessons alone for a task with no repository', async () => {
    const capture: Capture = {};
    const db = fakeDb({ repositoryId: null, rows: [], capture });
    await augmentPromptWithLearnedGuidance(db, TASK_ID, STEP_ID, PROMPT);
    const where = new PgDialect().sqlToQuery(capture.where!);
    expect(where.sql).not.toContain('"repository_id"');
    expect(where.params).toContain('global');
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
