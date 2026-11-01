import {
  REVIEW_WATERMARK_KEYS,
  reviewWatermarks,
  type ReviewWatermarks,
} from '@haive/shared/project-state';
import { gitRun } from '../repo/git-exec.js';

export class ReviewWatermarkGitError extends Error {}
export class ReviewWatermarkUnavailableError extends Error {}

/** Only exit 1 means not an ancestor. Broken/unreadable Git must hold the import. */
export async function watermarkAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const res = await gitRun(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (res.code === 0) return true;
  if (res.code === 1) return false;
  throw new ReviewWatermarkGitError(
    `review watermark ancestry could not be read: ${(res.stderr || res.stdout).trim()}`,
  );
}

async function knownCommit(repoPath: string, sha: string): Promise<boolean> {
  const res = await gitRun(repoPath, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (res.code === 0) return true;
  if (res.code === 1) return false;
  throw new ReviewWatermarkGitError(
    `review watermark commit could not be read: ${(res.stderr || res.stdout).trim()}`,
  );
}

/** Preserve unavailable review proof on disk. A shallow clone must fetch the missing history;
 * a foreign watermark needs deliberate repair. Neither can silently become reviewed progress. */
export async function reviewWatermarkIntake(
  repoPath: string,
  value: unknown,
): Promise<ReviewWatermarks> {
  const marks = reviewWatermarks(value) ?? {};
  for (const key of REVIEW_WATERMARK_KEYS) {
    const sha = marks[key];
    if (!sha) continue;
    if (!(await knownCommit(repoPath, sha)))
      throw new ReviewWatermarkUnavailableError(
        `Review watermark ${key} is unavailable; fetch its commit history and retry. Incoming files and local review progress were preserved.`,
      );
    if (!(await watermarkAncestor(repoPath, sha, 'HEAD')))
      throw new ReviewWatermarkUnavailableError(
        `Review watermark ${key} belongs to another history; repair the incoming watermark or checkout and retry. Incoming files and local review progress were preserved.`,
      );
  }
  return marks;
}

export async function reviewWatermarkOrder(repoPath: string, local: unknown, incoming: unknown) {
  const ours = reviewWatermarks(local) ?? {};
  const theirs = reviewWatermarks(incoming) ?? {};
  const orders = new Map<string, 'local' | 'incoming' | 'incomparable'>();
  for (const key of REVIEW_WATERMARK_KEYS) {
    const l = ours[key],
      i = theirs[key];
    if (!l || !i || l === i) continue;
    const order = !(await knownCommit(repoPath, l))
      ? 'incoming'
      : (await watermarkAncestor(repoPath, l, i))
        ? 'incoming'
        : (await watermarkAncestor(repoPath, i, l))
          ? 'local'
          : 'incomparable';
    orders.set(`${l}:${i}`, order);
  }
  return (local: string, incoming: string) => orders.get(`${local}:${incoming}`) ?? 'incomparable';
}
