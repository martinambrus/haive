import { fixtureBase, httpOrigin } from './support/git-http.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { encrypt, encryptDek, generateDek, secretsService } from '@haive/shared';
import {
  boundQueryError,
  logger,
  safeErrorForTransport,
  safeErrorMessage,
} from '@haive/shared/logger';
import { bundleGitAuth } from '../src/repo/bundle-git.js';
import { handleResyncGit } from '../src/repo/bundle-ingest.js';
import { runBundleGitSyncTick } from '../src/repo/bundle-sync.js';
import { gitRun } from '../src/repo/git-exec.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { bundleResyncStep } from '../src/step-engine/steps/onboarding-upgrade/00-bundle-resync.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const BUNDLE = '00000000-0000-4000-8000-0000000000b1';
const REPOSITORY = '00000000-0000-4000-8000-0000000000c1';
const CREDENTIAL = '00000000-0000-4000-8000-0000000000d1';
const TASK = '00000000-0000-4000-8000-0000000000e1';
const KEK = 'ab'.repeat(32);
const query = 'update custom_bundles set git_url = $1 where id = $2';
const lines: string[] = [];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(fixtureBase, 'bundle-forwarder-'));
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
  lines.length = 0;
  const key = Object.getOwnPropertySymbols(logger).find(
    (key) => key.description === 'pino.stream',
  )!;
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: string[], allowFileTransport = false) {
  const out = await gitRun(cwd, args, undefined, { allowFileTransport });
  if (out.code !== 0) throw new Error(out.stderr);
  return out.stdout.trim();
}

async function setup(secret: string) {
  const extracted = path.join(root, USER, BUNDLE, 'extracted');
  await mkdir(extracted, { recursive: true });
  await git(extracted, ['init', '-b', 'main']);
  await writeFile(path.join(extracted, 'README.md'), '# fixture\n');
  await git(extracted, ['add', 'README.md']);
  await git(extracted, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'seed',
  ]);
  const origin = path.join(root, 'origin.git');
  await git(root, ['clone', '--bare', extracted, origin], true);
  const clean = httpOrigin(origin);
  const legacy = new URL(clean);
  legacy.username = 'fixture-user';
  legacy.password = 'retired-fixture-password';
  await git(extracted, ['remote', 'add', 'origin', legacy.toString()]);
  const fake = createFakeDb({
    customBundles: schema.customBundles,
    repoCredentials: schema.repoCredentials,
    tasks: schema.tasks,
  });
  const dek = generateDek();
  fake.insert(schema.repoCredentials, {
    id: CREDENTIAL,
    userId: USER,
    host: new URL(clean).host,
    usernameEncrypted: encrypt('fixture-user', dek),
    secretEncrypted: encrypt(secret, dek),
    encryptedDek: encryptDek(dek, KEK),
  });
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    repositoryId: REPOSITORY,
    name: 'fixture',
    sourceType: 'git',
    status: 'active',
    gitUrl: legacy.toString(),
    gitCredentialsId: CREDENTIAL,
    gitBranch: 'main',
    storageRoot: extracted,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPOSITORY });
  const db = fake.db as unknown as Database;
  const ctx = {
    db,
    taskId: TASK,
    userId: USER,
    logger: logger.child({ module: 'bundle-forwarder-control' }),
  } as StepContext;
  return { fake, db, ctx, clean, extracted };
}

const cases = [
  [true, 'fixture-prefix" fixture-suffix'],
  [true, 'Database'],
  [false, 'fixture-prefix" fixture-suffix'],
] as const;

