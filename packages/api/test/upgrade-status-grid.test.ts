import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import {
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  buildClaudeSettingsJson,
  buildGeminiSettingsJson,
} from '@haive/shared';

const { state } = vi.hoisted(() => ({
  state: {
    userId: 'user-1',
    repo: null as Record<string, unknown> | null,
    rows: new Map<unknown, unknown[]>(),
    onboarded: false,
  },
}));

// The same hand mock as upgrade-status-rules-imports.test.ts: each table answers the rows the cell
// put there, whatever the WHERE.
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      repositories: { findFirst: async () => state.repo },
      tasks: { findFirst: async () => (state.onboarded ? { id: 'onboarding-1' } : null) },
    },
    select: () => ({
      from: (table: unknown) => {
        const q = {
          where: () => q,
          innerJoin: () => q,
          orderBy: () => q,
          limit: () => q,
          then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
            Promise.resolve(state.rows.get(table) ?? []).then(resolve, reject),
        };
        return q;
      },
    }),
  }),
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', state.userId);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({}) }));

import { Hono } from 'hono';
import { upgradeRoutes } from '../src/routes/upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/', upgradeRoutes);
app.onError(errorHandler);

/**
 * The characterization grid of the banner's resolution of RTK: the same states as the plan's grid
 * (upgrade-plan-grid.test.ts in the worker), through GET /repos/:id/upgrade-status with its hand
 * mock. Written against main before the shared resolution order and the column read exist, and it
 * must give the same answers after both: the column is absent, NULL or refused in every cell, and a
 * column the schema refuses reads as NULL.
 *
 * What the mock cannot say: it ignores every WHERE, so a task row answers every task query at once.
 * A completed onboarding is the `onboarded` flag together with one task row, and no cell holds a
 * live task or an upgrade task. The states that need them are POST /tasks's, in
 * upgrade-gate-render-context.test.ts, where the fake database evaluates its filters.
 */
