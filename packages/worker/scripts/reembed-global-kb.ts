/**
 * One-off, idempotent maintenance script (RAG breadcrumb context headers).
 *
 * Re-embeds every ACTIVE global KB entry so its chunks pick up the breadcrumb
 * context header ("[<title> > <H1> > <H2>]") the chunker now prepends. Per-repo
 * stores re-embed themselves on their next 10-rag-populate / 02-pre-rag-sync,
 * but global KB sync is purely event-driven — syncGlobalKbEntry fires on entry
 * upsert/delete and nothing compares contentHash for drift — so an entry whose
 * body has not changed would keep its pre-breadcrumb chunks forever.
 *
 * Idempotent: syncGlobalKbEntry replaces an entry's chunks wholesale inside one
 * transaction, so re-running produces the same rows rather than duplicates.
 *
 * Safety:
 *  - Dry-run by default. Set APPLY=1 to embed + write.
 *  - Best-effort per entry: one failure is logged and the sweep continues.
 *  - No-op when the global KB feature is disabled.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && pnpm exec tsx scripts/reembed-global-kb.ts'         # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 pnpm exec tsx scripts/reembed-global-kb.ts' # apply
 *
 * Rollback: global KB vectors are derived, regenerable data. Revert the chunker
 * change and re-run this script — the entries re-embed back to header-less chunks.
 */
import { eq } from 'drizzle-orm';
import { configService, secretsService } from '@haive/shared';
import { globalKbEntries, resolveGlobalKbSettings, withGlobalKb } from '@haive/shared/global-kb';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis } from '../src/redis.js';
import { syncGlobalKbEntry } from '../src/queues/global-kb-sync-queue.js';

const APPLY = process.env.APPLY === '1';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    console.error('DATABASE_URL and REDIS_URL are required');
    process.exit(1);
  }

  // Minimal bootstrap: the global KB connection resolver reads its settings from
  // configService and its (external-mode) connection string from secretsService.
  // Deliberately NOT the full bootstrap() — this script has no business running
  // data migrations or syncing the template manifest.
  initRedis(redisUrl);
  await configService.initialize(redisUrl);
  const db = initDatabase(databaseUrl);
  await secretsService.initialize(db);

  const settings = await resolveGlobalKbSettings();
  if (!settings.enabled) {
    console.log('Global KB is disabled — nothing to re-embed.');
    process.exit(0);
  }

  const entries = await withGlobalKb(getDb(), async (ctx) =>
    ctx.db
      .select({
        id: globalKbEntries.id,
        namespace: globalKbEntries.namespace,
        title: globalKbEntries.title,
      })
      .from(globalKbEntries)
      .where(eq(globalKbEntries.status, 'active')),
  );

  console.log(`Active global KB entries: ${entries.length} (namespace: ${settings.namespace})`);

  if (!APPLY) {
    for (const e of entries) console.log(`  would re-embed: ${e.title}`);
    console.log(`\nDRY RUN — ${entries.length} entry(ies) would be re-embedded.`);
    console.log('Set APPLY=1 to embed + write.');
    process.exit(0);
  }

  let done = 0;
  let failed = 0;
  for (const e of entries) {
    try {
      await syncGlobalKbEntry({ entryId: e.id, namespace: e.namespace, reason: 'upsert' });
      done += 1;
      console.log(`  re-embedded: ${e.title}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${e.title}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nApplied — re-embedded: ${done}, failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
