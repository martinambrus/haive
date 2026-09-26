import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import {
  buildClaudeSettingsJson,
  buildCliRulesBlockFromProviders,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_TEMPLATE_ID,
  normalizeContent,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  sha256Hex,
} from '@haive/shared';

const { state } = vi.hoisted(() => ({
  state: {
    userId: 'user-1',
    repo: null as Record<string, unknown> | null,
    rows: new Map<unknown, unknown[]>(),
    onboarded: false,
  },
}));

// The route reads through `select().from(table)` chains. Each table answers the rows the test put
// there, whatever the WHERE, so every row below is one the route would have selected.
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

/** A repository whose templates all match the current set, so only its rules files can make an
 *  upgrade available. */
function inSync(providers: { name: string; rulesContent: string; enabled: boolean }[]) {
  const block = buildCliRulesBlockFromProviders(providers);
  const agent = { templateId: 'agent.x', schemaVersion: 1, contentHash: 'h1' };
  const artifact = (templateId: string, templateSchemaVersion: number, hash: string) => ({
    templateId,
    templateSchemaVersion,
    templateContentHash: hash,
    bundleItemId: null,
    haiveVersion: null,
    generatedAt: null,
  });
  state.rows = new Map<unknown, unknown[]>([
    [schema.templateManifestCache, [{ ...agent, setHash: 's' }]],
    [schema.cliProviders, providers],
    [
      schema.onboardingArtifacts,
      [
        artifact(agent.templateId, agent.schemaVersion, agent.contentHash),
        ...(block
          ? [
              artifact(
                CLI_RULES_TEMPLATE_ID,
                CLI_RULES_SCHEMA_VERSION,
                sha256Hex(normalizeContent(block)),
              ),
            ]
          : []),
      ],
    ],
  ]);
}

const claude = { name: 'claude-code', rulesContent: '', enabled: true };

async function status(): Promise<Record<string, unknown>> {
  const res = await app.request('/repo-1/upgrade-status');
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('upgrade-status and the rules import', () => {
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-'));
    outside = await mkdtemp(path.join(tmpdir(), 'upgrade-status-out-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
    };
    inSync([claude]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reports nothing when the enabled providers rules files import AGENTS.md', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.missingRulesImports).toBeUndefined();
    expect(body.linkedRulesFiles).toBeUndefined();
  });

  it('offers an upgrade for a rules file that lacks the import', async () => {
    const body = await status();
    expect(body.changedTemplateIds).toEqual([]);
    expect(body.hasUpgradeAvailable).toBe(true);
    expect(body.missingRulesImports).toEqual(['CLAUDE.md']);
  });

  it('reports a rules file linked elsewhere without offering an upgrade for it', async () => {
    await writeFile(path.join(outside, 'CLAUDE.md'), '# elsewhere\n', 'utf8');
    await symlink(path.join(outside, 'CLAUDE.md'), path.join(repo, 'CLAUDE.md'));
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.missingRulesImports).toBeUndefined();
    expect(body.linkedRulesFiles).toEqual(['CLAUDE.md']);
  });

  it('claims nothing about a repository root it cannot read', async () => {
    state.repo = { ...state.repo, storagePath: path.join(repo, 'gone') };
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.missingRulesImports).toBeUndefined();
  });

  it('asks only the enabled providers for a rules file', async () => {
    inSync([
      { ...claude, enabled: false },
      { name: 'codex', rulesContent: '', enabled: true },
    ]);
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.missingRulesImports).toBeUndefined();
  });
});

describe('upgrade-status and a template rendered to several paths', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-paths-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
    };
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** agent.x rendered to two paths: one row current, one holding a restored edit's own hash. */
  const rows = (order: 'current-first' | 'edited-first') => {
    inSync([claude]);
    const artifacts = state.rows.get(schema.onboardingArtifacts)!;
    const edited = { ...(artifacts[0] as object), templateContentHash: 'h-edited' };
    state.rows.set(
      schema.onboardingArtifacts,
      order === 'current-first' ? [...artifacts, edited] : [edited, ...artifacts],
    );
  };

  it('offers an upgrade while any rendering is not current, whichever row comes first', async () => {
    for (const order of ['current-first', 'edited-first'] as const) {
      rows(order);
      const body = await status();
      expect(body.changedTemplateIds, order).toEqual(['agent.x']);
      expect(body.hasUpgradeAvailable, order).toBe(true);
    }
  });
});

