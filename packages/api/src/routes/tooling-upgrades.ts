import { Hono } from 'hono';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  LSP_KEY_SET,
  LSP_SERVER_OPTIONS,
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
  TOOL_INSTALL_METADATA,
  configService,
  logger,
  decideImportedMcpServers,
  pendingImportedMcpServers,
  userSecretsService,
  verifyCommandsSchema,
  type OnboardingEnvironmentMirror,
  type OnboardingToolingMirror,
  type ToolName,
} from '@haive/shared';
import { rtkEnabledUpdate, convergeRtkQuestion } from '@haive/shared/rtk-enabled';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import {
  RAG_TABLE,
  openExistingRagDatabase,
  ragDatabaseName,
  ragRowsAwaitReembed,
  resolveRagConnection,
  tryAcquireRagSyncLock,
  type RagConnection,
  type RagSyncLock,
  type RagMode,
} from '@haive/shared/rag';
import {
  ALL_REVIEW_DIMENSION_IDS,
  REVIEW_DIMENSIONS,
  normalizeReviewDimensionIds,
} from '@haive/shared/review';
import { getDb } from '../db.js';
import { insertAuditEvent, logAuditEvent, type AuditEvent } from '../lib/audit.js';
import { getRedis } from '../redis.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

export const toolingUpgradeRoutes = new Hono<AppEnv>();
toolingUpgradeRoutes.use('*', requireAuth);

/** Per-repo tooling component (RTK, chrome-devtools-mcp, an LSP server). */
interface ToolingComponentStatus {
  /** Stable component id: 'rtk', 'chrome-devtools-mcp', or an lsp key (which may
   *  be 'intelephense-extended' even though its package/tool is 'intelephense'). */
  component: string;
  displayName: string;
  installed: string | null;
  latest: string | null;
  upgradeAvailable: boolean;
}

interface ToolingUpgradeStatusResponse {
  repositoryId: string;
  hasUpgradeAvailable: boolean;
  components: ToolingComponentStatus[];
}

// lsp key (as stored in declaredDeps.lspServers / repo.lspServerVersions) -> the
// tool name whose version cache + package it maps to. intelephense-extended is
// the same intelephense package.
const LSP_KEY_TO_TOOL: Record<string, ToolName> = {
  intelephense: 'intelephense',
  'intelephense-extended': 'intelephense',
  vtsls: 'vtsls',
  pyright: 'pyright',
  gopls: 'gopls',
  solargraph: 'solargraph',
  'rust-analyzer': 'rust-analyzer',
  jdtls: 'jdtls',
};

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `candidate` is a strictly newer release than `current`. Unparseable
 *  versions never flag an upgrade (so we never prompt a churn/downgrade we can't
 *  reason about). */
function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

async function loadToolVersions(
  db: ReturnType<typeof getDb>,
): Promise<Map<string, { versions: string[]; latest: string | null }>> {
  const rows = await db
    .select({
      name: schema.toolPackageVersions.name,
      versions: schema.toolPackageVersions.versions,
      latestVersion: schema.toolPackageVersions.latestVersion,
    })
    .from(schema.toolPackageVersions);
  const map = new Map<string, { versions: string[]; latest: string | null }>();
  for (const r of rows)
    map.set(r.name, { versions: r.versions ?? [], latest: r.latestVersion ?? null });
  return map;
}

/** Newest installable version for a tool: the head of the sorted-desc versions
 *  list (the highest published), falling back to the dist-tag latest. The list
 *  head is preferred because the dist-tag can lag behind the newest publish. */
function newestFor(
  tool: ToolName,
  versionMap: Map<string, { versions: string[]; latest: string | null }>,
): string | null {
  const entry = versionMap.get(tool);
  if (!entry) return null;
  return entry.versions[0] ?? entry.latest ?? null;
}

/** Build the candidate component list from the repo's pins. A component appears
 *  only when explicitly pinned: unpinned (null) means track-latest — RTK is
 *  resolved to the newest release by the composer, LSP/chrome install latest at
 *  build — so an unpinned component is never "behind" and never nags. */
