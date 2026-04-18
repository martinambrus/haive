import { stat, mkdir, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
    const ok = await ensureHostPath(hostFsPath, entry.kind);
    if (!ok) continue;
    binds.push({
      hostPath: join(hostHomeReal, entry.rel),
      containerPath: join(SANDBOX_USER_HOME, entry.rel),
      readOnly: !options.writable,
    });
  }
  return binds;
}

async function ensureHostPath(fsPath: string, kind: 'dir' | 'file'): Promise<boolean> {
  try {
    const st = await stat(fsPath);
    if (kind === 'dir' && !st.isDirectory()) return false;
    if (kind === 'file' && !st.isFile()) return false;
    return true;
  } catch {
    // fall through to create
  }
  try {
    if (kind === 'dir') {
      await mkdir(fsPath, { recursive: true });
    } else {
      const parent = join(fsPath, '..');
      await mkdir(parent, { recursive: true });
      try {
        await access(fsPath, fsConstants.F_OK);
      } catch {
        await writeFile(fsPath, '', { flag: 'wx' });
      }
    }
    return true;
  } catch (err) {
    log.warn({ err, fsPath, kind }, 'failed to ensure host auth path');
    return false;
  }
}
