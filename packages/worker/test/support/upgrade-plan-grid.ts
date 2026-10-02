import type { Fake } from './upgrade-plan-fixtures.js';
import {
  ctxFor,
  newDb,
  seedLiveRow,
  seedOnboarding,
  seedProviders,
  seedRepository,
} from './upgrade-plan-fixtures.js';
import {
  RenderContextUnresolvedError,
  upgradePlanStep,
  type UpgradePlanDetect,
} from '../../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';

/** The characterization grid of 01's render-context resolution: the state of the repository's live
 *  artifact rows, of the step 07 output of its completed onboarding, and its source, crossed with
 *  the live RTK switch and with a column the resolver must not read. */
export const ROW_STATES = ['none', 'no-snapshot', 'recorded', 'unrecorded', 'mixed'] as const;
export const HISTORY_STATES = ['recorded', 'unrecorded', 'missing-row', 'none'] as const;
export const SOURCES = ['git_https', 'blank'] as const;

export type RowState = (typeof ROW_STATES)[number];
export type HistoryState = (typeof HISTORY_STATES)[number];
export type Source = (typeof SOURCES)[number];

export interface Cell {
  rows: RowState;
  history: HistoryState;
  source: Source;
  /** The repository's live RTK switch. */
  live: boolean;
}

export const cellKey = (c: Cell): string =>
  `rows=${c.rows} 07=${c.history} source=${c.source} live=${c.live ? 'on' : 'off'}`;

export const allCells = (): Cell[] =>
  ROW_STATES.flatMap((rows) =>
    HISTORY_STATES.flatMap((history) =>
      SOURCES.flatMap((source) => [true, false].map((live) => ({ rows, history, source, live }))),
    ),
  );

/** The render context a live row snapshots; its framework names the row that supplied it. */
export const rowSnapshot = (framework: string, rtk?: boolean): Record<string, unknown> => ({
  projectInfo: { name: framework },
  framework,
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
  lspLanguages: [],
  ...(rtk === undefined ? {} : { rtkEnabled: rtk }),
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
});

/** Step 07's detect output. The unrecorded one is a run from before RTK and before the targets. */
export const detect07 = (framework: string, recorded: boolean): Record<string, unknown> => ({
  framework,
  language: 'php',
  projectName: framework,
  projectInfo: { name: framework },
  acceptedAgentIds: ['code-reviewer', 'security-auditor'],
  customAgentSpecs: [],
  lspLanguages: ['php-extended'],
  mcpSettingsJson: '',
  cliProviders: [{ name: 'claude-code', rulesContent: '' }],
  plannedAgents: [],
  existingFiles: [],
  unmanagedAgentFiles: [],
  ...(recorded
    ? {
        agentTargets: [{ dir: '.claude/agents', format: 'markdown' }],
        rtkEnabled: false,
        enabledCliProviders: [
          { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
        ],
      }
    : {}),
});

export function seedRows(fake: Fake, rows: RowState): void {
  if (rows === 'no-snapshot') {
    seedLiveRow(fake, { path: '.claude/agents/row-0.md', snapshot: null, at: 1000 });
  }
  if (rows === 'recorded' || rows === 'mixed') {
    seedLiveRow(fake, {
      path: '.claude/agents/row-0.md',
      snapshot: rowSnapshot('rows-recorded', false),
      at: 1000,
    });
  }
  if (rows === 'unrecorded') {
    seedLiveRow(fake, {
      path: '.claude/agents/row-0.md',
      snapshot: rowSnapshot('rows-unrecorded'),
      at: 1000,
    });
  }
  if (rows === 'mixed') {
    seedLiveRow(fake, {
      path: '.claude/agents/row-1.md',
      snapshot: rowSnapshot('rows-unrecorded'),
      at: 2000,
    });
  }
}

export function seedHistory(fake: Fake, history: HistoryState): void {
  if (history === 'recorded') seedOnboarding(fake, detect07('history-recorded', true));
  if (history === 'unrecorded') seedOnboarding(fake, detect07('history-unrecorded', false));
  if (history === 'missing-row') seedOnboarding(fake);
}

/** Columns the resolver must read as NULL: none the schema accepts. */
export const PORTABLE_COLUMN = {
  projectInfo: { name: 'column' },
  framework: 'column',
  acceptedAgentIds: ['column-agent'],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkChoiceRecorded: true,
};
export const COLUMNS: Record<string, unknown> = {
  NULL: null,
  'refused {}': {},
  'refused unknown key': { ...PORTABLE_COLUMN, somethingNew: true },
};

export type CellResult = { error: string } | { detected: UpgradePlanDetect };

export async function runCell(cell: Cell, repoPath: string, column: unknown): Promise<CellResult> {
  const fake = newDb();
  seedProviders(fake);
  seedRepository(fake, { source: cell.source, rtkEnabled: cell.live, renderContext: column });
  seedRows(fake, cell.rows);
  seedHistory(fake, cell.history);
  try {
    return { detected: await upgradePlanStep.detect!(ctxFor(fake, repoPath)) };
  } catch (err) {
    if (err instanceof RenderContextUnresolvedError) return { error: err.message };
    throw err;
  }
}

const list = (items: readonly string[]): string => (items.length === 0 ? '-' : items.join(','));

/** What the grid pins about an answer: the context's source and RTK choice, whether it follows the
 *  live switch, the RTK settings files offered for removal and the rules files still holding RTK. */
export function summarize(result: CellResult): string {
  if ('error' in result) return `error: ${result.error}`;
  const d = result.detected;
  const ctx = d.renderCtxSnapshot;
  const rtkEntries = d.entries
    .filter((e) => e.templateKind === 'rtk-config')
    .map((e) => `${e.diskPath}:${e.bucket}`)
    .sort();
  return [
    `framework=${String(ctx.framework)}`,
    `rtkEnabled=${String(ctx.rtkEnabled)}`,
    `follows=${String(d.rtkFollowsLive)}`,
    `rtkEntries=${list(rtkEntries)}`,
    `leftovers=${list(d.rtkBlockLeftovers ?? [])}`,
    `backfill=${String(d.ranBackfill)}`,
  ].join(' ');
}