function repoComponents(repo: {
  rtkVersion: string | null;
  lspServerVersions: Record<string, string | null> | null;
  chromeDevtoolsMcpVersion: string | null;
}): { component: string; tool: ToolName; installed: string }[] {
  const out: { component: string; tool: ToolName; installed: string }[] = [];
  if (repo.rtkVersion) out.push({ component: 'rtk', tool: 'rtk', installed: repo.rtkVersion });
  for (const [lspKey, version] of Object.entries(repo.lspServerVersions ?? {})) {
    const tool = LSP_KEY_TO_TOOL[lspKey];
    if (!tool || !version || !TOOL_INSTALL_METADATA[tool].versionPinnable) continue;
    out.push({ component: lspKey, tool, installed: version });
  }
  if (repo.chromeDevtoolsMcpVersion) {
    out.push({
      component: 'chrome-devtools-mcp',
      tool: 'chrome-devtools-mcp',
      installed: repo.chromeDevtoolsMcpVersion,
    });
  }
  return out;
}

toolingUpgradeRoutes.get('/:id/tooling-upgrade-status', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: {
      id: true,
      rtkVersion: true,
      lspServerVersions: true,
      chromeDevtoolsMcpVersion: true,
    },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const versionMap = await loadToolVersions(db);
  const components: ToolingComponentStatus[] = repoComponents(repo).map(
    ({ component, tool, installed }) => {
      const latest = newestFor(tool, versionMap);
      return {
        component,
        displayName: TOOL_INSTALL_METADATA[tool].displayName,
        installed,
        latest,
        upgradeAvailable: !!latest && isNewer(latest, installed),
      };
    },
  );

  const body: ToolingUpgradeStatusResponse = {
    repositoryId,
    hasUpgradeAvailable: components.some((x) => x.upgradeAvailable),
    components,
  };
  return c.json(body);
});

toolingUpgradeRoutes.post('/:id/tooling-upgrade', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: {
      id: true,
      rtkVersion: true,
      lspServerVersions: true,
      chromeDevtoolsMcpVersion: true,
    },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  // Optional { components: string[] } restricts which to upgrade; absent = all.
  let parsed: { components?: string[] } = {};
  try {
    parsed = (await c.req.json()) as { components?: string[] };
  } catch {
    // empty body → upgrade everything upgradeable
  }
  const requested = Array.isArray(parsed.components) ? new Set(parsed.components) : null;

  const versionMap = await loadToolVersions(db);
  const applied: { component: string; from: string; to: string }[] = [];
  let nextRtk = repo.rtkVersion;
  const nextLsp: Record<string, string | null> = { ...(repo.lspServerVersions ?? {}) };
  let nextChrome = repo.chromeDevtoolsMcpVersion;

  for (const { component, tool, installed } of repoComponents(repo)) {
    if (requested && !requested.has(component)) continue;
    const latest = newestFor(tool, versionMap);
    if (!latest || !isNewer(latest, installed)) continue;
    applied.push({ component, from: installed, to: latest });
    if (component === 'rtk') nextRtk = latest;
    else if (component === 'chrome-devtools-mcp') nextChrome = latest;
    else nextLsp[component] = latest;
  }

  // Only the repo pins change here. The repo's next workflow task re-runs
  // 01-declare-deps, which injects the new pins into declaredDeps → the
  // staleDockerfile check re-renders + rebuilds the env image (and the composed
  // image rebuilds on its hash change). No eager build is triggered.
  if (applied.length > 0) {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.repositories)
        .set({
          rtkVersion: nextRtk,
          lspServerVersions: nextLsp,
          chromeDevtoolsMcpVersion: nextChrome,
          updatedAt: new Date(),
        })
        .where(eq(schema.repositories.id, repositoryId));
      await markProjectStateDirty(tx, repositoryId);
    });
  }

  return c.json({ repositoryId, applied, rebuildOnNextTask: applied.length > 0 });
});

// The connect bound rag_search puts on a project store (routes/rag.ts).
const RAG_REEMBED_CONNECT_TIMEOUT_SECONDS = 3;
// Measured on 4,000 production-shape rows: 8 batches of 500, the longest statement 1.5 s, 9.7 s in all.
const RAG_REEMBED_BATCH_ROWS = 500;
const RAG_REEMBED_STATEMENT_TIMEOUT_MS = 3_000;
const RAG_REEMBED_DEADLINE_MS = 60_000;
const RAG_PROBE_DEADLINE_MS = 10_000;
const QUERY_CANCELED = '57014';
const UNDEFINED_TABLE = '42P01';

class ReembedDeadline extends Error {}

