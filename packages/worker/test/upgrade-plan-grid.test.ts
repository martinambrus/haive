import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeRtkRepo } from './support/upgrade-plan-fixtures.js';
import {
  COLUMNS,
  allCells,
  cellKey,
  runCell,
  summarize,
  type Cell,
} from './support/upgrade-plan-grid.js';

/**
 * The characterization grid of 01's render-context resolution: what the plan renders from, and what
 * it says about RTK, for every state of the repository's live artifact rows, of its step 07 output
 * and of its source, under each live RTK switch. Written against main before the shared resolution
 * order and the column read exist, and it must give the same answers after both: the column is
 * absent, NULL or refused in every cell, and a column the schema refuses reads as NULL.
 *
 * The answers are literals captured from main. A cell whose context is a pre-RTK snapshot answers
 * `rtkEnabled=undefined`: the snapshot carries no such key, and main passes it through as it is.
 */
const EXPECTED: Record<string, string> = {
  'rows=none 07=recorded source=git_https live=on':
    'framework=history-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=true',
  'rows=none 07=recorded source=git_https live=off':
    'framework=history-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=true',
  'rows=none 07=recorded source=blank live=on':
    'framework=history-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=true',
  'rows=none 07=recorded source=blank live=off':
    'framework=history-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=true',
  'rows=none 07=unrecorded source=git_https live=on':
    'framework=history-unrecorded rtkEnabled=false follows=false rtkEntries=- leftovers=AGENTS.md backfill=true',
  'rows=none 07=unrecorded source=git_https live=off':
    'framework=history-unrecorded rtkEnabled=false follows=false rtkEntries=- leftovers=AGENTS.md backfill=true',
  'rows=none 07=unrecorded source=blank live=on':
    'framework=history-unrecorded rtkEnabled=false follows=false rtkEntries=- leftovers=AGENTS.md backfill=true',
  'rows=none 07=unrecorded source=blank live=off':
    'framework=history-unrecorded rtkEnabled=false follows=false rtkEntries=- leftovers=AGENTS.md backfill=true',
  'rows=none 07=missing-row source=git_https live=on':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=none 07=missing-row source=git_https live=off':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=none 07=missing-row source=blank live=on':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=none 07=missing-row source=blank live=off':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=none 07=none source=git_https live=on':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=none 07=none source=git_https live=off':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=none 07=none source=blank live=on':
    'framework=null rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=true',
  'rows=none 07=none source=blank live=off':
    'framework=null rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=true',
  'rows=no-snapshot 07=recorded source=git_https live=on':
    'framework=history-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=no-snapshot 07=recorded source=git_https live=off':
    'framework=history-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=no-snapshot 07=recorded source=blank live=on':
    'framework=history-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=no-snapshot 07=recorded source=blank live=off':
    'framework=history-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=no-snapshot 07=unrecorded source=git_https live=on':
    'framework=history-unrecorded rtkEnabled=false follows=false rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=no-snapshot 07=unrecorded source=git_https live=off':
    'framework=history-unrecorded rtkEnabled=false follows=false rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=no-snapshot 07=unrecorded source=blank live=on':
    'framework=history-unrecorded rtkEnabled=false follows=false rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=no-snapshot 07=unrecorded source=blank live=off':
    'framework=history-unrecorded rtkEnabled=false follows=false rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=no-snapshot 07=missing-row source=git_https live=on':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=no-snapshot 07=missing-row source=git_https live=off':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=no-snapshot 07=missing-row source=blank live=on':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=no-snapshot 07=missing-row source=blank live=off':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=no-snapshot 07=none source=git_https live=on':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=no-snapshot 07=none source=git_https live=off':
    'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found',
  'rows=no-snapshot 07=none source=blank live=on':
    'framework=null rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=no-snapshot 07=none source=blank live=off':
    'framework=null rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=recorded 07=recorded source=git_https live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=recorded 07=recorded source=git_https live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=recorded 07=recorded source=blank live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=recorded 07=recorded source=blank live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=recorded 07=unrecorded source=git_https live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=recorded 07=unrecorded source=git_https live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=recorded 07=unrecorded source=blank live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=recorded 07=unrecorded source=blank live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=recorded 07=missing-row source=git_https live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=recorded 07=missing-row source=git_https live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=recorded 07=missing-row source=blank live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=recorded 07=missing-row source=blank live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=recorded 07=none source=git_https live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=recorded 07=none source=git_https live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=recorded 07=none source=blank live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=recorded 07=none source=blank live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=unrecorded 07=recorded source=git_https live=on':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=recorded source=git_https live=off':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=recorded source=blank live=on':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=recorded source=blank live=off':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=unrecorded source=git_https live=on':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=unrecorded source=git_https live=off':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=unrecorded source=blank live=on':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=unrecorded source=blank live=off':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=missing-row source=git_https live=on':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=missing-row source=git_https live=off':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=missing-row source=blank live=on':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=missing-row source=blank live=off':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=none source=git_https live=on':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=none source=git_https live=off':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=none source=blank live=on':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=unrecorded 07=none source=blank live=off':
    'framework=rows-unrecorded rtkEnabled=undefined follows=false rtkEntries=- leftovers=- backfill=false',
  'rows=mixed 07=recorded source=git_https live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=mixed 07=recorded source=git_https live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=mixed 07=recorded source=blank live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=mixed 07=recorded source=blank live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=mixed 07=unrecorded source=git_https live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=mixed 07=unrecorded source=git_https live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=mixed 07=unrecorded source=blank live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=mixed 07=unrecorded source=blank live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=mixed 07=missing-row source=git_https live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=mixed 07=missing-row source=git_https live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=mixed 07=missing-row source=blank live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=mixed 07=missing-row source=blank live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
  'rows=mixed 07=none source=git_https live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=mixed 07=none source=git_https live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=- leftovers=AGENTS.md backfill=false',
  'rows=mixed 07=none source=blank live=on':
    'framework=rows-recorded rtkEnabled=true follows=true rtkEntries=.claude/settings.json:new_artifact leftovers=- backfill=false',
  'rows=mixed 07=none source=blank live=off':
    'framework=rows-recorded rtkEnabled=false follows=true rtkEntries=.claude/settings.json:obsolete,.gemini/settings.json:obsolete leftovers=AGENTS.md backfill=false',
};

