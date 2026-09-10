import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema } from '@haive/shared';
import { pathExists } from '../onboarding/_helpers.js';

/**
 * Pre-flight for 08b: can the runner load this repo's EXISTING tests at all, before a tester
 * agent is dispatched to write more?
 *
 * 08b already has two stand-down guards and neither covers this. The enumerate guard is barred
 * before the first FIX pass on purpose (a spec the tester just wrote with a syntax error also
 * enumerates as nothing, and that IS the fixer's to repair), so it can only ever fire after a
 * tester pass and a fixer pass have both been spent. `classifyTestEnvFailure` fires from pass 0
 * but keys on error IDs PLAYWRIGHT raises, and the failure measured on task ef954a3d came from
 * the project's own code — `COMMON_DATA env variable not defined`, thrown at module load
 * because a gitignored `.env` never reached the worktree. That string is this repository's
 * prose, not the runner's, so it is not classifier material.
 *
 * The signal that IS an invariant is the one the enumerate guard already relies on: `playwright
 * test --list` exits 0 when at least one requested spec enumerates and non-zero when none does.
 * Running that over specs the repo ALREADY had — before the tester writes anything — is a
 * measurement the tester cannot have caused, which is exactly what licenses acting on it at
 * pass 0.
 *
 * A structural hint decides whether to probe at all, never whether the step is blocked. A
 * repo shipping `.env.sample` with no `.env` is common and usually fine, so parking on the hint
 * alone would falsely stop healthy tasks; and a repo with no sample file pays nothing, which
 * keeps the common path byte-identical to what it was.
 */

/** Suffixes that mark a file as the TEMPLATE for a `.env` the project expects someone to
 *  create. Checked against `<root>/.env<suffix>`; the absent file is always `<root>/.env`. */
const ENV_SAMPLE_SUFFIXES = ['.sample', '.example', '.dist', '.template'] as const;

/** Directories the spec search never descends into — installed dependencies and build output
 *  carry other projects' specs, and `playwright --list` on one of those proves nothing about
 *  this repo. Mirrors 08b's own ROOT_SEARCH_SKIP. */
const SPEC_SEARCH_SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '.git']);

/** How deep the spec search walks below the framework root. */
const SPEC_SEARCH_MAX_DEPTH = 6;

const SPEC_FILE_RE = /\.(spec|test)\.[cm]?[jt]sx?$/;

/** An env file the project's own template says should exist, and does not. */
export interface MissingEnvFile {
  /** Workspace-relative path of the absent file. */
  expected: string;
  /** Workspace-relative path of the template that says it is expected. */
  sample: string;
}

/** The verdict when the runner could load none of the repo's existing tests. */
export interface TestPreflightBlock {
  /** The enumerate command that was run, as shown to the user. */
  command: string;
  /** Its output, tail-sliced by the caller's runner. */
  output: string;
  /** Env files a template says are missing. Wording only — never the decision. */
  missing: MissingEnvFile[];
}

/**
 * Env files the repo's own templates say are expected but that are absent, for each framework
 * root given (workspace-relative, `''` for the workspace root).
 *
 * Structural: presence of one file and absence of another. Nothing here reads a file's
 * CONTENT or matches a message, so a project rewording its error changes nothing.
 */
export async function findMissingEnvFiles(
  workspace: string,
  roots: readonly string[],
): Promise<MissingEnvFile[]> {
  const found: MissingEnvFile[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const envRel = path.posix.join(root, '.env');
    if (seen.has(envRel)) continue;
    seen.add(envRel);
    if (await pathExists(path.join(workspace, root, '.env'))) continue;
    for (const suffix of ENV_SAMPLE_SUFFIXES) {
      const sampleRel = path.posix.join(root, `.env${suffix}`);
      if (await pathExists(path.join(workspace, root, `.env${suffix}`))) {
        found.push({ expected: envRel, sample: sampleRel });
        break;
      }
    }
  }
  return found;
}

/**
 * Whether the repo ALREADY has at least one spec file under `root`.
 *
 * Existence, not a list: the probe enumerates the whole project, so no file list is passed
 * to the runner and a sampled one would be actively wrong — a subset can consist entirely of
 * specs that fail to load while a spec outside it is fine, which would park a repo whose
 * suite actually runs.
 *
 * This guard is still needed because `--list` exits non-zero both for a suite that cannot
 * load and for a project with no tests at all, and only the first is a block.
 */
export async function hasExistingSpecFile(workspace: string, root: string): Promise<boolean> {
  const walk = async (rel: string, depth: number): Promise<boolean> => {
    if (depth > SPEC_SEARCH_MAX_DEPTH) return false;
    const entries = await readdir(path.join(workspace, rel), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (SPEC_SEARCH_SKIP.has(entry.name)) continue;
      const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
      if (entry.isFile() && SPEC_FILE_RE.test(entry.name)) return true;
      if (entry.isDirectory() && (await walk(childRel, depth + 1))) return true;
    }
    return false;
  };
  return walk(root, 0);
}

/**
 * The gate 08b parks on when the pre-flight probe found the runner can load nothing.
 *
 * `submitAction: 'retry'` rather than a choice form: a retry schema is never auto-passed
 * (step-runner's auto-submit is gated on `submitAction === 'submit'`), so this pauses even
 * under auto-continue — which is the state the task that prompted it was in. The user fixes
 * the precondition on the host and Retry re-runs detect, which clears the gate on its own.
 * Skipping instead is the other half, and comes from 08b's `allowSkip` rather than from here.
 */
export function preflightGateSchema(block: TestPreflightBlock): FormSchema {
  const missing = block.missing
    .map((m) => `- \`${m.expected}\` is missing (\`${m.sample}\` says it is expected)`)
    .join('\n');
  return {
    title: 'Tests cannot run in this workspace',
    description: [
      "The test runner could not load any of this project's existing tests, so writing more",
      'would produce tests that are never executed. No agent can repair this from inside the',
      'sandbox.',
      ...(missing ? ['', '**Missing environment files**', missing] : []),
      '',
      'Create the file in the repository, then re-run this step. A worktree is checked out',
      'with tracked files only, so anything gitignored is carried from the repository root —',
      'if the file is absent there too, it has to be created before any run can use it.',
      '',
      '**Enumerate command**',
      '',
      '```',
      block.command,
      block.output.trim(),
      '```',
      '',
      'Skip this step instead to continue without test management.',
    ].join('\n'),
    fields: [],
    submitAction: 'retry',
    submitLabel: 'Re-check and run tests',
  };
}
