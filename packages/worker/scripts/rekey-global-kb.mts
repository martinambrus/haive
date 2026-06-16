/**
 * One-time, idempotent re-key of the global KB corpus.
 *
 * Entries promoted before the facet-derived dedup key carry the old free-form
 * topic_key (e.g. "best_practice:php5" vs "best_practice:php" for the SAME tech),
 * so future onboards won't dedup against them. This recomputes every entry's
 * topic_key from its canonical facets via the SAME globalKbTopicKey the promotion
 * path now uses. Non-destructive (only updates topic_key); re-running is a no-op.
 *
 * Run in the worker container (has DATABASE_URL + the global KB DB):
 *   node --import tsx scripts/rekey-global-kb.mts            # dry-run (prints changes)
 *   node --import tsx scripts/rekey-global-kb.mts --apply    # commit
 *
 * Internal mode only (derives the KB URL from DATABASE_URL → haive_kb_global, or
 * GLOBAL_KB_DB_NAME). For an external global KB, point DATABASE_URL/GLOBAL_KB_DB_URL
 * at it instead.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { globalKbEntries } from '@haive/shared/global-kb';
import { globalKbTopicKey } from '../src/step-engine/steps/_global-kb-promote.js';

const apply = process.argv.includes('--apply');

const kbUrl =
  process.env.GLOBAL_KB_DB_URL ??
  (() => {
    const u = new URL(process.env.DATABASE_URL ?? '');
    u.pathname = `/${process.env.GLOBAL_KB_DB_NAME ?? 'haive_kb_global'}`;
    return u.toString();
  })();

const pg = postgres(kbUrl, { max: 2 });
const db = drizzle(pg);

try {
  const rows = await db.select().from(globalKbEntries);
  let changed = 0;
  for (const r of rows) {
    const next = globalKbTopicKey(r.category, r.facets ?? {});
    if (next && next !== r.topicKey) {
      console.log(`[rekey] ${r.status.padEnd(8)} "${r.title}": ${r.topicKey ?? '(none)'} -> ${next}`);
      if (apply) {
        await db.update(globalKbEntries).set({ topicKey: next }).where(eq(globalKbEntries.id, r.id));
      }
      changed += 1;
    }
  }
  console.log(
    `\n${apply ? 'APPLIED' : 'DRY-RUN'}: ${changed}/${rows.length} entries ${apply ? 're-keyed' : 'would be re-keyed'}.`,
  );
} finally {
  await pg.end();
}
process.exit(0);
