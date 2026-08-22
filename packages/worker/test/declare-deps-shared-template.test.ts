import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { declareDepsStep } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type {
  DeclareDepsDetect,
  DeclareDepsFormValues,
} from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

// 02-generate-dockerfile relinks tasks onto each other's env templates, so the row
// apply() finds via getTaskEnvTemplate can define OTHER tasks' environments too.
// Rewriting a changed definition into it would switch their php/database/webserver
// with no event and force each of them to rebuild.

interface Harness {
  ctx: StepContext;
  updated: Record<string, unknown>[];
  inserted: Record<string, unknown>[];
}

function makeHarness(
  existing: { id: string; baseImage: string; declaredDeps: Record<string, unknown> } | null,
  sharingTaskIds: string[],
): Harness {
  const updated: Record<string, unknown>[] = [];
  const inserted: Record<string, unknown>[] = [];
  const db = {
    query: {
      tasks: {
        findFirst: vi.fn(async () => ({
          envTemplateId: existing?.id ?? null,
          repositoryId: 'repo-1',
        })),
      },
      envTemplates: { findFirst: vi.fn(async () => existing ?? undefined) },
    },
    // Two callers land here: the repositories row (ends in .limit(1)) and
    // liveTasksSharingEnvTemplate (awaits the .where() directly).
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { lspServerVersions: null, chromeDevtoolsMcpVersion: null, lspServers: null },
          ],
          then: (resolve: (rows: { id: string }[]) => unknown) =>
            resolve(sharingTaskIds.map((id) => ({ id }))),
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updated.push(v);
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(v);
          return [{ id: 'tpl-forked' }];
        },
      }),
    }),
  } as unknown as Database;
  const ctx = {
    taskId: 'task-1',
    userId: 'user-1',
    cliProviderId: null,
    db,
    logger: { info: vi.fn() },
  } as unknown as StepContext;
  // linkTaskToEnvTemplate goes through the same update() mock, without declaredDeps.
  return { ctx, updated, inserted };
}

const detected = {
  runtimes: [],
  containerTool: 'ddev',
  webserver: 'apache-fpm',
  ddevProjectName: null,
  database: { kind: 'mariadb', version: '10.11' },
  suggestedLsp: [],
  cliSupportsLsp: false,
} as unknown as DeclareDepsDetect;

const formValues = {
  runtimes: ['php'],
  phpVersion: '5.6',
  containerTool: 'ddev',
  webserver: 'apache-fpm',
  databaseKind: 'mariadb',
  databaseVersion: '10.11',
  preinstallDeps: true,
  browserTesting: true,
  extraPackages: '',
} as DeclareDepsFormValues;

function run(h: Harness) {
  return declareDepsStep.apply(h.ctx, { detected, formValues } as Parameters<
    typeof declareDepsStep.apply
  >[1]);
}

const NGINX_DEPS = { containerTool: 'ddev', webserver: 'nginx-fpm' };

describe('01-declare-deps apply on a shared env template', () => {
  it('forks a row of its own when the shared definition would change', async () => {
    const h = makeHarness(
      { id: 'tpl-shared', baseImage: 'ubuntu:24.04', declaredDeps: NGINX_DEPS },
      ['task-2'],
    );
    const out = await run(h);
    expect(out.envTemplateId).toBe('tpl-forked');
    expect(h.inserted).toHaveLength(1);
    expect((h.inserted[0]?.declaredDeps as Record<string, unknown>).webserver).toBe('apache-fpm');
    // The shared row keeps its own definition; only the task link is written.
    expect(h.updated.some((u) => 'declaredDeps' in u)).toBe(false);
  });

  it('writes in place when no other live task shares the row', async () => {
    const h = makeHarness(
      { id: 'tpl-solo', baseImage: 'ubuntu:24.04', declaredDeps: NGINX_DEPS },
      [],
    );
    const out = await run(h);
    expect(out.envTemplateId).toBe('tpl-solo');
    expect(h.inserted).toEqual([]);
    expect((h.updated[0]?.declaredDeps as Record<string, unknown>).webserver).toBe('apache-fpm');
  });

  it('writes in place on a shared row when the definition is unchanged', async () => {
    // Capture what apply() builds from these form values, then feed it back as the
    // shared row's deps: an unchanged re-declaration redefines nothing, so there is
    // nothing to protect the sharers from.
    const probe = makeHarness(
      { id: 'tpl-solo', baseImage: 'ubuntu:24.04', declaredDeps: NGINX_DEPS },
      [],
    );
    await run(probe);
    const sameDeps = probe.updated[0]?.declaredDeps as Record<string, unknown>;

    const h = makeHarness({ id: 'tpl-shared', baseImage: 'ubuntu:24.04', declaredDeps: sameDeps }, [
      'task-2',
    ]);
    const out = await run(h);
    expect(out.envTemplateId).toBe('tpl-shared');
    expect(h.inserted).toEqual([]);
  });
});