describe('upgrade-status and a repository that switched RTK off', () => {
  let repo: string;
  let outside: string;
  const rtk = { templateId: 'rtk.claude-settings', schemaVersion: 1, contentHash: 'h-rtk' };
  const block = `${RTK_REF_MARKER_START}\nRTK is here.\n${RTK_REF_MARKER_END}\n`;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-rtk-'));
    outside = await mkdtemp(path.join(tmpdir(), 'upgrade-status-rtk-out-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    inSync([claude]);
    state.rows.get(schema.templateManifestCache)!.push({
      ...rtk,
      templateKind: 'rtk-config',
      setHash: 's',
    });
    state.rows.get(schema.onboardingArtifacts)!.push({
      templateId: rtk.templateId,
      templateSchemaVersion: rtk.schemaVersion,
      templateContentHash: rtk.contentHash,
      bundleItemId: null,
      haiveVersion: null,
      generatedAt: null,
    });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const repoRow = (rtkEnabled: boolean, applicable = ['agent.x', rtk.templateId]) => {
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: applicable,
      storagePath: repo,
      localPath: null,
      rtkEnabled,
    };
  };

  it('reports an installed RTK settings file as changed once RTK is off', async () => {
    repoRow(true);
    expect((await status()).hasUpgradeAvailable).toBe(false);
    repoRow(false);
    const body = await status();
    expect(body.changedTemplateIds).toEqual([rtk.templateId]);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('offers an upgrade for an RTK block left in a rules file once RTK is off', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), `# rules\n${block}`, 'utf8');
    repoRow(true, ['agent.x']);
    const on = await status();
    expect(on.hasUpgradeAvailable).toBe(false);
    expect(on.rtkBlockLeftovers).toBeUndefined();
    repoRow(false, ['agent.x']);
    const off = await status();
    expect(off.changedTemplateIds).toEqual([]);
    expect(off.rtkBlockLeftovers).toEqual(['AGENTS.md']);
    expect(off.hasUpgradeAvailable).toBe(true);
  });

  it('claims nothing for a block behind a link', async () => {
    await rm(path.join(repo, 'CLAUDE.md'));
    await writeFile(path.join(outside, 'CLAUDE.md'), `@AGENTS.md\n${block}`, 'utf8');
    await symlink(path.join(outside, 'CLAUDE.md'), path.join(repo, 'CLAUDE.md'));
    repoRow(false, ['agent.x']);
    const body = await status();
    expect(body.rtkBlockLeftovers).toBeUndefined();
  });
});

describe('upgrade-status and a repository that switched RTK back on', () => {
  let repo: string;
  const claudeRtk = { templateId: 'rtk.claude-settings', schemaVersion: 1, contentHash: 'h-rtk' };
  const geminiRtk = { templateId: 'rtk.gemini-settings', schemaVersion: 1, contentHash: 'h-gem' };

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-rtk-on-'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    inSync([claude]);
    for (const t of [claudeRtk, geminiRtk]) {
      state.rows.get(schema.templateManifestCache)!.push({
        ...t,
        templateKind: 'rtk-config',
        setHash: 's',
      });
    }
    // The upgrade that switched RTK off removed the settings file and wrote the snapshot without it.
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
      rtkEnabled: true,
    };
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** What every live row's render-context snapshot says about RTK and the providers. */
  const snapshots = (rtkRecorded: boolean | null, providers: unknown) => {
    const rows = state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[];
    state.rows.set(
      schema.onboardingArtifacts,
      rows.map((r) => ({ ...r, rtkRecorded, snapshotProviders: providers })),
    );
  };

  it('offers the settings file the recorded providers read once RTK is back on', async () => {
    snapshots(true, [{ name: 'claude-code' }]);
    const body = await status();
    expect(body.changedTemplateIds).toEqual([claudeRtk.templateId]);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('stays quiet with RTK off, for providers that read no file, and before RTK', async () => {
    const cases: Array<[string, boolean, boolean | null, unknown]> = [
      ['RTK off', false, true, [{ name: 'claude-code' }]],
      ['no provider reads one', true, true, [{ name: 'codex' }]],
      ['a snapshot from before RTK', true, null, [{ name: 'claude-code' }]],
    ];
    for (const [label, rtkEnabled, recorded, providers] of cases) {
      state.repo = { ...state.repo, rtkEnabled };
      snapshots(recorded, providers);
      const body = await status();
      expect(body.changedTemplateIds, label).toEqual([]);
      expect(body.hasUpgradeAvailable, label).toBe(false);
    }
  });

  it('reads the providers of the newest recorded snapshot, whatever order the rows come in', async () => {
    const rows = state.rows.get(schema.onboardingArtifacts) as Record<string, unknown>[];
    const recorded = (row: Record<string, unknown>, id: string, at: number, name: string) => ({
      ...row,
      id,
      generatedAt: new Date(at),
      rtkRecorded: true,
      snapshotProviders: [{ name }],
    });
    state.rows.set(schema.onboardingArtifacts, [
      ...rows.map((r, i) => recorded(r, `older-${i}`, 1000, 'gemini')),
      recorded(rows[0]!, 'newer', 2000, 'claude-code'),
    ]);
    const body = await status();
    expect(body.changedTemplateIds).toEqual([claudeRtk.templateId]);
  });

  it('reads a settings file the off-upgrade kept as installed, not as missing', async () => {
    snapshots(true, [{ name: 'claude-code' }]);
    state.rows.get(schema.onboardingArtifacts)!.push({
      templateId: claudeRtk.templateId,
      templateSchemaVersion: claudeRtk.schemaVersion,
      templateContentHash: claudeRtk.contentHash,
      bundleItemId: null,
      haiveVersion: null,
      generatedAt: null,
      rtkRecorded: true,
      snapshotProviders: [{ name: 'claude-code' }],
    });
    const body = await status();
    expect(body.changedTemplateIds).toEqual([]);
    expect(body.hasUpgradeAvailable).toBe(false);
  });
});

describe('upgrade-status and an upgrade that only removed files', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-removed-'));
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: [],
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
    };
    // No live row and no completed onboarding: the upgrade removed the only files a row recorded.
    state.rows = new Map<unknown, unknown[]>([
      [
        schema.templateManifestCache,
        [{ templateId: 'agent.x', schemaVersion: 1, contentHash: 'h1', setHash: 's' }],
      ],
      [schema.tasks, [{ id: 'upgrade-1', metadata: null }]],
      [schema.taskSteps, [{ output: { removedPaths: ['.claude/settings.json'] } }]],
    ]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('answers as onboarded, so the banner offers its rollback', async () => {
    const body = await status();
    expect(body.isOnboarded).toBe(true);
    expect(body.hasPriorUpgrade).toBe(true);
  });
});

