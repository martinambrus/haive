import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { ONBOARDING_ENVIRONMENT_SCHEMA_VERSION, validateFormValues } from '@haive/shared';
import { declareDepsStep } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

// The repo on disk is markerless — no .htaccess, no .ddev/config.yaml — so the scan
// answers nginx-fpm for want of a marker, not because nginx was detected. What the
// user confirmed at onboarding is the only evidence such a project has.

const TASK_ID = 'de98d843-2b03-463e-98fb-ff9bd99f2970';
const OWN_TEMPLATE_NAME = 'task-de98d843';

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(path.join(os.tmpdir(), 'haive-declare-deps-'));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

function makeCtx(template: { name: string; declaredDeps: Record<string, unknown> } | null) {
  const db = {
    query: {
      tasks: {
        findFirst: vi.fn(async () => ({
          repositoryId: 'repo-1',
          title: 'Add DDEV',
          description: '',
          envTemplateId: template ? 'tpl-linked' : null,
        })),
      },
      repositories: {
        findFirst: vi.fn(async () => ({
          onboardingEnvironment: {
            schemaVersion: ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
            envDetectData: {},
            confirmedValues: { primaryLanguage: 'php', phpVersion: '5.6', webserver: 'apache' },
          },
        })),
      },
      envTemplates: { findFirst: vi.fn(async () => template ?? undefined) },
    },
    select: () => ({
      from: () => {
        const empty = Promise.resolve([]);
        return { then: empty.then.bind(empty), where: () => ({ limit: async () => [] }) };
      },
    }),
  } as unknown as Database;
  return {
    db,
    taskId: TASK_ID,
    userId: 'user-1',
    cliProviderId: null,
    repoPath,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as StepContext;
}

describe('01-declare-deps detect webserver precedence', () => {
  it('offers the webserver confirmed at onboarding for a markerless repo', async () => {
    const detected = await declareDepsStep.detect!(makeCtx(null));
    expect(detected.webserver).toBe('apache-fpm');
  });

  it('ignores a webserver stored on a template row this task does not own', async () => {
    // 02-generate-dockerfile relinks tasks onto each other's rows, so the linked row
    // can carry a choice made by (and for) a different task.
    const ctx = makeCtx({ name: 'task-73852f1b', declaredDeps: { webserver: 'nginx-fpm' } });
    const detected = await declareDepsStep.detect!(ctx);
    expect(detected.webserver).toBe('apache-fpm');
  });

  it("keeps this task's own previously declared webserver", async () => {
    const ctx = makeCtx({ name: OWN_TEMPLATE_NAME, declaredDeps: { webserver: 'nginx-fpm' } });
    const detected = await declareDepsStep.detect!(ctx);
    expect(detected.webserver).toBe('nginx-fpm');
  });
});

describe('01-declare-deps PHP language server suggestion', () => {
  const lspField = (detected: Awaited<ReturnType<NonNullable<typeof declareDepsStep.detect>>>) => {
    const schema = declareDepsStep.form!({} as never, detected)!;
    const field = schema.fields.find((f) => f.id === 'lspServers');
    if (!field || field.type !== 'multi-select') throw new Error('lspServers field missing');
    return { schema, field };
  };

  // The language server field and its suggestion only exist for a provider that supports them.
  const lspCtx = () => {
    const ctx = makeCtx(null);
    const rows = [{ name: 'claude-code' }];
    // Every query builder step stays chainable and resolves to the one provider row.
    const chain: unknown = new Proxy(() => undefined, {
      get: (_t, prop) =>
        prop === 'then' ? (resolve: (v: unknown) => void) => resolve(rows) : () => chain,
    });
    (ctx.db as unknown as { select: unknown }).select = () => chain;
    (ctx.db.query as unknown as Record<string, unknown>).taskTypeDefinitions = {
      findFirst: vi.fn(async () => undefined),
    };
    return { ...ctx, cliProviderId: 'provider-1' } as StepContext;
  };

  const expectSubmittable = (
    detected: Awaited<ReturnType<NonNullable<typeof declareDepsStep.detect>>>,
  ) => {
    const { schema, field } = lspField(detected);
    expect(field.defaults).toEqual(['intelephense-extended']);
    const options = field.options.map((o) => o.value);
    for (const value of field.defaults ?? []) expect(options).toContain(value);
    // Only this field is validated: the other required fields need user input.
    const result = validateFormValues(
      { ...schema, fields: [field] },
      { lspServers: field.defaults },
    );
    expect(result.success ? [] : result.issues).toEqual([]);
  };

  it('defaults a plain PHP repository to the surviving key', async () => {
    await writeFile(
      path.join(repoPath, 'composer.json'),
      JSON.stringify({ require: { php: '^8.2', 'monolog/monolog': '^3.0' } }),
    );
    expectSubmittable(await declareDepsStep.detect!(lspCtx()));
  });

  it('keeps a DDEV project with no composer.json on the surviving key', async () => {
    await mkdir(path.join(repoPath, '.ddev'));
    await writeFile(
      path.join(repoPath, '.ddev', 'config.yaml'),
      'name: site\ntype: php\nphp_version: "8.2"\n',
    );
    expectSubmittable(await declareDepsStep.detect!(lspCtx()));
  });
});