/** Opens the repository's RAG store from its own onboarding mirrors rather than a
 *  task's step outputs, since the callers run from a settings page with no task in hand.
 *  Null when the repo has no usable RAG config. */
async function openRagStore(
  db: ReturnType<typeof getDb>,
  repositoryId: string,
  opts: { existingOnly?: boolean } = {},
): Promise<RagConnection | null> {
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { onboardingTooling: true, onboardingEnvironment: true },
  });
  const toolingMirror = repo?.onboardingTooling as OnboardingToolingMirror | null | undefined;
  const envMirror = repo?.onboardingEnvironment as OnboardingEnvironmentMirror | null | undefined;
  if (
    toolingMirror?.schemaVersion !== ONBOARDING_TOOLING_SCHEMA_VERSION ||
    !toolingMirror.tooling
  ) {
    return null;
  }
  const t = toolingMirror.tooling as {
    ragMode?: string;
    ragConnectionString?: string | null;
    ollamaUrl?: string | null;
    embeddingModel?: string | null;
    embeddingDimensions?: number;
  };
  if (!t.ragMode || t.ragMode === 'none') return null;
  const projectName =
    envMirror?.schemaVersion === ONBOARDING_ENVIRONMENT_SCHEMA_VERSION
      ? ((envMirror.envDetectData as { project?: { name?: string } } | undefined)?.project?.name ??
        'default')
      : 'default';

  const dims = typeof t.embeddingDimensions === 'number' ? t.embeddingDimensions : 2560;
  // A read must not create the internal database it is asking about.
  if (opts.existingOnly && t.ragMode === 'internal') {
    return openExistingRagDatabase(db, ragDatabaseName(projectName), dims);
  }
  return resolveRagConnection(
    {
      ragMode: t.ragMode as RagMode,
      ragConnectionString: t.ragConnectionString || null,
      ollamaUrl: t.ollamaUrl || null,
      embeddingModel: t.embeddingModel || null,
      embeddingDimensions: dims,
    },
    db,
    projectName,
    { connectTimeoutSeconds: RAG_REEMBED_CONNECT_TIMEOUT_SECONDS, fetchTypes: false },
  );
}

/** Whether the repository's store holds rows awaiting re-embed. A store that is
 *  configured but does not answer in time reads as true: the caller keeps its flag
 *  rather than clearing it blind. No store configured reads as false. */
async function ragStoreAwaitsReembedBounded(
  db: ReturnType<typeof getDb>,
  repositoryId: string,
): Promise<boolean> {
  const held: { conn: RagConnection | null } = { conn: null };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReembedDeadline()), RAG_PROBE_DEADLINE_MS);
  });
  const probe = async () => {
    held.conn = await openRagStore(db, repositoryId, { existingOnly: true });
    if (!held.conn) return false;
    try {
      return await held.conn.pg.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '${RAG_REEMBED_STATEMENT_TIMEOUT_MS}ms'`);
        return ragRowsAwaitReembed(tx, repositoryId);
      });
    } catch (err) {
      // A store with no index table holds no rows to re-embed.
      if ((err as { code?: unknown } | null)?.code === UNDEFINED_TABLE) return false;
      throw err;
    }
  };
  try {
    return await Promise.race([probe(), deadline]);
  } catch {
    void held.conn?.pg.end({ timeout: 0 }).catch(() => {});
    return true;
  } finally {
    clearTimeout(timer);
    await held.conn?.close().catch(() => {});
  }
}

/** Fences each write of a RAG embed action: once the lock is lost another sync may be writing. */
function assertRagLockHeld(lock: RagSyncLock | null): void {
  if (lock?.lost) {
    throw new HttpError(
      409,
      'The RAG sync lock of this repository was lost while this action ran (another sync may have started); run it again when no sync is running',
    );
  }
}

/** Force every chunk of a repository's RAG index to be re-embedded on the next
 *  sync, WITHOUT deleting anything: nulling `chunk_hash` makes the incremental
 *  differ (`_rag-index.ts`) see every chunk as changed, so the rows stay
 *  searchable in the meantime and are replaced one batch at a time.
 *
 *  Needed in exactly two cases, both of which leave hash vectors on disk that a
 *  content-hash comparison would otherwise keep forever: a repository leaving
 *  lexical-only mode, and one indexed before strict embedding existed (those carry
 *  no degradation record, so this is their only route back).
 *
 *  Returns false when the repo has no usable RAG config — nothing to re-embed.
 *  Resets in bounded batches, so a stopped run is not rolled back: running it again
 *  continues, since it only touches rows that still hold a hash. */
async function forceRagReembed(
  db: ReturnType<typeof getDb>,
  repositoryId: string,
  lock: RagSyncLock | null,
): Promise<boolean> {
  const conn = await openRagStore(db, repositoryId);
  if (!conn) return false;
  const progress = { reset: 0 };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReembedDeadline()), RAG_REEMBED_DEADLINE_MS);
  });
  const resetBatches = async () => {
    for (;;) {
      assertRagLockHeld(lock);
      const res = await conn.pg.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '${RAG_REEMBED_STATEMENT_TIMEOUT_MS}ms'`);
        return tx.unsafe(
          `UPDATE ${RAG_TABLE} SET chunk_hash = NULL
            WHERE id IN (
              SELECT id FROM ${RAG_TABLE}
              WHERE repository_id = $1 AND chunk_hash IS NOT NULL
              ORDER BY id LIMIT ${RAG_REEMBED_BATCH_ROWS}
            )`,
          [repositoryId],
        );
      });
      if (res.count === 0) return;
      progress.reset += res.count;
    }
  };
  try {
    await Promise.race([resetBatches(), deadline]);
    return true;
  } catch (err) {
    void conn.pg.end({ timeout: 0 }).catch(() => {});
    if (!(err instanceof ReembedDeadline) && (err as { code?: string }).code !== QUERY_CANCELED) {
      throw err;
    }
    throw new HttpError(
      503,
      `The re-embed is not finished: the RAG store did not answer in time after ${progress.reset} chunks were marked. Run it again to continue where it stopped.`,
    );
  } finally {
    clearTimeout(timer);
    await conn.close().catch(() => {});
  }
}

