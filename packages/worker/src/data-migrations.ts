import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService, logger, type OnboardingToolingMirror } from '@haive/shared';
import { withGlobalKb } from '@haive/shared/global-kb';
import { loadPlanSkeletons } from '@haive/shared/plan';
import { resolveToolingOllamaUrl } from '@haive/shared/rag';
import { defaultDockerRunner } from './sandbox/docker-runner.js';
import { isHeadingOnlyChunk } from './step-engine/steps/onboarding/_rag-chunkers.js';
import { describePlanOp, proposedOps } from './step-engine/steps/workflow/_plan-ops.js';

const log = logger.child({ module: 'data-migrations' });

/** What a data migration does to data that cannot be got back.
 *
 *  `convergent` — idempotent and non-destructive: a soft-delete via a `superseded_at` column, a
 *  status flip, a flag, an in-place relabel. Re-running is a no-op and rolling the code back
 *  costs nothing, so these run at every boot as they always have.
 *
 *  `destructive` — removes data with no tombstone. These must NOT run at boot, because boot is
 *  BEFORE an upgrade has been verified: `steadfast-committing-gray` rolls back to the previous
 *  images when the health gate fails, and a destructive fix that already ran would have deleted
 *  rows the restored version expects. They run after the upgrade is committed. */
type DataMigrationKind = 'convergent' | 'destructive';

interface DataMigration {
  id: string;
  kind: DataMigrationKind;
  run: (db: Database) => Promise<void>;
}

/** Every data fix, each declaring its own kind. There is deliberately NO default: a new entry
 *  cannot be added without someone deciding whether it destroys anything, which is exactly the
 *  question that was previously answered by whichever function happened to hold a raw DELETE. */
const DATA_MIGRATIONS: DataMigration[] = [
  { id: 'supersedeRemovedRtkArtifacts', kind: 'convergent', run: supersedeRemovedRtkArtifacts },
  { id: 'skipRemovedSteps', kind: 'convergent', run: skipRemovedSteps },
  { id: 'supersedePhantomAgentArtifacts', kind: 'convergent', run: supersedePhantomAgentArtifacts },
  { id: 'clearPrunedSandboxImageState', kind: 'convergent', run: clearPrunedSandboxImageState },
  { id: 'flagHashIndexedRestoredRepos', kind: 'convergent', run: flagHashIndexedRestoredRepos },
  { id: 'relabelPlanReconcileForms', kind: 'convergent', run: relabelPlanReconcileForms },
  // The only one. It issues a raw `DELETE FROM ai_rag_embeddings` against the global KB store —
  // a SEPARATE database, so outside any core-DB transaction and outside a core-DB snapshot.
  // Nothing can undo it.
  { id: 'dropHeadingOnlyGlobalKbChunks', kind: 'destructive', run: dropHeadingOnlyGlobalKbChunks },
];

/** Run one, and never let it take the process down with it.
 *
 *  Uniform on purpose. Before this, three helpers had no error handling at all and were
 *  therefore boot-fatal while the other four swallowed their errors — an inconsistency nobody
 *  chose, decided by which function happened to have a try/catch. These are convergent fixes,
 *  not correctness prerequisites: the connection is already proven by `waitForDatabaseReady`
 *  earlier in bootstrap, a failure here converges on the next boot, and stopping the whole
 *  worker because a cosmetic form relabel failed is the wrong trade. Logged at `error` so a
 *  persistent failure is still visible rather than merely swallowed.
 *
 *  A backstop, not a replacement: the four helpers that already catch their own errors keep
 *  doing so, because they log context this cannot see. */
async function runOne(db: Database, migration: DataMigration): Promise<void> {
  try {
    await migration.run(db);
  } catch (err) {
    log.error({ err, migration: migration.id, kind: migration.kind }, 'data migration failed');
  }
}

/**
 * Idempotent data fixes applied on every worker boot. Each helper must be
 * narrow, fast, and a no-op on a clean DB so that re-running on every restart
 * costs nothing.
 *
 * CONVERGENT ONLY. Anything that destroys data waits for `runDestructiveDataMigrations`.
 */
