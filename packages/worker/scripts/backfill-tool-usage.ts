/**
 * One-off, idempotent maintenance script: the whole-install form of the boot-time
 * `backfillToolUsage` data migration.
 *
 * Reads every ended cli_invocations row whose tool_usage is still NULL and writes what its
 * stored stream_log says the run used — through the SAME tally the live collectors feed, so a
 * backfilled record and a live one read a run identically. The boot migration does the same
 * under a 10 s budget per boot; this runs to completion in one go.
 *
 * Safety:
 *  - Dry-run by default: prints counts by coverage and provider plus a sample of records,
 *    writes nothing. Set APPLY=1 to write.
 *  - Every targeted row was NULL by selection, so no backup file is needed: the rollback is one
 *    statement, `UPDATE cli_invocations SET tool_usage = NULL WHERE tool_usage->>'source' = 'backfill'`.
 *  - Idempotent: a written row no longer matches the selection, so a second run finds nothing.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && tsx scripts/backfill-tool-usage.ts'         # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 tsx scripts/backfill-tool-usage.ts' # apply
 */
import { createDatabase } from '@haive/database';
import type { InvocationToolUsage } from '@haive/shared';
import {
  backfillToolUsage,
  TOOL_USAGE_BACKFILL_BATCH_SIZE,
} from '../src/queues/cli-exec/tool-usage-backfill.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const APPLY = process.env.APPLY === '1';
const SAMPLE_SIZE = 20;

const db = createDatabase(DATABASE_URL);

const byProvider = new Map<string, { full: number; partial: number; none: number }>();
const sample: Array<{ id: string; provider: string | null; usage: InvocationToolUsage }> = [];

console.log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
const result = await backfillToolUsage(db, {
  budgetMs: Number.POSITIVE_INFINITY,
  batchSize: TOOL_USAGE_BACKFILL_BATCH_SIZE,
  apply: APPLY,
  onRow: (id, provider, usage) => {
    const key = provider ?? '(no provider)';
    const bucket = byProvider.get(key) ?? { full: 0, partial: 0, none: 0 };
    bucket[usage.coverage] += 1;
    byProvider.set(key, bucket);
    if (sample.length < SAMPLE_SIZE) sample.push({ id, provider, usage });
  },
});

console.log('\nby provider (full / partial / none):');
for (const [provider, c] of [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${provider}: ${c.full} / ${c.partial} / ${c.none}`);
}
console.log(`\nsample (${sample.length} of ${result.examined}):`);
for (const s of sample) {
  const u = s.usage;
  const tools = Object.entries(u.tools)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const mcp = u.mcp.map((m) => `${m.server}/${m.tool}=${m.calls}`).join(' ');
  console.log(
    `  ${s.id} ${s.provider ?? '-'} ${u.coverage} tools[${tools}] mcp[${mcp}] ` +
      `agentsRead=${u.agents.read.length} skillsRead=${u.skills.read.length} ` +
      `loaded=${u.loaded ? `${u.loaded.agents.length}a/${u.loaded.skills.length}s/${u.loaded.mcpServers.length}m` : '-'}`,
  );
}
console.log(
  `\n${APPLY ? 'DONE' : 'DRY RUN'}: examined ${result.examined} ` +
    `(full ${result.full}, partial ${result.partial}, none ${result.none}), ` +
    `written ${result.written}, remaining ${result.remaining}, ${result.elapsedMs} ms`,
);
process.exit(0);
