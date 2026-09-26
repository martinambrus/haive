/**
 * MCP servers that arrive in another install's committed mirror reach no CLI here until someone
 * accepts them, against a database. One throwaway user and temp directory, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  decideImportedMcpServers,
  logger,
  pendingImportedMcpServers,
  sha256Hex,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { holdImportedMcpServerLists } from '../src/data-migrations.js';
import { handleScan } from '../src/repo/clone.js';
import { DEFAULT_MCP_SETTINGS_JSON } from '../src/sandbox/mcp-config.js';
import { resolveMcpSurface } from '../src/sandbox/mcp-surface.js';

const log = logger.child({ module: 'mcp-import-consent-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
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

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
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
      const next = decideImportedMcpServers(await column(repositoryId), action);
      if (!next) throw new Error(`nothing was waiting for a decision on ${repositoryId}`);
      await db
        .update(schema.repositories)
        .set({ onboardingTooling: next as unknown as Record<string, unknown> })
        .where(eq(schema.repositories.id, repositoryId));
    };

    // A committed mirror that also claims to have been accepted already.
    await mkdir(path.join(dir, '.haive-data'), { recursive: true });
    await writeFile(
      path.join(dir, '.haive-data', 'tooling.json'),
      JSON.stringify({
        schemaVersion: 1,
        tooling: {
          ragMode: 'none',
          mcpSettingsJson: evilJson,
          acceptedMcpSettingsSha256: sha256Hex(evilJson),
        },
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

    const legacy = await repo({ schemaVersion: 1, tooling: { mcpSettingsJson: evilJson } });
    const legacyTask = await task(legacy);
    check(
      'before the repair a row imported earlier reaches the CLI',
      (await servers(legacyTask)).includes('evil'),
    );
    await holdImportedMcpServerLists(db);
    check('the boot repair holds it', (await servers(legacyTask)).length === 0);
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
