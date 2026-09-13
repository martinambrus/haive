import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import type {
  CodexAppServerFailure,
  CodexAppServerStage,
} from '../cli-executor/codex-app-server.js';
import type { CliProviderRecord } from './types.js';

const log = logger.child({ module: 'codex-app-server-verdict' });

/** The task event written beside every `unsupported` verdict — see recordCodexAppServerVerdict. */
export const CODEX_APP_SERVER_UNAVAILABLE_EVENT = 'codex_app_server.unavailable';

/** Whether codex's experimental app-server transport works for one provider in one task.
 *
 *  Stored per task in `tasks.codex_app_server`, keyed by provider id (migration 0157), and kept in
 *  sync by hand with the jsonb type there — the database package cannot import the worker.
 *
 *  `providerCliVersion` is the provider row's `cli_version` when the verdict was taken. A verdict
 *  is CURRENT only while that still matches, so a version change re-probes rather than trusting a
 *  statement about a different binary. A provider left on "latest" (NULL) keeps its verdict across
 *  an image rebuild; a rebuild that broke the transport is caught at runtime instead, and recorded
 *  as `source: 'runtime'`.
 *
 *  `detail` is display copy. Nothing branches on it. */
export interface CodexAppServerVerdict {
  status: 'supported' | 'unsupported';
  providerCliVersion: string | null;
  /** `thread.cliVersion` as the binary reported it during the probe, for the record. */
  binaryVersion: string | null;
  stage: CodexAppServerStage | null;
  detail: string | null;
  source: 'probe' | 'runtime';
  at: string;
}

export type CodexAppServerVerdicts = Record<string, CodexAppServerVerdict>;

function normalizeCliVersion(version: string | null | undefined): string | null {
  return version?.trim() || null;
}

/** The verdict that still describes this provider's binary, or null when there is none. */
export function currentCodexAppServerVerdict(
  verdicts: CodexAppServerVerdicts | null | undefined,
  provider: Pick<CliProviderRecord, 'id' | 'cliVersion'>,
): CodexAppServerVerdict | null {
  const verdict = verdicts?.[provider.id];
  if (!verdict) return null;
  return verdict.providerCliVersion === normalizeCliVersion(provider.cliVersion) ? verdict : null;
}

export function isCodexAppServerSupported(
  verdicts: CodexAppServerVerdicts | null | undefined,
  provider: Pick<CliProviderRecord, 'id' | 'cliVersion'>,
): boolean {
  return currentCodexAppServerVerdict(verdicts, provider)?.status === 'supported';
}

export function codexAppServerVerdict(
  provider: Pick<CliProviderRecord, 'cliVersion'>,
  fields: Pick<CodexAppServerVerdict, 'status' | 'binaryVersion' | 'stage' | 'detail' | 'source'>,
): CodexAppServerVerdict {
  return {
    ...fields,
    providerCliVersion: normalizeCliVersion(provider.cliVersion),
    at: new Date().toISOString(),
  };
}

/** Every verdict recorded for a task. A read that fails answers "none", which dispatches
 *  `codex exec` — the path that worked before any of this existed. */
export async function loadCodexAppServerVerdicts(
  db: Database,
  taskId: string,
): Promise<CodexAppServerVerdicts> {
  try {
    const row = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { codexAppServer: true },
    });
    return (row?.codexAppServer as CodexAppServerVerdicts | null | undefined) ?? {};
  } catch {
    return {};
  }
}

/** Record one provider's verdict. One statement that merges into the stored object, so two
 *  providers recorded at once cannot overwrite each other's entry.
 *
 *  An `unsupported` verdict is also written as a task event, which the Activity tab keeps for the
 *  life of the task. The step warning cannot carry it alone: a self-revising step resets its own
 *  row at the end of the turn that set it — MEASURED on a plan_chat turn, the warning was cleared
 *  0.3 s after it was written. Best-effort, so a recorded verdict is never lost to a failed event. */
export async function recordCodexAppServerVerdict(
  db: Database,
  taskId: string,
  providerId: string,
  verdict: CodexAppServerVerdict,
): Promise<void> {
  await db
    .update(schema.tasks)
    .set({
      codexAppServer: sql`coalesce(${schema.tasks.codexAppServer}, '{}'::jsonb) || jsonb_build_object(${providerId}::text, ${JSON.stringify(verdict)}::jsonb)`,
    })
    .where(eq(schema.tasks.id, taskId));
  if (verdict.status !== 'unsupported' || verdict.stage === null) return;
  const codexVersion = verdict.binaryVersion ?? verdict.providerCliVersion;
  try {
    await db.insert(schema.taskEvents).values({
      taskId,
      eventType: CODEX_APP_SERVER_UNAVAILABLE_EVENT,
      payload: {
        message: codexAppServerFallbackWarning(
          { stage: verdict.stage, detail: verdict.detail },
          codexVersion,
        ),
        providerId,
        stage: verdict.stage,
        detail: verdict.detail,
        codexVersion,
        source: verdict.source,
      },
    });
  } catch (err) {
    log.warn({ err, taskId, providerId }, 'failed to record the codex app-server event');
  }
}

/** A run found the transport broken: the rest of the task uses `codex exec` for this provider.
 *  Stamped with the provider's CURRENT cli_version, so it describes the binary that just failed and
 *  a later version change still re-probes. */
export async function recordCodexAppServerRuntimeFailure(
  db: Database,
  taskId: string,
  providerId: string,
  failure: CodexAppServerFailure,
  binaryVersion: string | null,
): Promise<void> {
  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, providerId),
    columns: { cliVersion: true },
  });
  if (!provider) return;
  await recordCodexAppServerVerdict(
    db,
    taskId,
    providerId,
    codexAppServerVerdict(provider, {
      status: 'unsupported',
      binaryVersion,
      stage: failure.stage,
      detail: failure.detail,
      source: 'runtime',
    }),
  );
}

/** A run reported the codex version it actually used. When the stored verdict was taken on a
 *  different binary — a provider left on "latest" whose image was rebuilt mid-task — it no longer
 *  describes what runs, so it is dropped and the next steerable dispatch probes the new binary
 *  before relying on it. That probe, not the run that noticed, is what catches a changed protocol.
 *  Returns true when a verdict was dropped. */
export async function forgetCodexAppServerVerdictForOtherBinary(
  db: Database,
  taskId: string,
  providerId: string,
  observedBinaryVersion: string,
): Promise<boolean> {
  const verdict = (await loadCodexAppServerVerdicts(db, taskId))[providerId];
  if (
    !verdict ||
    verdict.binaryVersion === null ||
    verdict.binaryVersion === observedBinaryVersion
  ) {
    return false;
  }
  await db
    .update(schema.tasks)
    .set({ codexAppServer: sql`${schema.tasks.codexAppServer} - ${providerId}::text` })
    .where(eq(schema.tasks.id, taskId));
  return true;
}

/** The step banner for a run that fell back. Written for the person watching the task, and says
 *  what to do when it is not a one-off: the admin page lists every recorded failure with the codex
 *  version, which is the report Haive's own protocol support gets updated from. */
export function codexAppServerFallbackWarning(
  failure: CodexAppServerFailure,
  binaryVersion: string | null,
): string {
  const version = binaryVersion ? ` on codex ${binaryVersion}` : '';
  return (
    `codex app-server failed at ${failure.stage}${version}: ${failure.detail ?? 'no detail'}. ` +
    'This task continues on codex exec, without mid-run steering. If this keeps happening after a ' +
    "codex update, Haive's app-server support needs updating — Admin > Execution lists every " +
    'recorded failure.'
  );
}
