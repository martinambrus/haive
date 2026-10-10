import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import {
  classifyGlobalKbError,
  enforcementState,
  globalKbEntries,
  resolveGlobalKbEnabled,
  resolveHouseRulesEnabled,
  resolveTaskFacets,
  withGlobalKb,
  type GlobalKbCallOptions,
  type GlobalKbDb,
  type GlobalKbErrorClass,
  type HouseRulesStamp,
  type ProjectFacetSet,
} from '@haive/shared/global-kb';
import {
  emptyDigest,
  facetsMatchProject,
  readDigestRows,
  selectDigest,
  type GlobalKbDigest,
} from '../step-engine/steps/_global-kb-digest.js';
import { vetHouseRules, type HouseRuleCandidate } from './house-rules.js';

const log = logger.child({ module: 'global-kb-context' });

/** What one dispatch waits on the store, per call so the sync job and the api keep their own limits. */
export const DISPATCH_KB_BOUNDS: Readonly<GlobalKbCallOptions & { statementTimeoutMs: number }> = {
  connectTimeoutSeconds: 3,
  statementTimeoutMs: 3_000,
  deadlineMs: 6_000,
};

export interface GlobalKbContext {
  digest: GlobalKbDigest;
  /** Enforced, in scope for the project and clean to show; empty unless rules were asked for. */
  rules: HouseRuleCandidate[];
  refused: HouseRulesStamp['omitted'];
  /** Of the rules half: 'disabled' is a switch, 'unavailable' a store that could not be read. */
  status: 'ok' | 'disabled' | 'unavailable';
  errorClass?: GlobalKbErrorClass;
}

const settled = (
  status: GlobalKbContext['status'],
  extra: Partial<GlobalKbContext> = {},
): GlobalKbContext => ({
  digest: emptyDigest(),
  rules: [],
  refused: [],
  status,
  ...extra,
});

type Tx = Parameters<Parameters<GlobalKbDb['transaction']>[0]>[0];

/** `SET LOCAL` in a transaction of its own: the server stops a statement the client gave up on, and a
 *  pooler's other sessions never see the setting. */
export const timed = <T>(gdb: GlobalKbDb, ms: number, run: (tx: Tx) => Promise<T>): Promise<T> =>
  gdb.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${Math.trunc(ms)}ms'`));
    return run(tx);
  });

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * The global KB's side of one dispatch, read once: the title digest, and for a dispatch that asks
 * for them the enforced entries. Never rejects, and bounded (`DISPATCH_KB_BOUNDS`) because the
 * dispatch waits on it. A failure says only its class: the message names the store's host.
 * The two halves settle apart, so a failed title scan does not mark the rules unavailable.
 */
export async function resolveGlobalKbContext(
  db: Database,
  taskId: string,
  opts: { houseRules: boolean },
  bounds: typeof DISPATCH_KB_BOUNDS = DISPATCH_KB_BOUNDS,
): Promise<GlobalKbContext> {
  const wantRules = opts.houseRules;
  const failed = (err: unknown): GlobalKbContext => {
    const errorClass = classifyGlobalKbError(err);
    log.warn({ err, taskId, errorClass }, 'global KB could not be read for a dispatch');
    return settled('unavailable', { errorClass });
  };

  let rulesSwitchedOff = false;
  try {
    const [globalEnabled, digestEnabled, rulesEnabled] = await Promise.all([
      resolveGlobalKbEnabled(configService),
      configService.getBoolean(CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED, true),
      wantRules ? resolveHouseRulesEnabled(configService) : Promise.resolve(false),
    ]);
    if (!globalEnabled) return settled('disabled');
    const readRules = wantRules && rulesEnabled;
    rulesSwitchedOff = wantRules && !rulesEnabled;
    const idleStatus = rulesSwitchedOff ? 'disabled' : 'ok';
    if (!digestEnabled && !readRules) return settled(idleStatus);

    const projectFacets = await resolveTaskFacets(db, taskId);
    const options: GlobalKbCallOptions = {
      connectTimeoutSeconds: bounds.connectTimeoutSeconds,
      deadlineMs: bounds.deadlineMs,
    };

    const read = await withGlobalKb(
      db,
      async ({ db: gdb, settings }) => {
        const [digestRows, ruleRows] = await Promise.all([
          digestEnabled
            ? settle(
                timed(gdb, bounds.statementTimeoutMs, (tx) =>
                  readDigestRows(tx, settings.namespace),
                ),
              )
            : null,
          readRules
            ? settle(
                readApplicableRows(
                  gdb,
                  settings.namespace,
                  projectFacets,
                  bounds.statementTimeoutMs,
                ),
              )
            : null,
        ]);
        return { digestRows, ruleRows, namespace: settings.namespace };
      },
      options,
    );

    let digest = emptyDigest();
    if (read.digestRows?.ok) digest = selectDigest(read.digestRows.value, projectFacets);
    else if (read.digestRows) log.warn({ taskId }, 'global KB digest could not be read');

    if (read.ruleRows === null) return settled(idleStatus, { digest });
    if (!read.ruleRows.ok) {
      const errorClass = classifyGlobalKbError(read.ruleRows.error);
      log.warn(
        { err: read.ruleRows.error, taskId, errorClass },
        'enforced house rules could not be read',
      );
      return settled('unavailable', { digest, errorClass });
    }
    const vetted = vetHouseRules(enforcedRules(read.ruleRows.value, read.namespace, projectFacets));
    return settled('ok', { digest, rules: vetted.usable, refused: vetted.refused });
  } catch (err) {
    const unavailable = failed(err);
    // A switch read as off stays off: only the digest's read failed.
    return rulesSwitchedOff ? settled('disabled') : unavailable;
  }
}