const NO_CONTEXT =
  'error: upgrade-plan: cannot resolve render context — no prior onboarding snapshot or step 07 output found';

describe('GRID: 01 resolves its render context: the characterization grid', () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'upgrade-plan-grid-'));
    await writeRtkRepo(repo);
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('has one answer per cell, and no cell without one', () => {
    expect(allCells().map(cellKey).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(COLUMNS)).toEqual(['NULL', 'refused {}', 'refused unknown key']);
  });

  it.each(allCells().map((cell): [string, Cell] => [cellKey(cell), cell]))(
    '%s',
    async (key, cell) => {
      for (const [column, value] of Object.entries(COLUMNS)) {
        const got = summarize(await runCell(cell, repo, value));
        expect({ column, got }).toEqual({ column, got: EXPECTED[key] });
      }
    },
  );

  it('throws the one named error only where no source resolves', () => {
    const throwing = Object.entries(EXPECTED).filter(([, answer]) => answer.startsWith('error:'));
    expect(throwing.map(([key]) => key).sort()).toEqual([
      'rows=no-snapshot 07=missing-row source=blank live=off',
      'rows=no-snapshot 07=missing-row source=blank live=on',
      'rows=no-snapshot 07=missing-row source=git_https live=off',
      'rows=no-snapshot 07=missing-row source=git_https live=on',
      'rows=no-snapshot 07=none source=git_https live=off',
      'rows=no-snapshot 07=none source=git_https live=on',
      'rows=none 07=missing-row source=blank live=off',
      'rows=none 07=missing-row source=blank live=on',
      'rows=none 07=missing-row source=git_https live=off',
      'rows=none 07=missing-row source=git_https live=on',
      'rows=none 07=none source=git_https live=off',
      'rows=none 07=none source=git_https live=on',
    ]);
    for (const [, answer] of throwing) expect(answer).toBe(NO_CONTEXT);
  });
});

