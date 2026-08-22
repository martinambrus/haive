import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { ensureSandboxWritableTree } from '../../../repo/worktree-permissions.js';
import { resolveTaskWorktreePath } from './_spec-artifact.js';

const log = logger.child({ module: 'screenshots' });

/** Worktree-relative directory the browser tester saves evidence screenshots into.
 *  Lives under `.haive/`, which 01-worktree-setup adds to `.git/info/exclude`
 *  (shared by linked worktrees), so `git add -A` at gate 3 never commits an image
 *  into the user's repository and the whole set dies with the worktree at step 12.
 *  The agent writes here itself — chrome-devtools-mcp mkdir -p's the parent — so
 *  nothing pre-creates it root-owned under the sandbox uid. */
export const SCREENSHOTS_DIR_REL = '.haive/screenshots';

/** Manifest file, a sibling of the directory (not inside it, so a rebuild never
 *  has to skip its own output while scanning). */
export const SCREENSHOT_MANIFEST_NAME = 'screenshots.json';

/** Hard cap on manifest entries, so a runaway capture loop cannot produce a
 *  multi-megabyte artifact the task page has to fetch every render. */
export const MAX_SCREENSHOTS = 200;

const IMAGE_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.avif']);

export type ScreenshotResult = 'pass' | 'fail' | 'info';

/** What the tester/fixer agent claims about a shot it took. Descriptive only —
 *  never evidence that the file exists. */
export interface ReportedScreenshot {
  file: string;
  caption?: string;
  testCase?: string | null;
  result?: string;
}

export interface ScreenshotEntry {
  /** Basename on disk. */
  file: string;
  /** Absolute path, which the web hands to `GET /tasks/:id/files/raw?path=`. */
  path: string;
  caption: string;
  testCase: string | null;
  result: ScreenshotResult;
}

export interface ScreenshotManifest {
  /** Files found on disk (may exceed `shots.length` when capped). */
  count: number;
  truncated: boolean;
  shots: ScreenshotEntry[];
}

export interface ScreenshotManifestResult {
  /** Absolute path to the written artifact. */
  artifactPath: string;
  count: number;
}

/** The tree the evidence lives in: the task WORKTREE, never the repo root.
 *
 *  A cli-exec invocation mounts the worktree ALONE at the sandbox workdir, so the agent's
 *  `filePath` captures land under `<worktree>/.haive/screenshots`. The api resolves its
 *  file root the same way (`resolveWorkspaceRoot` prefers `tasks.worktree_path`), so a
 *  manifest built against the repo root is wrong twice over: it scans an empty directory
 *  AND names a path `GET /tasks/:id/files/raw` answers 403 for.
 *
 *  Falls back to the repo root for a task with no worktree (root mode, read-only local
 *  repos) — which is the same fallback the api makes.
 */
export async function resolveScreenshotRoot(ctx: StepContext): Promise<string> {
  return (await resolveTaskWorktreePath(ctx)) ?? ctx.workspacePath;
}

/** Create the capture directory and hand it to the sandbox uid BEFORE the agent runs.
 *
 *  chrome-devtools-mcp mkdir -p's the parent itself, which is enough only while nothing
 *  else has created `<worktree>/.haive` first. The worker runs as root, so any step that
 *  writes a `.haive/` artifact before this one leaves a root-owned 0755 directory the
 *  uid-1000 agent cannot then create `screenshots/` inside — and the capture would fail
 *  with EACCES per shot, visible only as tool errors in the tester's transcript.
 *  ensureSandboxWritableTree owns that repair everywhere else; reuse it here rather than
 *  depending on step ordering that is free to change.
 *
 *  Best-effort by design: a browser verification must not fail because its evidence
 *  gallery could not be prepared. */
export async function ensureScreenshotsDir(workspacePath: string): Promise<void> {
  const dir = path.join(workspacePath, SCREENSHOTS_DIR_REL);
  try {
    await mkdir(dir, { recursive: true });
    await ensureSandboxWritableTree(dir);
  } catch (err) {
    log.warn({ err, dir }, 'could not prepare the screenshot directory for the sandbox');
  }
}

/** Turn `03-submit-empty-form-validation-error.webp` into
 *  `Submit empty form validation error`. The fallback caption for a file the agent
 *  wrote but never reported — the gallery always says something. */
export function humanizeSlug(file: string): string {
  const base = file.replace(/\.[^.]+$/, '');
  const words = base
    .replace(/^\d+[-_]/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (words.length === 0) return base;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeResult(value: string | undefined): ScreenshotResult {
  return value === 'pass' || value === 'fail' ? value : 'info';
}

/** Join the files actually on disk with what the agent said about them.
 *
 *  Existence comes from `files` ALONE: an entry the agent claimed but never wrote is
 *  dropped rather than rendered as a broken image, and a file with no report still
 *  appears with a slug-derived caption. Later reports win on a repeated basename, so a
 *  fixer pass that re-shoots the same view replaces the tester's caption. */
export function joinScreenshots(
  files: string[],
  reported: ReportedScreenshot[],
  dir: string,
): ScreenshotEntry[] {
  const byFile = new Map<string, ReportedScreenshot>();
  for (const entry of reported) {
    if (typeof entry?.file !== 'string') continue;
    byFile.set(path.basename(entry.file), entry);
  }
  return files.map((file) => {
    const report = byFile.get(file);
    const caption = (report?.caption ?? '').trim();
    const testCase = (report?.testCase ?? '')?.toString().trim();
    return {
      file,
      path: path.join(dir, file),
      caption: caption.length > 0 ? caption : humanizeSlug(file),
      testCase: testCase && testCase.length > 0 ? testCase : null,
      result: normalizeResult(report?.result),
    };
  });
}

/** Scan `<workspacePath>/.haive/screenshots`, join it with the agent's captions and
 *  write `<workspacePath>/.haive/screenshots.json` for the task page's gallery.
 *  A missing directory is an empty manifest, not a failure — the tester may legitimately
 *  have taken none (a backend-only change, or a no-vision model whose take_screenshot is
 *  denied). Always writes, so a rebuild clears a stale list. */
export async function buildScreenshotManifest(
  workspacePath: string,
  reported: ReportedScreenshot[],
): Promise<ScreenshotManifestResult> {
  const dir = path.join(workspacePath, SCREENSHOTS_DIR_REL);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const files = names
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const capped = files.slice(0, MAX_SCREENSHOTS);

  const manifest: ScreenshotManifest = {
    count: files.length,
    truncated: files.length > capped.length,
    shots: joinScreenshots(capped, reported, dir),
  };

  const artifactPath = path.join(workspacePath, '.haive', SCREENSHOT_MANIFEST_NAME);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(manifest), 'utf8');

  return { artifactPath, count: files.length };
}
