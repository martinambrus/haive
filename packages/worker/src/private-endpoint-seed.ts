import dns from 'node:dns';
import net from 'node:net';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  BUILT_IN_PRIVATE_ORIGINS,
  CONFIG_KEYS,
  PRIVATE_ENDPOINT_SEED_STATE_KEY,
  IN_STACK_OLLAMA_HOSTS,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
  configService,
  logger,
  type ConfigService,
  type OnboardingToolingMirror,
} from '@haive/shared';
import {
  MAX_ALLOWLIST_BYTES,
  MAX_ALLOWLIST_ENTRIES,
  dnsResolver,
  isBlockedAddress,
  validateAllowlist,
  type Resolver,
} from '@haive/shared/egress';
import { dsnDialHost, resolveToolingOllamaUrl } from '@haive/shared/rag';
import { loadPreviousStepOutput } from './step-engine/steps/onboarding/_helpers.js';

const log = logger.child({ module: 'private-endpoint-seed' });

/** The admin save of this list takes the same advisory lock (`saveConfig` in api/src/routes/admin.ts
 *  hashes `admin-config:<route>`), so a seed and a save never interleave. */
const ALLOWLIST_LOCK_NAME = 'admin-config:private-endpoint-allowlist';
const AUDIT_ACTION = 'config.private_endpoint_allowlist';
/** No authenticated actor: the same sentinel as the api's ANONYMOUS_AUDIT_ACTOR. */
const SEED_AUDIT_ACTOR = '00000000-0000-0000-0000-000000000000';
const LOCK_TIMEOUT_MS = 5000;
const TOOLING_STEP_ID = '04-tooling-infrastructure';

export type SeedSkipReason = 'invalid' | 'public' | 'unresolved' | 'not-seedable';

export interface PlanOptions {
  resolvers?: { dns?: Resolver; system?: Resolver };
  lookupTimeoutMs?: number;
  concurrency?: number;
  deadlineMs?: number;
}

export interface SeedPlan {
  entries: string[];
  skipped: Array<{ host: string; reason: SeedSkipReason }>;
  dropped: number;
}

export interface SeedDeps {
  config?: Pick<ConfigService, 'getFresh' | 'comparePrivateEndpointSeed'>;
  plan?: PlanOptions;
}

// What a one-time seed may lift: the private ranges an operator reaches by name, never loopback,
// link-local, unspecified or the cloud metadata addresses. Node's BlockList also matches the
// IPv4-mapped form of an IPv4 rule.
const SEEDABLE = new net.BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
] as const) {
  SEEDABLE.addSubnet(network, prefix, 'ipv4');
}
SEEDABLE.addSubnet('fc00::', 7, 'ipv6');

const METADATA = new net.BlockList();
METADATA.addAddress('100.100.100.200', 'ipv4');
METADATA.addAddress('fd00:ec2::254', 'ipv6');

function listed(list: net.BlockList, address: string): boolean {
  const family = net.isIP(address);
  return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Blocked by the guard AND inside the seedable set, so the set can never grant what the guard allows already. */
function isSeedable(address: string): boolean {
  return isBlockedAddress(address) && listed(SEEDABLE, address) && !listed(METADATA, address);
}

function normalizeHost(raw: string): string {
  let host = raw.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.toLowerCase();
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/** The host a stored URL dials, or null when it is not http(s) or is built in (the guard's own exact checks). */
export function seedHostOfUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (BUILT_IN_PRIVATE_ORIGINS.has(parsed.origin)) return null;
  if (IN_STACK_OLLAMA_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return normalizeHost(parsed.hostname);
}

function withTimeout<T>(
  run: () => Promise<T>,
  ms: number,
  timers: Set<NodeJS.Timeout>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      reject(new Error('lookup timed out'));
    }, ms);
    timers.add(timer);
    const done = () => {
      clearTimeout(timer);
      timers.delete(timer);
    };
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          done();
          resolve(value);
        },
        (error: unknown) => {
          done();
          reject(error as Error);
        },
      );
  });
}