/** Current per-repo tooling config + available versions, for the management page. */
toolingUpgradeRoutes.get('/:id/tooling-config', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: {
      id: true,
      rtkEnabled: true,
      rtkVersion: true,
      lspServers: true,
      lspServerVersions: true,
      chromeDevtoolsMcpVersion: true,
      secretMaskEnabled: true,
      secretMaskAllow: true,
      secretMaskDenyExtend: true,
      appAuth: true,
      prWorkflowEnabled: true,
      stepGuidanceEnabled: true,
      reviewDimensions: true,
      ragEmbedDegradedAt: true,
      ragEmbedDegradedReason: true,
      ragEmbedLexicalOnly: true,
      onboardingTooling: true,
      verifyCommands: true,
    },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  // Effective active LSP set + browser-testing flag from the repo's latest
  // env-template when there is no explicit repo-level LSP override.
  const envTemplate = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.repositoryId, repositoryId),
    orderBy: [desc(schema.envTemplates.updatedAt)],
    columns: { declaredDeps: true },
  });
  const deps = (envTemplate?.declaredDeps ?? {}) as {
    lspServers?: string[];
    browserTesting?: boolean;
  };

  const versionMap = await loadToolVersions(db);
  const versionsFor = (tool: ToolName): string[] => versionMap.get(tool)?.versions ?? [];

  const storedKeys = new Set(
    (await userSecretsService.listForUser(userId)).map((secret) => secret.keyName),
  );
  const appAuthUsernameSet = storedKeys.has(`app_auth:${repositoryId}:username`);
  const appAuthPasswordSet = storedKeys.has(`app_auth:${repositoryId}:password`);

  const lspOptions = LSP_SERVER_OPTIONS.map((o) => {
    const tool = LSP_KEY_TO_TOOL[o.value]!;
    const meta = TOOL_INSTALL_METADATA[tool];
    return {
      value: o.value,
      label: o.label,
      pinnable: meta.versionPinnable,
      versions: meta.versionPinnable ? versionsFor(tool) : [],
    };
  });

  return c.json({
    repositoryId,
    rtkEnabled: repo.rtkEnabled,
    rtkVersion: repo.rtkVersion,
    rtkVersions: versionsFor('rtk'),
    chromeDevtoolsMcpVersion: repo.chromeDevtoolsMcpVersion,
    chromeVersions: versionsFor('chrome-devtools-mcp'),
    browserTesting: !!deps.browserTesting,
    lspServers: repo.lspServers ?? deps.lspServers ?? [],
    lspServerVersions: repo.lspServerVersions ?? {},
    secretMaskEnabled: repo.secretMaskEnabled,
    secretMaskAllow: repo.secretMaskAllow ?? [],
    secretMaskDenyExtend: repo.secretMaskDenyExtend ?? [],
    appAuth: repo.appAuth ?? null,
    // Whether credentials exist, never what they are. The password is in the encrypted
    // secret store precisely so it never travels back out over an API.
    appAuthUsernameSet,
    appAuthPasswordSet,
    appAuthCredentialsSet: appAuthUsernameSet && appAuthPasswordSet,
    prWorkflowEnabled: repo.prWorkflowEnabled,
    stepGuidanceEnabled: repo.stepGuidanceEnabled,
    // RAG embedding health. `ragEmbedDegradedAt` is the structural flag the page
    // gates on; the reason beside it is display copy that outlives the state.
    ragEmbedDegradedAt: repo.ragEmbedDegradedAt?.toISOString() ?? null,
    ragEmbedDegradedReason: repo.ragEmbedDegradedReason,
    ragEmbedLexicalOnly: repo.ragEmbedLexicalOnly,
    pendingRepoMcpServers: pendingImportedMcpServers(repo.onboardingTooling),
    // null (never configured) is sent as the full set: that is what the reviewers
    // actually score, so the page shows the effective policy rather than an empty
    // list the user would read as "nothing is reviewed".
    verifyCommands: repo.verifyCommands ?? {},
    reviewDimensions: repo.reviewDimensions ?? [...ALL_REVIEW_DIMENSION_IDS],
    reviewDimensionOptions: REVIEW_DIMENSIONS.map((d) => ({
      value: d.id,
      label: d.label,
      hint: d.criteria.join(' '),
    })),
    // Guidance currently steering this repo's runs -- both its own items and the
    // stack-global ones, since a global item is just as invisible and just as
    // permanent. Rejected tombstones and archived items are NOT listed: a tombstone
    // records a decision already made and archived is already off, so showing either
    // would turn an off-switch into a browsable history nobody asked for.
    stepGuidance: (
      await db
        .select({
          id: schema.stepGuidance.id,
          stepId: schema.stepGuidance.stepId,
          scope: schema.stepGuidance.scope,
          cause: schema.stepGuidance.cause,
          guidance: schema.stepGuidance.guidance,
          providerFamily: schema.stepGuidance.providerFamily,
          occurrences: schema.stepGuidance.occurrences,
          updatedAt: schema.stepGuidance.updatedAt,
        })
        .from(schema.stepGuidance)
        .where(
          and(
            eq(schema.stepGuidance.status, 'active'),
            or(
              eq(schema.stepGuidance.repositoryId, repositoryId),
              isNull(schema.stepGuidance.repositoryId),
            ),
          ),
        )
        .orderBy(desc(schema.stepGuidance.occurrences), desc(schema.stepGuidance.updatedAt))
        .limit(100)
    ).map((g) => ({ ...g, updatedAt: g.updatedAt.toISOString() })),
    lspOptions,
  });
});

