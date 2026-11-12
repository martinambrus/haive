/** Measure WHICH channel each CLI reports its resolved model on, so a model-identity
 *  feature is built from observed CLI output instead of guessed from vendor docs.
 *
 *  Every adapter is asked the same trivial question through its real
 *  buildCliInvocation + real sandbox image + real credentials, and every place a
 *  model identifier appears in the answer is extracted:
 *
 *    claude-stream-json  system/init `.model`      (what the CLI ASKED for)
 *                        assistant `.message.model` (what the server SERVED)
 *                        result `.modelUsage` keys  (every model billed, incl. side calls)
 *    codex-jsonl         any `model` field on a typed event
 *    gemini-json         `stats.models` keys
 *    plain text (agy)    stdout + the --log-file capture
 *
 *  The distinction that matters is REQUESTED vs SERVED: they are not always equal.
 *  Measured 2026-08-18, a provider configured for `glm-5.2[1m]` was served `glm-5.3`
 *  by api.z.ai, while recorded streams from 2026-07-24 show that same provider being
 *  served `glm-5.2` — the endpoint changed with no config change on our side. "Are we
 *  running the model we think we are" is exactly that comparison, which is why this
 *  script reports both channels separately rather than one resolved model.
 *
 *  Run inside the worker container:
 *    docker compose exec worker pnpm --filter @haive/worker exec tsx \
 *      test/model-report-discover.ts [--only claude-code,codex] [--timeout 120]
 */
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService } from '@haive/shared';
import { initDatabase } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { resolveCliAuthMounts } from '../src/sandbox/cli-auth-volume.js';
import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import { buildModelIdentity, requestedFromSpec } from '../src/queues/cli-exec/model-identity.js';
import { extractGeminiJsonOutput } from '../src/cli-executor/usage-extract.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import { resolveProviderSecrets } from '../src/secrets/provider-secrets.js';

/** Default question: trivial, so the answer is about WHICH MODEL replied and nothing else.
 *
 *  `--prompt` overrides it. That exists to probe a provider's own moderation: a vendor gate
 *  does not fire on "PONG", and what a gate DOES is vendor-specific — codex refuses outright
 *  (exit 1 plus a structured error, now classified content_filter), while Claude Code is
 *  reported to silently DOWNGRADE to a weaker model, which is not an error at all and is only
 *  visible as a requested-vs-served mismatch. This script already reports exactly that. */
const DEFAULT_PROMPT = 'Reply with exactly one word: PONG';

interface ModelSighting {
  channel: string;
  value: string;
}

/** Walk every NDJSON line and pull model identifiers out of whichever protocol
 *  this CLI speaks. Tolerant by design: a stream that is prose, a mixed stream,
 *  or a protocol we do not recognise simply yields no sightings rather than
 *  throwing — "reports nothing" is a legitimate measurement here. */
