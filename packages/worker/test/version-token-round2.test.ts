import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ONBOARDING_ENVIRONMENT_SCHEMA_VERSION, validateFormValues } from '@haive/shared';
import {
  declareDepsStep,
  scanRepoForDeps,
  loadOnboardingDetection,
  reconcileStaleDeps,
  type DeclareDepsFormValues,
} from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import {
  generateDockerfileStep,
  renderDockerfile,
} from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import { renderDdevConfig, type DdevConfigInput } from '../src/step-engine/steps/_ddev-config.js';
import { resolveImageTag, renderDockerfile as renderImage } from '../src/sandbox/image-cache.js';
import { ddevEnvStep } from '../src/step-engine/steps/workflow/01c-ddev-env.js';
import { markProvidersReady } from '../src/queues/cli-exec/images.js';
import { log } from '../src/queues/cli-exec/_shared.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-000000000002';
function setup(repoPath: string, confirmedValues: Record<string, unknown> = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    envTemplates: schema.envTemplates,
    toolPackageVersions: schema.toolPackageVersions,
    cliProviders: schema.cliProviders,
  });
  fake.insert(schema.tasks, { id: TASK, repositoryId: REPO });
  fake.insert(schema.repositories, {
    id: REPO,
    onboardingEnvironment: {
      schemaVersion: ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
      envDetectData: {},
      confirmedValues,
    },
  });
  const ctx = {
    db: fake.db,
    taskId: TASK,
    userId: REPO,
    repoPath,
    cliProviderId: null,
    logger: { info: vi.fn(), warn: vi.fn() },
    emitProgress: vi.fn(),
  } as unknown as StepContext;
  return { fake, ctx };
}
function defaults(ctx: StepContext, detected: Awaited<ReturnType<typeof scanRepoForDeps>>) {
  const form = declareDepsStep.form!(ctx, detected)!;
  return Object.fromEntries(
    form.fields
      .filter((f) => 'default' in f || 'defaults' in f)
      .map((f) => [f.id, 'default' in f ? f.default : 'defaults' in f ? f.defaults : undefined]),
  );
}

it.each([
  ['package.json', JSON.stringify({ engines: { node: '>=18 <21' } }), 'node', '22'],
  ['composer.json', JSON.stringify({ require: { php: '^7.3|^8.0' } }), 'php', '8.3'],
  ['pom.xml', '<maven.compiler.source>${java.version}</maven.compiler.source>', 'java', '17'],
  ['Gemfile', 'ruby "~> 3.2.0"', 'ruby', ''],
])(
  'scans %s to a submittable default equal to main’s fallback',
  async (file, body, language, fallback) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'version-default-'));
    try {
      await writeFile(path.join(repo, file), body);
      const { fake, ctx } = setup(repo);
      const detected = await scanRepoForDeps(repo);
      expect(detected.runtimes.find((r) => r.language === language)?.version).toBeNull();
      const values = defaults(ctx, detected);
      expect(values[`${language}Version`]).toBe(fallback);
      await declareDepsStep.apply(ctx, {
        detected,
        formValues: values,
        iteration: 0,
        previousIterations: [],
      } as never);
      const deps = fake.rows(schema.envTemplates)[0]!.declaredDeps;
      expect(renderDockerfile('ubuntu:24.04', deps as never)).not.toContain(body);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);

