import { resolve, relative } from 'node:path';
import { stat } from 'node:fs/promises';
import { HttpError } from '../context.js';

export function getFilesystemRoot(): string {
  const root = process.env.HOST_REPO_ROOT?.trim();
  if (root) return resolve(root);
  return resolve(process.env.HOME ?? '/');
}

export function validateLocalPath(p: string): string {
  if (!p) throw new HttpError(400, 'Path is required');
  const abs = resolve(p);
  const root = getFilesystemRoot();
  const rel = relative(root, abs);
  if (rel.startsWith('..') || rel === '..' || rel.includes('\0')) {
    throw new HttpError(403, 'Path is outside the allowed root');
  }
  return abs;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isGitRepository(absPath: string): Promise<boolean> {
  try {
    const s = await stat(`${absPath}/.git`);
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}