const IMPORT_CLAUDE = { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' };
const TARGET_CLAUDE = { dir: '.claude/agents', format: 'markdown', supportsLsp: false };

describe('GRID: the contexts 01 renders from, in full', () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'upgrade-plan-grid-full-'));
    await writeRtkRepo(repo);
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const contextOf = async (cell: Cell, column: unknown = null) => {
    const result = await runCell(cell, repo, column);
    if (!('detected' in result)) throw new Error(result.error);
    return result.detected;
  };

  it('takes the snapshot of the live row that recorded RTK, with the live switch', async () => {
    const cell: Cell = { rows: 'mixed', history: 'recorded', source: 'git_https', live: false };
    for (const column of Object.values(COLUMNS)) {
      const detected = await contextOf(cell, column);
      expect(detected.renderCtxSnapshot).toEqual({
        projectInfo: { name: 'rows-recorded' },
        framework: 'rows-recorded',
        acceptedAgentIds: ['code-reviewer'],
        customAgentSpecs: [],
        agentTargets: [TARGET_CLAUDE],
        lspLanguages: [],
        rtkEnabled: false,
        enabledCliProviders: [IMPORT_CLAUDE],
      });
      expect(detected.rtkFollowsLive).toBe(true);
    }
  });

  it('keeps a snapshot from before RTK as it is, with no RTK key and no live switch', async () => {
    const cell: Cell = { rows: 'unrecorded', history: 'recorded', source: 'git_https', live: true };
    for (const column of Object.values(COLUMNS)) {
      const detected = await contextOf(cell, column);
      expect(detected.renderCtxSnapshot).toEqual({
        projectInfo: { name: 'rows-unrecorded' },
        framework: 'rows-unrecorded',
        acceptedAgentIds: ['code-reviewer'],
        customAgentSpecs: [],
        agentTargets: [TARGET_CLAUDE],
        lspLanguages: [],
        enabledCliProviders: [IMPORT_CLAUDE],
      });
      expect('rtkEnabled' in detected.renderCtxSnapshot).toBe(false);
      expect(detected.rtkFollowsLive).toBe(false);
    }
  });

  it('rebuilds the context of step 07, with the live switch where it recorded one', async () => {
    const recorded = await contextOf({
      rows: 'none',
      history: 'recorded',
      source: 'git_https',
      live: false,
    });
    expect(recorded.renderCtxSnapshot).toEqual({
      projectInfo: { name: 'history-recorded' },
      framework: 'history-recorded',
      acceptedAgentIds: ['code-reviewer', 'security-auditor'],
      customAgentSpecs: [],
      agentTargets: [{ ...TARGET_CLAUDE, supportsLsp: true }],
      lspLanguages: ['php-extended'],
      rtkEnabled: false,
      enabledCliProviders: [IMPORT_CLAUDE],
    });
    expect(recorded.rtkFollowsLive).toBe(true);
  });

  it('gives an output from before RTK and before the targets the fallbacks it always had', async () => {
    const detected = await contextOf({
      rows: 'none',
      history: 'unrecorded',
      source: 'git_https',
      live: true,
    });
    expect(detected.renderCtxSnapshot).toEqual({
      projectInfo: { name: 'history-unrecorded' },
      framework: 'history-unrecorded',
      acceptedAgentIds: ['code-reviewer', 'security-auditor'],
      customAgentSpecs: [],
      agentTargets: [TARGET_CLAUDE],
      lspLanguages: ['php-extended'],
      rtkEnabled: false,
      enabledCliProviders: [],
    });
    expect(detected.rtkFollowsLive).toBe(false);
  });

  it('rebuilds a blank repository from the providers its user has enabled now', async () => {
    for (const live of [true, false]) {
      const detected = await contextOf({ rows: 'none', history: 'none', source: 'blank', live });
      expect(detected.renderCtxSnapshot).toEqual({
        projectInfo: {
          name: 'acme',
          framework: null,
          primaryLanguage: null,
          description: null,
          localUrl: null,
          databaseType: null,
          databaseVersion: null,
          webserver: null,
          docroot: null,
          runtimeVersions: {},
          testFrameworks: [],
          testPaths: [],
          buildTool: null,
          commands: [],
          containerType: null,
        },
        framework: null,
        acceptedAgentIds: [],
        customAgentSpecs: [],
        agentTargets: [TARGET_CLAUDE, { dir: '.codex/agents', format: 'toml', supportsLsp: false }],
        lspLanguages: [],
        rtkEnabled: live,
        enabledCliProviders: [
          IMPORT_CLAUDE,
          { name: 'codex', rulesFile: 'AGENTS.md', rulesFileMode: 'native' },
        ],
      });
      expect(detected.rtkFollowsLive).toBe(true);
    }
  });

  it('adds no field to its detect output', async () => {
    const detected = await contextOf({
      rows: 'recorded',
      history: 'none',
      source: 'git_https',
      live: true,
    });
    expect(Object.keys(detected).sort()).toEqual([
      'counts',
      'currentTemplateSetHash',
      'entries',
      'installedTemplateSetHash',
      'missingRulesImports',
      'ranBackfill',
      'renderCtxSnapshot',
      'repositoryId',
      'rtkBlockLeftovers',
      'rtkFollowsLive',
    ]);
  });
});
