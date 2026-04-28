import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type ArchiveFormat, type RepoJobPayload } from '@haive/shared';
import { detectFromDirectory } from './framework-detect.js';
import { getDecryptedCredentials } from './credentials.js';

export function buildAuthenticatedUrl(url: string, username: string, secret: string): string {
  const u = new URL(url);
  u.username = encodeURIComponent(username);
  u.password = encodeURIComponent(secret);
  return u.toString();
}

export function gitClone(url: string, dest: string, branch?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push('--', url, dest);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
    };
    const proc = spawn('git', args, { env });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const msg = stderr.replace(/https?:\/\/[^@]+@/g, 'https://***@').trim();
      reject(new Error(`git clone failed (exit ${code}): ${msg}`));
    });
  });
}

async function persistDetection(
  db: Database,
  repositoryId: string,
  storagePath: string,
): Promise<void> {
  const detection = await detectFromDirectory(storagePath);
  await db
    .update(schema.repositories)
    .set({
      fileTree: detection.fileTree,
      detectedFramework: detection.framework,
      detectedLanguages: detection.languages,
      excludedPaths: detection.excludedPaths,
      selectedPaths: detection.selectedPaths,
      sizeBytes: detection.sizeBytes,
      storagePath,
      status: 'ready',
      statusMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.repositories.id, repositoryId));
}

export async function handleScan(payload: RepoJobPayload, db: Database): Promise<void> {
  if (!payload.localPath) throw new Error('localPath required for scan job');
  await persistDetection(db, payload.repositoryId, payload.localPath);
  logger.info({ repositoryId: payload.repositoryId }, 'Repo scan complete');
}

function runExtract(cmd: string, args: string[], okExits: number[] = [0]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== null && okExits.includes(code)) {
        if (code !== 0) {
          logger.warn(
            { cmd, exit: code, stderr: stderr.trim() },
            'extract completed with warnings',
          );
        }
        resolve();
        return;
      }
      reject(new Error(`${cmd} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

async function flattenSingleTopLevel(dest: string): Promise<void> {
  const entries = await readdir(dest);
  if (entries.length !== 1) return;
  const only = path.join(dest, entries[0]!);
  const st = await stat(only);
  if (!st.isDirectory()) return;
  const inner = await readdir(only);
  for (const name of inner) {
    await rename(path.join(only, name), path.join(dest, name));
  }
  await rm(only, { recursive: true, force: true });
}

export async function extractArchive(
  archivePath: string,
  format: ArchiveFormat,
  dest: string,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  if (format === 'zip') {
    // unzip exit 1 = warnings only (e.g. non-ASCII filename header mismatch);
    // files are still extracted, so treat it as success and log the stderr.
    await runExtract('unzip', ['-q', '-o', archivePath, '-d', dest], [0, 1]);
  } else if (format === 'tar') {
    await runExtract('tar', ['-xf', archivePath, '-C', dest]);
  } else if (format === 'tar.gz') {
    await runExtract('tar', ['-xzf', archivePath, '-C', dest]);
  } else {
    throw new Error(`unsupported archive format: ${format as string}`);
  }
  await flattenSingleTopLevel(dest);
}

export async function handleExtract(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  if (!payload.archivePath) throw new Error('archivePath required for extract job');
  if (!payload.archiveFormat) throw new Error('archiveFormat required for extract job');

  const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
  await extractArchive(payload.archivePath, payload.archiveFormat, dest);
  await persistDetection(db, payload.repositoryId, dest);
  // Only remove the archive after successful extract + detection. Leaving it
  // in place on failure lets the user (or a retry) look at what actually
  // arrived on disk instead of silently masking the error.
  await rm(payload.archivePath, { force: true }).catch(() => {});
  logger.info({ repositoryId: payload.repositoryId, dest }, 'Repo extract complete');
}

export async function handleClone(
  payload: RepoJobPayload,
  db: Database,
  repoStorageRoot: string,
): Promise<void> {
  if (!payload.remoteUrl) throw new Error('remoteUrl required for clone job');

  const dest = path.join(repoStorageRoot, payload.userId, payload.repositoryId);
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });

  let cloneUrl = payload.remoteUrl;
  if (payload.credentialsId) {
    const creds = await getDecryptedCredentials(db, payload.credentialsId, payload.userId);
    cloneUrl = buildAuthenticatedUrl(payload.remoteUrl, creds.username, creds.secret);
  }

  await gitClone(cloneUrl, dest, payload.branch);
  await persistDetection(db, payload.repositoryId, dest);
  logger.info({ repositoryId: payload.repositoryId, dest }, 'Repo clone complete');
}
