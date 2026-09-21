/**
 * The async half of per-call agent isolation: the kill switch, the project-instruction scan, and
 * the persona reader.
 *
 * `agentIsolationApplies` (dispatcher.ts) is the pure rule and stays there. Everything here needs
 * IO, so it runs once per dispatch AFTER the provider is chosen — the instruction file to scan and
 * the agents directory to read are both properties of the selected provider — and its results are
 * fed back into one second `resolveDispatch` pass.
 *
 * Nothing here decides isolation on its own. The instruction scan answers "do the repository's own
 * instructions send the agent at an agent definition", and the reader answers "which persona bodies
 * can be pasted"; the rule combines them.
 */
import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { readFileNoFollow, readTextNoFollow } from '@haive/shared/fs-safe';
import { CONFIG_KEYS, configService, logger, promptNamesAgentPath } from '@haive/shared';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import { parseAgentFile } from '../step-engine/steps/workflow/_agent-loader.js';
import {
  secretMaskDeniesPath,
  secretMaskPolicy,
  type SecretMaskPolicy,
} from '../queues/cli-exec/secret-mask-policy.js';
import { listTrackedFiles } from '../queues/cli-exec/secret-mask.js';

/** Total bytes of persona body one prompt may carry. A guard rail above the largest definition
 *  measured (24,694 bytes), not a target: a prompt that would exceed it keeps its inline protocol
 *  rather than a truncated persona, because a cut definition reads as a complete one. */
export const MAX_PERSONA_BODY_BYTES = 64 * 1024;

/** Caps on the instruction chain. A chain past either leaves the invocation UNISOLATED, so a
 *  truncated scan can never hide a referenced file. */
const MAX_INSTRUCTION_IMPORTS = 5;
const MAX_INSTRUCTION_BYTES = 1024 * 1024;

/** `@`-imports, as the claude family and gemini expand them: a reference at a line start or after
 *  whitespace. Resolved relative to the file that makes it. */
const IMPORT_REFERENCE_RE = /(?:^|\s)@([A-Za-z0-9_./-]+)/g;

/** The global kill switch. A failed read means OFF — today's behaviour — for the same reason
 *  `resolveCodexAppServerVerdicts` fails toward `codex exec`: a config fault must not silently
 *  enable a context control nobody asked for. */
export async function resolveAgentIsolationEnabled(): Promise<boolean> {
  try {
    return await configService.getBoolean(CONFIG_KEYS.AGENT_ISOLATION_ENABLED, true);
  } catch {
    return false;
  }
}

/**
 * Do the repository's own instruction files name an agent directory, or a file inside one?
 *
 * The prompt is not all a CLI reads: it loads the repository's instruction file itself, after it
 * starts, and that file can send the agent to a definition the mask would hide. MEASURED across the
 * dev install's repositories, one `AGENTS.md` carries a legacy workflow's "FIRST: Read your full
 * agent definition from .claude/agents/{agent-name}.md".
 *
 * TRUE also means "could not be scanned": an unreadable entry point, a chain past the caps, or a
 * reference that leaves the tree. Both outcomes end isolation, which is the direction a context
 * control fails in — a truncated scan must never hide a referenced file.
 *
 * `native` readers do not expand `@` references, so theirs are not followed. Files are only
 * scanned, never pasted, so this returns a verdict and no bytes.
 */
export async function instructionsNameAgentPath(args: {
  workerTree: string;
  rulesFile: string;
  rulesFileMode: 'import' | 'native';
}): Promise<boolean> {
  const seen = new Set<string>();
  const queue: string[] = [normaliseRel(args.rulesFile)];
  let budget = MAX_INSTRUCTION_BYTES;
  let opened = 0;

  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (rel === '' || seen.has(rel)) continue;
    seen.add(rel);
    if (opened > MAX_INSTRUCTION_IMPORTS) return true;
    opened += 1;

    let text: string | null;
    try {
      text = await readTextNoFollow(args.workerTree, rel, { maxBytes: budget + 1 });
    } catch {
      // A refusal is indistinguishable from a file that names something, so it ends isolation.
      return true;
    }
    // An ABSENT file names nothing. Only the entry point is commonly absent (a repository with no
    // instruction file at all), and that is the normal case, not a fault.
    if (text === null) continue;
    if (text.length > budget) return true;
    budget -= text.length;

    if (promptNamesAgentPath(text, SANDBOX_WORKDIR)) return true;
    if (args.rulesFileMode !== 'import') continue;

    for (const match of text.matchAll(IMPORT_REFERENCE_RE)) {
      const target = resolveImport(rel, match[1]!);
      if (target !== null) queue.push(target);
    }
  }
  return false;
}

