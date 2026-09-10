/**
 * Replay every real corrector pass on this install through the SHIPPED guard.
 *
 * Same shape as `test/model-report-discover.ts`: the measurement that justifies a
 * threshold has to be re-runnable against live data, not quoted from a comment.
 *
 *   docker exec -e DATABASE_URL=... haive-worker pnpm exec tsx scripts/verify-amended-spec-guard.ts
 */
import postgres from 'postgres';
import {
  chooseAmendedSpec,
  specHeadingCount,
} from '../src/step-engine/steps/workflow/05-phase-0b5-spec-quality.js';

const sql = postgres(process.env.DATABASE_URL!);

interface Pair {
  task: string;
  round: number;
  ord: number;
  prev: string;
  next: string;
}

const rows = await sql<{ pairs: Pair[] }[]>`
  with it as (
    select ts.task_id, ts.round, i.ord,
           (i.iv->'applyOutput'->>'source') as source,
           coalesce(i.iv->'applyOutput'->>'spec','') as spec
    from task_steps ts, jsonb_array_elements(ts.iterations) with ordinality as i(iv, ord)
    where ts.step_id = '05-phase-0b5-spec-quality'
  ), pairs as (
    select task_id, round, ord, source, spec,
           lag(spec) over (partition by task_id, round order by ord) as prev
    from it
  )
  select coalesce(json_agg(json_build_object(
           'task', left(task_id::text, 8), 'round', round, 'ord', ord,
           'prev', prev, 'next', spec)), '[]'::json) as pairs
  from pairs
  where source = 'correct' and prev is not null and length(prev) > 0
`;

const pairs = rows[0]!.pairs;
let accepted = 0;
let rejected = 0;

console.log(
  [
    'task'.padEnd(9),
    'rd',
    'ord',
    'prevLen'.padStart(8),
    'nextLen'.padStart(8),
    'ratio'.padStart(7),
    'headings'.padStart(8),
    'verdict',
  ].join(' '),
);

for (const p of pairs) {
  const d = chooseAmendedSpec(p.prev, p.next);
  const ratio = p.next.length / p.prev.length;
  const headings = specHeadingCount(p.next);
  const verdict = d.rejected ? 'REJECTED' : 'accepted';
  if (d.rejected) rejected += 1;
  else accepted += 1;
  console.log(
    [
      p.task.padEnd(9),
      String(p.round).padStart(2),
      String(p.ord).padStart(3),
      String(p.prev.length).padStart(8),
      String(p.next.length).padStart(8),
      ratio.toFixed(4).padStart(7),
      String(headings).padStart(8),
      verdict,
    ].join(' '),
  );
}

console.log(`\n${pairs.length} corrector passes: ${accepted} accepted, ${rejected} rejected`);
await sql.end();
