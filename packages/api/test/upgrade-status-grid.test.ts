import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import {
  CLI_RULES_TEMPLATE_ID,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  buildClaudeSettingsJson,
  buildCliRulesBlockFromProviders,
  buildGeminiSettingsJson,
  bundleAgentTemplateHash,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';

const { state } = vi.hoisted(() => ({
  state: {
    userId: 'user-1',
    repo: null as Record<string, unknown> | null,
    rows: new Map<unknown, unknown[]>(),
    onboarded: false,
    snapshotGroups: [] as unknown[],
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
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const q = {
          where: () => q,
          innerJoin: () => q,
          orderBy: () => q,
          groupBy: () => q,
          limit: () => q,
          then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
            Promise.resolve(
              fields && 'ids' in fields ? state.snapshotGroups : (state.rows.get(table) ?? []),
            ).then(resolve, reject),
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
  diskPath: id === 'row-1' ? '.codex/agents/x.toml' : '.claude/agents/x.md',
  templateId: agent.templateId,
  templateKind: 'agent',
  templateSchemaVersion: agent.schemaVersion,
  templateContentHash: agent.contentHash,
  bundleItemId: null,
  haiveVersion: null,
  repositoryId: 'repo-1',
  generatedAt: new Date(at),
  hasSnapshot: snapshot === 'none' ? null : true,
  rtkRecorded: snapshot === 'recorded' ? true : null,
  // Match the complete raw snapshot selected by the real route, so canonical membership recovery
  // can distinguish newest target provenance from the older RTK-recorded context.
  formValuesSnapshot:
    snapshot === 'none'
      ? null
      : {
          projectInfo: {},
          framework: null,
          acceptedAgentIds: ['x'],
          customAgentSpecs: [],
          lspLanguages: [],
          enabledCliProviders: [
            {
              name: snapshot === 'recorded' ? 'gemini' : 'claude-code',
              rulesFile: snapshot === 'recorded' ? 'GEMINI.md' : 'CLAUDE.md',
              rulesFileMode: 'import',
            },
          ],
          ...(snapshot === 'recorded' ? { rtkEnabled: true } : {}),
        },
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
    [
      schema.tasks,
      cell.history === 'none'
        ? []
        : [
            {
              id: 'onboarding-1',
              repositoryId: 'repo-1',
              type: 'onboarding',
              status: 'completed',
              completedAt: new Date(1),
              metadata: null,
            },
          ],
    ],
    [
      schema.taskSteps,
      cell.history === 'recorded'
        ? [{ detected: true, recorded: true }]
        : cell.history === 'unrecorded'
          ? [{ detected: true, recorded: false }]
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
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
  'rows=none 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=-',
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
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=none source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=none source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=none source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=no-snapshot 07=none source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=recorded 07=recorded source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=recorded source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=recorded 07=recorded source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=recorded source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=recorded 07=unrecorded source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=unrecorded source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=recorded 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=recorded 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=recorded 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=recorded 07=none source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=none source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=recorded 07=none source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.gemini-settings rtkSettings=- rtkBlocks=-',
  'rows=recorded 07=none source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=unrecorded 07=recorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=recorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=recorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=recorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=unrecorded source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=unrecorded source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=none source=git_https live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=none source=git_https live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=none source=blank live=on':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=unrecorded 07=none source=blank live=off':
    'onboarded=true available=true changed=cli-rules rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=recorded source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.claude-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=recorded source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=recorded source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.claude-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=recorded source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=mixed 07=unrecorded source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.claude-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=unrecorded source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=unrecorded source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.claude-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=unrecorded source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=mixed 07=missing-row source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.claude-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=missing-row source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=missing-row source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.claude-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=missing-row source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
  'rows=mixed 07=none source=git_https live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.claude-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=none source=git_https live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=- rtkBlocks=AGENTS.md',
  'rows=mixed 07=none source=blank live=on':
    'onboarded=true available=true changed=agent.x,cli-rules,rtk.claude-settings rtkSettings=- rtkBlocks=-',
  'rows=mixed 07=none source=blank live=off':
    'onboarded=true available=true changed=agent.x,cli-rules rtkSettings=.claude/settings.json,.gemini/settings.json rtkBlocks=AGENTS.md',
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

describe('the banner reads the context the plan reads', () => {
  const cell: Cell = { rows: 'unrecorded', history: 'recorded', source: 'git_https', live: false };
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'upgrade-status-snapshots-'));
    await writeRtkRepo(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('S-a: does not count a snapshot that does not decode as a render context', async () => {
    seed(cell, dir, null);
    state.rows.set(schema.onboardingArtifacts, [
      artifact('row-0', 1000, 'unrecorded'),
      artifact('row-1', 2000, 'recorded'),
    ]);
    state.snapshotGroups = [];
    const counted = await answerFor();
    state.snapshotGroups = [{ snapshot: { rtkEnabled: false }, ids: ['row-1'] }];
    const refused = await answerFor();
    state.snapshotGroups = [];

    expect(counted).toContain('rtkBlocks=AGENTS.md');
    expect(refused).toContain('rtkBlocks=-');
  });

  it('S-c: offers no RTK block on a snapshot from before RTK, switch off', async () => {
    seed(cell, dir, null);
    expect(await answerFor()).toContain('rtkBlocks=-');
  });
});

describe('a switch a person made on this install counts as the team’s choice', () => {
  const SWITCHED = new Date(1000);
  const UNRECORDED_COLUMN = { ...PORTABLE_COLUMN, rtkChoiceRecorded: false };
  const cellOf = (rows: RowState, history: HistoryState, live: boolean): Cell => ({
    rows,
    history,
    source: 'git_https',
    live,
  });
  const ORIGINS: [string, (live: boolean) => Cell, unknown][] = [
    [
      'a column that recorded no choice',
      (live) => cellOf('none', 'recorded', live),
      UNRECORDED_COLUMN,
    ],
    ['a snapshot from before RTK', (live) => cellOf('unrecorded', 'recorded', live), null],
    ['a step 07 output from before RTK', (live) => cellOf('none', 'unrecorded', live), null],
  ];

  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'upgrade-status-switched-'));
    await writeRtkRepo(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function answer(cell: Cell, column: unknown, switched: boolean): Promise<string> {
    seed(cell, dir, column);
    state.snapshotGroups = [];
    if (switched) {
      state.repo = { ...(state.repo as Record<string, unknown>), rtkChoiceMadeAt: SWITCHED };
    }
    return answerFor();
  }

  it.each(ORIGINS.slice(0, 2))(
    'offers the RTK settings files when RTK is on, from %s',
    async (_name, cellFor, column) => {
      const switched = await answer(cellFor(true), column, true);
      const never = await answer(cellFor(true), column, false);

      expect(switched).toMatch(/changed=\S*rtk\.claude-settings/);
      expect(switched).toContain('available=true');
      expect(never).not.toContain('rtk.');
    },
  );

  it.each(ORIGINS)(
    'reports the block left in AGENTS.md when RTK is off, from %s',
    async (_name, cellFor, column) => {
      const switched = await answer(cellFor(false), column, true);
      const never = await answer(cellFor(false), column, false);

      expect(switched).toContain('rtkBlocks=AGENTS.md');
      expect(switched).toContain('available=true');
      expect(never).toContain('rtkBlocks=-');
    },
  );

  describe('from a step 07 output that names its providers', () => {
    async function fromHistory(recorded: boolean, switched: boolean): Promise<string> {
      seed(cellOf('none', recorded ? 'recorded' : 'unrecorded', true), dir, null);
      state.snapshotGroups = [];
      state.rows.set(schema.taskSteps, [
        { detected: true, recorded, enabledCliProviders: [{ name: 'claude-code' }] },
      ]);
      if (switched) {
        state.repo = { ...(state.repo as Record<string, unknown>), rtkChoiceMadeAt: SWITCHED };
      }
      return answerFor();
    }

    it('offers the RTK settings files of its providers once a person switched RTK on', async () => {
      const switched = await fromHistory(false, true);

      expect(switched).toMatch(/changed=\S*rtk\.claude-settings/);
      expect(switched).not.toContain('rtk.gemini-settings');
      expect(switched).toContain('available=true');
      expect(await fromHistory(false, false)).not.toContain('rtk.');
    });

    it('offers them for a step 07 output that recorded the choice', async () => {
      expect(await fromHistory(true, false)).toMatch(/changed=\S*rtk\.claude-settings/);
    });
  });

  it.each([ORIGINS[0]!, ORIGINS[2]!])(
    'reports the settings files left behind when RTK is off, from %s',
    async (_name, cellFor, column) => {
      const switched = await answer(cellFor(false), column, true);
      const never = await answer(cellFor(false), column, false);

      expect(switched).toContain('rtkSettings=.claude/settings.json,.gemini/settings.json');
      expect(never).toContain('rtkSettings=-');
    },
  );
});

/**
 * An install that adopted a teammate's RTK value records the choice in its column (flag true), so the
 * banner counts the RTK settings file a teammate's record installed as current; before, the column
 * read as unrecorded and the same row read as a change to take out.
 */
describe('a column that records the RTK choice keeps the installed RTK settings current', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'upgrade-status-adopted-'));
    await writeRtkRepo(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rtkRow = {
    ...artifact('row-rtk', 1000, 'none'),
    diskPath: '.claude/settings.json',
    templateId: claudeRtk.templateId,
    templateKind: 'rtk-config',
    templateSchemaVersion: claudeRtk.schemaVersion,
    templateContentHash: claudeRtk.contentHash,
  };
  async function answerWith(flag: boolean): Promise<string> {
    seed({ rows: 'none', history: 'recorded', source: 'git_https', live: true }, dir, {
      ...PORTABLE_COLUMN,
      rtkChoiceRecorded: flag,
    });
    state.snapshotGroups = [];
    state.rows.set(schema.onboardingArtifacts, [rtkRow]);
    return answerFor();
  }

  it('offers the installed RTK settings as a change while the column records no choice', async () => {
    const answer = await answerWith(false);

    expect(answer).toMatch(/changed=\S*rtk\.claude-settings/);
    expect(answer).toContain('available=true');
  });

  it('counts them as current once the column records the choice', async () => {
    const answer = await answerWith(true);

    expect(answer).not.toContain('rtk.claude-settings');
  });
});

/**
 * #242-1 and #234: the banner and 01 agree on which paths a repository's templates render to. A
 * custom item 01 cannot render (no agent target, no skills directory) is no upgrade, a live row of
 * one 01 would remove is, and so is a row at a path the template no longer renders to, such as the
 * skills directory of a CLI since disabled, whatever the hashes say.
 */
describe('the banner and the plan agree on the paths a template renders to', () => {
  const SPEC_AGENT = {
    id: 'a1',
    title: 'Agent',
    description: 'A bundle agent',
    color: 'blue',
    field: 'qa',
    tools: [],
    coreMission: 'Review',
    responsibilities: [],
    whenInvoked: [],
    executionSteps: [],
    outputFormat: '',
    qualityCriteria: [],
    antiPatterns: [],
  };
  const SPEC_SKILL = { id: 'sk', title: 'Skill', description: 'A bundle skill' };
  const AMP_ONLY = [{ name: 'amp', rulesContent: '', enabled: true }];
  const CLAUDE_ONLY = [
    { name: 'claude-code', rulesContent: '', enabled: true },
    { name: 'codex', rulesContent: '', enabled: false },
    { name: 'gemini', rulesContent: '', enabled: false },
  ];
  const NO_CLI = [{ name: 'claude-code', rulesContent: '', enabled: false }];
  const portable = { ...PORTABLE_COLUMN, rtkEnabled: true };

  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'upgrade-status-targets-'));
    await writeFile(path.join(dir, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const row = (
    templateId: string,
    templateKind: string,
    diskPath: string,
    contentHash: string,
  ) => ({
    id: `row-${diskPath}`,
    diskPath,
    templateId,
    templateKind,
    templateSchemaVersion: 1,
    templateContentHash: contentHash,
    writtenHash: 'w',
    bundleItemId: templateId.startsWith('custom.') ? templateId.split('.')[2] : null,
    haiveVersion: null,
    repositoryId: 'repo-1',
    generatedAt: new Date(1000),
    hasSnapshot: null,
    rtkRecorded: null,
    snapshotProviders: null,
  });
  const item = (itemId: string, kind: 'agent' | 'skill', spec: Record<string, unknown>) => ({
    itemId,
    bundleId: 'b1',
    kind,
    schemaVersion: 1,
    contentHash: 'h-c',
    normalizedSpec: spec,
  });

  /** A repository in sync apart from what the cell puts in: its rules row is current, so the
   *  banner's answer is down to the custom or agent rows it adds. */
  function world(args: {
    providers: { name: string; rulesContent: string; enabled: boolean }[];
    column: unknown;
    applicable?: string[];
    items?: ReturnType<typeof item>[];
    rows: Record<string, unknown>[];
  }): void {
    const block = buildCliRulesBlockFromProviders(args.providers);
    const rules = block
      ? [row(CLI_RULES_TEMPLATE_ID, 'cli-rules', 'AGENTS.md', sha256Hex(normalizeContent(block)))]
      : [];
    state.onboarded = true;
    state.snapshotGroups = [];
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: args.applicable ?? [],
      storagePath: dir,
      localPath: null,
      rtkEnabled: true,
      source: 'blank',
      status: 'ready',
      onboardedAt: null,
      onboardingResetAt: null,
      renderContext: args.column,
    };
    state.rows = new Map<unknown, unknown[]>([
      [schema.templateManifestCache, [{ ...agent, templateKind: 'agent', setHash: 's' }]],
      [schema.cliProviders, args.providers],
      [schema.onboardingArtifacts, [...rules, ...args.rows]],
      [schema.customBundleItems, args.items ?? []],
      [schema.customBundles, [{ name: 'House bundle' }]],
      [
        schema.tasks,
        [
          {
            id: 'onboarding-1',
            repositoryId: 'repo-1',
            type: 'onboarding',
            status: 'completed',
            completedAt: new Date(1),
            metadata: null,
          },
        ],
      ],
      [schema.taskSteps, [{ detected: true, recorded: true }]],
    ]);
  }

  async function body(): Promise<Record<string, unknown>> {
    const res = await app.request('/repo-1/upgrade-status');
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  it('A1: offers no upgrade for a bundle agent a repository with no agent target cannot render', async () => {
    world({
      providers: AMP_ONLY,
      column: { ...portable, agentTargets: [] },
      items: [item('a1', 'agent', SPEC_AGENT)],
      rows: [],
    });
    const got = await body();
    expect(got.changedTemplateIds).toEqual([]);
    expect(got.hasUpgradeAvailable).toBe(false);
  });

  it('A2: reports the rows of a bundle skill no skills directory exists for as an obsolete change', async () => {
    world({
      providers: NO_CLI,
      column: { ...portable, agentTargets: [], enabledCliProviders: [] },
      items: [item('sk', 'skill', SPEC_SKILL)],
      rows: [row('custom.b1.sk', 'custom-skill', '.claude/skills/sk/SKILL.md', 'h-c')],
    });
    const got = await body();
    expect(got.changedTemplateIds).toEqual(['custom.b1.sk']);
    expect(got.obsoleteTemplateIds).toEqual(['custom.b1.sk']);
    expect(got.hasUpgradeAvailable).toBe(true);
  });

  it('B1: reports a skill row in the directory of a CLI since disabled, hashes unchanged', async () => {
    world({
      providers: CLAUDE_ONLY,
      column: portable,
      items: [item('sk', 'skill', SPEC_SKILL)],
      rows: [
        row('custom.b1.sk', 'custom-skill', '.claude/skills/sk/SKILL.md', 'h-c'),
        row('custom.b1.sk', 'custom-skill', '.agents/skills/sk/SKILL.md', 'h-c'),
      ],
    });
    const got = await body();
    expect(got.changedTemplateIds).toEqual(['custom.b1.sk']);
    expect(got.obsoleteTemplateIds).toEqual(['custom.b1.sk']);
    expect(got.hasUpgradeAvailable).toBe(true);
  });

  it('B2: reports an agent row in the directory of a CLI since disabled, on a column a sync filled', async () => {
    world({
      providers: CLAUDE_ONLY,
      column: portable,
      applicable: [agent.templateId],
      rows: [
        row(agent.templateId, 'agent', '.claude/agents/x.md', agent.contentHash),
        row(agent.templateId, 'agent', '.gemini/agents/x.md', agent.contentHash),
      ],
    });
    const got = await body();
    expect(got.changedTemplateIds).toEqual([agent.templateId]);
    expect(got.obsoleteTemplateIds).toEqual([agent.templateId]);
    expect(got.hasUpgradeAvailable).toBe(true);
  });

  const CLAUDE_AGENTS = [{ dir: '.claude/agents', format: 'markdown' }];
  const BOTH_CLIS = [
    { name: 'claude-code', rulesContent: '', enabled: true },
    { name: 'codex', rulesContent: '', enabled: true },
  ];
  const agentRows = () => [
    row(agent.templateId, 'agent', '.claude/agents/x.md', agent.contentHash),
    row(agent.templateId, 'agent', '.codex/agents/x.toml', agent.contentHash),
  ];

  it('B3: reads the targets a snapshot recorded, not the CLIs enabled now', async () => {
    world({
      providers: BOTH_CLIS,
      column: null,
      applicable: [agent.templateId],
      rows: agentRows().map((r, i) =>
        i === 0
          ? {
              ...r,
              hasSnapshot: true,
              rtkRecorded: true,
              snapshotProviders: [{ name: 'claude-code' }],
              snapshotAgentTargets: CLAUDE_AGENTS,
              snapshotLspLanguages: [],
            }
          : r,
      ),
    });
    const got = await body();
    expect(got.changedTemplateIds).toEqual([agent.templateId]);
    expect(got.obsoleteTemplateIds).toEqual([agent.templateId]);
  });

  it('judges no path where no render context resolves, as 01 plans nothing there', async () => {
    world({
      providers: CLAUDE_ONLY,
      column: null,
      items: [item('sk', 'skill', SPEC_SKILL)],
      rows: [
        row('custom.b1.sk', 'custom-skill', '.claude/skills/sk/SKILL.md', 'h-c'),
        row('custom.b1.sk', 'custom-skill', '.agents/skills/sk/SKILL.md', 'h-c'),
      ],
    });
    state.repo = { ...(state.repo as Record<string, unknown>), source: 'git' };
    state.rows.set(schema.taskSteps, []);
    const got = await body();
    expect(got.changedTemplateIds).toEqual([]);
    expect(got.hasUpgradeAvailable).toBe(false);
  });

  it('B4: reads the targets step 07 recorded when no column or snapshot is left', async () => {
    world({
      providers: BOTH_CLIS,
      column: null,
      applicable: [agent.templateId],
      rows: agentRows(),
    });
    state.rows.set(schema.taskSteps, [
      { detected: true, recorded: true, agentTargets: CLAUDE_AGENTS },
    ]);
    const got = await body();
    expect(got.changedTemplateIds).toEqual([agent.templateId]);
    expect(got.obsoleteTemplateIds).toEqual([agent.templateId]);
  });

  it('keeps a stranded row quiet while 02 would keep its file', async () => {
    const edited = path.join(dir, '.gemini/agents/x.md');
    await mkdir(path.dirname(edited), { recursive: true });
    await writeFile(edited, "a person's own bytes\n", 'utf8');
    try {
      world({
        providers: CLAUDE_ONLY,
        column: portable,
        applicable: [agent.templateId],
        rows: [
          row(agent.templateId, 'agent', '.claude/agents/x.md', agent.contentHash),
          row(agent.templateId, 'agent', '.gemini/agents/x.md', agent.contentHash),
        ],
      });
      const got = await body();
      expect(got.changedTemplateIds).toEqual([]);
      expect(got.hasUpgradeAvailable).toBe(false);
    } finally {
      await rm(path.join(dir, '.gemini'), { recursive: true, force: true });
    }
  });

  it('keeps a non-rendering bundle item quiet when a stale applicable set still names it', async () => {
    const edited = path.join(dir, '.claude/skills/sk/SKILL.md');
    await mkdir(path.dirname(edited), { recursive: true });
    await writeFile(edited, "a person's own bytes\n", 'utf8');
    try {
      world({
        providers: NO_CLI,
        column: { ...portable, agentTargets: [], enabledCliProviders: [] },
        applicable: ['custom.b1.sk'],
        items: [item('sk', 'skill', SPEC_SKILL)],
        rows: [row('custom.b1.sk', 'custom-skill', '.claude/skills/sk/SKILL.md', 'h-c')],
      });
      const got = await body();
      expect(got.changedTemplateIds).toEqual([]);
      expect(got.hasUpgradeAvailable).toBe(false);
    } finally {
      await rm(path.join(dir, '.claude/skills'), { recursive: true, force: true });
    }
  });

  it('stays quiet while every row stands at a path the template renders to', async () => {
    world({
      providers: CLAUDE_ONLY,
      column: portable,
      applicable: [agent.templateId],
      items: [item('sk', 'skill', SPEC_SKILL), item('a1', 'agent', SPEC_AGENT)],
      rows: [
        row(agent.templateId, 'agent', '.claude/agents/x.md', agent.contentHash),
        row('custom.b1.sk', 'custom-skill', '.claude/skills/sk/SKILL.md', 'h-c'),
        row('custom.b1.a1', 'custom-agent', '.claude/agents/a1.md', bundleAgentTemplateHash('h-c')),
      ],
    });
    const got = await body();
    expect(got.changedTemplateIds).toEqual([]);
    expect(got.hasUpgradeAvailable).toBe(false);
  });

  describe('a row imported from another install', () => {
    const imported = (r: Record<string, unknown>, haiveVersion: string | null = null) => ({
      ...r,
      source: 'backfill',
      sourceStepId: 'project-state-import',
      haiveVersion,
    });

    it('leaves the banner down for a claim at a path this install does not render to', async () => {
      world({
        providers: CLAUDE_ONLY,
        column: portable,
        applicable: [agent.templateId],
        rows: [
          row(agent.templateId, 'agent', '.claude/agents/x.md', agent.contentHash),
          imported(row(agent.templateId, 'agent', '.codex/agents/x.toml', agent.contentHash)),
        ],
      });
      const got = await body();
      expect(got.changedTemplateIds).toEqual([]);
      expect(got.hasUpgradeAvailable).toBe(false);
    });

    it('leaves the banner down for a claim from a newer release, whatever its hashes say', async () => {
      process.env.HAIVE_VERSION = '1.4.0';
      try {
        world({
          providers: CLAUDE_ONLY,
          column: portable,
          applicable: [agent.templateId],
          rows: [
            imported(row(agent.templateId, 'agent', '.claude/agents/x.md', 'h-newer'), '1.5.0'),
          ],
        });
        const got = await body();
        expect(got.changedTemplateIds).toEqual([]);
        expect(got.hasUpgradeAvailable).toBe(false);
      } finally {
        delete process.env.HAIVE_VERSION;
      }
    });

    it('leaves the banner down for a bundle item this install does not hold', async () => {
      world({
        providers: CLAUDE_ONLY,
        column: portable,
        applicable: [agent.templateId],
        rows: [
          row(agent.templateId, 'agent', '.claude/agents/x.md', agent.contentHash),
          imported(
            row('custom:git@host/a/b:items/y', 'custom-agent', '.claude/agents/y.md', 'h-c'),
          ),
        ],
      });
      const got = await body();
      expect(got.changedTemplateIds).toEqual([]);
      expect(got.hasUpgradeAvailable).toBe(false);
    });

    it('still raises the banner for a claim this install renders and can update', async () => {
      world({
        providers: CLAUDE_ONLY,
        column: portable,
        applicable: [agent.templateId],
        rows: [imported(row(agent.templateId, 'agent', '.claude/agents/x.md', 'h-old'))],
      });
      const got = await body();
      expect(got.changedTemplateIds).toEqual([agent.templateId]);
      expect(got.hasUpgradeAvailable).toBe(true);
    });
  });
});