/** Turn one guidance item off (status -> 'archived'). The off-switch for an item that
 *  is already steering runs; kept out of the tooling PATCH because it is a different
 *  object and must work without saving the whole tooling form.
 *
 *  Archive, never delete: the row is what a later run's fingerprint matches against, so
 *  deleting it would let the same defect be re-offered as brand new. A GLOBAL item is
 *  archivable from here too -- it steers this repo's runs, so this is where its owner
 *  discovers it -- and archiving it turns it off everywhere, which is stated in the UI. */
toolingUpgradeRoutes.post('/:id/step-guidance/:guidanceId/archive', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const guidanceId = c.req.param('guidanceId');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const updated = await db
    .update(schema.stepGuidance)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(
      and(
        eq(schema.stepGuidance.id, guidanceId),
        eq(schema.stepGuidance.status, 'active'),
        // Scoped exactly like the list above: this repo's own items plus the global
        // ones it is subject to. A row belonging to another repository is not this
        // caller's to switch off.
        or(
          eq(schema.stepGuidance.repositoryId, repositoryId),
          isNull(schema.stepGuidance.repositoryId),
        ),
      ),
    )
    .returning({ id: schema.stepGuidance.id });
  if (updated.length === 0) throw new HttpError(404, 'Guidance item not found');
  return c.json({ id: guidanceId, status: 'archived' });
});

