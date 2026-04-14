import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pack as tarPack } from 'tar-fs';
import type Docker from 'dockerode';
import { getCliProviderMetadata, logger } from '@haive/shared';
import type { CliProviderName } from '@haive/shared';

const log = logger.child({ module: 'env-injector' });

export interface InjectCliAuthOptions {
  container: Docker.Container;
  cliProvider: CliProviderName;
  targetHome?: string;
}

export interface InjectCliAuthResult {
  injected: string[];
  skipped: string[];
}

export async function injectCliAuth(opts: InjectCliAuthOptions): Promise<InjectCliAuthResult> {
  const meta = getCliProviderMetadata(opts.cliProvider);
  const targetHome = opts.targetHome ?? '/home/claude';
  const injected: string[] = [];
  const skipped: string[] = [];

  for (const rawPath of meta.authConfigPaths) {
    const hostAbs = expandTilde(rawPath);
    try {
      const st = await stat(hostAbs);
      if (!st.isDirectory()) {
        skipped.push(rawPath);
        continue;
      }
    } catch {
      skipped.push(rawPath);
      continue;
    }

    const containerPath = rawPath.startsWith('~/') ? join(targetHome, rawPath.slice(2)) : rawPath;
    const parentDir = dirname(containerPath);
    const basename = containerPath.slice(parentDir.length + 1) || '';
    if (!basename) {
      skipped.push(rawPath);
      continue;
    }

    const mkdirExit = await execInContainer(opts.container, ['mkdir', '-p', parentDir]);
    if (mkdirExit !== 0) {
      log.warn({ cli: opts.cliProvider, parentDir, mkdirExit }, 'mkdir failed');
      skipped.push(rawPath);
      continue;
    }

    try {
      const packStream = tarPack(hostAbs, {
        map: (header) => {
          header.name = `${basename}/${header.name}`.replace(/\/$/, '');
          return header;
        },
      });
      await opts.container.putArchive(packStream, { path: parentDir });
      injected.push(rawPath);
      log.info({ cli: opts.cliProvider, hostAbs, containerPath }, 'injected auth path');
    } catch (err) {
      log.warn({ err, hostAbs, containerPath }, 'putArchive failed');
      skipped.push(rawPath);
    }
  }

  return { injected, skipped };
}

async function execInContainer(container: Docker.Container, cmd: string[]): Promise<number> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
    stream.resume();
  });
  const info = await exec.inspect();
  return info.ExitCode ?? -1;
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}
