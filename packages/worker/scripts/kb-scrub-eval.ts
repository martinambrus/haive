/**
 * Citation-scrub calibration harness.
 *
 * Runs the CURRENT scrub rules over every stored global KB article, anchored to a real
 * repository, and reports which blocks each rule would remove. The scrub's two errors do not
 * cost the same: a miss lets a citation reach a draft a human reviews, while a false hit
 * deletes a block of somebody's article, silently. So the bar for touching a rule is evidence
 * that it does not start eating known-good prose — and this is how that evidence is produced.
 *
 * Measure the WHOLE corpus, never one article. MEASURED while this was written: a single
 * article reported zero removals while the same rule set was deleting 7 of 167 blocks across
 * the other ten, because one sample cannot exercise a rule that fires on ordinary vocabulary.
 * Both defects it caught were of that shape — generic method names (`render`, `handle`) and
 * PHP built-ins pulled in by `use function ...;` being treated as repository symbols.
 *
 * A non-zero count is not automatically a bug: an article promoted from an onboarding run may
 * genuinely cite its repo. Read the reasons. What must never appear is a removal whose reason
 * is ordinary vocabulary.
 *
 * Run it against SEVERAL repositories, not one. Their symbol sets differ enormously (10k-22k on
 * this install) and a false positive usually comes from what one checkout happens to vendor:
 * MEASURED, a rule set that scored zero on the first repo still deleted a block on two others,
 * from a minified jQuery plugin declaring `function is_string(arg)` and a site's own
 * `const in_array = ...`. Four checkouts now score zero across all 11 articles.
 *
 * Run (inside the worker container):
 *   docker exec haive-worker sh -lc 'cd /app/packages/worker && \
 *     KB_SCRUB_REPO=/var/lib/haive/repos/<userId>/<repoId> pnpm exec tsx scripts/kb-scrub-eval.ts'
 *
 * Env:
 *   KB_SCRUB_REPO  (required) path to the anchor repository checkout on the worker
 *   KB_SCRUB_LIMIT optional cap on articles scanned (default all)
 */
import { configService, secretsService } from '@haive/shared';
import { globalKbEntries, withGlobalKb } from '@haive/shared/global-kb';
import { initDatabase } from '../src/db.js';
import { initRedis } from '../src/redis.js';
import {
  scrubCitations,
  splitIntoBlocks,
} from '../src/step-engine/steps/kb-author/_citation-scrub.js';
import {
  bodyUsesRepoSymbol,
  collectRepoBasenames,
  collectRepoSymbols,
} from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

const repoPath = process.env.KB_SCRUB_REPO;
const limit = Number(process.env.KB_SCRUB_LIMIT ?? '0');

async function main(): Promise<void> {
  if (!repoPath) throw new Error('KB_SCRUB_REPO is required (path to the anchor repo checkout)');
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required');

  // Minimal bootstrap, the same shape reembed-global-kb.ts uses: the global KB connection
  // resolver reads its settings from configService and its connection string from
  // secretsService. Deliberately NOT bootstrap() — this script reads and measures only.
  initRedis(redisUrl);
  await configService.initialize(redisUrl);
  const db = initDatabase(databaseUrl);
  await secretsService.initialize(db);

  const symbols = await collectRepoSymbols(repoPath, null).catch(() => new Set<string>());
  const repoBasenames = await collectRepoBasenames(repoPath).catch(() => new Set<string>());
  const rows = await withGlobalKb(db, async ({ db: kb }) =>
    kb
      .select({ id: globalKbEntries.id, title: globalKbEntries.title, body: globalKbEntries.body })
      .from(globalKbEntries),
  );
  const articles = limit > 0 ? rows.slice(0, limit) : rows;

  let blocks = 0;
  let removed = 0;
  let chars = 0;
  for (const row of articles) {
    const body = row.body ?? '';
    if (!body.trim()) continue;
    const count = splitIntoBlocks(body).length;
    const result = await scrubCitations(body, {
      repoPath,
      repoSymbols: symbols,
      findSymbol: bodyUsesRepoSymbol,
      // MUST mirror 01-enrich's call exactly. An option this harness omits is a rule it does not
      // exercise, and it would then score a clean 0 while measuring nothing — the one way this
      // harness can lie about a change it exists to gate.
      repoBasenames,
    });
    blocks += count;
    chars += body.length;
    removed += result.removed.length;
    if (result.removed.length > 0) {
      process.stdout.write(
        `\n[${row.id.slice(0, 8)}] ${row.title.slice(0, 60)} — ${result.removed.length}/${count} removed\n`,
      );
      for (const block of result.removed) {
        const excerpt = block.excerpt.slice(0, 90).replace(/\n/g, ' ');
        process.stdout.write(`    ${JSON.stringify(block.reason)} | ${excerpt}\n`);
      }
    }
  }

  process.stdout.write(
    `\nsymbols ${symbols.size} | ${articles.length} articles, ${blocks} blocks, ${chars} chars -> ${removed} removed\n`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