/** An `@` reference resolved against the file that makes it, or null when it leaves the tree.
 *  Absolute references are refused rather than reinterpreted: a `/etc/...` reference is not a
 *  repository path, and following one would read outside the invocation's tree. */
function resolveImport(fromRel: string, reference: string): string | null {
  if (reference.startsWith('/')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromRel), reference));
  if (joined.startsWith('..') || joined.startsWith('/')) return null;
  return normaliseRel(joined);
}

function normaliseRel(rel: string): string {
  let out = rel.replaceAll('\\', '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out === '.' ? '' : out;
}

export interface PersonaBodiesResult {
  /** Body text by marker id, for every id whose file could be pasted. */
  bodies: Record<string, string>;
  /** Ids whose file exists but did not fit the remaining budget, with the size it claimed. The
   *  caller reports these; they fall back to their inline protocol. */
  oversized: { id: string; rel: string; size: number }[];
}

/**
 * Read one persona body per marker id, from the SELECTED provider's own agents directory.
 *
 * By FILENAME (`<projectAgentsDir>/<id>.md`) — the exact file today's pointer names — and never by
 * the frontmatter `name` that `loadAgentPersonas` keys on: the two can differ, and a lookup by name
 * would silently drop the customisation that outranks the inline persona. One file per id, no
 * directory scan, and nothing outside the tree: `readFileNoFollow` follows the ANCHOR but no
 * component of the rel, verifies the descriptor it opened, and never opens a FIFO or device.
 *
 * Treated as MISSING (the id keeps its inline protocol): an absent or refused file, one the
 * invocation's secret-mask policy would hide, one `parseAgentFile` cannot parse, and one whose body
 * is empty after the frontmatter — pasting an empty persona is the same silent failure as pasting
 * none. Ids are read in marker order and share one budget.
 */
export async function readPersonaBodies(args: {
  workerTree: string;
  projectAgentsDir: string;
  ids: readonly string[];
  policy: SecretMaskPolicy;
  /** Resolves the tracked set for the tree, called at most once and only when the deny globs
   *  actually match a path — a committed file is out of scope for masking, so the git call is only
   *  needed to rescue a path the globs already denied. */
  loadTracked: () => Promise<Set<string> | null>;
}): Promise<PersonaBodiesResult> {
  const bodies: Record<string, string> = {};
  const oversized: PersonaBodiesResult['oversized'] = [];
  let remaining = MAX_PERSONA_BODY_BYTES;
  let tracked: Set<string> | null | undefined;

  for (const id of args.ids) {
    if (remaining <= 0) break;
    const rel = `${args.projectAgentsDir}/${id}.md`;

    // Two steps so the git call is paid for only when it can change the answer. With no tracked set
    // the predicate treats everything as untracked and masks more, so a "not denied" verdict here is
    // final and needs no git at all — which is the overwhelmingly common case, since no default deny
    // glob matches a `.md` under an agents directory.
    if (secretMaskDeniesPath(args.policy, rel)) {
      if (tracked === undefined) tracked = await args.loadTracked();
      if (secretMaskDeniesPath({ ...args.policy, tracked }, rel)) continue;
    }

    let read: { data: Buffer; size: number; truncated: boolean } | null;
    try {
      // One byte more than the budget, so a file that claims to fit and then reads longer is
      // caught rather than silently truncated.
      read = await readFileNoFollow(args.workerTree, rel, { maxBytes: remaining + 1 });
    } catch {
      continue;
    }
    if (read === null) continue;
    if (read.size > remaining || read.data.length > remaining) {
      oversized.push({ id, rel, size: read.size });
      continue;
    }

    const parsed = parseAgentFile(read.data.toString('utf8'));
    if (!parsed) continue;
    const body = parsed.body.trim();
    if (!body) continue;

    bodies[id] = body;
    remaining -= read.size;
  }

  return { bodies, oversized };
}

/** The invocation's effective secret-mask policy, for the reader above. Mirrors
 *  `resolveSecretMasks`'s inputs minus the scan: the global switch, the repository's own toggle and
 *  globs. A repository with masking OFF denies nothing, so every persona file is readable. */
export function personaSecretMaskPolicy(args: {
  maskingEnabled: boolean;
  repoMaskEnabled: boolean;
  allow?: string[] | null;
  denyExtend?: string[] | null;
}): SecretMaskPolicy {
  if (!args.maskingEnabled || !args.repoMaskEnabled) {
    return { globs: { deny: [], ignore: [] }, tracked: null };
  }
  return secretMaskPolicy({ allow: args.allow, denyExtend: args.denyExtend });
}

/**
 * The persona reader's mask policy for one task, resolved from config and the repository row.
 *
 * Fails CLOSED, unlike the rest of isolation: when the policy cannot be evaluated nothing is
 * pasted, matching masking's own rule. That is the one place isolation is not fail-open, because
 * the cost is opposite — a body pasted under an unknown policy hands the provider bytes the mask
 * exists to withhold, and a prompt cannot be un-sent.
 */
export async function resolvePersonaMaskPolicy(
  db: Database,
  taskId: string,
  workerTree: string,
): Promise<{ policy: SecretMaskPolicy; loadTracked: () => Promise<Set<string> | null> } | null> {
  let maskingEnabled: boolean;
  try {
    maskingEnabled = await configService.getBoolean(CONFIG_KEYS.SECRET_MASK_ENABLED, true);
  } catch {
    return null;
  }

  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  if (!task) return null;
  // No repository: nothing is mounted, so there is no policy to evaluate and nothing to hide.
  if (!task.repositoryId) {
    return {
      policy: { globs: { deny: [], ignore: [] }, tracked: null },
      loadTracked: async () => null,
    };
  }

  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { secretMaskEnabled: true, secretMaskAllow: true, secretMaskDenyExtend: true },
  });
  if (!repo) return null;

  return {
    policy: personaSecretMaskPolicy({
      maskingEnabled,
      repoMaskEnabled: repo.secretMaskEnabled,
      allow: repo.secretMaskAllow,
      denyExtend: repo.secretMaskDenyExtend,
    }),
    loadTracked: () => listTrackedFiles(workerTree),
  };
}

/** A persona file that exists and does not fit the prompt's remaining budget. Its id falls back to
 *  the inline protocol, and this says so on the Activity tab: silently dropping a definition the
 *  repository carries would look like the customisation was ignored. */
export const AGENT_PERSONA_OVERSIZED_EVENT = 'agent_persona.oversized';

/** Recorded with a direct insert rather than `appendEvent`, which lives in `task-queue.ts` — a
 *  module the dispatcher cannot import (`task-queue` -> `step-engine/index` -> `step-runner` ->
 *  dispatcher). Best-effort: telemetry must never fail the dispatch that produced it. */
export async function recordOversizedPersonas(
  db: Database,
  taskId: string,
  oversized: PersonaBodiesResult['oversized'],
): Promise<void> {
  if (oversized.length === 0) return;
  try {
    await db.insert(schema.taskEvents).values(
      oversized.map((o) => ({
        taskId,
        eventType: AGENT_PERSONA_OVERSIZED_EVENT,
        payload: { agentId: o.id, path: o.rel, size: o.size, budget: MAX_PERSONA_BODY_BYTES },
      })),
    );
  } catch (err) {
    logger.warn({ err, taskId }, 'could not record oversized persona event');
  }
}

export { listTrackedFiles };
