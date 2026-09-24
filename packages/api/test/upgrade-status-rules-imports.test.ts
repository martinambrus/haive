import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import {
  buildCliRulesBlockFromProviders,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_TEMPLATE_ID,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';

const { state } = vi.hoisted(() => ({
  state: {
    userId: 'user-1',
    repo: null as Record<string, unknown> | null,
    rows: new Map<unknown, unknown[]>(),
  },
}));

// The route reads through `select().from(table)` chains. Each table answers the rows the test put
// there, whatever the WHERE, so every row below is one the route would have selected.
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      repositories: { findFirst: async () => state.repo },
      tasks: { findFirst: async () => null },
    },
    select: () => ({
      from: (table: unknown) => {
        const q = {
          where: () => q,
          innerJoin: () => q,
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
