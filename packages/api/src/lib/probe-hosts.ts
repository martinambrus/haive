import type { Context } from 'hono';
import { CONFIG_KEYS, configService, IN_STACK_OLLAMA_HOSTS, logger } from '@haive/shared';
import type { AppEnv } from '../context.js';
import { egressFor } from './probe-egress.js';

const log = logger.child({ module: 'probe-hosts' });

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

export async function ownProbeHosts(): Promise<ReadonlySet<string>> {
  const hosts = new Set<string>(IN_STACK_OLLAMA_HOSTS);
  try {
    const configured = hostOf(await configService.get(CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL));
    if (configured !== null) hosts.add(configured);
  } catch (err) {
    log.warn({ err }, 'configured ollama host unreadable, not exempted');
  }
  return hosts;
}

export async function probeEgressFor(c: Context<AppEnv>): Promise<ReturnType<typeof egressFor>> {
  const role = c.get('userRole');
  return egressFor(role, role === 'admin' ? undefined : await ownProbeHosts());
}