function extractSightings(raw: string): ModelSighting[] {
  const out: ModelSighting[] = [];
  const seen = new Set<string>();
  const push = (channel: string, value: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    const key = JSON.stringify([channel, value]);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ channel, value });
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    // claude-stream-json
    if (event.type === 'system' && event.subtype === 'init') push('init.model', event.model);
    if (event.type === 'assistant') {
      const msg = event.message as Record<string, unknown> | undefined;
      push('assistant.message.model', msg?.model);
    }
    if (event.type === 'result') {
      const usage = event.modelUsage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        for (const k of Object.keys(usage)) push('result.modelUsage[key]', k);
      }
    }

    // codex-jsonl: no documented model field — probe every plausible carrier so a
    // newer binary that starts emitting one is caught rather than assumed absent.
    for (const [k, v] of Object.entries(event)) {
      if (/^model/i.test(k)) push(`event.${event.type as string}.${k}`, v);
    }
    const item = event.item as Record<string, unknown> | undefined;
    if (item) {
      for (const [k, v] of Object.entries(item)) {
        if (/^model/i.test(k)) push(`item.${String(item.type)}.${k}`, v);
      }
    }

    // gemini-json is a single JSON document, not NDJSON: {response, stats:{models:{…}}}
    const stats = event.stats as Record<string, unknown> | undefined;
    const models = stats?.models as Record<string, unknown> | undefined;
    if (models && typeof models === 'object') {
      for (const k of Object.keys(models)) push('stats.models[key]', k);
    }
  }

  // Whole-buffer JSON (gemini emits one pretty-printed document, so the
  // line-by-line pass above misses it).
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const stats = doc.stats as Record<string, unknown> | undefined;
    const models = stats?.models as Record<string, unknown> | undefined;
    if (models && typeof models === 'object') {
      for (const k of Object.keys(models)) push('stats.models[key]', k);
    }
  } catch {
    /* not a single JSON document */
  }

  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only')
    ? (argv[argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean)
    : null;
  const timeoutMs =
    (argv.includes('--timeout') ? Number(argv[argv.indexOf('--timeout') + 1] ?? '120') : 120) *
    1000;

  const redisUrl = process.env.REDIS_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!redisUrl || !databaseUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
  initRedis(redisUrl);
  const db = initDatabase(databaseUrl);
  await configService.initialize(redisUrl, db);
  await secretsService.initialize(db);

  const all = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.enabled, true),
  });
  // One provider per adapter name: prefer a credential that already probed `ok`,
  // then the most recently touched, so the run measures a provider that can answer.
  const byName = new Map<string, (typeof all)[number]>();
  for (const row of all) {
    const cur = byName.get(row.name);
    if (!cur) {
      byName.set(row.name, row);
      continue;
    }
    const better =
      (row.authStatus === 'ok' ? 1 : 0) - (cur.authStatus === 'ok' ? 1 : 0) ||
      row.updatedAt.getTime() - cur.updatedAt.getTime();
    if (better > 0) byName.set(row.name, row);
  }
  const pinnedId = argv.includes('--provider-id') ? argv[argv.indexOf('--provider-id') + 1] : null;
  const prompt = argv.includes('--prompt')
    ? (argv[argv.indexOf('--prompt') + 1] ?? DEFAULT_PROMPT)
    : DEFAULT_PROMPT;
  const selected = (pinnedId ? all.filter((p) => p.id === pinnedId) : [...byName.values()]).filter(
    (p) => (only ? only.includes(p.name) : true),
  );

  const summary: string[] = [];
  for (const provider of selected) {
    if (!cliAdapterRegistry.has(provider.name)) {
      summary.push(`${provider.name}: NO ADAPTER REGISTERED`);
      continue;
    }
    const adapter = cliAdapterRegistry.get(provider.name);
    console.log(`\n=== ${provider.name} (${provider.label}) auth=${provider.authStatus}`);
    console.log(
      `    configured model=${provider.model || '(unset)'} args=${JSON.stringify(provider.cliArgs ?? [])}`,
    );
    try {
      const image = await resolveSandboxImageTag(db, null, provider);
      const secrets = await resolveProviderSecrets(db, provider.id);
      const authMounts = resolveCliAuthMounts(
        {
          userId: provider.userId,
          providerId: provider.id,
          providerName: provider.name,
          authMode: provider.authMode,
          isolateAuth: provider.isolateAuth,
        },
        { writable: true },
      );
      const spec = adapter.buildCliInvocation(provider, prompt, { disableTools: true });
      const spawner = createSandboxSpawner(
        provider.wrapperContent,
        image,
        null,
        SANDBOX_WORKDIR,
        provider.networkPolicy,
        provider.egressDomains ?? [],
        [],
        authMounts,
      );
      const res = await spawner({ ...spec, env: { ...spec.env, ...secrets } }, { timeoutMs });
      const blob = `${res.stdout}\n${res.stderr}\n${res.capturedLog ?? ''}`;
      const sightings = extractSightings(blob);

      // Feed the SAME live output through the production capture path, so this
      // script checks the shipped code against reality rather than only describing
      // reality. A disagreement between the two lines below means the parser drifted
      // from what the CLIs actually emit — which is the failure this guards.
      const collector = createStreamJsonCollector();
      collector.onChunk(res.stdout);
      const gemini = extractGeminiJsonOutput(res.stdout);
      const identity = buildModelIdentity({
        stream: collector.getModelIdentity(),
        geminiModels: gemini?.models ?? null,
        antigravityLog: res.capturedLog ?? null,
        specRequested: requestedFromSpec(spec),
      });
      console.log(`  => captured ModelIdentity: ${JSON.stringify(identity)}`);
      console.log(`exit=${res.exitCode}${res.timedOut ? ' TIMEOUT' : ''} bytes=${blob.length}`);
      if (sightings.length === 0) {
        console.log('  NO MODEL IDENTIFIER ANYWHERE IN OUTPUT');
        summary.push(`${provider.name}: none (exit=${res.exitCode})`);
      } else {
        for (const s of sightings) console.log(`  ${s.channel} = ${s.value}`);
        summary.push(
          `${provider.name}: ${sightings.map((s) => `${s.channel}=${s.value}`).join(' | ')}`,
        );
      }
      if (argv.includes('--dump')) {
        console.log(`----8<---- FULL OUTPUT ${provider.name} ----8<----`);
        console.log(blob);
        console.log(`----8<---- END ${provider.name} ----8<----`);
      } else {
        console.log(`  out tail: …${blob.replace(/\s+/g, ' ').slice(-500)}`);
      }
    } catch (err) {
      console.log(`  FAILED: ${(err as Error).message}`);
      summary.push(`${provider.name}: ERROR ${(err as Error).message.slice(0, 120)}`);
    }
  }

  console.log('\n================ SUMMARY ================');
  for (const line of summary) console.log(line);

  await closeRedis();
  process.exit(0);
}

void main();