type Outcome = { entry: string } | { skip: SeedSkipReason };

function classifyAddresses(addresses: ReadonlyArray<{ address: string }>, viaSystem: boolean) {
  const blocked = addresses.filter((answer) => isBlockedAddress(answer.address));
  if (blocked.some((answer) => !isSeedable(answer.address))) return 'not-seedable' as const;
  if (blocked.length === 0 && !viaSystem) return 'public' as const;
  return 'entry' as const;
}

/** Which of these hosts the guard refuses today and an allowlist entry would fix. Bounded: boot never waits on DNS. */
export async function planPrivateEndpointSeed(
  hosts: readonly string[],
  options: PlanOptions = {},
): Promise<SeedPlan> {
  const lookupTimeoutMs = options.lookupTimeoutMs ?? 5000;
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const deadlineMs = options.deadlineMs ?? 20_000;
  const skipped: SeedPlan['skipped'] = [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const raw of hosts) {
    const host = normalizeHost(raw);
    if (seen.has(host)) continue;
    seen.add(host);
    const verdict = validateAllowlist(host);
    // One entry, no CIDR: a host carrying a separator would otherwise pass as several entries or a range.
    if (!verdict.ok || verdict.entries !== 1 || /[\s,/]/.test(host)) {
      skipped.push({ host, reason: 'invalid' });
    } else {
      candidates.push(host);
    }
  }

  const found = new Map<string, Outcome>();
  const lookups: string[] = [];
  for (const host of candidates) {
    if (net.isIP(host) === 0) {
      lookups.push(host);
    } else if (!isBlockedAddress(host)) {
      found.set(host, { skip: 'public' });
    } else {
      found.set(host, isSeedable(host) ? { entry: host } : { skip: 'not-seedable' });
    }
  }

  const timers = new Set<NodeJS.Timeout>();
  const dnsLookup: Resolver = options.resolvers?.dns ?? dnsResolver()(lookupTimeoutMs).resolve;
  const systemLookup: Resolver =
    options.resolvers?.system ?? ((host) => dns.promises.lookup(host, { all: true }));
  const classify = async (host: string): Promise<Outcome> => {
    const primary = await withTimeout(() => dnsLookup(host), lookupTimeoutMs, timers).catch(
      () => [],
    );
    if (primary.length > 0) {
      const verdict = classifyAddresses(primary, false);
      return verdict === 'entry' ? { entry: host } : { skip: verdict };
    }
    const fallback = await withTimeout(() => systemLookup(host), lookupTimeoutMs, timers).catch(
      () => [],
    );
    if (fallback.length === 0) return { skip: 'unresolved' };
    const verdict = classifyAddresses(fallback, true);
    return verdict === 'entry' ? { entry: host } : { skip: verdict };
  };

  let expired = false;
  let next = 0;
  const lane = async (): Promise<void> => {
    while (!expired && next < lookups.length) {
      const host = lookups[next++]!;
      const outcome = await classify(host);
      if (!expired) found.set(host, outcome);
    }
  };
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      expired = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      resolve();
    }, deadlineMs);
    void Promise.all(Array.from({ length: Math.min(concurrency, lookups.length) }, lane)).then(
      () => {
        clearTimeout(deadline);
        resolve();
      },
    );
  });

  const wanted: string[] = [];
  for (const host of candidates) {
    const outcome = found.get(host) ?? { skip: 'unresolved' as const };
    if ('entry' in outcome) wanted.push(outcome.entry);
    else skipped.push({ host, reason: outcome.skip });
  }
  wanted.sort();
  const entries: string[] = [];
  let bytes = 0;
  for (const entry of wanted) {
    const size = Buffer.byteLength(entry) + (entries.length > 0 ? 1 : 0);
    if (entries.length >= MAX_ALLOWLIST_ENTRIES || bytes + size > MAX_ALLOWLIST_BYTES) break;
    entries.push(entry);
    bytes += size;
  }
  return { entries, skipped, dropped: wanted.length - entries.length };
}

function toolingOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The tooling `resolveRagSyncPrefs` would read: the repository mirror, else the newest onboarding task's 04 output. */
async function toolingOfRepository(
  db: Database,
  repo: { id: string; onboardingTooling: unknown },
): Promise<Record<string, unknown> | null> {
  const mirror = repo.onboardingTooling as OnboardingToolingMirror | null;
  if (mirror?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION && mirror.tooling) {
    return toolingOf(mirror.tooling);
  }
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.repositoryId, repo.id), eq(schema.tasks.type, 'onboarding')),
    orderBy: [desc(schema.tasks.createdAt)],
    columns: { id: true },
  });
  if (!task) return null;
  const previous = await loadPreviousStepOutput(db, task.id, TOOLING_STEP_ID);
  return toolingOf(toolingOf(previous?.output)?.tooling);
}

function toolingHosts(tooling: Record<string, unknown>): Array<string | null> {
  const mode = typeof tooling.ragMode === 'string' ? tooling.ragMode : 'none';
  const found: Array<string | null> = [];
  if ((mode === 'external' || mode === 'ddev') && typeof tooling.ragConnectionString === 'string') {
    found.push(dsnDialHost(tooling.ragConnectionString));
  }
  if (mode === 'internal' || mode === 'external' || mode === 'ddev') {
    const { url } = resolveToolingOllamaUrl(tooling);
    if (url) found.push(seedHostOfUrl(url));
  }
  return found;
}

