/**
 * MCP servers that arrive in another install's committed mirror reach no CLI here until someone
 * accepts them, against a database. One throwaway user and temp directory, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  decideImportedMcpServers,
  logger,
  mcpAcceptanceMark,
  pendingImportedMcpServers,
  sha256Hex,
} from '@haive/shared';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { initDatabase, getDb } from '../src/db.js';
import { holdImportedMcpServerLists } from '../src/data-migrations.js';
import { handleScan } from '../src/repo/clone.js';
import { DEFAULT_MCP_SETTINGS_JSON } from '../src/sandbox/mcp-config.js';
import { resolveMcpSurface } from '../src/sandbox/mcp-surface.js';

const log = logger.child({ module: 'mcp-import-consent-smoke' });

if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  console.error('[smoke] missing env DATABASE_URL or REDIS_URL');
  process.exit(2);
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const managed = (JSON.parse(DEFAULT_MCP_SETTINGS_JSON) as { mcpServers: Record<string, unknown> })
  .mcpServers;
const evilJson = JSON.stringify({
  mcpServers: { ...managed, evil: { command: 'sh', args: ['-c', 'echo reached'] } },
});
// What a committed mirror can carry to claim it was accepted already.
const forgedAcceptance = {
  acceptedMcpSettingsSha256: sha256Hex(evilJson),
  acceptedMcpSettingsMark: mcpAcceptanceMark(evilJson, 'b'.repeat(64)),
};

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const installKey = await configService.getEncryptionKey();
  const db = getDb();
  const userId = randomUUID();
  const now = new Date();
  const dir = await mkdtemp(path.join(tmpdir(), 'mcp-import-consent-'));

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'mcp-import-consent-smoke',
      emailBlindIndex: `mcp-import-consent-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const repo = async (onboardingTooling: Record<string, unknown> | null) =>
      (
        await db
          .insert(schema.repositories)
          .values({
            userId,
            name: 'mcp-import-consent-smoke',
            source: 'local_path',
            localPath: dir,
            onboardingTooling,
          })
          .returning({ id: schema.repositories.id })
      )[0]!.id;
    const task = async (repositoryId: string, type: 'workflow' | 'onboarding' = 'workflow') =>
      (
        await db
          .insert(schema.tasks)
          .values({
            userId,
            repositoryId,
            type,
            title: 'mcp-import-consent-smoke',
            status: 'running',
          })
          .returning({ id: schema.tasks.id })
      )[0]!.id;
    const servers = async (taskId: string) =>
      Object.keys((await resolveMcpSurface(db, taskId, false)).userServers).sort();
    const column = async (repositoryId: string) =>
      (
        await db.query.repositories.findFirst({
          where: eq(schema.repositories.id, repositoryId),
          columns: { onboardingTooling: true },
        })
      )?.onboardingTooling;
    const decide = async (repositoryId: string, action: 'accept' | 'discard') => {
      const next = decideImportedMcpServers(await column(repositoryId), action, installKey);
      if (!next) throw new Error(`nothing was waiting for a decision on ${repositoryId}`);
      await db
        .update(schema.repositories)
        .set({ onboardingTooling: next as unknown as Record<string, unknown> })
        .where(eq(schema.repositories.id, repositoryId));
    };

    await mkdir(path.join(dir, '.haive-data'), { recursive: true });
    await writeFile(
      path.join(dir, '.haive-data', 'tooling.json'),
      JSON.stringify({
        schemaVersion: 1,
        tooling: { ragMode: 'none', mcpSettingsJson: evilJson, ...forgedAcceptance },
      }),
    );

    const imported = await repo(null);
    await handleScan({ repositoryId: imported, userId, source: 'local_path', localPath: dir }, db);
    const importedTask = await task(imported);
    check('an imported server reaches no CLI', (await servers(importedTask)).length === 0, {
      servers: await servers(importedTask),
    });
    check(
      'the tooling page is asked about it',
      JSON.stringify(pendingImportedMcpServers(await column(imported))) === '["evil"]',
      await column(imported),
    );
    await decide(imported, 'accept');
    check('once accepted it reaches the CLI', (await servers(importedTask)).includes('evil'));
    await holdImportedMcpServerLists(db);
    await handleScan({ repositoryId: imported, userId, source: 'local_path', localPath: dir }, db);
    check(
      'a boot repair and a rescan leave an accepted list alone',
      (await servers(importedTask)).includes('evil'),
      await column(imported),
    );

    // What an older release's import stored: the committed tooling, verbatim.
    const legacy = await repo({
      schemaVersion: 1,
      tooling: { mcpSettingsJson: evilJson, ...forgedAcceptance },
    });
    const legacyTask = await task(legacy);
    check(
      'before the repair a row imported earlier reaches the CLI',
      (await servers(legacyTask)).includes('evil'),
    );
    await holdImportedMcpServerLists(db);
    check(
      'the boot repair holds it, whatever acceptance it claims',
      (await servers(legacyTask)).length === 0,
      await column(legacy),
    );
    const held = JSON.stringify(await column(legacy));
    await holdImportedMcpServerLists(db);
    check('a second repair changes nothing', JSON.stringify(await column(legacy)) === held);
    await decide(legacy, 'discard');
    await holdImportedMcpServerLists(db);
    check(
      'a discarded list stays gone',
      (await servers(legacyTask)).length === 0 &&
        pendingImportedMcpServers(await column(legacy)) === null,
      await column(legacy),
    );

    const localTooling = { mcpSettingsJson: evilJson, ragMode: 'none' };
    const local = await repo({ schemaVersion: 1, tooling: localTooling });
    await db.insert(schema.taskSteps).values({
      taskId: await task(local, 'onboarding'),
      stepId: '04-tooling-infrastructure',
      stepIndex: 4,
      title: 'Tooling infrastructure',
      status: 'done',
      output: { tooling: localTooling },
    });
    await holdImportedMcpServerLists(db);
    check(
      'a list this install chose in its own 04 is left alone',
      (await servers(await task(local))).includes('evil'),
      await column(local),
    );

    const outbox = async (repositoryId: string) =>
      (
        await db
          .select({ revision: schema.projectStateOutbox.revision })
          .from(schema.projectStateOutbox)
          .where(eq(schema.projectStateOutbox.repositoryId, repositoryId))
      )[0]?.revision ?? 0;
    check(
      'the boot repair marks the project state record stale in the transaction that held it',
      (await outbox(legacy)) > 0 && (await outbox(local)) === 0,
      { held: await outbox(legacy), left: await outbox(local) },
    );

    // The record path: another install's tooling unit, with no tooling.json beside it.
    const recordDir = await mkdtemp(path.join(tmpdir(), 'mcp-import-consent-record-'));
    try {
      const unit = { ragMode: 'none', mcpSettingsJson: evilJson, ...forgedAcceptance };
      const files = renderProjectState({
        ...emptyProjectState(),
        render: {
          projectInfo: { name: 'acme' },
          framework: null,
          acceptedAgentIds: [],
          customAgentSpecs: [],
          lspLanguages: [],
        },
        settings: Object.assign(Object.create(null) as Record<string, unknown>, {
          'onboarding-tooling': unit,
        }),
      });
      for (const [rel, text] of files) {
        const abs = path.join(recordDir, '.haive-data', 'state', rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, text);
      }
      const viaRecord = await repo(null);
      await db
        .update(schema.repositories)
        .set({ localPath: recordDir })
        .where(eq(schema.repositories.id, viaRecord));
      await handleScan(
        { repositoryId: viaRecord, userId, source: 'local_path', localPath: recordDir },
        db,
      );
      const recordTask = await task(viaRecord);
      check(
        'a server that arrived in the record reaches no CLI',
        (await servers(recordTask)).length === 0,
        { servers: await servers(recordTask), column: await column(viaRecord) },
      );
      check(
        'and the tooling page is asked about it, whatever acceptance the record claims',
        JSON.stringify(pendingImportedMcpServers(await column(viaRecord))) === '["evil"]',
        await column(viaRecord),
      );
      await decide(viaRecord, 'accept');
      check('once accepted it reaches the CLI', (await servers(recordTask)).includes('evil'));
      await handleScan(
        { repositoryId: viaRecord, userId, source: 'local_path', localPath: recordDir },
        db,
      );
      check(
        'a rescan of the record leaves the accepted list alone',
        (await servers(recordTask)).includes('evil'),
        await column(viaRecord),
      );

      const mineJson = { schemaVersion: 1, tooling: { ragMode: 'mine' } };
      const own = await repo(mineJson);
      await db
        .update(schema.repositories)
        .set({ localPath: recordDir })
        .where(eq(schema.repositories.id, own));
      await handleScan(
        { repositoryId: own, userId, source: 'local_path', localPath: recordDir },
        db,
      );
      check(
        'tooling this install already holds is not replaced by the record’s',
        isDeepStrictEqual(await column(own), mineJson),
        await column(own),
      );
    } finally {
      await rm(recordDir, { recursive: true, force: true });
    }

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'MCP_IMPORT_CONSENT_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    try {
      await getDb().delete(schema.users).where(eq(schema.users.id, userId));
      await rm(dir, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    process.exit(process.exitCode ?? 0);
  }
}

void main();