for (const mode of ['helper', 'resync', 'tick', 'detect', 'apply'] as const) {
  it.each(cases)(
    `${mode} keeps legacy URL update failures safe and diagnostic (bound: %s, secret: %s)`,
    async (bound, secret) => {
      const s = await setup(secret);
      const originalMessage = `failed https://user:${secret}@example.invalid/r and token=${secret}\n  exact whitespace`;
      // Production update parameters are a clean URL/time/ID, not a password. This
      // narrow rejection keeps the actual helper, credential decryption and Git.
      const error = bound
        ? new DrizzleQueryError(
            query,
            [s.clean, BUNDLE],
            Object.assign(new Error('database read-only'), { code: '25006' }),
          )
        : new TypeError(originalMessage);
      let writes = 0;
      s.fake.hooks.beforeUpdate = (table) => {
        if (table === schema.customBundles && ++writes === 1) throw error;
      };
      const expected = bound
        ? 'Database operation failed'
        : 'failed https://example.invalid/r and token=***\n  exact whitespace';
      let result: unknown;
      if (mode === 'helper' || mode === 'resync') {
        const promise =
          mode === 'helper'
            ? bundleGitAuth(s.db, s.fake.rows(schema.customBundles)[0] as never)
            : handleResyncGit({ bundleId: BUNDLE, userId: USER }, s.db, root);
        const caught: unknown = await promise.catch((err: unknown) => err);
        expect.soft(safeErrorMessage(caught)).toBe(expected);
        if (bound) {
          expect.soft(caught).toBe(error);
          expect.soft(boundQueryError(caught)).toBe(error);
        } else {
          expect(caught).toBeInstanceOf(Error);
          expect.soft(caught).not.toHaveProperty('cause');
        }
        const transported = safeErrorForTransport(caught, {
          name: 'bundle-resync',
          id: BUNDLE,
        }) as Error;
        expect
          .soft(transported.message)
          .toBe(bound ? 'Database operation failed (25006)' : expected);
        expect.soft(transported.stack).not.toContain(s.clean);
        result = { message: safeErrorMessage(caught), transported: transported.message };
        if (mode === 'resync')
          expect.soft(s.fake.rows(schema.customBundles)[0]!.lastSyncError).toBe(expected);
      } else if (mode === 'tick') {
        result = await runBundleGitSyncTick(s.db);
        expect(result).toEqual({ scanned: 1, updated: 0, errors: 1 });
      } else if (mode === 'detect') {
        const detected = await bundleResyncStep.detect!(s.ctx);
        expect.soft(detected.candidates[0]?.fetchError).toBe(expected);
        const form = bundleResyncStep.form!(s.ctx, detected);
        result = [detected, form];
        expect.soft(JSON.stringify(form)).toContain(expected.split('\n')[0]!);
      } else {
        vi.stubEnv('BUNDLE_STORAGE_ROOT', root);
        result = await bundleResyncStep.apply(s.ctx, {
          iteration: 0,
          previousIterations: [],
          detected: {
            candidates: [
              {
                bundleId: BUNDLE,
                name: 'fixture',
                branch: 'main',
                storageRoot: s.extracted,
                lastSyncCommit: null,
                remoteCommit: 'upstream',
                hasUpstreamChange: true,
                fetchError: null,
              },
            ],
          },
          formValues: { bundlesToPull: [BUNDLE] },
        });
        expect.soft(result).toEqual({
          resyncedBundleIds: [],
          warnings: [`bundle fixture resync failed: ${expected}`],
        });
        expect.soft(s.fake.rows(schema.customBundles)[0]!.lastSyncError).toBe(expected);
      }
      expect(writes).toBe(mode === 'resync' || mode === 'apply' ? 2 : 1);
      expect(await git(s.extracted, ['remote', 'get-url', 'origin'])).toBe(s.clean);
      if (bound) {
        expect.soft(lines.map((line) => JSON.parse(line))).toContainEqual(
          expect.objectContaining({
            err: expect.objectContaining({ type: 'DrizzleQueryError', code: '25006', query }),
          }),
        );
      }
      const visible = JSON.stringify([result, lines]);
      expect.soft(visible).not.toContain(s.clean);
      for (const token of ['fixture-prefix', 'fixture-suffix', 'retired-fixture-password'])
        expect.soft(visible).not.toContain(token);
    },
  );
}

it.each([true, false])(
  'upgrade detect sanitizes the credential reader before helper setup (bound: %s)',
  async (bound) => {
    const s = await setup('fixture-password');
    const ordinary = 'credential reader refused\n  exact whitespace';
    const readerQuery = 'select * from repo_credentials where id = $1';
    const marker = 'CREDENTIAL_READER_BOUND_VALUE_340';
    const error = bound
      ? new DrizzleQueryError(
          readerQuery,
          [marker],
          Object.assign(new Error(marker), { code: '08006' }),
        )
      : new TypeError(ordinary);
    const read = vi.spyOn(s.fake.db.query.repoCredentials, 'findFirst').mockRejectedValue(error);
    const detected = await bundleResyncStep.detect!(s.ctx);
    expect(read).toHaveBeenCalledOnce();
    expect
      .soft(detected.candidates[0]?.fetchError)
      .toBe(bound ? 'Database operation failed' : ordinary);
    if (bound)
      expect.soft(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          err: expect.objectContaining({
            type: 'DrizzleQueryError',
            code: '08006',
            query: readerQuery,
          }),
        }),
      );
    expect.soft(JSON.stringify([detected, lines])).not.toContain(marker);
  },
);
