/**
 * The `.haive-data` mirror import reads its files without following links and applies the RTK
 * choice they carry, against a database. One throwaway user and temp directory, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import {
  PROJECT_STATE_DIR,
  RTK_ENABLED_UNIT,
  emptyProjectState,
  renderProjectState,
} from '@haive/shared/project-state';
import { handleScan } from '../src/repo/clone.js';
import { raiseRtkQuestions } from '../src/project-state/rtk-conflict.js';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { sweepDirtyProjectStates } from '../src/project-state/refresh.js';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';

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
const environment = JSON.stringify({
  schemaVersion: 1,
  envDetectData: {
    project: { name: 'mirror-import-smoke' },
    __configContents: '--- docker-compose.yml ---\nservices: {}',
    __repoIntel: 'file tree',
  },
  confirmedValues: {},
});
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
    check(
      "without the prompt-only fields an older release's 02 mirrored",
      JSON.stringify(
        (b.onboardingEnvironment as { envDetectData?: unknown } | null)?.envDetectData,
      ) === '{"project":{"name":"mirror-import-smoke"}}',
      b.onboardingEnvironment,
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

    // D: tooling imported before the column followed it says off while the column holds on.
    const askedAbout = async (repositoryId: string) =>
      db
        .select()
        .from(schema.projectStateConflicts)
        .where(
          and(
            eq(schema.projectStateConflicts.repositoryId, repositoryId),
            eq(schema.projectStateConflicts.unit, RTK_ENABLED_UNIT),
          ),
        );
    const imported = async (name: string) => {
      const folder = path.join(tmp, name);
      await mkdir(folder);
      const [row] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name,
          source: 'local_path',
          localPath: folder,
          onboardingTooling: JSON.parse(tooling()),
        })
        .returning({ id: schema.repositories.id });
      const scan = () =>
        handleScan({ repositoryId: row!.id, userId, source: 'local_path', localPath: folder }, db);
      return { id: row!.id, scan };
    };
    const rtkOf = async (id: string) =>
      (await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, id),
        columns: { rtkEnabled: true },
      }))!.rtkEnabled;

    const taken = await imported('rtk-take');
    await taken.scan();
    check(
      'an imported RTK-off the column never took is asked about',
      (await askedAbout(taken.id)).length === 1,
    );
    await taken.scan();
    await raiseRtkQuestions(db);
    const rows = await askedAbout(taken.id);
    check('asked once, however often it is scanned or booted', rows.length === 1, rows.length);
    check('with the column still on', (await rtkOf(taken.id)) === true);
    const takeAnswer = await resolveProjectStateConflict(db, {
      repositoryId: taken.id,
      userId,
      conflictId: rows[0]!.id,
      answer: 'take_theirs',
    });
    check(
      'taking theirs switches RTK off',
      takeAnswer.kind === 'resolved' && (await rtkOf(taken.id)) === false,
      takeAnswer,
    );
    await taken.scan();
    await raiseRtkQuestions(db);
    check('an answered question is never asked again', (await askedAbout(taken.id)).length === 1);

    const kept = await imported('rtk-keep');
    await kept.scan();
    const keepRows = await askedAbout(kept.id);
    const keepAnswer = await resolveProjectStateConflict(db, {
      repositoryId: kept.id,
      userId,
      conflictId: keepRows[0]!.id,
      answer: 'keep_mine',
    });
    await raiseRtkQuestions(db);
    check(
      'keeping mine leaves RTK on and the question closed',
      keepAnswer.kind === 'resolved' &&
        (await rtkOf(kept.id)) === true &&
        (await askedAbout(kept.id)).length === 1,
      keepAnswer,
    );

    const switchedOff = await imported('rtk-off');
    await switchedOff.scan();
    await db
      .update(schema.repositories)
      .set({ rtkEnabled: false })
      .where(eq(schema.repositories.id, switchedOff.id));
    await raiseRtkQuestions(db);
    const closedRows = await askedAbout(switchedOff.id);
    check(
      'a question still pending once RTK is off is closed as converged',
      closedRows.length === 1 && closedRows[0]!.resolution === 'converged',
      closedRows,
    );

    // D2: keeping mine is this install's own choice, so a later record file adopts nothing.
    const stateFolder = path.join(tmp, 'rtk-keep-record');
    await mkdir(path.join(stateFolder, '.haive-data'), { recursive: true });
    const keepFiles = renderProjectState({
      ...emptyProjectState(),
      render: {
        projectInfo: {},
        framework: 'unknown',
        acceptedAgentIds: [],
        customAgentSpecs: [],
        lspLanguages: [],
      } as never,
      settings: { 'onboarding-tooling': { ragMode: 'none', rtkEnabled: false } },
      environment: { envDetectData: { project: { name: 'keep' } }, confirmedValues: {} },
    });
    for (const [rel, text] of keepFiles) {
      await mkdir(path.dirname(path.join(stateFolder, PROJECT_STATE_DIR, rel)), {
        recursive: true,
      });
      await writeFile(path.join(stateFolder, PROJECT_STATE_DIR, rel), text);
    }
    const [keepRepo] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'rtk-keep-record', source: 'local_path', localPath: stateFolder })
      .returning({ id: schema.repositories.id });
    const keepScan = () =>
      handleScan(
        { repositoryId: keepRepo!.id, userId, source: 'local_path', localPath: stateFolder },
        db,
      );
    await keepScan();
    await raiseRtkQuestions(db);
    const recordRows = await askedAbout(keepRepo!.id);
    check('a record naming RTK off asks once', recordRows.length === 1, recordRows.length);
    await resolveProjectStateConflict(db, {
      repositoryId: keepRepo!.id,
      userId,
      conflictId: recordRows[0]!.id,
      answer: 'keep_mine',
    });
    const stamped = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, keepRepo!.id),
      columns: { rtkChoiceMadeAt: true },
    });
    check('keeping mine records the choice', stamped?.rtkChoiceMadeAt instanceof Date, stamped);
    const rtkFile = path.join(stateFolder, PROJECT_STATE_DIR, 'settings', 'rtk-enabled.json');
    await mkdir(path.dirname(rtkFile), { recursive: true });
    await writeFile(rtkFile, 'false\n');
    await keepScan();
    const afterRow = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, keepRepo!.id),
      columns: { rtkEnabled: true, renderContext: true },
    });
    check(
      'a later rtk-enabled file adopts nothing and asks nothing',
      afterRow?.rtkEnabled === true &&
        (afterRow.renderContext as { rtkChoiceRecorded?: unknown } | null)?.rtkChoiceRecorded ===
          false &&
        (await askedAbout(keepRepo!.id)).length === 1,
      { afterRow, asked: (await askedAbout(keepRepo!.id)).length },
    );
    await markProjectStateDirty(db, keepRepo!.id);
    await sweepDirtyProjectStates(db);
    const written = (await readFile(rtkFile, 'utf8')).trim();
    check("and the next record write carries this install's choice", written === 'true', written);

    // G, H: the question is weighed after the record is synced.
    const recordFolder = async (name: string, settings: Record<string, unknown>) => {
      const folder = path.join(tmp, name);
      await mkdir(path.join(folder, '.haive-data'), { recursive: true });
      const recordFiles = renderProjectState({
        ...emptyProjectState(),
        render: {
          projectInfo: {},
          framework: 'unknown',
          acceptedAgentIds: [],
          customAgentSpecs: [],
          lspLanguages: [],
        } as never,
        settings,
        environment: { envDetectData: { project: { name } }, confirmedValues: {} },
      });
      for (const [rel, text] of recordFiles) {
        await mkdir(path.dirname(path.join(folder, PROJECT_STATE_DIR, rel)), { recursive: true });
        await writeFile(path.join(folder, PROJECT_STATE_DIR, rel), text);
      }
      return folder;
    };
    const gFolder = await recordFolder('rtk-record-clone', {
      'onboarding-tooling': { ragMode: 'none', rtkEnabled: false },
    });
    const [gRepo] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'rtk-record-clone', source: 'local_path', localPath: gFolder })
      .returning({ id: schema.repositories.id });
    await handleScan(
      { repositoryId: gRepo!.id, userId, source: 'local_path', localPath: gFolder },
      db,
    );
    const gRows = await askedAbout(gRepo!.id);
    check(
      'a record-based clone is asked about its RTK-off at scan time',
      gRows.length === 1 && gRows[0]!.resolution === null && (await rtkOf(gRepo!.id)) === true,
      gRows,
    );

    const hFolder = await recordFolder('rtk-stale-adopts', { 'rtk-enabled': true });
    const [hRepo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'rtk-stale-adopts',
        source: 'local_path',
        localPath: hFolder,
        onboardingTooling: JSON.parse(tooling()),
      })
      .returning({ id: schema.repositories.id });
    await handleScan(
      { repositoryId: hRepo!.id, userId, source: 'local_path', localPath: hFolder },
      db,
    );
    const hAfter = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, hRepo!.id),
      columns: { renderContext: true },
    });
    const hRows = await askedAbout(hRepo!.id);
    check(
      "a stale RTK-off blob that adopts the team's choice is not asked about",
      hRows.length === 0 &&
        (hAfter?.renderContext as { rtkChoiceRecorded?: unknown } | null)?.rtkChoiceRecorded ===
          true,
      { hRows, hAfter },
    );

    // E: a checkout holding a record carries its units; a stale legacy file does not outrank them.
    const withRecord = path.join(tmp, 'with-record');
    await mkdir(path.join(withRecord, '.haive-data'), { recursive: true });
    const files = renderProjectState({
      ...emptyProjectState(),
      render: {
        projectInfo: {},
        framework: 'unknown',
        acceptedAgentIds: [],
        customAgentSpecs: [],
        lspLanguages: [],
      } as never,
      settings: {
        'scope-exclude-globs': ['record/**'],
        'onboarding-tooling': { ragMode: 'record', ollamaUrl: 'http://attacker.example' },
      },
      environment: { envDetectData: { project: { name: 'record' } }, confirmedValues: {} },
    });
    for (const [rel, text] of files) {
      await mkdir(path.dirname(path.join(withRecord, PROJECT_STATE_DIR, rel)), { recursive: true });
      await writeFile(path.join(withRecord, PROJECT_STATE_DIR, rel), text);
    }
    await writeFile(path.join(withRecord, '.haive-data', 'environment.json'), environment);
    await writeFile(path.join(withRecord, '.haive-data', 'exclusions.json'), exclusions);
    await writeFile(path.join(withRecord, '.haive-data', 'tooling.json'), tooling());
    const e = await scanned(withRecord);
    check(
      'a record unit outranks a stale legacy file',
      JSON.stringify(e.scopeExcludeGlobs) === '["record/**"]' &&
        JSON.stringify(
          (e.onboardingEnvironment as { envDetectData?: unknown } | null)?.envDetectData,
        ) === '{"project":{"name":"record"}}',
      e,
    );
    check(
      'and so does the tooling unit, without a machine-local key and without the stale RTK-off',
      isDeepStrictEqual(e.onboardingTooling, {
        schemaVersion: 1,
        tooling: { ragMode: 'record' },
      }) && e.rtkEnabled === true,
      e,
    );

    // F: a record unit file the sync refuses leaves the columns to the legacy files.
    const refused = path.join(tmp, 'refused-record');
    await mkdir(path.join(refused, '.haive-data', 'state', 'settings'), { recursive: true });
    await mkdir(path.join(refused, '.haive-data', 'state', 'project'), { recursive: true });
    await writeFile(
      path.join(refused, '.haive-data', 'state', 'settings', 'scope-exclude-globs.json'),
      '["record/**"]\n',
    );
    await writeFile(
      path.join(refused, '.haive-data', 'state', 'project', 'environment.json'),
      '{}\n',
    );
    await writeFile(
      path.join(refused, '.haive-data', 'state', 'settings', 'onboarding-tooling.json'),
      '{"ragMode":"record"}\n',
    );
    await writeFile(path.join(refused, '.haive-data', 'environment.json'), environment);
    await writeFile(path.join(refused, '.haive-data', 'exclusions.json'), exclusions);
    await writeFile(path.join(refused, '.haive-data', 'tooling.json'), tooling());
    const f = await scanned(refused);
    check(
      'a record the sync refuses leaves the columns to the legacy files',
      JSON.stringify(f.scopeExcludeGlobs) === '["vendor/**"]' &&
        f.onboardingEnvironment !== null &&
        (f.onboardingTooling as { tooling?: { ragMode?: unknown } } | null)?.tooling?.ragMode ===
          'none',
      f,
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
