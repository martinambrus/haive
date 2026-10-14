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
import { readFileNoFollow, type ReadResult } from '@haive/shared/fs-safe';
import {
  CLI_PROVIDER_LIST,
  CONFIG_KEYS,
  configService,
  logger,
  promptNamesAgentPath,
} from '@haive/shared';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import { workspaceAnchor } from '../repo/worktree-paths.js';
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
 * TRUE also means "could not be scanned": an unreadable entry point or a chain past the caps. Both
 * outcomes end isolation, which is the direction a context control fails in — a truncated scan must
 * never hide a referenced file.
 *
 * `native` readers do not expand `@` references, so theirs are not followed. Files are only
 * scanned, never pasted, so this returns a verdict and no bytes.
 */
export async function instructionsNameAgentPath(args: {
  workerTree: string;
  rulesFile: string;
  rulesFileMode: 'import' | 'native';
}): Promise<boolean> {
  const wa = workspaceAnchor(args.workerTree);
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

    let read: ReadResult | null;
    try {
      // `strict` is what makes the catch below reachable: without it a containment refusal, an
      // unreadable file or a non-regular one folds into `null`, which the absence branch then reads
      // as "names nothing" — so a symlinked rules file a CLI still follows would leave isolation ON
      // while the mask hid the definition it references. Absence stays `null` under strict
      // (fs-safe's `readResult` answers ABSENT before it consults the flag), so the common case of a
      // repository with no instruction file is unaffected.
      read = await readFileNoFollow(wa.anchor, `${wa.prefix}${rel}`, {
        maxBytes: budget + 1,
        strict: true,
      });
    } catch {
      // A refusal is indistinguishable from a file that names something, so it ends isolation.
      return true;
    }
    // An ABSENT file names nothing. Only the entry point is commonly absent (a repository with no
    // instruction file at all), and that is the normal case, not a fault.
    if (read === null) continue;
    // Counted in BYTES, which is what the reader caps and what `size` reports. `text.length` is
    // UTF-16 code units, so a multibyte file read at `budget + 1` bytes can measure under `budget`
    // and be accepted as complete while its unscanned tail names an agent path.
    if (read.truncated || read.size > budget) return true;
    const text = read.data.toString('utf8');
    budget -= read.size;

    if (promptNamesAgentPath(text, SANDBOX_WORKDIR)) return true;
    if (args.rulesFileMode !== 'import') continue;

    for (const match of text.matchAll(IMPORT_REFERENCE_RE)) {
      const target = resolveImport(rel, match[1]!);
      if (target === null) continue;
      // The import IS the reference, however it is spelled: `@docs/../.claude/agents/x.md`.
      if (promptNamesAgentPath(target, null)) return true;
      queue.push(target);
    }
  }
  return false;
}

/** An `@` reference resolved where the CLI resolves it, in the sandbox, against the directory of the
 *  file that makes it: the rel it lands on inside the mounted tree, or null when it lands outside,
 *  where nothing is the repository's to name. */
function resolveImport(fromRel: string, reference: string): string | null {
  const target = reference.startsWith('/')
    ? posix.normalize(reference)
    : posix.join(posix.dirname(posix.join(SANDBOX_WORKDIR, fromRel)), reference);
  if (!target.startsWith(`${SANDBOX_WORKDIR}/`)) return null;
  return normaliseRel(target.slice(SANDBOX_WORKDIR.length + 1));
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
  /** Bytes of the budget the pasted bodies spent. */
  used: number;
}

type PersonaFileOutcome =
  | { kind: 'ok'; body: string; size: number }
  | { kind: 'absent' | 'refused' | 'masked' | 'unparseable' | 'empty' }
  | { kind: 'oversized'; size: number };

/** One persona file under the rules both readers share: the mask policy first (so the git call is
 *  paid for only when it can change the answer), then a no-follow read capped at the remaining
 *  budget, then the frontmatter split. `strict` tells a refused path (a link, outside the tree, not
 *  a regular file) from an absent one; the lenient form folds both into `absent`. */
async function existsNoFollow(
  anchor: ReturnType<typeof workspaceAnchor>,
  rel: string,
): Promise<boolean> {
  try {
    return (
      (await readFileNoFollow(anchor.anchor, `${anchor.prefix}${rel}`, {
        maxBytes: 0,
        strict: true,
      })) !== null
    );
  } catch {
    return true;
  }
}

async function readPersonaFile(args: {
  anchor: ReturnType<typeof workspaceAnchor>;
  rel: string;
  policy: SecretMaskPolicy;
  tracked: () => Promise<Set<string> | null>;
  remaining: number;
  strict: boolean;
}): Promise<PersonaFileOutcome> {
  // With no tracked set the predicate treats everything as untracked and masks more, so a "not
  // denied" verdict here is final and needs no git at all — the overwhelmingly common case, since no
  // default deny glob matches a `.md` under an agents directory.
  if (secretMaskDeniesPath(args.policy, args.rel)) {
    // A strict reader tells "denied and present" from "denied and absent": only the first holds the
    // id. A path it cannot probe cleanly (a link in a component) counts as present.
    if (args.strict && !(await existsNoFollow(args.anchor, args.rel))) return { kind: 'absent' };
    if (secretMaskDeniesPath({ ...args.policy, tracked: await args.tracked() }, args.rel)) {
      return { kind: 'masked' };
    }
  }

  let read: ReadResult | null;
  try {
    // One byte more than the budget, so a file that claims to fit and then reads longer is caught
    // rather than silently truncated.
    read = await readFileNoFollow(args.anchor.anchor, `${args.anchor.prefix}${args.rel}`, {
      maxBytes: args.remaining + 1,
      strict: args.strict,
    });
  } catch {
    return { kind: 'refused' };
  }
  if (read === null) return { kind: 'absent' };
  if (read.size > args.remaining || read.data.length > args.remaining) {
    return { kind: 'oversized', size: read.size };
  }

  const parsed = parseAgentFile(read.data.toString('utf8'));
  if (!parsed) return { kind: 'unparseable' };
  const body = parsed.body.trim();
  if (!body) return { kind: 'empty' };
  return { kind: 'ok', body, size: read.size };
}

