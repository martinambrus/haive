// Enforcement routes on a real Postgres: the corpus lock, and writers that wait on each other's rows.
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, logger, secretsService, userSecretsService } from '@haive/shared';
import {
  HOUSE_RULES_ALWAYS_CAP_BYTES,
  globalKbEntries,
  houseRuleBytes,
  withGlobalKb,
} from '@haive/shared/global-kb';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'house-rules-enforcement-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const ROUNDS = 20;
const GLOBS = ['**/*.twig'];
// Each fits the always-on cap alone. Two do not, though they hold fewer characters than the cap.
const HEAVY = 'é'.repeat(Math.ceil(HOUSE_RULES_ALWAYS_CAP_BYTES * 0.3));

type Role = 'admin' | 'user';
type Json = Record<string, any>;
interface Reply {
  status: number;
  body: Json;
}

class Refusal extends Error {}

async function createUser(db: ReturnType<typeof getDb>, role: Role): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const email = `${role}-${process.pid}@smoke.local`;
  await db.insert(schema.users).values({
    id,
    emailEncrypted: email,
    emailBlindIndex: `${email}-${randomBytes(4).toString('hex')}`,
    passwordHash: 'smoke-not-real',
    role,
    status: 'active',
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function main(): Promise<void> {
  let exitCode = 0;
  const userIds: string[] = [];
  const entryIds: string[] = [];
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail?: unknown): void => {
    if (ok) console.log(`[smoke] ok   ${label}`);
    else {
      console.error(`[smoke] FAIL ${label} — ${JSON.stringify(detail)}`);
      failures.push(label);
    }
  };

  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    await userSecretsService.initialize(db, await secretsService.getMasterKek());
    const app = createApiApp('http://localhost:3000');

    const cookies = {} as Record<Role, string>;
    for (const role of ['admin', 'user'] as const) {
      const id = await createUser(db, role);
      userIds.push(id);
      cookies[role] = `${ACCESS_COOKIE}=${await signAccessToken({ sub: id, role, tv: 0 })}`;
    }

    const call = async (
      who: Role,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Reply> => {
      const res = await app.request(path, {
        method,
        headers: {
          cookie: cookies[who],
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) as Json };
      } catch {
        return { status: res.status, body: { text } };
      }
    };
    const entryPath = (id: string) => `/global-kb/entries/${id}`;
    const enforce = (id: string, token: string, spec: Json = { mode: 'always' }) =>
      call('admin', 'PUT', `${entryPath(id)}/enforcement`, { ...spec, expectedHash: token });
    const row = (id: string) =>
      withGlobalKb(getDb(), async ({ db: kb }) =>
        kb.query.globalKbEntries.findFirst({ where: eq(globalKbEntries.id, id) }),
      );
    const link = (draftId: string, predecessorId: string) =>
      withGlobalKb(getDb(), async ({ db: kb }) => {
        await kb
          .update(globalKbEntries)
          .set({ supersedesEntryId: predecessorId })
          .where(eq(globalKbEntries.id, draftId));
      });
    const remove = (ids: string[]) =>
      withGlobalKb(getDb(), async ({ db: kb }) => {
        await kb.delete(globalKbEntries).where(inArray(globalKbEntries.id, ids));
      });
    const make = async (
      title: string,
      over: { body?: string; status?: 'draft' | 'active' } = {},
    ) => {
      const res = await call('admin', 'POST', '/global-kb/entries', {
        title,
        body: over.body ?? '# Smoke rule\n\nUse the smoke pattern.',
        category: 'best_practice',
        description: 'A rule the smoke made.',
        facets: { framework: ['drupal'] },
        status: over.status ?? 'active',
      });
      if (res.status !== 201) throw new Error(`could not create "${title}": ${res.status}`);
      const entry = res.body.entry as Json;
      entryIds.push(entry.id as string);
      return { id: entry.id as string, token: entry.contentToken as string };
    };

    // One sequential request first: the first use of a fresh internal store creates its database.
    const warm = await call('admin', 'GET', '/global-kb/entries?pageSize=1');
    if (warm.status !== 200) throw new Error(`the global KB did not come up: ${warm.status}`);
    const config = await call('admin', 'GET', '/global-kb/config');
    if (warm.body.total !== 0 || config.body.mode !== 'internal') {
      throw new Refusal(
        `the global KB holds ${warm.body.total} entries in ${config.body.mode} mode. This smoke ` +
          'writes entries and deletes them by id; it needs a store of its own, empty and internal.',
      );
    }

    const always: Array<{ statuses: number[]; ok: boolean }> = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const a = await make(`Smoke always ${round} A`, { body: HEAVY });
      const b = await make(`Smoke always ${round} B`, { body: HEAVY });
      const [ra, rb] = await Promise.all([enforce(a.id, a.token), enforce(b.id, b.token)]);
      const [won, lost] = ra.status === 200 ? [a, b] : [b, a];
      const refused = ra.status === 200 ? rb : ra;
      const [wonRow, lostRow, aRow, bRow] = await Promise.all([
        row(won.id),
        row(lost.id),
        row(a.id),
        row(b.id),
      ]);
      const statuses = [ra.status, rb.status].sort();
      always.push({
        statuses,
        ok:
          statuses[0] === 200 &&
          statuses[1] === 409 &&
          refused.body.code === 'always_cap' &&
          refused.body.usedBytes === houseRuleBytes(wonRow!) &&
          refused.body.entryBytes === houseRuleBytes(lostRow!) &&
          [aRow, bRow].filter((r) => r!.enforcedHash !== null).length === 1,
      });
      if (round === 1) {
        const list = await call('admin', 'GET', '/global-kb/entries?pageSize=50');
        const listed = (list.body.entries as Json[]).find((e) => e.id === won.id);
        check(
          'the list carries the enforcement state of an enforced entry',
          listed?.enforcementState?.state === 'enforced' && typeof listed.contentToken === 'string',
          listed?.enforcementState,
        );
      }
      await remove([a.id, b.id]);
    }
    check(
      `two concurrent always enforces that fit alone and not together: one 200 and one always_cap 409 with the byte counts, ${ROUNDS} rounds`,
      always.every((r) => r.ok),
      always.filter((r) => !r.ok).slice(0, 3),
    );

    const reactivation: Array<Json> = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const p = await make(`Smoke reactivate ${round} predecessor`);
      const d = await make(`Smoke reactivate ${round} draft`, { status: 'draft' });
      await link(d.id, p.id);
      await call('admin', 'PATCH', entryPath(d.id), { status: 'archived' });
      const [enf, act] = await Promise.all([
        enforce(p.id, p.token, { mode: 'files', globs: GLOBS }),
        call('admin', 'PATCH', entryPath(d.id), { status: 'active' }),
      ]);
      const [pRow, dRow] = await Promise.all([row(p.id), row(d.id)]);
      const ok =
        (enf.status === 200 || (enf.status === 409 && enf.body.code === 'not_active')) &&
        act.status === 200 &&
        pRow?.status === 'archived' &&
        pRow.enforcedHash === null &&
        dRow?.status === 'active';
      if (!ok) reactivation.push({ round, enforce: enf.status, activate: act.status, pRow });
      await remove([p.id, d.id]);
    }
    check(
      `enforcing racing the reactivation of the draft that replaces it: no 500, and the replaced entry ends archived and unapproved, ${ROUNDS} rounds`,
      reactivation.length === 0,
      reactivation.slice(0, 3),
    );

    const deletion: Array<Json> = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const p = await make(`Smoke delete ${round} predecessor`);
      const d = await make(`Smoke delete ${round} draft`, { status: 'draft' });
      await link(d.id, p.id);
      const [del, act] = await Promise.all([
        call('admin', 'DELETE', entryPath(p.id)),
        call('admin', 'PATCH', entryPath(d.id), { status: 'active' }),
      ]);
      const [pRow, dRow] = await Promise.all([row(p.id), row(d.id)]);
      if (
        del.status !== 200 ||
        act.status !== 200 ||
        pRow !== undefined ||
        dRow?.status !== 'active'
      ) {
        deletion.push({ round, delete: del.status, activate: act.status, pRow, dRow });
      }
      await remove([p.id, d.id]);
    }
    check(
      `deleting an entry racing the activation of the draft that supersedes it: no 500, ${ROUNDS} rounds`,
      deletion.length === 0,
      deletion.slice(0, 3),
    );

    const rescope: Array<Json> = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const e = await make(`Smoke rescope ${round} entry`);
      const s = await make(`Smoke rescope ${round} draft`, { status: 'draft' });
      await link(s.id, e.id);
      const [edit, act] = await Promise.all([
        call('admin', 'PATCH', entryPath(e.id), { facets: { framework: ['laravel'] } }),
        call('admin', 'PATCH', entryPath(s.id), { status: 'active' }),
      ]);
      if (edit.status !== 200 || act.status !== 200) {
        rescope.push({ round, edit: edit.status, activate: act.status });
      }
      await remove([e.id, s.id]);
    }
    check(
      `re-scoping an entry racing the activation of the draft that supersedes it: no 500, ${ROUNDS} rounds`,
      rescope.length === 0,
      rescope.slice(0, 3),
    );

    if (failures.length > 0) {
      exitCode = 1;
      console.error(`[smoke] ${failures.length} FAILED: ${failures.join(' | ')}`);
    } else {
      console.log(
        JSON.stringify({ smoke: 'HOUSE_RULES_ENFORCEMENT_OK', checks: 5, rounds: ROUNDS }),
      );
    }
  } catch (err) {
    if (err instanceof Refusal) {
      exitCode = 2;
      console.error(`[smoke] REFUSING: ${err.message}`);
    } else {
      exitCode = 1;
      log.error({ err }, 'smoke failed');
      console.error('[smoke] FAILED:', err);
    }
  } finally {
    try {
      if (entryIds.length > 0) {
        await withGlobalKb(getDb(), async ({ db: kb }) => {
          await kb.delete(globalKbEntries).where(inArray(globalKbEntries.id, entryIds));
        });
      }
      if (userIds.length > 0) {
        await getDb().delete(schema.users).where(inArray(schema.users.id, userIds));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