function hostnameOf(value: string, withScheme: boolean): string | null {
  try {
    const parsed = new URL(withScheme ? `https://${value}` : value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return normalizeHost(parsed.hostname) || null;
  } catch {
    return null;
  }
}

async function candidateHosts(
  db: Database,
  config: Pick<ConfigService, 'getFresh'>,
): Promise<string[]> {
  const hosts: string[] = [];
  const add = (host: string | null) => {
    if (host) hosts.push(host);
  };

  const globalUrl = (await config.getFresh(CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL))?.trim();
  if (globalUrl) add(seedHostOfUrl(globalUrl));

  const repos = await db
    .select({
      id: schema.repositories.id,
      onboardingTooling: schema.repositories.onboardingTooling,
    })
    .from(schema.repositories);
  for (const repo of repos) {
    try {
      const tooling = await toolingOfRepository(db, repo);
      if (tooling) toolingHosts(tooling).forEach(add);
    } catch {
      // The error can hold a stored DSN or URL, so only the row and a fixed reason are logged.
      log.warn({ repositoryId: repo.id, reason: 'tooling-unreadable' }, 'repository skipped');
    }
  }

  const credentials = await db
    .select({ host: schema.repoCredentials.host, apiBaseUrl: schema.repoCredentials.apiBaseUrl })
    .from(schema.repoCredentials)
    .where(isNotNull(schema.repoCredentials.provider));
  for (const credential of credentials) {
    add(hostnameOf(credential.host, true));
    if (credential.apiBaseUrl) add(hostnameOf(credential.apiBaseUrl, false));
  }
  return hosts;
}

class SeedLostRace extends Error {}

const MAX_SEED_ATTEMPTS = 10;
interface SeedState {
  attempts: number;
  written: string | null;
  pending: string[];
}

function readSeedState(raw: string | null): SeedState | null {
  if (raw === null) return null;
  const state = JSON.parse(raw) as SeedState;
  if (
    !Number.isInteger(state.attempts) ||
    state.attempts < 1 ||
    state.attempts > MAX_SEED_ATTEMPTS ||
    (state.written !== null && typeof state.written !== 'string') ||
    !Array.isArray(state.pending) ||
    !state.pending.every((host) => typeof host === 'string')
  ) {
    throw new Error('Invalid private endpoint seed state');
  }
  return state;
}

/** Resume only our unfinished seed. Any existing value without matching seed ownership is a
 * decision; administrator writes atomically clear ownership, even when saving the same value. */
export async function seedPrivateEndpointAllowlist(
  db: Database,
  deps: SeedDeps = {},
): Promise<void> {
  const config = deps.config ?? configService;
  const key = CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST;
  const previous = await config.getFresh(key);
  const rawState = await config.getFresh(PRIVATE_ENDPOINT_SEED_STATE_KEY);
  const savedState = readSeedState(rawState);
  // DEL of a previously written list explicitly asks for a new seed (the documented undo).
  const state = previous === null && savedState?.written !== null ? null : savedState;
  if (state) {
    if (
      state.attempts >= MAX_SEED_ATTEMPTS ||
      state.pending.length === 0 ||
      state.written !== previous
    )
      return;
  } else if (previous !== null) return;

  const plan = await planPrivateEndpointSeed(
    state ? state.pending : await candidateHosts(db, config),
    deps.plan,
  );
  // Preserve entries we already made available, even if DNS now fails for those names.
  const entries = previous ? previous.split('\n') : [];
  for (const entry of plan.entries) {
    if (entries.includes(entry)) continue;
    if (
      entries.length >= MAX_ALLOWLIST_ENTRIES ||
      Buffer.byteLength([...entries, entry].join('\n')) > MAX_ALLOWLIST_BYTES
    ) {
      plan.dropped++;
    } else entries.push(entry);
  }
  entries.sort();
  const attempts = (state?.attempts ?? 0) + 1;
  const unresolved = plan.skipped
    .filter((skip) => skip.reason === 'unresolved')
    .map((skip) => skip.host);
  const capped = attempts >= MAX_SEED_ATTEMPTS && unresolved.length > 0;
  const pending = capped ? [] : unresolved;
  // No empty decision marker until DNS settles or the durable retry budget is exhausted.
  const text = entries.length > 0 || pending.length === 0 ? entries.join('\n') : null;
  const nextState = JSON.stringify({ attempts, written: text ?? previous, pending });
  const skips: Record<SeedSkipReason, number> = {
    invalid: 0,
    public: 0,
    unresolved: 0,
    'not-seedable': 0,
  };
  for (const skip of plan.skipped) skips[skip.reason] += 1;
  const summary = { entries, skipped: skips, dropped: plan.dropped, attempts };

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`));
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${ALLOWLIST_LOCK_NAME}, 0))`,
      );
      if (
        (await config.getFresh(key)) !== previous ||
        (await config.getFresh(PRIVATE_ENDPOINT_SEED_STATE_KEY)) !== rawState
      )
        throw new SeedLostRace();
      // Redis is external to the transaction: the granting audit must succeed first.
      if (text !== null && text !== '' && text !== previous) {
        await tx.insert(schema.auditEvents).values({
          actorUserId: SEED_AUDIT_ACTOR,
          action: AUDIT_ACTION,
          targetType: 'system',
          targetId: null,
          metadata: { from: previous ?? '', to: text, seeded: true },
          createdAt: sql`clock_timestamp()`,
        });
      }
      if (!(await config.comparePrivateEndpointSeed(previous, rawState, text, nextState))) {
        throw new SeedLostRace();
      }
    });
  } catch (error) {
    if (error instanceof SeedLostRace) {
      log.info('private endpoint allowlist written by someone else first; seed skipped');
      return;
    }
    throw error;
  }
  if (capped) log.warn(summary, 'private endpoint seed retry cap reached; keeping known entries');
  else if (pending.length > 0)
    log.info(summary, 'private endpoint seed pending; retry on next boot');
  else log.info(summary, 'private endpoint allowlist seeded from stored targets');
}
