/** Measure which hosts a CLI actually contacts, so an egress allow-set is
 *  derived from observed traffic instead of guessed from vendor docs or from
 *  strings grepped out of a binary.
 *
 *  How: a throwaway squid that ALLOWS everything and logs every request to its
 *  stdout, dual-homed on `haive-sandbox` (where the CLI sandbox lives) and
 *  `haive-network` (where the internet is). The CLI runs under policy `none`
 *  with NO egress domains, so its only route off the box is that proxy —
 *  a CLI that ignores HTTP(S)_PROXY therefore shows up as "reached nothing",
 *  which is itself the answer for whether it can ever work under `none`.
 *
 *  Run inside the worker container:
 *    docker compose exec worker pnpm --filter @haive/worker exec tsx \
 *      test/egress-discover.ts --only antigravity [--timeout 180]
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, type CliNetworkPolicy } from '@haive/shared';
import { initDatabase } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { resolveCliAuthMounts } from '../src/sandbox/cli-auth-volume.js';
import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import { resolveProviderSecrets } from '../src/secrets/provider-secrets.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

const PROMPT = 'Reply with exactly one word: PONG';
const OFFLINE: CliNetworkPolicy = { mode: 'none', domains: [], ips: [] };
const CONFIG_VOLUME = 'haive_squid_configs';
const CONFIG_WORKER_ROOT = '/var/lib/haive/squid-configs';
const SANDBOX_NET = process.env.SANDBOX_NETWORK ?? 'haive-sandbox';
const UPSTREAM_NET = 'haive-network';

const PERMISSIVE_CONF = `http_port 3128

acl SSL_ports port 443
acl Safe_ports port 80
acl Safe_ports port 443
acl CONNECT method CONNECT

http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow all

# /dev/stdout is NOT writable by squid's cache_effective_user ('proxy'), which
# kills the daemon at startup — log to a tmp file and read it back with exec.
access_log stdio:/tmp/squid-access.log
cache deny all
pid_filename none
coredump_dir /tmp
`;

function docker(args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

async function startLoggingProxy(): Promise<{
  host: string;
  url: string;
  stop: () => Promise<void>;
}> {
  const id = randomUUID();
  const name = `haive-egress-discover-${id.slice(0, 8)}`;
  const dir = join(CONFIG_WORKER_ROOT, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'squid.conf'), PERMISSIVE_CONF, 'utf8');
  const created = await docker([
    'create',
    '--name',
    name,
    '--network',
    SANDBOX_NET,
    '--mount',
    `type=volume,source=${CONFIG_VOLUME},destination=/haive/squid-config,volume-subpath=${id},readonly`,
    process.env.SANDBOX_SQUID_IMAGE ?? 'ubuntu/squid:latest',
    '-N',
    '-d',
    '1',
    '-f',
    '/haive/squid-config/squid.conf',
  ]);
  if (created.code !== 0) throw new Error(`discovery squid create failed: ${created.out}`);
  const connected = await docker(['network', 'connect', UPSTREAM_NET, name]);
  if (connected.code !== 0) throw new Error(`discovery squid net connect failed: ${connected.out}`);
  const started = await docker(['start', name]);
  if (started.code !== 0) throw new Error(`discovery squid start failed: ${started.out}`);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const logs = await docker(['logs', name]);
    if (/Accepting\s+HTTP\s+Socket\s+connections/i.test(logs.out)) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    const logs = await docker(['logs', name]);
    throw new Error(`discovery squid never became ready:\n${logs.out.slice(-800)}`);
  }
  return {
    host: name,
    url: `http://${name}:3128`,
    stop: async () => {
      await docker(['rm', '-f', name]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Hosts squid saw, in first-seen order. Its access log line is
 *  `<ts> <elapsed> <client> <result>/<status> <bytes> <method> <url> ...`;
 *  the URL is field 7 (a CONNECT logs `host:port`). */