describe('upgrade-status and the RTK settings files no row records', () => {
  let repo: string;
  const settings = (text: string) => writeFile(path.join(repo, '.claude/settings.json'), text);

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-status-rtk-settings-'));
    await mkdir(path.join(repo, '.claude'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# rules\n', 'utf8');
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    state.onboarded = false;
    state.repo = {
      id: 'repo-1',
      applicableTemplateIds: ['agent.x'],
      storagePath: repo,
      localPath: null,
      rtkEnabled: false,
      source: 'blank',
    };
    inSync([claude]);
    // Rows elsewhere, from a snapshot that recorded RTK: 01 follows the switch and probes.
    state.rows.set(
      schema.onboardingArtifacts,
      state.rows.get(schema.onboardingArtifacts)!.map((a, i) => ({
        ...(a as object),
        id: `row-${i}`,
        diskPath: `.claude/agents/row-${i}.md`,
        hasSnapshot: true,
        rtkRecorded: true,
      })),
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('offers the upgrade for the settings file a blank scaffold seeded', async () => {
    await settings(buildClaudeSettingsJson());
    const body = await status();
    expect(body.rtkSettingsLeftovers).toEqual(['.claude/settings.json']);
    expect(body.hasUpgradeAvailable).toBe(true);
  });

  it('and for one edited around its hook', async () => {
    const edited = JSON.parse(buildClaudeSettingsJson()) as Record<string, unknown>;
    edited.theme = 'dark';
    await settings(`${JSON.stringify(edited, null, 2)}\n`);
    const body = await status();
    expect(body.rtkSettingsLeftovers).toEqual(['.claude/settings.json']);
  });

  it('not for a settings file without the hook', async () => {
    await settings('{\n  "theme": "dark"\n}\n');
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
    expect(body.hasUpgradeAvailable).toBe(false);
  });

  it('not while RTK is on', async () => {
    await settings(buildClaudeSettingsJson());
    state.repo = { ...state.repo, rtkEnabled: true };
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
  });

  it('not for a path a live row records', async () => {
    await settings(buildClaudeSettingsJson());
    const rows = state.rows.get(schema.onboardingArtifacts)!;
    rows.push({ ...(rows[0] as object), id: 'settings-row', diskPath: '.claude/settings.json' });
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
  });

  it('not where the plan renders from snapshots that predate RTK', async () => {
    await settings(buildClaudeSettingsJson());
    state.rows.set(
      schema.onboardingArtifacts,
      state.rows
        .get(schema.onboardingArtifacts)!
        .map((a) => ({ ...(a as object), rtkRecorded: false })),
    );
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
    expect(body.hasUpgradeAvailable).toBe(false);
  });

  it('not for a repository that was not blank and has rows of its own', async () => {
    await settings(buildClaudeSettingsJson());
    state.repo = { ...state.repo, source: 'git' };
    const body = await status();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
  });

  it('for a repository with no rows whose onboarding recorded the choice, and not otherwise', async () => {
    await settings(buildClaudeSettingsJson());
    state.onboarded = true;
    state.repo = { ...state.repo, source: 'git' };
    state.rows.set(schema.onboardingArtifacts, []);
    state.rows.set(schema.tasks, [{ id: 'onboarding-1', metadata: null }]);
    state.rows.set(schema.taskSteps, [{ recorded: true }]);
    expect((await status()).rtkSettingsLeftovers).toEqual(['.claude/settings.json']);
    state.rows.set(schema.taskSteps, [{ recorded: false }]);
    expect((await status()).rtkSettingsLeftovers).toBeUndefined();
  });
});