export async function runDataMigrations(db: Database): Promise<void> {
  for (const migration of DATA_MIGRATIONS.filter((m) => m.kind === 'convergent')) {
    await runOne(db, migration);
  }
}

/**
 * The data fixes that remove data for good.
 *
 * Called once an upgrade has been verified and committed — never at boot, and never before the
 * health gate, because the whole point of that gate is that the previous images can still be
 * restored. Exported and currently called by nothing: `steadfast-committing-gray`'s updater is
 * what invokes it at its Phase 5.
 */
export async function runDestructiveDataMigrations(db: Database): Promise<void> {
  for (const migration of DATA_MIGRATIONS.filter((m) => m.kind === 'destructive')) {
    log.info({ migration: migration.id }, 'running destructive data migration');
    await runOne(db, migration);
  }
}

/** Flag repos whose RAG index was built with no embedding endpoint, so the query side
 *  holds them lexical-only until the indexer replaces those vectors.
 *
 *  `ollamaUrl` is stripped from the committed `.haive-data/tooling.json` as
 *  machine-specific, and until `resolveToolingOllamaUrl` existed nothing re-derived it on
 *  a machine that RESTORED that mirror. `useOllama` was therefore false for every sync of
 *  such a repo and every chunk was hash-embedded — MEASURED on one: all 9,278 chunks, best
 *  dense similarity for a real query embedding 0.0707 against 0.7273 on its non-restored
 *  twin.
 *
 *  A NEW restore no longer needs this: `02-pre-rag-sync` (step index 2) re-derives the URL,
 *  forces the re-embed and stamps the flag itself, and it runs before the first step that
 *  can issue a `rag_search`. This exists for repos ALREADY indexed that way, where the
 *  re-derivation would otherwise let the api embed a real query vector against hash rows —
 *  which ranks worse than not using the dense half at all, because the 0.7-weighted dense
 *  half then contributes a random ordering.
 *
 *  Idempotent by construction: it only ever stamps a repo that has NO degradation record,
 *  and the flag is cleared by a sync that embedded for real. Once cleared it is never
 *  re-stamped, because the clearing sync also replaced the `chunk_hash` values this reads.
 *  `ragEmbedLexicalOnly` repos are skipped — that is a decision a person made, and their
 *  hash rows are already excluded from the dense half. */
async function flagHashIndexedRestoredRepos(db: Database): Promise<void> {
  try {
    const repos = await db.query.repositories.findMany({
      columns: {
        id: true,
        onboardingTooling: true,
        ragEmbedDegradedAt: true,
        ragEmbedLexicalOnly: true,
      },
    });

    for (const repo of repos) {
      if (repo.ragEmbedDegradedAt || repo.ragEmbedLexicalOnly) continue;
      const tooling = (repo.onboardingTooling as OnboardingToolingMirror | null)?.tooling;
      if (!tooling) continue;
      const { ragMode } = tooling as { ragMode?: string };
      if (!ragMode || ragMode === 'none') continue;
      if (!resolveToolingOllamaUrl(tooling).derived) continue;

      await db
        .update(schema.repositories)
        .set({
          ragEmbedDegradedAt: new Date(),
          ragEmbedDegradedReason:
            'Indexed without an embedding endpoint (the URL was stripped from the committed onboarding mirror). The next RAG sync re-embeds it.',
        })
        .where(eq(schema.repositories.id, repo.id));
      log.warn(
        { repositoryId: repo.id },
        'repo indexed without an embedding endpoint; held lexical-only until re-embedded',
      );
    }
  } catch (err) {
    // Boot path: a failure here must not stop the worker starting. The cost of skipping
    // is a degraded ranking, not a broken one.
    log.error({ err }, 'failed to flag hash-indexed restored repos');
  }
}