it('drops non-token onboarding runtime and database versions before merging defaults', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'version-onboarding-'));
  try {
    const { ctx, fake } = setup(repo, {
      primaryLanguage: 'php',
      nodeVersion: '>=18 <21',
      phpVersion: '^7.3|^8.0',
      javaVersion: '${java.version}',
      rubyVersion: '~> 3.2.0',
      databaseType: 'mysql',
      databaseVersion: '8.0"\nhooks:\n  pre-start:\n    - exec-host: id #',
    });
    const detected = await declareDepsStep.detect!(ctx);
    expect(detected.runtimes.every((r) => r.version === null)).toBe(true);
    expect(detected.database.version).toBeNull();
    const values = defaults(ctx, detected);
    expect(values).toMatchObject({
      nodeVersion: '22',
      phpVersion: '8.3',
      javaVersion: '17',
      rubyVersion: '',
      databaseVersion: '',
    });
    await declareDepsStep.apply(ctx, {
      detected,
      formValues: values,
      iteration: 0,
      previousIterations: [],
    } as never);
    expect(fake.rows(schema.envTemplates)).toHaveLength(1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it('drops a non-token DDEV database version at scan', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'version-ddev-'));
  try {
    await mkdir(path.join(repo, '.ddev'));
    await writeFile(
      path.join(repo, '.ddev/config.yaml'),
      'database:\n  type: mysql\n  version: "8.0\\\"\\nhooks: injected"\n',
    );
    const detected = await scanRepoForDeps(repo);
    expect(detected.database).toEqual({ kind: 'mysql', version: null });
    expect(defaults(setup(repo).ctx, detected).databaseVersion).toBe('');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it('refuses raw database and both browser pins before any dependency write', async () => {
  for (const field of ['databaseVersion', 'browserVersion_chrome', 'browserVersion_edge']) {
    const token = '8.0"\nhooks:\n  pre-start:\n    - exec-host: id #';
    const { fake, ctx } = setup('');
    await expect(
      declareDepsStep.apply(ctx, {
        detected: { runtimes: [] },
        formValues: {
          runtimes: [],
          containerTool: 'ddev',
          browserType: field === 'browserVersion_edge' ? 'chrome' : 'edge',
          [field]: token,
        },
        iteration: 0,
        previousIterations: [],
      } as never),
    ).rejects.toThrow(/version token/);
    expect(fake.rows(schema.envTemplates)).toEqual([]);
  }
  const { ctx } = setup('');
  await expect(
    declareDepsStep.apply(ctx, {
      detected: { runtimes: [] },
      formValues: {
        runtimes: [],
        containerTool: 'none',
        browserTesting: true,
        browserType: ' chrome ',
        browserVersion_chrome: ' 1.2.3 ',
      },
      iteration: 0,
      previousIterations: [],
    } as never),
  ).rejects.toThrow(/version token/);
});

it.each(['type', 'phpVersion', 'dbVersion', 'webserverType', 'docroot'] as const)(
  'refuses YAML injection in %s before returning any config',
  (field) => {
    const token = '8.0"\nhooks:\n  pre-start:\n    - exec-host: id #';
    expect(() =>
      renderDdevConfig({ name: 'safe', dbType: 'mysql', [field]: token } as DdevConfigInput),
    ).toThrow(/version token/);
  },
);

it('keeps valid DDEV rendering byte-identical to main', () => {
  expect(
    renderDdevConfig({
      name: 'My App',
      type: 'drupal',
      docroot: 'public/web',
      phpVersion: '8.3',
      nodejsVersion: '22.11.0',
      webserverType: 'apache-fpm',
      dbType: 'mysql',
      dbVersion: '8.0',
      nodeInspect: true,
    }),
  ).toBe(
    'name: my-app\ntype: drupal\ndocroot: "public/web"\nphp_version: "8.3"\nnodejs_version: "22.11.0"\nwebserver_type: apache-fpm\ndatabase:\n  type: mysql\n  version: "8.0"\nweb_environment:\n  - "NODE_OPTIONS=--inspect=0.0.0.0:9229"\n',
  );
});

it('maps + only in the CLI tag segment, retaining content identity', () => {
  const params = { name: 'codex' as const, providerId: TASK, sandboxDockerfileExtra: null };
  const plus = resolveImageTag({ ...params, cliVersion: '1.0.0+build.5' })!;
  const underscore = resolveImageTag({ ...params, cliVersion: '1.0.0_build.5' })!;
  expect(plus.tag).toMatch(/:codex-1\.0\.0_build\.5-[a-f0-9]{16}$/);
  expect(plus.tag.split(':')[1]).toMatch(/^[\w][\w.-]*$/);
  expect(renderImage(plus)).toContain('@1.0.0+build.5');
  expect(plus.tag).not.toBe(underscore.tag);
});

it('logs and skips an invalid sibling pin without aborting ready updates', async () => {
  const { fake, ctx } = setup('');
  const params = {
    name: 'claude-code' as const,
    cliVersion: '1.0.0',
    providerId: TASK,
    sandboxDockerfileExtra: null,
  };
  const tag = resolveImageTag(params)!.tag;
  for (const [id, cliVersion] of [
    [TASK, '1.0.0'],
    [REPO, '$(id)'],
  ])
    fake.insert(schema.cliProviders, {
      id,
      userId: id,
      name: 'claude-code',
      cliVersion,
      sandboxImageTag: 'old',
      sandboxImageBuildStatus: 'failed',
    });
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  try {
    await expect(markProvidersReady(ctx.db, tag, TASK, true)).resolves.toEqual({
      self: true,
      replaced: ['old'],
    });
    expect(fake.rows(schema.cliProviders).map((r) => r.sandboxImageBuildStatus)).toEqual([
      'ready',
      'failed',
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: REPO }),
      expect.any(String),
    );
  } finally {
    warn.mockRestore();
  }
});

it('refuses a stored database injection in the workflow before a config is offered or written', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'version-ddev-workflow-'));
  try {
    const { ctx, fake } = setup(repo);
    fake.insert(schema.envTemplates, {
      id: TASK,
      declaredDeps: {
        containerTool: 'ddev',
        database: { kind: 'mysql', version: '8.0"\nhooks:\n  pre-start:\n    - exec-host: id #' },
      },
    });
    await ctx.db
      .update(schema.tasks)
      .set({ envTemplateId: TASK })
      .where((await import('drizzle-orm')).eq(schema.tasks.id, TASK));
    await expect(ddevEnvStep.detect!(ctx)).rejects.toThrow(/DDEV dbVersion: invalid version token/);
    await expect(access(path.join(repo, '.ddev/config.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it.each(['>=18.17.0 <21', '^18.12.0 || ^20.0.0'])(
  'keeps the numeric leading Node major from %s as main did',
  async (constraint) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'version-node-major-'));
    try {
      await writeFile(
        path.join(repo, 'package.json'),
        JSON.stringify({ engines: { node: constraint } }),
      );
      const detected = await scanRepoForDeps(repo);
      expect(detected.runtimes.find((r) => r.language === 'node')?.version).toBe('18');
      expect(defaults(setup(repo).ctx, detected).nodeVersion).toBe('18');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);

it('trims onboarding pins and ignores blank runtime values before language detection', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'version-onboarding-padded-'));
  try {
    const { ctx } = setup(repo, {
      phpVersion: ' 8.3 ',
      databaseType: 'postgres',
      databaseVersion: ' 15 ',
      nodeVersion: '   ',
      rubyVersion: '\t',
    });
    const detected = await declareDepsStep.detect!(ctx);
    expect(detected.runtimes).toMatchObject([{ language: 'php', version: '8.3' }]);
    expect(detected.runtimes).toHaveLength(1);
    expect(detected.database).toEqual({ kind: 'postgres', version: '15' });
    expect(defaults(ctx, detected)).toMatchObject({ phpVersion: '8.3', databaseVersion: '15' });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

it('omits non-interpolated DDEV fields without refusing legacy data', () => {
  const unsafe = '8.0"\nhooks: injected';
  for (const dbType of [undefined, null, 'none', 'mysql ', 'sql server', unsafe]) {
    expect(renderDdevConfig({ name: 'safe', dbType, dbVersion: unsafe })).not.toContain(
      'database:',
    );
  }
  expect(renderDdevConfig({ name: 'safe', nodejsVersion: unsafe })).not.toContain('nodejs_version');
});

it.each(['${PG_VERSION:-15}', '15@sha256:abcdef'])(
  'drops the detected Compose pin %s and repairs reused runtime/database answers before apply',
  async (version) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'version-compose-reuse-'));
    try {
      await writeFile(
        path.join(repo, 'compose.yml'),
        `services:\n  db:\n    image: postgres:${version}\n`,
      );
      await writeFile(path.join(repo, 'package.json'), JSON.stringify({ engines: { node: '22' } }));
      const { ctx, fake } = setup(repo);
      const detected = await declareDepsStep.detect!(ctx);
      expect(detected.database).toEqual({ kind: 'postgres', version: null });
      const reused = {
        ...defaults(ctx, detected),
        databaseVersion: version,
        nodeVersion: '18.17.0 <21',
        phpVersion: '^7.3|^8.0',
        pythonVersion: '>=3.12',
        javaVersion: '${java.version}',
        goVersion: '>=1.23',
        rustVersion: '>=1.80',
        rubyVersion: '~> 3.2.0',
      } as DeclareDepsFormValues;
      const reconciled = reconcileStaleDeps(detected, reused);
      for (const field of [
        'databaseVersion',
        'nodeVersion',
        'phpVersion',
        'pythonVersion',
        'javaVersion',
        'goVersion',
        'rustVersion',
        'rubyVersion',
      ])
        expect(reconciled[field]).toBe('');
      expect(reused.databaseVersion).toBe(version);
      const validated = validateFormValues(declareDepsStep.form!(ctx, detected)!, reconciled);
      expect(validated.success).toBe(true);
      if (!validated.success) throw new Error(validated.issues.join('; '));
      expect(validated.data).toMatchObject({ nodeVersion: '22', databaseVersion: '' });
      await declareDepsStep.apply(ctx, {
        detected,
        formValues: validated.data,
        iteration: 0,
        previousIterations: [],
      } as never);
      expect(fake.rows(schema.envTemplates)[0]!.declaredDeps).toMatchObject({
        versions: { node: '22' },
        database: { kind: 'postgres', version: null },
      });
      expect(() =>
        renderDockerfile('ubuntu:24.04', { database: { kind: 'postgres', version } }),
      ).not.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  },
);

it('ignores blank onboarding database and runtime values', async () => {
  const { ctx } = setup('', { nodeVersion: '   ', phpVersion: '', databaseVersion: '\t ' });
  expect(await loadOnboardingDetection(ctx.db, REPO)).toMatchObject({
    languages: [],
    runtimeVersions: {},
    databaseVersion: null,
  });
});

it.each(['${PG_VERSION:-15}', '15@sha256:abcdef'])(
  'allows stored database version %s through Dockerfile detect where it is not interpolated',
  async (version) => {
    const { ctx, fake } = setup('');
    fake.insert(schema.envTemplates, {
      id: TASK,
      baseImage: 'ubuntu:24.04',
      declaredDeps: { database: { kind: 'postgres', version } },
    });
    await ctx.db
      .update(schema.tasks)
      .set({ envTemplateId: TASK })
      .where((await import('drizzle-orm')).eq(schema.tasks.id, TASK));
    await expect(generateDockerfileStep.detect!(ctx)).resolves.toMatchObject({
      declaredDeps: { database: { version } },
    });
  },
);
