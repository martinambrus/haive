/** Live egress smoke: does every CLI still reach its own model under the
 *  "no internet" network policy?
 *
 *  Policy `none` + a non-empty egress allow-set spins up a squid gateway that
 *  permits ONLY the adapter's declared `defaultEgressDomains` (∪ the provider's
 *  extras) — see sandbox-runner.runInSandbox. Nothing else in the stack proves
 *  that set is sufficient for the CLI's real traffic: a vendor that adds an auth
 *  host, a telemetry gate, or a CDN redirect breaks a `none` run silently while
 *  every `full` run keeps working.
 *
 *  So this drives the REAL binary, with the REAL credentials, through the REAL
 *  gateway, and reports PASS only when the model answered.
 *
 *  Run inside the worker container (needs the docker socket + the auth volumes):
 *    docker compose exec worker pnpm --filter @haive/worker exec tsx \
 *      test/egress-none-smoke.ts [--only claude-code,codex] [--control] [--timeout 180]
 *
 *  --control runs two credential-free curl probes instead of the CLIs, proving
 *  the gateway allows exactly the allow-set and blocks everything else.
 */
import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, type CliNetworkPolicy } from '@haive/shared';
import { initDatabase } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { resolveEffectiveEgressDomains } from '../src/queues/cli-exec/resolvers.js';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { resolveCliAuthMounts } from '../src/sandbox/cli-auth-volume.js';
import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import { resolveProviderSecrets } from '../src/secrets/provider-secrets.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

const PROMPT = 'Reply with exactly one word: PONG';
const NO_INTERNET: CliNetworkPolicy = { mode: 'none', domains: [], ips: [] };

/** Signatures of "the sandbox could not reach the host at all" — a squid DENY
 *  (403 from the proxy), a refused CONNECT tunnel, or a DNS failure on the
 *  gateway-less path. Kept separate from auth/credit failures, which mean the
 *  egress worked and the ACCOUNT did not. */
const BLOCKED_RE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|ETIMEDOUT|ECONNRESET|proxy|tunnel|403 Forbidden|Access Denied|connect error|Could not resolve host|network error|fetch failed|Connection error/i;
const CREDIT_RE =
  /\b(quota|credit|balance|billing|insufficient|payment|402|429)\b|rate[_\s-]?limit|too many requests/i;
const AUTH_RE =
  /\b401\b|\b403\b|unauthor(ised|ized)|invalid[_\s-]?api[_\s-]?key|not authenticated/i;

interface Row {
  provider: string;
  verdict: string;
  detail: string;
  domains: string;
  ms: number;
}