function memoTracked(
  loadTracked: () => Promise<Set<string> | null>,
): () => Promise<Set<string> | null> {
  let loaded: Promise<Set<string> | null> | undefined;
  return () => (loaded ??= loadTracked());
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
 * none. Ids are read in marker order and share one budget, `budget` bytes when the caller has
 * already spent part of `MAX_PERSONA_BODY_BYTES`.
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
  budget?: number;
}): Promise<PersonaBodiesResult> {
  const anchor = workspaceAnchor(args.workerTree);
  const tracked = memoTracked(args.loadTracked);
  const bodies: Record<string, string> = {};
  const oversized: PersonaBodiesResult['oversized'] = [];
  const start = args.budget ?? MAX_PERSONA_BODY_BYTES;
  let remaining = start;

  for (const id of args.ids) {
    if (remaining <= 0) break;
    const rel = `${args.projectAgentsDir}/${id}.md`;
    const outcome = await readPersonaFile({
      anchor,
      rel,
      policy: args.policy,
      tracked,
      remaining,
      strict: false,
    });
    if (outcome.kind === 'oversized') oversized.push({ id, rel, size: outcome.size });
    if (outcome.kind !== 'ok') continue;
    bodies[id] = outcome.body;
    remaining -= outcome.size;
  }

  return { bodies, oversized, used: start - remaining };
}

/** Every markdown agent directory, in catalog order: where a template's persona is looked for when
 *  the selected provider's own directory (if it has a markdown one) does not hold it. */
const MARKDOWN_AGENT_DIRS: readonly string[] = [
  ...new Set(
    CLI_PROVIDER_LIST.flatMap((p) =>
      p.agentFileFormat === 'markdown' && p.projectAgentsDir ? [p.projectAgentsDir] : [],
    ),
  ),
];

export type TemplatePersonasResult =
  | { ok: true; personas: Record<string, { body: string; rel: string }>; used: number }
  | { ok: false; failure: string };

/** The step's failure text for a template persona that cannot be pasted: names the id and why. */
export function templatePersonaFailure(id: string, reason: string): string {
  return `Prompt step persona "${id}" cannot be used: ${reason}.`;
}

/**
 * Read the persona behind every `{{agent:<id>}}` marker of a prompt step's template.
 *
 * Unlike a built-in marker, which falls back to its inline protocol, a template persona has no
 * fallback text: the admin chose it, so any file that cannot be pasted FAILS the step with the id
 * and the reason. Each id is looked up in the selected provider's markdown directory first (when it
 * has one), then in every markdown directory in catalog order, and the first that holds `<id>.md`
 * decides — a refused, masked, empty or over-budget file there is a failure, never a reason to try
 * the next directory. A path the mask policy denies counts as held only when a file exists there. Same reader, mask policy and budget as the built-in bodies.
 */
export async function readTemplatePersonas(args: {
  workerTree: string;
  /** The selected provider's agents directory when it holds markdown definitions, else null. */
  providerAgentsDir: string | null;
  ids: readonly string[];
  policy: SecretMaskPolicy;
  loadTracked: () => Promise<Set<string> | null>;
  budget?: number;
}): Promise<TemplatePersonasResult> {
  const anchor = workspaceAnchor(args.workerTree);
  const tracked = memoTracked(args.loadTracked);
  const dirs = [
    ...new Set([
      ...(args.providerAgentsDir ? [args.providerAgentsDir] : []),
      ...MARKDOWN_AGENT_DIRS,
    ]),
  ];
  const start = args.budget ?? MAX_PERSONA_BODY_BYTES;
  let remaining = start;
  const personas: Record<string, { body: string; rel: string }> = {};

  for (const id of args.ids) {
    let resolved = false;
    for (const dir of dirs) {
      const rel = `${dir}/${id}.md`;
      const outcome = await readPersonaFile({
        anchor,
        rel,
        policy: args.policy,
        tracked,
        remaining,
        strict: true,
      });
      if (outcome.kind === 'absent') continue;
      const fail = (reason: string): TemplatePersonasResult => ({
        ok: false,
        failure: templatePersonaFailure(id, reason),
      });
      switch (outcome.kind) {
        case 'refused':
          return fail(
            `${rel} is a link, lies outside the repository tree, or is not a regular file`,
          );
        case 'masked':
          return fail(`${rel} is hidden by the secret-mask policy`);
        case 'oversized':
          return fail(
            `${rel} is ${outcome.size} bytes and does not fit the ${remaining} bytes left of the ` +
              `${MAX_PERSONA_BODY_BYTES}-byte persona budget`,
          );
        case 'unparseable':
          return fail(`${rel} has no frontmatter that can be parsed`);
        case 'empty':
          return fail(`${rel} has an empty body`);
        case 'ok':
          personas[id] = { body: outcome.body, rel };
          remaining -= outcome.size;
          resolved = true;
      }
      break;
    }
    if (!resolved) {
      return {
        ok: false,
        failure: templatePersonaFailure(id, `no ${id}.md found in ${dirs.join(', ')}`),
      };
    }
  }

  return { ok: true, personas, used: start - remaining };
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