type EnforcedRow = Awaited<ReturnType<typeof readEnforcedRows>>[number];

const enforcedIn = (namespace: string) =>
  and(
    eq(globalKbEntries.namespace, namespace),
    eq(globalKbEntries.status, 'active'),
    isNull(globalKbEntries.supersededAt),
    isNotNull(globalKbEntries.enforcedHash),
  );

function readEnforcedScope(gdb: Pick<GlobalKbDb, 'select'>, namespace: string) {
  return gdb
    .select({ id: globalKbEntries.id, facets: globalKbEntries.facets })
    .from(globalKbEntries)
    .where(enforcedIn(namespace));
}

function readEnforcedRows(gdb: Pick<GlobalKbDb, 'select'>, namespace: string, ids: string[]) {
  return gdb
    .select({
      id: globalKbEntries.id,
      namespace: globalKbEntries.namespace,
      status: globalKbEntries.status,
      supersededAt: globalKbEntries.supersededAt,
      title: globalKbEntries.title,
      category: globalKbEntries.category,
      description: globalKbEntries.description,
      body: globalKbEntries.body,
      facets: globalKbEntries.facets,
      enforce: globalKbEntries.enforce,
      enforcedHash: globalKbEntries.enforcedHash,
      enforcedAt: globalKbEntries.enforcedAt,
    })
    .from(globalKbEntries)
    .where(and(enforcedIn(namespace), inArray(globalKbEntries.id, ids)))
    .orderBy(asc(globalKbEntries.enforcedAt), asc(globalKbEntries.id));
}

/** The project's scope is judged on `id` and `facets` alone, so no row cap can hide a rule from it. */
async function readApplicableRows(
  gdb: GlobalKbDb,
  namespace: string,
  projectFacets: ProjectFacetSet,
  statementTimeoutMs: number,
): Promise<EnforcedRow[]> {
  const scope = await timed(gdb, statementTimeoutMs, (tx) => readEnforcedScope(tx, namespace));
  const ids = scope.filter((r) => facetsMatchProject(r.facets, projectFacets)).map((r) => r.id);
  if (ids.length === 0) return [];
  return timed(gdb, statementTimeoutMs, (tx) => readEnforcedRows(tx, namespace, ids));
}

/** `enforcementState` re-derives the hash from the stored content, so a row edited without clearing it drops. */
function enforcedRules(
  rows: readonly EnforcedRow[],
  namespace: string,
  projectFacets: ProjectFacetSet,
): HouseRuleCandidate[] {
  const out: HouseRuleCandidate[] = [];
  for (const row of rows) {
    const state = enforcementState(row, { namespace, houseRulesEnabled: true });
    if (state.state !== 'enforced' || row.enforcedHash === null) continue;
    if (!facetsMatchProject(row.facets, projectFacets)) continue;
    out.push({
      id: row.id,
      hash: row.enforcedHash,
      title: row.title,
      category: row.category,
      description: row.description,
      body: row.body,
      spec:
        state.mode === 'files' ? { mode: 'files', globs: state.globs ?? [] } : { mode: 'always' },
      enforcedAt: row.enforcedAt,
    });
  }
  return out;
}