/** A checkout that still carries RTK: its block in AGENTS.md and the hook in both settings files. */
async function writeRtkRepo(dir: string): Promise<void> {
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await mkdir(path.join(dir, '.gemini'), { recursive: true });
  await writeFile(
    path.join(dir, 'AGENTS.md'),
    `# rules\n${RTK_REF_MARKER_START}\nRTK is here.\n${RTK_REF_MARKER_END}\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
  await writeFile(path.join(dir, '.claude/settings.json'), buildClaudeSettingsJson(), 'utf8');
  await writeFile(path.join(dir, '.gemini/settings.json'), buildGeminiSettingsJson(), 'utf8');
}

const ROW_STATES = ['none', 'no-snapshot', 'recorded', 'unrecorded', 'mixed'] as const;
const HISTORY_STATES = ['recorded', 'unrecorded', 'missing-row', 'none'] as const;
const SOURCES = ['git_https', 'blank'] as const;
type RowState = (typeof ROW_STATES)[number];
type HistoryState = (typeof HISTORY_STATES)[number];
type Source = (typeof SOURCES)[number];

interface Cell {
  rows: RowState;
  history: HistoryState;
  source: Source;
  live: boolean;
}

const cellKey = (c: Cell): string =>
  `rows=${c.rows} 07=${c.history} source=${c.source} live=${c.live ? 'on' : 'off'}`;
const allCells = (): Cell[] =>
  ROW_STATES.flatMap((rows) =>
    HISTORY_STATES.flatMap((history) =>
      SOURCES.flatMap((source) => [true, false].map((live) => ({ rows, history, source, live }))),
    ),
  );

const ABSENT = Symbol('the repository row has no renderContext key');
const PORTABLE_COLUMN = {
  projectInfo: { name: 'column' },
  framework: 'column',
  acceptedAgentIds: ['column-agent'],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkChoiceRecorded: true,
};
const COLUMNS: [string, unknown][] = [
  ['key absent', ABSENT],
  ['NULL', null],
  ['refused {}', {}],
  ['refused unknown key', { ...PORTABLE_COLUMN, somethingNew: true }],
];

const claudeRtk = { templateId: 'rtk.claude-settings', schemaVersion: 1, contentHash: 'h-rtk-c' };
const geminiRtk = { templateId: 'rtk.gemini-settings', schemaVersion: 1, contentHash: 'h-rtk-g' };
const agent = { templateId: 'agent.x', schemaVersion: 1, contentHash: 'h1' };

/** One live row as the route selects it. A snapshot without an RTK choice has no `rtkRecorded` the
 *  database could say, so that column is NULL, as `jsonb_typeof(NULL)` is. */
const artifact = (id: string, at: number, snapshot: 'none' | 'recorded' | 'unrecorded') => ({
  id,
  diskPath: `.claude/agents/${id}.md`,
  templateId: agent.templateId,
  templateSchemaVersion: agent.schemaVersion,
  templateContentHash: agent.contentHash,
  bundleItemId: null,
  haiveVersion: null,
  generatedAt: new Date(at),
  hasSnapshot: snapshot === 'none' ? null : true,
  rtkRecorded: snapshot === 'recorded' ? true : null,
  snapshotProviders:
    snapshot === 'recorded'
      ? [{ name: 'gemini' }]
      : snapshot === 'unrecorded'
        ? [{ name: 'claude-code' }]
        : null,
});

function liveRows(rows: RowState): unknown[] {
  switch (rows) {
    case 'none':
      return [];
    case 'no-snapshot':
      return [artifact('row-0', 1000, 'none')];
    case 'recorded':
      return [artifact('row-0', 1000, 'recorded')];
    case 'unrecorded':
      return [artifact('row-0', 1000, 'unrecorded')];
    case 'mixed':
      return [artifact('row-0', 1000, 'recorded'), artifact('row-1', 2000, 'unrecorded')];
  }
}

function seed(cell: Cell, repoDir: string, column: unknown): void {
  state.onboarded = cell.history !== 'none';
  state.repo = {
    id: 'repo-1',
    applicableTemplateIds: [agent.templateId],
    storagePath: repoDir,
    localPath: null,
    rtkEnabled: cell.live,
    source: cell.source,
    status: 'ready',
    onboardedAt: null,
    onboardingResetAt: null,
    ...(column === ABSENT ? {} : { renderContext: column }),
  };
  state.rows = new Map<unknown, unknown[]>([
    [
      schema.templateManifestCache,
      [
        { ...agent, setHash: 's' },
        { ...claudeRtk, templateKind: 'rtk-config', setHash: 's' },
        { ...geminiRtk, templateKind: 'rtk-config', setHash: 's' },
      ],
    ],
    [
      schema.cliProviders,
      [
        { name: 'claude-code', rulesContent: '', enabled: true },
        { name: 'codex', rulesContent: '', enabled: true },
        { name: 'gemini', rulesContent: '', enabled: false },
      ],
    ],
    [schema.onboardingArtifacts, liveRows(cell.rows)],
    [schema.tasks, cell.history === 'none' ? [] : [{ id: 'onboarding-1', metadata: null }]],
    [
      schema.taskSteps,
      cell.history === 'recorded'
        ? [{ recorded: true }]
        : cell.history === 'unrecorded'
          ? [{ recorded: false }]
          : [],
    ],
  ]);
}

const list = (items: unknown): string =>
  Array.isArray(items) && items.length > 0 ? (items as string[]).join(',') : '-';

/** What the grid pins about an answer: whether the banner shows at all, the templates it counts as
 *  changed (the RTK ones are the providers' RTK add-back), and the RTK files and blocks it offers
 *  to take out. */
async function answerFor(): Promise<string> {
  const res = await app.request('/repo-1/upgrade-status');
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  return [
    `onboarded=${String(body.isOnboarded)}`,
    `available=${String(body.hasUpgradeAvailable)}`,
    `changed=${list([...((body.changedTemplateIds as string[]) ?? [])].sort())}`,
    `rtkSettings=${list(body.rtkSettingsLeftovers)}`,
    `rtkBlocks=${list(body.rtkBlockLeftovers)}`,
  ].join(' ');
}

const EXPECTED: Record<string, string> = {
  'rows=none 07=recorded source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=recorded source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=none 07=recorded source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=recorded source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=none 07=unrecorded source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=unrecorded source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=none 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=none 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=none 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=none 07=none source=git_https live=on':
    'onboarded=false available=false changed=- rtkSettings=- rtkBlocks=-',
  'rows=none 07=none source=git_https live=off':
    'onboarded=false available=false changed=- rtkSettings=- rtkBlocks=-',
  'rows=none 07=none source=blank live=on':
    'onboarded=false available=false changed=- rtkSettings=- rtkBlocks=-',
  'rows=none 07=none source=blank live=off':
    'onboarded=false available=false changed=- rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=recorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=recorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=no-snapshot 07=recorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=recorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=no-snapshot 07=unrecorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=unrecorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=no-snapshot 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=no-snapshot 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=no-snapshot 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=no-snapshot 07=none source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=none source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=no-snapshot 07=none source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=none source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=recorded 07=recorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=recorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=recorded 07=recorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=recorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=recorded 07=unrecorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=unrecorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=recorded 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=recorded 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=recorded 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=recorded 07=none source=git_https live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=none source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=recorded 07=none source=blank live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=none source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=recorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=recorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=recorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=recorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=unrecorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=unrecorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=none source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=none source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=none source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=none source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=recorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=recorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=recorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=recorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=mixed 07=unrecorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=unrecorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=mixed 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=mixed 07=none source=git_https live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=none source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=none source=blank live=on':
    'onboarded=true available=true changed=cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=none source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
};

describe('GRID: upgrade-status resolves RTK: the characterization grid', () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-grid-'));
    await writeRtkRepo(repo);
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('has one answer per cell, and no cell without one', () => {
    expect(allCells().map(cellKey).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(COLUMNS.map(([name]) => name)).toEqual([
      'key absent',
      'NULL',
      'refused {}',
      'refused unknown key',
    ]);
  });

  it.each(allCells().map((cell): [string, Cell] => [cellKey(cell), cell]))(
    '%s',
    async (key, cell) => {
      for (const [column, value] of COLUMNS) {
        seed(cell, repo, value);
        const got = await answerFor();
        expect({ column, got }).toEqual({ column, got: EXPECTED[key] });
      }
    },
  );
});