/** Accept an app-login config only if it is complete, else store null.
 *
 *  A half-filled config is worse than none: browser-login.js would fail on a missing
 *  selector, which the user reads as "the login is broken" rather than "I have not
 *  finished configuring it". Mirrors isUsableAppAuth in the worker, which is its reader.
 *  Credentials are never part of this object — they live in user_secrets. */
function normalizeAppAuth(raw: unknown): typeof schema.repositories.$inferInsert.appAuth {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const cond = (c.successCondition ?? {}) as Record<string, unknown>;
  const type =
    cond.type === 'element_present' ? ('element_present' as const) : ('url_contains' as const);
  const config = {
    enabled: c.enabled === true,
    loginUrl: str(c.loginUrl),
    usernameSelector: str(c.usernameSelector),
    passwordSelector: str(c.passwordSelector),
    submitSelector: str(c.submitSelector),
    successCondition: { type, value: str(cond.value) },
  };
  return config.loginUrl &&
    config.usernameSelector &&
    config.passwordSelector &&
    config.submitSelector &&
    config.successCondition.value
    ? config
    : null;
}

const PORTABLE_SETTING_UPDATE_KEYS = [
  'rtkEnabled',
  'rtkVersion',
  'lspServers',
  'lspServerVersions',
  'chromeDevtoolsMcpVersion',
  'reviewDimensions',
] as const;

/** Update per-repo tooling: enable/disable RTK + LSP servers and pin versions.
 *  Only writes repo columns; the env image rebuilds on the next task (via
 *  01-declare-deps re-injection). Disabling RTK flips rtk_enabled; the upgrade
 *  banner then offers an onboarding upgrade, which offers the RTK settings
 *  files for removal and takes the RTK block out of the rules files. */