function hostsFromAccessLog(log: string): Map<string, string[]> {
  const hosts = new Map<string, string[]>();
  for (const line of log.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const result = parts[3] ?? '';
    const url = parts[6] ?? '';
    if (!/^(TCP|TAG|NONE|UDP)/.test(result)) continue;
    let host = url;
    if (url.includes('://')) {
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
    } else {
      host = url.split(':')[0] ?? url;
    }
    if (!host || host === '-') continue;
    const seen = hosts.get(host) ?? [];
    if (!seen.includes(result)) seen.push(result);
    hosts.set(host, seen);
  }
  return hosts;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only')
    ? (argv[argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean)
    : null;
  const timeoutMs =
    (argv.includes('--timeout') ? Number(argv[argv.indexOf('--timeout') + 1] ?? '180') : 180) *
    1000;

  const redisUrl = process.env.REDIS_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!redisUrl || !databaseUrl) throw new Error('DATABASE_URL and REDIS_URL are required');
  initRedis(redisUrl);
  await configService.initialize(redisUrl);
  const db = initDatabase(databaseUrl);
  await secretsService.initialize(db);

  const all = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.enabled, true),
  });
  const byName = new Map<string, CliProviderRecord>();
  for (const row of all) {
    const cur = byName.get(row.name);
    if (
      !cur ||
      (row.authStatus === 'ok' ? 1 : 0) - (cur.authStatus === 'ok' ? 1 : 0) ||
      row.updatedAt.getTime() > cur.updatedAt.getTime()
    ) {
      if (!cur || row.updatedAt.getTime() > cur.updatedAt.getTime() || row.authStatus === 'ok') {
        byName.set(row.name, row);
      }
    }
  }
  const pinnedId = argv.includes('--provider-id') ? argv[argv.indexOf('--provider-id') + 1] : null;
  const selected = (pinnedId ? all.filter((p) => p.id === pinnedId) : [...byName.values()]).filter(
    (p) => (only ? only.includes(p.name) : true),
  );

  for (const provider of selected) {
    if (!cliAdapterRegistry.has(provider.name)) continue;
    const adapter = cliAdapterRegistry.get(provider.name);
    const proxy = await startLoggingProxy();
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
      const spec = adapter.buildCliInvocation(provider, PROMPT, { disableTools: true });
      const env = {
        ...spec.env,
        ...secrets,
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        http_proxy: proxy.url,
        https_proxy: proxy.url,
        NO_PROXY: 'localhost,127.0.0.1,::1,api',
        no_proxy: 'localhost,127.0.0.1,::1,api',
      };
      if (
        env.OLLAMA_API_KEY &&
        (!env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN === 'ollama')
      ) {
        env.ANTHROPIC_AUTH_TOKEN = env.OLLAMA_API_KEY;
        env.ANTHROPIC_API_KEY = env.OLLAMA_API_KEY;
      }
      // policy none + empty egress = no auto-gateway, so haive-sandbox (internal,
      // no NAT) is the sandbox's only network and the discovery proxy is its only
      // way out.
      const spawner = createSandboxSpawner(
        provider.wrapperContent,
        image,
        null,
        SANDBOX_WORKDIR,
        OFFLINE,
        [],
        [],
        authMounts,
      );
      console.log(`\n=== ${provider.name}: measuring hosts through ${proxy.host} …`);
      const res = await spawner({ ...spec, env }, { timeoutMs });
      const logs = await docker(['exec', proxy.host, 'cat', '/tmp/squid-access.log']);
      const hosts = hostsFromAccessLog(logs.out);
      console.log(`exit=${res.exitCode}${res.timedOut ? ' TIMEOUT' : ''}`);
      console.log(
        `answered=${/pong/i.test(`${res.stdout}${res.stderr}${res.capturedLog ?? ''}`) ? 'yes' : 'no'}`,
      );
      if (hosts.size === 0) {
        console.log('NO HOSTS SEEN — this CLI ignores HTTP(S)_PROXY (or never left the box).');
      }
      for (const [host, results] of hosts) console.log(`  ${host}  [${results.join(',')}]`);
      const outTail = `${res.stdout}\n${res.stderr}\n${res.capturedLog ?? ''}`.replace(/\s+/g, ' ');
      // Hostnames the CLI tried to resolve/reach DIRECTLY: on the gateway-less
      // internal network a direct connection fails with a DNS error naming the
      // host, which is exactly the evidence an allow-set needs.
      const direct = [
        ...new Set(
          [
            ...outTail.matchAll(
              /(?:lookup|dial tcp|host|Host:)\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi,
            ),
          ].map((m) => m[1] ?? ''),
        ),
      ].filter(Boolean);
      if (direct.length > 0)
        console.log(`direct (proxy-bypassing) hosts seen in errors: ${direct.join(' ')}`);
      console.log(`out: …${outTail.slice(-4000)}`);
    } finally {
      await proxy.stop();
    }
  }

  await closeRedis();
  process.exit(0);
}

void main();