/** Reconcile `cli_providers` sandbox-image state against the images this host actually
 *  has, and reset the rows that no longer describe reality.
 *
 *  Two states go stale, and neither is cosmetic:
 *
 *  `ready` — a `docker image prune` leaves the row green while the image is gone. Nothing
 *  in the exec path is fooled (it inspects the image before it reads the row), but
 *  createSandboxLoginContainer gates on `status === 'ready'` and then hands the tag to
 *  dockerode, so a stale row turns "not built yet" into `No such image`.
 *
 *  `building` — nothing anywhere resets it. The api writes it before `queue.add`, the
 *  worker writes it around a build that a SIGKILL can interrupt, and the jobs are
 *  `removeOnComplete`, so a lost job never comes back. A stuck row blocks Test-connection
 *  and interactive login, makes the provider form poll every 2.5s forever, and — the trap —
 *  DISABLES the Rebuild button that is the only way out of it.
 *
 *  Resetting `building` unconditionally is safe here and only here: runDataMigrations is
 *  awaited by bootstrap() before main() starts a single queue, and compose pins the worker
 *  to one instance (`container_name: haive-worker`), so no build can be in flight at this
 *  moment. Replicating the worker is what would break this first.
 *
 *  `idle` rather than `failed`: the row is not a failure, it is an absence. The build error
 *  text is left alone so a genuine past failure stays readable. Docker errors are swallowed
 *  — this runs on the boot path and a docker hiccup must not stop the worker starting. */
async function clearPrunedSandboxImageState(db: Database): Promise<void> {
  try {
    const rows = await db
      .select({
        id: schema.cliProviders.id,
        tag: schema.cliProviders.sandboxImageTag,
        status: schema.cliProviders.sandboxImageBuildStatus,
      })
      .from(schema.cliProviders)
      .where(inArray(schema.cliProviders.sandboxImageBuildStatus, ['ready', 'building']));
    if (rows.length === 0) return;

    // Providers whose rendered Dockerfile is identical share one tag, so inspect the
    // distinct set rather than once per row.
    const present = new Map<string, boolean>();
    for (const tag of new Set(rows.map((r) => r.tag).filter((t): t is string => !!t))) {
      present.set(tag, (await defaultDockerRunner.inspect(tag)).exists);
    }

    const stale = rows
      .filter((r) => r.status === 'building' || !r.tag || !present.get(r.tag))
      .map((r) => r.id);
    if (stale.length === 0) return;

    await db
      .update(schema.cliProviders)
      .set({ sandboxImageBuildStatus: 'idle', updatedAt: new Date() })
      .where(inArray(schema.cliProviders.id, stale));
    log.info({ count: stale.length }, 'reset sandbox image state for providers with no image');
  } catch (err) {
    log.warn({ err }, 'sandbox image state reconcile skipped');
  }
}

/** Template ids removed when the RTK awareness markdown was consolidated into
 *  the (non-manifest) AGENTS.md block. Already-onboarded repos still have live
 *  onboarding_artifacts rows for these. For the `*-md-ref` ids the diskPath is
 *  a shared rules file (CLAUDE.md / GEMINI.md / AGENTS.md); the upgrade path's
 *  whole-file `obsolete → rm` would otherwise offer to delete that entire file.
 *  syncTemplateManifestCache already prunes these ids from
 *  template_manifest_cache; this clears the per-repo install rows. */
const REMOVED_RTK_TEMPLATE_IDS = [
  'rtk.claude-rtk-md',
  'rtk.claude-md-ref',
  'rtk.gemini-rtk-md',
  'rtk.gemini-md-ref',
  'rtk.agents-rtk-md',
  'rtk.agents-md-ref',
];

/** Soft-delete (supersede) live onboarding_artifacts rows for the removed RTK
 *  template items so they never surface as removable `obsolete` entries on the
 *  next upgrade. Idempotent: the `superseded_at IS NULL` guard makes a second
 *  run a no-op. The stale on-disk blocks they pointed at are cosmetic and are
 *  cleared on re-onboard. */