toolingUpgradeRoutes.patch('/:id/tooling', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.param('id');
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const body = (await c.req.json().catch(() => ({}))) as {
    rtkEnabled?: boolean;
    rtkVersion?: string | null;
    lspServers?: string[];
    lspServerVersions?: Record<string, string | null>;
    chromeDevtoolsMcpVersion?: string | null;
    secretMaskEnabled?: boolean;
    secretMaskAllow?: string[];
    secretMaskDenyExtend?: string[];
    prWorkflowEnabled?: boolean;
    stepGuidanceEnabled?: boolean;
    reviewDimensions?: string[];
    verifyCommands?: unknown;
    /** RAG embed-health action. Not a settable field — each one is a decision with
     *  a side effect, so it is expressed as a verb rather than as three booleans a
     *  caller could combine into a meaningless state. */
    ragEmbedAction?: 'retry' | 'accept_lexical_only' | 'rebuild_index';
    /** Decides the MCP servers held when this repository's mirror was imported. */
    repoMcpServersAction?: 'accept' | 'discard';
    appAuth?: unknown;
    /** Write-only. Stored in user_secrets, never on the repositories row and never
     *  returned by the GET above. */
    appAuthUsername?: string;
    appAuthPassword?: string;
  };

  if (body.repoMcpServersAction === 'accept' || body.repoMcpServersAction === 'discard') {
    if (Object.keys(body).length > 1) {
      throw new HttpError(400, 'Decide the imported MCP servers in a request of their own');
    }
    const current = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
      columns: { onboardingTooling: true },
    });
    const read = current?.onboardingTooling;
    const decided = read
      ? decideImportedMcpServers(
          read,
          body.repoMcpServersAction,
          await configService.getEncryptionKey(),
        )
      : null;
    if (!read || !decided) {
      throw new HttpError(409, 'No imported MCP servers are waiting for a decision');
    }
    const written = await db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.repositories)
        .set({
          onboardingTooling: decided as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.repositories.id, repositoryId),
            eq(schema.repositories.onboardingTooling, read),
          ),
        )
        .returning({ id: schema.repositories.id });
      if (rows.length > 0) await markProjectStateDirty(tx, repositoryId);
      return rows;
    });
    if (written.length === 0) {
      throw new HttpError(
        409,
        'The MCP server settings changed meanwhile; reload and decide again',
      );
    }
    return c.json({ repositoryId, ok: true, reembedQueued: false });
  }

  let lock: RagSyncLock | null = null;
  if (body.ragEmbedAction) {
    try {
      lock = await tryAcquireRagSyncLock(getRedis(), repositoryId);
    } catch (err) {
      logger.warn({ err, repositoryId }, 'could not check the RAG sync lock');
      throw new HttpError(
        503,
        'Could not check whether a RAG sync of this repository is running; try again',
      );
    }
    if (!lock) {
      throw new HttpError(
        409,
        'A RAG sync of this repository is running; try again when it finishes',
      );
    }
  }
  try {
    const updates: Partial<typeof schema.repositories.$inferInsert> = { updatedAt: new Date() };
    if (body.verifyCommands !== undefined) {
      const parsed = verifyCommandsSchema.safeParse(body.verifyCommands);
      if (!parsed.success) {
        throw new HttpError(400, `Invalid verify commands: ${parsed.error.issues[0]?.message}`);
      }
      updates.verifyCommands = Object.keys(parsed.data).length > 0 ? parsed.data : null;
    }
    if (typeof body.rtkEnabled === 'boolean')
      Object.assign(updates, rtkEnabledUpdate(body.rtkEnabled));
    if (body.rtkVersion !== undefined) updates.rtkVersion = body.rtkVersion?.trim() || null;
    if (body.chromeDevtoolsMcpVersion !== undefined) {
      updates.chromeDevtoolsMcpVersion = body.chromeDevtoolsMcpVersion?.trim() || null;
    }
    if (Array.isArray(body.lspServers)) {
      updates.lspServers = [...new Set(body.lspServers.filter((s) => LSP_KEY_SET.has(s)))];
    }
    if (body.lspServerVersions && typeof body.lspServerVersions === 'object') {
      const clean: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(body.lspServerVersions)) {
        if (!LSP_KEY_SET.has(k)) continue;
        const val = typeof v === 'string' ? v.trim() : '';
        if (val) clean[k] = val;
      }
      updates.lspServerVersions = clean;
    }
    if (typeof body.secretMaskEnabled === 'boolean') {
      updates.secretMaskEnabled = body.secretMaskEnabled;
    }
    if (Array.isArray(body.secretMaskAllow)) {
      updates.secretMaskAllow = [
        ...new Set(body.secretMaskAllow.map((s) => s.trim()).filter(Boolean)),
      ];
    }
    if (Array.isArray(body.secretMaskDenyExtend)) {
      updates.secretMaskDenyExtend = [
        ...new Set(body.secretMaskDenyExtend.map((s) => s.trim()).filter(Boolean)),
      ];
    }
    if (typeof body.prWorkflowEnabled === 'boolean') {
      updates.prWorkflowEnabled = body.prWorkflowEnabled;
    }
    if (Array.isArray(body.reviewDimensions)) {
      const ids = normalizeReviewDimensionIds(body.reviewDimensions);
      // An empty result is rejected rather than stored: it would mean "review nothing",
      // which is never what a user means by unticking the last box, and a caller that
      // sent only unknown ids has a bug worth surfacing.
      if (ids.length === 0) throw new HttpError(400, 'At least one review dimension is required');
      updates.reviewDimensions = ids;
    }
    if (typeof body.stepGuidanceEnabled === 'boolean') {
      updates.stepGuidanceEnabled = body.stepGuidanceEnabled;
    }
    if (body.appAuth !== undefined) {
      updates.appAuth = normalizeAppAuth(body.appAuth);
    }
    // Credentials go to the encrypted per-user store, keyed per repository. An empty
    // string is a deliberate clear; `undefined` leaves the stored value alone, so saving
    // the form without retyping the password does not wipe it.
    const appAuthWrites = (
      [
        ['appAuthUsername', 'username'],
        ['appAuthPassword', 'password'],
      ] as const
    ).flatMap(([field, suffix]) => {
      const value = body[field];
      return typeof value === 'string' ? [{ suffix, value }] : [];
    });

    // RAG embed-health actions. A re-embed is forced only where hash vectors can
    // actually be on disk: leaving lexical-only mode, or an explicit rebuild. A repo
    // that merely failed under strict mode has no hash rows — those chunks were left
    // unindexed — so its next incremental sync picks them up as ordinary inserts and
    // re-embedding the whole repository would be wasted work.
    let retryCleared: { ragEmbedDegradedAt: Date; ragEmbedDegradedReason: string | null } | null =
      null;
    let reembedQueued = false;
    let degradationKept = false;
    if (body.ragEmbedAction) {
      const current = await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, repositoryId),
        columns: {
          ragEmbedLexicalOnly: true,
          ragEmbedDegradedAt: true,
          ragEmbedDegradedReason: true,
        },
      });
      if (!current) throw new HttpError(404, 'Repository not found');
      if (body.ragEmbedAction === 'accept_lexical_only') {
        updates.ragEmbedLexicalOnly = true;
        updates.ragEmbedDegradedAt = null;
        updates.ragEmbedDegradedReason = null;
      } else {
        updates.ragEmbedLexicalOnly = false;
        // A retry re-embeds nothing, so rows a degraded run left awaiting re-embed keep the dense half off.
        degradationKept =
          body.ragEmbedAction !== 'rebuild_index' &&
          !current.ragEmbedLexicalOnly &&
          !!current.ragEmbedDegradedAt &&
          (await ragStoreAwaitsReembedBounded(db, repositoryId));
        if (!degradationKept) {
          updates.ragEmbedDegradedAt = null;
          updates.ragEmbedDegradedReason = null;
          if (body.ragEmbedAction === 'retry' && current.ragEmbedDegradedAt) {
            retryCleared = {
              ragEmbedDegradedAt: current.ragEmbedDegradedAt,
              ragEmbedDegradedReason: current.ragEmbedDegradedReason,
            };
          }
        }
        if (body.ragEmbedAction === 'rebuild_index' || current.ragEmbedLexicalOnly) {
          const pending = {
            ragEmbedDegradedAt: new Date(),
            ragEmbedDegradedReason:
              'Index rebuild pending: chunks are re-embedded on the next sync.',
          };
          // Stored before the reset: a reset that fails part-way leaves NULL hashes over the old vectors.
          assertRagLockHeld(lock);
          await db
            .update(schema.repositories)
            .set(pending)
            .where(eq(schema.repositories.id, repositoryId));
          reembedQueued = await forceRagReembed(db, repositoryId, lock);
          if (reembedQueued) Object.assign(updates, pending);
        }
      }
    }

    const appAuthEvent: AuditEvent = {
      actorUserId: userId,
      action: 'repository.app_auth.update',
      targetType: 'repository',
      targetId: repositoryId,
      metadata: Object.fromEntries(
        appAuthWrites.map(({ suffix, value }) => [suffix, value ? 'set' : 'cleared']),
      ),
    };
    assertRagLockHeld(lock);
    await db.transaction(async (tx) => {
      if (typeof body.rtkEnabled === 'boolean') {
        const [stored] = await tx
          .select({ rtkEnabled: schema.repositories.rtkEnabled })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId))
          .for('update');
        if (stored?.rtkEnabled !== body.rtkEnabled) updates.rtkChoiceMadeAt = new Date();
      }
      await tx
        .update(schema.repositories)
        .set(updates)
        .where(eq(schema.repositories.id, repositoryId));
      for (const { suffix, value } of appAuthWrites) {
        const key = `app_auth:${repositoryId}:${suffix}`;
        if (value) await userSecretsService.set(userId, key, value, `App login ${suffix}`, tx);
        else await userSecretsService.delete(userId, key, tx);
      }
      if (appAuthWrites.length > 0) await insertAuditEvent(tx, appAuthEvent);
      if (updates.rtkEnabled === false) await convergeRtkQuestion(tx, repositoryId, userId);
      if (PORTABLE_SETTING_UPDATE_KEYS.some((key) => key in updates)) {
        await markProjectStateDirty(tx, repositoryId);
      }
    });
    if (appAuthWrites.length > 0) logAuditEvent(appAuthEvent);
    // A sync can write fallback rows between the probe and the clear; look once more after it.
    // Unfenced: the save has committed, and a lock lost by expiry leaves no sync to restore the flag.
    if (retryCleared && (await ragStoreAwaitsReembedBounded(db, repositoryId))) {
      await db
        .update(schema.repositories)
        .set(retryCleared)
        .where(eq(schema.repositories.id, repositoryId));
      degradationKept = true;
    }
    return c.json({ repositoryId, ok: true, reembedQueued, degradationKept });
  } finally {
    await lock?.release();
  }
});