function tail(s: string, n = 1200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

function parseArgs(): { only: string[] | null; control: boolean; timeoutMs: number } {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only')
    ? (argv[argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean)
    : null;
  const timeoutArg = argv.includes('--timeout')
    ? Number(argv[argv.indexOf('--timeout') + 1] ?? '180')
    : 180;
  return { only, control: argv.includes('--control'), timeoutMs: timeoutArg * 1000 };
}

/** Credential-free proof that the gateway is a real allow-list: one host on the
 *  list, one off it, through the same squid instance. Uses curl (present in the
 *  sandbox image) because it honours the HTTP(S)_PROXY env the runner injects. */
async function runControl(image: string, timeoutMs: number): Promise<void> {
  const script =
    'echo "ALLOWED=$(curl -s -o /dev/null -m 20 -w %{http_code} https://api.anthropic.com/v1/messages 2>&1 || echo curl-failed)"; ' +
    'echo "BLOCKED=$(curl -s -o /dev/null -m 20 -w %{http_code} https://example.com 2>&1 || echo curl-failed)"';

  console.log('\n=== control A: policy none + allow-set [api.anthropic.com] ===');
  const withGateway = createSandboxSpawner(null, image, null, SANDBOX_WORKDIR, NO_INTERNET, [
    'api.anthropic.com',
  ]);
  const a = await withGateway({ command: 'bash', args: ['-lc', script], env: {} }, { timeoutMs });
  console.log(`exit=${a.exitCode} ${tail(a.stdout + a.stderr, 300)}`);

  console.log('\n=== control B: policy none + EMPTY allow-set (no gateway at all) ===');
  const noGateway = createSandboxSpawner(null, image, null, SANDBOX_WORKDIR, NO_INTERNET, []);
  const b = await noGateway({ command: 'bash', args: ['-lc', script], env: {} }, { timeoutMs });
  console.log(`exit=${b.exitCode} ${tail(b.stdout + b.stderr, 300)}`);
}

async function main(): Promise<void> {
  const { only, control, timeoutMs } = parseArgs();
  const redisUrl = process.env.REDIS_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!redisUrl || !databaseUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
  initRedis(redisUrl);
  await configService.initialize(redisUrl);
  const db = initDatabase(databaseUrl);
  await secretsService.initialize(db);

  // One representative provider per CLI: prefer a row whose auth already probed
  // ok, then the most recently updated — the same row a dispatch would land on.
  const all = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.enabled, true),
  });
  const byName = new Map<string, CliProviderRecord>();
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

  // --provider-id pins ONE exact row, for the case where a CLI has several
  // provider rows (e.g. a subscription grok and an api-key grok) and the
  // representative-picking above chose the one that is not the question.
  const pinnedId = process.argv.includes('--provider-id')
    ? process.argv[process.argv.indexOf('--provider-id') + 1]
    : null;
  const selected = (pinnedId ? all.filter((p) => p.id === pinnedId) : [...byName.values()])
    .filter((p) => (only ? only.includes(p.name) : true))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (control) {
    const anyClaude = byName.get('claude-code') ?? selected[0];
    if (!anyClaude) throw new Error('no provider row to resolve a sandbox image from');
    const image = await resolveSandboxImageTag(db, null, anyClaude);
    if (!image) throw new Error('could not resolve a sandbox image for the control run');
    await runControl(image, timeoutMs);
    await closeRedis();
    process.exit(0);
  }

  console.log(
    `egress smoke: ${selected.length} providers, policy=none, prompt="${PROMPT}", timeout=${timeoutMs / 1000}s\n`,
  );

  const results: Row[] = [];
  // Sequential on purpose: each run is a full CLI sandbox and the dev host may
  // already be hosting live task runners.
  for (const provider of selected) {
    const startedAt = Date.now();
    const name = provider.name;
    if (!cliAdapterRegistry.has(name)) {
      results.push({
        provider: name,
        verdict: 'SKIP',
        detail: 'no adapter registered',
        domains: '',
        ms: 0,
      });
      continue;
    }
    const adapter = cliAdapterRegistry.get(name);
    const egress = resolveEffectiveEgressDomains(provider);
    const domains = egress.join(' ');
    try {
      const image = await resolveSandboxImageTag(db, null, provider);
      const secrets = await resolveProviderSecrets(db, provider.id);
      const authMounts = resolveCliAuthMounts(
        {
          userId: provider.userId,
          providerId: provider.id,
          providerName: name,
          authMode: provider.authMode,
          isolateAuth: provider.isolateAuth,
        },
        { writable: true },
      );
      const spec = adapter.buildCliInvocation(provider, PROMPT, { disableTools: true });
      const env = { ...spec.env, ...secrets };
      // Mirrors executeCliSpec: ollama's key is stored as OLLAMA_API_KEY but the
      // claude binary authenticates with ANTHROPIC_AUTH_TOKEN.
      if (
        env.OLLAMA_API_KEY &&
        (!env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN === 'ollama')
      ) {
        env.ANTHROPIC_AUTH_TOKEN = env.OLLAMA_API_KEY;
        env.ANTHROPIC_API_KEY = env.OLLAMA_API_KEY;
      }
      const spawner = createSandboxSpawner(
        provider.wrapperContent,
        image,
        null,
        SANDBOX_WORKDIR,
        NO_INTERNET,
        egress,
        [],
        authMounts,
      );
      const secretShape = Object.entries(secrets)
        .map(([k, v]) => `${k}(len=${v.length})`)
        .join(' ');
      console.log(
        `--- ${name}: allow-set [${domains || 'EMPTY'}] auth=${provider.authMode} secrets=[${secretShape || 'none'}] …`,
      );
      const res = await spawner({ ...spec, env }, { timeoutMs });
      const out = `${res.stdout}\n${res.stderr}\n${res.capturedLog ?? ''}`;
      // Full transcript on demand: agy in particular buries its one real error
      // under thousands of file_watcher lines, so a tail is not enough.
      if (process.argv.includes('--dump')) {
        const path = `/tmp/egress-${name}.log`;
        await writeFile(path, out, 'utf8');
        console.log(`    (full output: ${path})`);
      }
      const answered = /pong/i.test(out);
      const verdict =
        res.exitCode === 0 && answered
          ? 'PASS'
          : BLOCKED_RE.test(out)
            ? 'BLOCKED?'
            : CREDIT_RE.test(out)
              ? 'CREDIT/RATE'
              : AUTH_RE.test(out)
                ? 'AUTH'
                : 'FAIL';
      results.push({
        provider: name,
        verdict,
        detail: `exit=${res.exitCode}${res.timedOut ? ' TIMEOUT' : ''} ${tail(out)}`,
        domains,
        ms: Date.now() - startedAt,
      });
      console.log(`    ${verdict} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    } catch (err) {
      results.push({
        provider: name,
        verdict: 'ERROR',
        detail: err instanceof Error ? err.message : String(err),
        domains,
        ms: Date.now() - startedAt,
      });
      console.log(`    ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n===== egress smoke summary (policy: none) =====');
  for (const r of results) {
    console.log(`\n[${r.verdict}] ${r.provider}  (${Math.round(r.ms / 1000)}s)`);
    console.log(`  allow-set: ${r.domains || 'EMPTY (no gateway — fully offline)'}`);
    console.log(`  ${r.detail}`);
  }
  await closeRedis();
  process.exit(0);
}

void main();
