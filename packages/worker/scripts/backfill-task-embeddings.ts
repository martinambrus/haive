/**
 * One-off, idempotent maintenance script (task-time estimation v2.2 — stored embeddings).
 *
 * Backfills the effort estimator's task-embedding store: embeds each existing COMPLETED
 * workflow task's title+description and upserts it as a source_type='task' row into its repo's
 * RAG vector store, so 00b-estimate can semantically retrieve those historical tasks as effort
 * anchors. New tasks are indexed automatically by runRagIndexSync (02-pre-rag-sync /
 * 11c-rag-reindex); this seeds the store with pre-existing history.
 *
 * Scope: completed workflow tasks whose repository has RAG configured (onboarding tooling
 * ragMode != none) with an ollama URL + embedding model. Repos without RAG are skipped — their
 * estimates simply fall back to newest-first anchors. Mode-aware: internal / external / ddev
 * stores are all reached via resolveRagConnection.
 *
 * Idempotent: a task already present (repository_id + source_path=taskId + source_type='task')
 * is skipped, so re-running re-embeds nothing.
 *
 * Safety:
 *  - Dry-run by default. Set APPLY=1 to embed + write.
 *  - Best-effort per repo: a repo whose ollama is unreachable / connection fails is logged and
 *    skipped without aborting the rest.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && pnpm exec tsx scripts/backfill-task-embeddings.ts'         # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 pnpm exec tsx scripts/backfill-task-embeddings.ts' # apply
 *
 * Rollback: task embeddings are derived, regenerable data. DELETE FROM ai_rag_embeddings
 * WHERE source_type='task' in a repo's RAG DB drops them; they repopulate as tasks run.
 */
import { and, eq } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';
import {
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
  type OnboardingEnvironmentMirror,
  type OnboardingToolingMirror,
} from '@haive/shared';
import { probeOllama } from '@haive/shared/rag';
import {
  ensureRagSchema,
  RAG_TABLE,
  resolveRagConnection,
  type RagConnection,
} from '../src/step-engine/steps/onboarding/_rag-connection.js';
import { toRagPrefs } from '../src/step-engine/steps/workflow/_rag-index.js';
import {
  indexTaskEmbedding,
  TASK_EMBED_SOURCE_TYPE,
} from '../src/step-engine/steps/workflow/_task-embedding.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const APPLY = process.env.APPLY === '1';
const db = createDatabase(DATABASE_URL);

interface RepoTask {
  id: string;
  title: string;
  description: string | null;
}

function projectNameOf(envMirror: OnboardingEnvironmentMirror | null | undefined): string {
  if (envMirror?.schemaVersion !== ONBOARDING_ENVIRONMENT_SCHEMA_VERSION) return 'default';
  const p = (envMirror.envDetectData as { project?: { name?: string } } | undefined)?.project;
  return p?.name ?? 'default';
}

async function main(): Promise<void> {
  const tasks = await db.query.tasks.findMany({
    where: and(eq(schema.tasks.type, 'workflow'), eq(schema.tasks.status, 'completed')),
    columns: { id: true, repositoryId: true, title: true, description: true },
  });
  const byRepo = new Map<string, RepoTask[]>();
  for (const t of tasks) {
    if (!t.repositoryId) continue;
    const list = byRepo.get(t.repositoryId) ?? [];
    list.push({ id: t.id, title: t.title, description: t.description });
    byRepo.set(t.repositoryId, list);
  }
  console.log(`Completed workflow tasks: ${tasks.length} across ${byRepo.size} repo(s)`);

  let indexed = 0;
  let skippedExisting = 0;
  let skippedRepos = 0;

  for (const [repositoryId, repoTasks] of byRepo) {
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
      columns: { name: true, onboardingTooling: true, onboardingEnvironment: true },
    });
    const label = repo?.name ?? repositoryId;
    const toolingMirror = repo?.onboardingTooling as OnboardingToolingMirror | null | undefined;
    const prefs =
      toolingMirror?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION && toolingMirror.tooling
        ? toRagPrefs(toolingMirror.tooling)
        : null;
    if (!prefs || prefs.ragMode === 'none' || !prefs.ollamaUrl || !prefs.embeddingModel) {
      console.log(`  [${label}] RAG not configured — skipping ${repoTasks.length} task(s)`);
      skippedRepos += 1;
      continue;
    }
    const projectName = projectNameOf(
      repo?.onboardingEnvironment as OnboardingEnvironmentMirror | null | undefined,
    );

    if (!APPLY) {
      console.log(
        `  [${label}] would index ${repoTasks.length} task(s) into project '${projectName}'`,
      );
      indexed += repoTasks.length;
      continue;
    }

    if (!(await probeOllama(prefs.ollamaUrl))) {
      console.log(`  [${label}] ollama unreachable — skipping`);
      skippedRepos += 1;
      continue;
    }
    let conn: RagConnection | null = null;
    try {
      conn = await resolveRagConnection(prefs, db, projectName);
      if (!conn) {
        skippedRepos += 1;
        continue;
      }
      await ensureRagSchema(conn);
      let repoIndexed = 0;
      for (const t of repoTasks) {
        const exists = (await conn.pg.unsafe(
          `SELECT 1 FROM ${RAG_TABLE} WHERE repository_id=$1 AND source_path=$2 AND source_type=$3 LIMIT 1`,
          [repositoryId, t.id, TASK_EMBED_SOURCE_TYPE],
        )) as unknown[];
        if (Array.isArray(exists) && exists.length > 0) {
          skippedExisting += 1;
          continue;
        }
        await indexTaskEmbedding(conn, prefs, repositoryId, t.id, t.title, t.description);
        indexed += 1;
        repoIndexed += 1;
      }
      console.log(`  [${label}] indexed ${repoIndexed} task(s) into project '${projectName}'`);
    } catch (err) {
      console.error(`  [${label}] failed:`, err instanceof Error ? err.message : err);
      skippedRepos += 1;
    } finally {
      if (conn) await conn.close().catch(() => {});
    }
  }

  console.log(
    `\n${APPLY ? 'Applied' : 'DRY RUN'} — indexed: ${indexed}, skipped(existing): ${skippedExisting}, skipped(repos): ${skippedRepos}`,
  );
  if (!APPLY) console.log('Set APPLY=1 to embed + write.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
