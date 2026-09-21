/**
 * "Would the sandbox mask this ONE path?", answered without scanning the tree.
 *
 * `computeSecretMasks` answers the same question for a whole tree with tinyglobby, which needs
 * a filesystem. A caller holding a single repository-relative path — the persona reader, which
 * must not paste a file the agent is forbidden to read — cannot use that: globbing a tree to
 * judge one path would read directories it has no business reading, and a path whose file was
 * deleted after dispatch produces no scan match at all, which is not evidence it is allowed.
 *
 * Deliberately free of DB, config and `resolvers.js` imports. The dispatcher needs this verdict
 * and cannot import cli-exec's resolvers, which reach the dispatcher back through
 * `task-queue.ts` -> `step-engine/index.ts` -> `step-runner.ts`.
 *
 * The glob engine is picomatch under `dot: true` — the same engine and the same option tinyglobby
 * uses internally — because the two verdicts must agree. They are pinned against each other in
 * `secret-mask-policy.test.ts` over a fixture tree; node:path's own `matchesGlob` was MEASURED
 * disagreeing on 5 of 26 real paths (`**` refuses to descend into a dotted directory and `*` will
 * not match a dotted basename), three of them in the unsafe direction.
 */
import picomatch from 'picomatch';
import { computeEffectiveSecretGlobs, type SecretMaskGlobs } from '@haive/shared';

export interface SecretMaskPolicy {
  globs: SecretMaskGlobs;
  /**
   * Tracked paths for the tree `rel` is relative to, or `null` when git could not answer.
   *
   * Tier 1 masks UNTRACKED files only, so a tracked path is not masked. `null` means treat
   * everything as untracked — mask more, never less — which is exactly what `filterUntracked`
   * does when a directory is not a git work tree. Omitted entirely means the same thing.
   *
   * For a path inside a linked worktree the caller passes that worktree's own set and a
   * worktree-relative `rel`: `git ls-files` reports paths relative to the tree it runs in, so
   * the repo root's listing never contains `.haive/worktrees/<name>/x`.
   */
  tracked?: Set<string> | null;
}

/** Build the policy for a repository's masking settings. Mirrors `resolveSecretMasks`'s inputs
 *  minus everything that needs IO, so a caller that already knows the repo row can construct it
 *  without a second query. */
export function secretMaskPolicy(opts: {
  allow?: string[] | null;
  denyExtend?: string[] | null;
  tracked?: Set<string> | null;
}): SecretMaskPolicy {
  return {
    globs: computeEffectiveSecretGlobs({ allow: opts.allow, denyExtend: opts.denyExtend }),
    tracked: opts.tracked ?? null,
  };
}

/**
 * True when the sandbox would hide `rel` from the agent, so a reader must treat it as missing.
 *
 * `rel` is repository-relative with forward slashes, exactly as `computeSecretMasks` reports its
 * matches and as the deny globs are written. A leading `./` or a backslash path will not match
 * the globs and is normalised rather than silently answering `false`.
 */
export function secretMaskDeniesPath(policy: SecretMaskPolicy, rel: string): boolean {
  const normalised = normaliseRel(rel);
  if (!normalised) return false;

  // Tracked (committed) files are out of scope for masking, so they are readable.
  if (policy.tracked?.has(normalised)) return false;

  const denied = picomatch(policy.globs.deny, { dot: true });
  if (!denied(normalised)) return false;
  const ignored = picomatch(policy.globs.ignore, { dot: true });
  return !ignored(normalised);
}

function normaliseRel(rel: string): string | null {
  const slashed = rel.replaceAll('\\', '/');
  const trimmed = slashed.startsWith('./') ? slashed.slice(2) : slashed;
  if (!trimmed || trimmed.startsWith('/')) return null;
  return trimmed;
}