async function supersedeRemovedRtkArtifacts(db: Database): Promise<void> {
  await db
    .update(schema.onboardingArtifacts)
    .set({ supersededAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        inArray(schema.onboardingArtifacts.templateId, REMOVED_RTK_TEMPLATE_IDS),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );
}

/** Step ids removed from the onboarding registry. Their task_steps rows are
 *  pre-created at task start, so a task created before the removal can still
 *  hold a non-terminal row for one — and the runner throws on an unknown step
 *  id when it reaches it. */
const REMOVED_STEP_IDS = ['06-workflow-prefs'];

/** Mark any non-terminal task_steps row for a removed step as skipped so the
 *  orchestrator advances past it instead of stranding on a missing definition.
 *  Idempotent: terminal rows (done/failed/skipped) are excluded, so a second
 *  run is a no-op. */
async function skipRemovedSteps(db: Database): Promise<void> {
  await db
    .update(schema.taskSteps)
    .set({ status: 'skipped', endedAt: new Date() })
    .where(
      and(
        inArray(schema.taskSteps.stepId, REMOVED_STEP_IDS),
        notInArray(schema.taskSteps.status, ['done', 'failed', 'skipped']),
      ),
    );
}

/** Soft-delete phantom Haive-agent onboarding_artifacts rows. Before the
 *  expandManifestFor `applies` gate, 12-post-onboarding recorded a row for every
 *  baseline + framework agent regardless of stack (the manifest was
 *  framework-blind), while 07-generate-files only wrote the accepted agents to
 *  disk. So repos carry rows for agents they never accepted and that were never
 *  written (e.g. django/node/react in a PHP repo); the upgrade plan then
 *  mislabels them `user_deleted` ("reinstate deleted files").
 *
 *  A row is phantom when its agent id is absent from its own
 *  `form_values_snapshot.acceptedAgentIds`. The non-empty guard skips
 *  legacy/snapshotless rows (acceptedAgentIds defaults to [] there) so a repo's
 *  whole agent set is never mass-superseded — same conservative rule as the
 *  `applies` gate. A genuinely user-deleted *accepted* agent keeps its id in the
 *  snapshot, so the predicate is false and the row is preserved.
 *
 *  Relies on the `applies` gate shipping together: once gated, the manifest no
 *  longer renders these agents, so a superseded phantom stays absent instead of
 *  resurfacing as `new_artifact`. Idempotent via the `superseded_at IS NULL`
 *  guard. Step 1 (applicable-ids cleanup) runs first because it reads the
 *  still-live phantom rows; step 2 then supersedes them. */
async function supersedePhantomAgentArtifacts(db: Database): Promise<void> {
  // 1. Remove phantom agent template_ids from each affected repo's
  //    applicable_template_ids. The upgrade-status API reads only
  //    template_manifest_cache + applicable_template_ids (it never expands), so
  //    without this a superseded phantom would resurface there as "new".
  await db.execute(sql`
    UPDATE repositories r
    SET applicable_template_ids = (
          SELECT COALESCE(array_agg(t ORDER BY t), '{}')
          FROM unnest(r.applicable_template_ids) AS t
          WHERE NOT EXISTS (
            SELECT 1 FROM onboarding_artifacts oa
            WHERE oa.repository_id = r.id
              AND oa.template_id = t
              AND oa.template_kind = 'agent'
              AND oa.template_id LIKE 'agent.%'
              AND oa.superseded_at IS NULL
              AND jsonb_typeof(oa.form_values_snapshot -> 'acceptedAgentIds') = 'array'
              AND jsonb_array_length(oa.form_values_snapshot -> 'acceptedAgentIds') > 0
              AND NOT jsonb_exists(oa.form_values_snapshot -> 'acceptedAgentIds', replace(oa.template_id, 'agent.', ''))
          )
        ),
        updated_at = now()
    WHERE r.applicable_template_ids IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM onboarding_artifacts oa
        WHERE oa.repository_id = r.id
          AND oa.template_kind = 'agent'
          AND oa.template_id LIKE 'agent.%'
          AND oa.superseded_at IS NULL
          AND jsonb_typeof(oa.form_values_snapshot -> 'acceptedAgentIds') = 'array'
          AND jsonb_array_length(oa.form_values_snapshot -> 'acceptedAgentIds') > 0
          AND NOT jsonb_exists(oa.form_values_snapshot -> 'acceptedAgentIds', replace(oa.template_id, 'agent.', ''))
      )
  `);

  // 2. Soft-delete the phantom rows themselves.
  await db.execute(sql`
    UPDATE onboarding_artifacts
    SET superseded_at = now(), updated_at = now()
    WHERE template_kind = 'agent'
      AND template_id LIKE 'agent.%'
      AND superseded_at IS NULL
      AND jsonb_typeof(form_values_snapshot -> 'acceptedAgentIds') = 'array'
      AND jsonb_array_length(form_values_snapshot -> 'acceptedAgentIds') > 0
      AND NOT jsonb_exists(form_values_snapshot -> 'acceptedAgentIds', replace(template_id, 'agent.', ''))
  `);
}

/** Cheap SQL prefilter before the real predicate runs in TS. A heading-only
 *  chunk is one context-header line plus one heading line; a 300-char title and
 *  its breadcrumb still fit well inside this. Nothing is decided by it — it only
 *  bounds how many rows are read. */
const HEADING_ONLY_PREFILTER_CHARS = 1024;

/** Delete global KB chunks that hold nothing but a heading.
 *
 *  `extractMarkdownSections` used to emit a section for a heading with no prose
 *  of its own (an H1 whose first child is an H2). Those chunks are pure title
 *  text: they outrank the entry's real body chunks on exactly the title-shaped
 *  query the digest tells agents to make, and then spend the entry's single
 *  global merge slot on zero information. The chunker no longer emits them, but
 *  entries embedded before that keep theirs — a global entry is re-chunked only
 *  when it is written, and a chunker change writes no entry.
 *
 *  Deleting the rows IS what re-chunking would produce: dropping a section
 *  changes no other section's id, chunk index or content, and no global entry is
 *  near the per-entry chunk cap that could otherwise let a dropped tail back in.
 *  The per-repo indexes need no equivalent — `_rag-index.ts` re-extracts every
 *  file on each run and sweeps section keys it no longer produces.
 *
 *  Idempotent: a second run matches nothing. Best-effort and flag-gated — a
 *  global KB that is disabled or unreachable must never fail worker boot, and a
 *  disabled one must not be connected to (that would create its database). */
async function dropHeadingOnlyGlobalKbChunks(db: Database): Promise<void> {
  try {
    // The `false` here is the UNSET fallback only, and reads more cautiously than it behaves:
    // `DEFAULT_CONFIG` seeds this key `'true'` and `configService.initialize()` runs before
    // any caller, so on a default install the gate is OPEN and the DELETE below does run.
    // Left as-is deliberately — the protection that matters is that this is now declared
    // `destructive` and therefore never runs at boot.
    if (!(await configService.getBoolean(CONFIG_KEYS.GLOBAL_KB_ENABLED, false))) return;
    await withGlobalKb(db, async ({ conn, settings }) => {
      const rows = (await conn.pg.unsafe(
        `SELECT id, content FROM ai_rag_embeddings WHERE namespace = $1 AND length(content) < $2`,
        [settings.namespace, HEADING_ONLY_PREFILTER_CHARS],
      )) as unknown as Array<{ id: number; content: string }>;
      const stale = rows.filter((r) => isHeadingOnlyChunk(r.content)).map((r) => r.id);
      if (stale.length === 0) return;
      const placeholders = stale.map((_, i) => `$${i + 1}`).join(', ');
      await conn.pg.unsafe(`DELETE FROM ai_rag_embeddings WHERE id IN (${placeholders})`, stale);
      log.info({ deleted: stale.length }, 'removed heading-only global KB chunks');
    });
  } catch (err) {
    log.warn({ err }, 'heading-only global KB chunk cleanup skipped');
  }
}

/** Re-label a parked plan-reconcile form whose options describe the wrong change.
 *
 *  `11f-plan-reconcile`'s form built its option labels against an EMPTY title
 *  map, and `describePlanOp` decided "is this a new node?" by asking that map.
 *  Every status change and code link on an existing node therefore rendered as
 *  `Add node "untitled" under a node` — a label describing the opposite of what
 *  ticking the box does, on the one control that exists so a developer can judge
 *  a proposal they are about to approve. MEASURED on a parked task: 7 of 8
 *  options, all of them upserts naming live node uuids.
 *
 *  A form is rebuilt only when its persisted schema is null, and nulling it here
 *  would leave the step with no form and nothing to re-advance it. The option
 *  labels are the only wrong part — indices, defaults and the ops they select are
 *  untouched — so they are recomputed in place through the shipped labeller,
 *  which is also what stops this drifting from what a fresh form would say.
 *
 *  Idempotent by construction rather than by a marker: a row is written only when
 *  a recomputed label actually differs, so a converged form costs one read. */
async function relabelPlanReconcileForms(db: Database): Promise<void> {
  try {
    const rows = await db
      .select({
        id: schema.taskSteps.id,
        detectOutput: schema.taskSteps.detectOutput,
        formSchema: schema.taskSteps.formSchema,
        repositoryId: schema.tasks.repositoryId,
      })
      .from(schema.taskSteps)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
      .where(
        and(
          eq(schema.taskSteps.stepId, '11f-plan-reconcile'),
          eq(schema.taskSteps.status, 'waiting_form'),
        ),
      );

    let fixed = 0;
    for (const row of rows) {
      const form = row.formSchema as {
        fields?: { id?: string; options?: { value?: string; label?: string }[] }[];
      } | null;
      const field = form?.fields?.find((f) => f.id === 'applyOps');
      if (!field?.options?.length) continue;

      // Same read resolveLlmPhase does — the step's live, unconsumed invocation.
      const [invocation] = await db
        .select({
          parsedOutput: schema.cliInvocations.parsedOutput,
          rawOutput: schema.cliInvocations.rawOutput,
        })
        .from(schema.cliInvocations)
        .where(
          and(
            eq(schema.cliInvocations.taskStepId, row.id),
            isNull(schema.cliInvocations.supersededAt),
            isNull(schema.cliInvocations.consumedAt),
            ne(schema.cliInvocations.mode, 'agent_mining'),
          ),
        )
        .orderBy(desc(schema.cliInvocations.createdAt))
        .limit(1);
      if (!invocation) continue;

      const ops = proposedOps(invocation.parsedOutput ?? invocation.rawOutput);
      if (ops.length !== field.options.length) continue;

      // The titles the form should have carried. A payload written before detect
      // stored them gets them backfilled here rather than left to render as
      // shortened uuids — naming the node is the whole reason the label exists,
      // and the value is the one a fresh detect would have written.
      const detect = row.detectOutput as { nodeTitles?: Record<string, string> } | null;
      let titles = detect?.nodeTitles;
      const backfill = titles === undefined && detect !== null && row.repositoryId !== null;
      if (backfill) {
        const nodes = await loadPlanSkeletons(db, row.repositoryId!);
        titles = Object.fromEntries(nodes.map((n) => [n.id, n.title]));
      }
      const titleById = new Map(Object.entries(titles ?? {}));

      const relabelled = field.options.map((opt, i) => ({
        ...opt,
        label: describePlanOp(ops[i]!, titleById),
      }));
      const same = relabelled.every((opt, i) => opt.label === field.options![i]!.label);
      if (same && !backfill) continue;

      field.options = relabelled;
      await db
        .update(schema.taskSteps)
        .set({
          formSchema: form,
          ...(backfill ? { detectOutput: { ...detect, nodeTitles: titles } } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.taskSteps.id, row.id));
      fixed += 1;
    }
    if (fixed > 0) log.info({ fixed }, 'relabelled parked plan-reconcile forms');
  } catch (err) {
    log.warn({ err }, 'plan reconcile form relabel skipped');
  }
}
