import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@haive/shared';
import type { CliProviderName } from '@haive/shared';
import { SANDBOX_USER_HOME } from './sandbox-runner.js';

const log = logger.child({ module: 'cli-auth-host' });

export interface HostCliAuthBind {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

interface AuthEntry {
  rel: string;
  kind: 'dir' | 'file';
}

const HOST_AUTH_ENTRIES: Partial<Record<CliProviderName, AuthEntry[]>> = {
  'claude-code': [
    { rel: '.claude', kind: 'dir' },
    { rel: '.claude.json', kind: 'file' },
    { rel: '.config/claude', kind: 'dir' },
  ],
  codex: [
    { rel: '.codex', kind: 'dir' },
    { rel: '.config/codex', kind: 'dir' },
  ],
};

export async function resolveCliAuthHostBinds(
  providerName: CliProviderName,
  options: { writable: boolean },
): Promise<HostCliAuthBind[]> {
  const entries = HOST_AUTH_ENTRIES[providerName];
  if (!entries || entries.length === 0) return [];

  const hostHomeReal = process.env.HOST_USER_HOME;
  const hostFsRoot = process.env.HOST_REPO_ROOT;
  if (!hostHomeReal || !hostFsRoot) {
    log.info(
      { providerName, hostHomeReal: !!hostHomeReal, hostFsRoot: !!hostFsRoot },
      'host home env missing; skipping host auth binds',
    );
    return [];
  }

  const binds: HostCliAuthBind[] = [];
  for (const entry of entries) {
    const hostFsPath = join(hostFsRoot, entry.rel);
    const exists = await hostPathExists(hostFsPath, entry.kind);
    if (!exists) continue;
    binds.push({
      hostPath: join(hostHomeReal, entry.rel),
      containerPath: join(SANDBOX_USER_HOME, entry.rel),
      readOnly: !options.writable,
    });
  }
  return binds;
}

/** Check whether a host path exists, has the expected kind, AND is writable
 *  by the sandbox `node` user (uid 1000). We do NOT create missing paths;
 *  creation via the worker container produces root-owned artifacts that the
 *  sandbox cannot write on Windows bind mounts. Root-owned paths are treated
 *  as absent so they fall through to the Docker named-volume branch which
 *  inherits node ownership from the image. */
const SANDBOX_USER_UID = 1000;

async function hostPathExists(fsPath: string, kind: 'dir' | 'file'): Promise<boolean> {
  try {
    const st = await stat(fsPath);
    if (kind === 'dir' && !st.isDirectory()) return false;
    if (kind === 'file' && !st.isFile()) return false;
    if (st.uid !== SANDBOX_USER_UID) {
      log.warn(
        { fsPath, uid: st.uid, expectedUid: SANDBOX_USER_UID },
        'host auth path owned by wrong uid; skipping bind and using named volume',
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
