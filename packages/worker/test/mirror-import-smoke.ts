/**
 * The `.haive-data` mirror import reads its files without following links and applies the RTK
 * choice they carry, against a database. One throwaway user and temp directory, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { handleScan } from '../src/repo/clone.js';

const log = logger.child({ module: 'mirror-import-smoke' });

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

const tooling = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, tooling: { ragMode: 'none', rtkEnabled: false, ...extra } });
const environment = JSON.stringify({ schemaVersion: 1, envDetectData: {}, confirmedValues: {} });
const exclusions = JSON.stringify({ schemaVersion: 1, scopeExcludeGlobs: ['vendor/**'] });

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const tmp = await mkdtemp(path.join(tmpdir(), 'mirror-import-smoke-'));
  const userId = randomUUID();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'mirror-import-smoke',
      emailBlindIndex: `mirror-import-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
    });
    const scanned = async (folder: string) => {
      const [row] = await db
        .insert(schema.repositories)
        .values({ userId, name: 'mirror-import-smoke', source: 'local_path', localPath: folder })
        .returning({ id: schema.repositories.id });
      await handleScan(
        { repositoryId: row!.id, userId, source: 'local_path', localPath: folder },
        db,
      );
      return (await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, row!.id),
        columns: {
          onboardingTooling: true,
          onboardingEnvironment: true,
          scopeExcludeGlobs: true,
          rtkEnabled: true,
        },
      }))!;
    };

    // A: every mirror file is a link to a file outside the repository.
    const outside = path.join(tmp, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'tooling.json'), tooling());
    await writeFile(path.join(outside, 'environment.json'), environment);
    await writeFile(path.join(outside, 'exclusions.json'), exclusions);
    const linked = path.join(tmp, 'linked');
    await mkdir(path.join(linked, '.haive-data'), { recursive: true });
    for (const name of ['tooling.json', 'environment.json', 'exclusions.json']) {
      await symlink(path.join(outside, name), path.join(linked, '.haive-data', name));
    }
    const a = await scanned(linked);
    check(
      'a mirror file that is a link is not read',
      a.onboardingTooling === null &&
        a.onboardingEnvironment === null &&
        a.scopeExcludeGlobs === null &&
        a.rtkEnabled === true,
      a,
    );

    // B: plain files are imported, the RTK choice with them.
    const plain = path.join(tmp, 'plain');
    await mkdir(path.join(plain, '.haive-data'), { recursive: true });
    await writeFile(path.join(plain, '.haive-data', 'tooling.json'), tooling());
    await writeFile(path.join(plain, '.haive-data', 'environment.json'), environment);
    await writeFile(path.join(plain, '.haive-data', 'exclusions.json'), exclusions);
    const b = await scanned(plain);
    check(
      'a plain mirror is imported',
      b.onboardingTooling !== null && b.onboardingEnvironment !== null,
      b,
    );
    check('with its scope list', JSON.stringify(b.scopeExcludeGlobs) === '["vendor/**"]', b);
    check('and RTK switched off as the mirror says', b.rtkEnabled === false, b);

    // C: a mirror file past the read cap is not read.
    const big = path.join(tmp, 'big');
    await mkdir(path.join(big, '.haive-data'), { recursive: true });
    await writeFile(
      path.join(big, '.haive-data', 'tooling.json'),
      tooling({ padding: 'x'.repeat(2 * 1024 * 1024) }),
    );
    const c = await scanned(big);
    check(
      'a mirror file past the cap is not read',
      c.onboardingTooling === null && c.rtkEnabled === true,
      {
        imported: c.onboardingTooling !== null,
        rtkEnabled: c.rtkEnabled,
      },
    );

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'MIRROR_IMPORT_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    try {
      await getDb().delete(schema.users).where(eq(schema.users.id, userId));
      await rm(tmp, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    process.exit(process.exitCode ?? 0);
  }
}

void main();
