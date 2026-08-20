/** Record ONE provider's real CLI output as a replayable test fixture.
 *
 *  Why this exists: stream-json-collector.test.ts and friends are thorough (700+ lines)
 *  but every event in them is hand-authored, so they pin what we BELIEVE a provider
 *  emits. A provider quietly changing its stream shape — amp moving where it reports
 *  usage, antigravity rewording its log label — is caught only by
 *  model-report-discover.ts, which needs live credentials and therefore cannot run in
 *  CI. This captures the real thing once so CI can replay it forever after.
 *
 *  Writes two files per provider:
 *    fixtures/streams/<name>.jsonl        the scrubbed raw stdout
 *    fixtures/streams/<name>.expected.json  what the SHIPPED parser read from it, now
 *
 *  The second is the pin: stream-fixture-replay.test.ts re-reads the fixture and
 *  asserts the parser still extracts the same thing. Review it by eye before
 *  committing — capturing a parser bug would pin the bug.
 *
 *  Run inside the worker container:
 *    docker compose exec worker pnpm --filter @haive/worker exec tsx \
 *      test/capture-stream-fixture.ts --provider ollama [--timeout 180]
 */
import { chown, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService } from '@haive/shared';
import type { CliProviderName } from '@haive/shared';
import { initDatabase } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { resolveCliAuthMounts } from '../src/sandbox/cli-auth-volume.js';
import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import { buildModelIdentity, requestedFromSpec } from '../src/queues/cli-exec/model-identity.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import { resolveProviderSecrets } from '../src/secrets/provider-secrets.js';

/** Deliberately trivial: the fixture pins the stream's SHAPE, not the model's ability.
 *  The same prompt model-report-discover uses, for the same reason. */
const PROMPT = 'Reply with exactly one word: PONG';

export const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'streams',
);

/** Replace values that are real, per-run, or identifying, keeping the STRUCTURE that the
 *  fixture exists to pin. A fixture is committed to a public repository, so this is a
 *  floor and not a substitute for reading the file before committing it. */
export function scrubStream(raw: string): string {
  return (
    raw
      // absolute paths — the sandbox workdir is stable, host paths are not
      .split(SANDBOX_WORKDIR)
      .join('/haive/workdir')
      .replace(/\/(?:home|Users|root)\/[^"\s,]*/g, '/redacted/path')
      // session / request / message identifiers
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        'redacted-uuid',
      )
      .replace(/\b(msg|req|toolu|chatcmpl)_[A-Za-z0-9]{6,}\b/g, '$1_redacted')
      // anything that looks like a key, even though local models need none
      .replace(/\b(sk|pk|ghp|gho|xoxb)-[A-Za-z0-9_-]{8,}\b/g, '$1-redacted')
      .trimEnd() + '\n'
  );
}

/** Give the written fixtures back to whoever owns the repository.
 *
 *  This script runs INSIDE the worker container, which has no USER and so runs as root,
 *  writing onto the `.:/app` bind mount. Without this the fixtures land root-owned and
 *  the developer cannot commit them — prettier fails with EACCES inside the pre-commit
 *  hook, which then cannot revert cleanly either. Same reasoning, and same fix, as
 *  scripts/build-libs.sh applies to the built lib output.
 *
 *  Best-effort: a mount that cannot represent ownership makes this a harmless no-op
 *  rather than a failed capture. */
async function handOutputToRepoOwner(): Promise<void> {
  try {
    const { uid, gid } = await stat('/app');
    await chown(FIXTURE_DIR, uid, gid);
    for (const f of await readdir(FIXTURE_DIR)) {
      await chown(path.join(FIXTURE_DIR, f), uid, gid);
    }
  } catch {
    // not running in the container, or a mount without ownership — nothing to do
  }
}

function arg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wanted = arg(argv, '--provider');
  if (!wanted) {
    console.error('usage: capture-stream-fixture.ts --provider <name> [--timeout <seconds>]');
    process.exit(1);
  }
  const timeoutMs = Number(arg(argv, '--timeout') ?? 180) * 1000;

  const redisUrl = process.env.REDIS_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!redisUrl || !databaseUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
  initRedis(redisUrl);
  await configService.initialize(redisUrl);
  const db = initDatabase(databaseUrl);
  await secretsService.initialize(db);

  const provider = await db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.name, wanted as CliProviderName),
  });
  if (!provider) throw new Error(`no cli_providers row named ${wanted}`);
  if (!cliAdapterRegistry.has(provider.name)) throw new Error(`no adapter for ${provider.name}`);
  const adapter = cliAdapterRegistry.get(provider.name);

  console.log(
    `capturing ${provider.name} (${provider.label}) model=${provider.model || '(unset)'}`,
  );

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
  // disableTools: the fixture pins the protocol envelope, and a tool-capable run adds
  // per-run tool ids and file paths that are noise here.
  const spec = adapter.buildCliInvocation(provider, PROMPT, { disableTools: true });
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
  console.log(`exit=${res.exitCode}${res.timedOut ? ' TIMEOUT' : ''} bytes=${res.stdout.length}`);
  if (!res.stdout.trim()) throw new Error('the run produced no stdout — nothing to capture');

  const scrubbed = scrubStream(res.stdout);

  // Read it with the SHIPPED parser, now, and pin that reading beside the fixture.
  const collector = createStreamJsonCollector();
  collector.onChunk(scrubbed);
  const expected = {
    provider: provider.name,
    capturedAt: new Date().toISOString(),
    isStreamJson: collector.isStreamJson(),
    result: collector.getResult(),
    noResultReason: collector.getNoResultReason(),
    malformedLines: collector.getMalformedLineCount(),
    tokenUsage: collector.getTokenUsage(),
    /** Stream-derived, so the replay test can assert it. Everything above is too. */
    streamModelIdentity: collector.getModelIdentity(),
    /** Informational only — `requested` comes from the invocation spec, not the stream,
     *  so a replay cannot reproduce it and does not assert it. */
    modelIdentity: buildModelIdentity({
      stream: collector.getModelIdentity(),
      geminiModels: null,
      antigravityLog: null,
      specRequested: requestedFromSpec(spec),
    }),
  };

  await mkdir(FIXTURE_DIR, { recursive: true });
  const stem = path.join(FIXTURE_DIR, provider.name);
  await writeFile(`${stem}.jsonl`, scrubbed, 'utf8');
  await writeFile(`${stem}.expected.json`, `${JSON.stringify(expected, null, 2)}\n`, 'utf8');
  await handOutputToRepoOwner();
  console.log(`wrote ${stem}.jsonl and ${stem}.expected.json`);
  console.log('REVIEW BOTH BY EYE before committing — this is real output from a real run.');

  await closeRedis();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
