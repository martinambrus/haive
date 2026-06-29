/**
 * One-off, idempotent maintenance script.
 *
 * Repairs cli_invocations.raw_output rows corrupted by the pre-fix exec-core
 * behaviour where a stream-json run that ended WITHOUT a result event
 * (killed/timed-out/aborted) stored the full raw NDJSON as raw_output. That
 * field is the terminal viewer's Clean-tab replay source, so those rows render
 * megabytes of raw protocol in Clean. The forward fix (exec-core no-result
 * branch -> getAssistantText()) prevents NEW corruption; this backfills the
 * existing rows to the same value.
 *
 * For each leaked row it re-extracts the assistant prose with the SAME collector
 * the runtime uses (no logic drift) and overwrites raw_output with it. Rows that
 * streamed no prose at all are emptied (Clean then shows "No model text for this
 * run."). The full raw NDJSON remains in stream_log (the Raw tab) regardless.
 *
 * Safety:
 *  - Dry-run by default. Set APPLY=1 to write.
 *  - On apply it first writes every targeted row's original (id, raw_output) to
 *    backfill-rawoutput-backup.json, then updates inside a single transaction.
 *  - Guards: a row is only touched when it is an init-prefixed CLI trace, or has
 *    >=2 stream-json event lines with the first line an event; it is only emptied
 *    when the init event confirms a real trace; the new value must be strictly
 *    shorter. Legit single-object JSON step outputs fail these guards and are
 *    skipped.
 *  - Idempotent: after a write raw_output no longer starts with the stream-json
 *    signature, so a re-run selects/needs nothing.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && tsx scripts/backfill-clean-rawoutput.ts'        # dry run
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && APPLY=1 tsx scripts/backfill-clean-rawoutput.ts' # apply
 *
 * Rollback: replay backfill-rawoutput-backup.json (UPDATE ... SET raw_output =
 * <original> WHERE id = <id>), or re-derive from stream_log.
 */
import { writeFileSync } from 'node:fs';
import { eq, like } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const APPLY = process.env.APPLY === '1';
const BACKUP_PATH = '/app/packages/worker/scripts/backfill-rawoutput-backup.json';

const db = createDatabase(DATABASE_URL);

// stream-json event `type` values emitted by claude-code / zai / amp. The init
// event prefix is a definitive signature: a model answer never starts with it.
const STREAM_EVENT_TYPES = new Set(['system', 'assistant', 'user', 'result', 'rate_limit_event']);
const INIT_PREFIX = '{"type":"system","subtype":"init"';

function classify(raw: string): { leaked: boolean; initPrefixed: boolean } {
  const initPrefixed = raw.trimStart().startsWith(INIT_PREFIX);
  if (initPrefixed) return { leaked: true, initPrefixed };
  // General NDJSON trace: first non-blank line is a stream-json event and at
  // least two such event lines exist. A single JSON object (legit step output)
  // fails this — its inner lines do not parse as typed events.
  const lines = raw.split('\n');
  let events = 0;
  let firstIsEvent = false;
  let seenFirst = false;
  for (let i = 0; i < lines.length && i < 50; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    let ok = false;
    try {
      const o = JSON.parse(t) as { type?: unknown };
      ok = typeof o.type === 'string' && STREAM_EVENT_TYPES.has(o.type);
    } catch {
      ok = false;
    }
    if (!seenFirst) {
      seenFirst = true;
      firstIsEvent = ok;
    }
    if (ok) events += 1;
  }
  return { leaked: events >= 2 && firstIsEvent, initPrefixed };
}

function extractProse(raw: string): string {
  const c = createStreamJsonCollector();
  c.onChunk(raw);
  return c.getAssistantText();
}

const rows = await db
  .select({
    id: schema.cliInvocations.id,
    rawOutput: schema.cliInvocations.rawOutput,
    exitCode: schema.cliInvocations.exitCode,
  })
  .from(schema.cliInvocations)
  .where(like(schema.cliInvocations.rawOutput, '{"type":"%'));

interface Target {
  id: string;
  exitCode: number | null;
  oldLen: number;
  newLen: number;
  newVal: string;
  raw: string;
  preview: string;
}
const targets: Target[] = [];
const skipped: { id: string; reason: string; len: number }[] = [];

for (const r of rows) {
  const raw = r.rawOutput;
  if (!raw) continue;
  const { leaked, initPrefixed } = classify(raw);
  if (!leaked) {
    skipped.push({ id: r.id, reason: 'not-a-trace', len: raw.length });
    continue;
  }
  const prose = extractProse(raw);
  let newVal: string | null = null;
  if (prose.length > 0) newVal = prose;
  else if (initPrefixed) newVal = '';
  else {
    skipped.push({ id: r.id, reason: 'no-prose-non-init', len: raw.length });
    continue;
  }
  if (newVal.length >= raw.length) {
    skipped.push({ id: r.id, reason: 'not-shorter', len: raw.length });
    continue;
  }
  targets.push({
    id: r.id,
    exitCode: r.exitCode,
    oldLen: raw.length,
    newLen: newVal.length,
    newVal,
    raw,
    preview: newVal.replace(/\s+/g, ' ').slice(0, 100),
  });
}

const freed = targets.reduce((a, t) => a + (t.oldLen - t.newLen), 0);
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`candidates (raw_output LIKE stream-json): ${rows.length}`);
console.log(`targets: ${targets.length}   skipped: ${skipped.length}   bytes freed: ${freed}`);
console.log('--- targets ---');
for (const t of targets) {
  console.log(`  FIX ${t.id} exit=${t.exitCode} ${t.oldLen} -> ${t.newLen}  "${t.preview}"`);
}
console.log('--- skipped ---');
for (const s of skipped) console.log(`  SKIP ${s.id} ${s.reason} len=${s.len}`);

if (!APPLY) {
  console.log('\nDRY-RUN: no rows written. Re-run with APPLY=1 to apply.');
  process.exit(0);
}

writeFileSync(
  BACKUP_PATH,
  JSON.stringify(
    targets.map((t) => ({ id: t.id, exitCode: t.exitCode, raw_output: t.raw })),
    null,
    0,
  ),
);
console.log(`\nbackup written: ${BACKUP_PATH}`);

await db.transaction(async (tx) => {
  for (const t of targets) {
    await tx
      .update(schema.cliInvocations)
      .set({ rawOutput: t.newVal })
      .where(eq(schema.cliInvocations.id, t.id));
  }
});

console.log(`DONE: updated ${targets.length} rows.`);
process.exit(0);
