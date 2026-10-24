import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, IN_STACK_OLLAMA_HOSTS, logger } from '@haive/shared';
import { readTextNoFollow } from '@haive/shared/fs-safe';
import { getDb } from '../db.js';
import type { AppEnv } from '../context.js';
import { egressFor } from './probe-egress.js';

const log = logger.child({ module: 'probe-hosts' });

const DDEV_CONFIG = '.ddev/config.yaml';
const DDEV_CONFIG_MAX_BYTES = 64 * 1024;
const DDEV_TLD = 'ddev.site';
const DDEV_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

function scalar(text: string, key: string): string | null {
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim();
  if (line === undefined) return null;
  const quoted = /^(?:"([^"]*)"|'([^']*)')(?:[ \t]+#.*)?$/.exec(line);
  return (quoted ? (quoted[1] ?? quoted[2] ?? '') : line.replace(/(?:^|[ \t])#.*$/, ''))
    .trim()
    .toLowerCase();
}

function ddevHostFromConfig(text: string): string | null {
  const name = scalar(text, 'name');
  const tld = scalar(text, 'project_tld') || DDEV_TLD;
  return name !== null && tld === DDEV_TLD && DDEV_NAME.test(name) ? `${name}.${DDEV_TLD}` : null;
}

export async function ownProbeHosts(userId: string): Promise<ReadonlySet<string>> {
  const hosts = new Set<string>(IN_STACK_OLLAMA_HOSTS);
  try {
    const configured = hostOf(await configService.get(CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL));
    if (configured !== null) hosts.add(configured);
  } catch (err) {
    log.warn({ err }, 'configured ollama host unreadable, not exempted');
  }
  try {
    const repos = await getDb().query.repositories.findMany({
      where: eq(schema.repositories.userId, userId),
      columns: { storagePath: true, localPath: true },
    });
    const found = await Promise.all(
      repos.map(async (repo) => {
        const root = repo.storagePath ?? repo.localPath;
        if (!root) return null;
        const text = await readTextNoFollow(root, DDEV_CONFIG, {
          maxBytes: DDEV_CONFIG_MAX_BYTES,
        }).catch(() => null);
        return text === null ? null : ddevHostFromConfig(text);
      }),
    );
    for (const host of found) if (host !== null) hosts.add(host);
  } catch (err) {
    log.warn({ err }, 'repositories unreadable, ddev hosts not exempted');
  }
  return hosts;
}

export async function probeEgressFor(c: Context<AppEnv>): Promise<ReturnType<typeof egressFor>> {
  const role = c.get('userRole');
  return egressFor(role, role === 'admin' ? undefined : await ownProbeHosts(c.get('userId')));
}
