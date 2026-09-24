import type { Database } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  getCliProviderMetadata,
  promptNamesAgentPath,
  resolveEffectiveRules,
  type StepCapability,
} from '@haive/shared';
import type { BaseCliAdapter } from '../cli-adapters/base-adapter.js';
import { ensureCodexAppServerVerdict } from '../cli-adapters/codex-app-server-probe.js';
import {
  currentCodexAppServerVerdict,
  loadCodexAppServerVerdicts,
  type CodexAppServerVerdicts,
} from '../cli-adapters/codex-app-server-verdict.js';
import { CliAdapterRegistry, cliAdapterRegistry } from '../cli-adapters/registry.js';
import { PromptTooLargeError } from '../cli-adapters/prompt-delivery.js';
import type {
  AgentRulesStamp,
  CliCommandSpec,
  CliProviderRecord,
  EffortDecision,
  InvokeOpts,
  SubAgentInvocation,
  SubAgentSpec,
} from '../cli-adapters/types.js';
import { splitSubAgentForProvider } from '../sub-agent-emulator/splitter.js';
import {
  adaptPromptForCliCapabilities,
  agentGuidanceIds,
  stripAgentGuidanceBlocks,
} from '../step-engine/steps/_retrieval-guidance.js';
import {
  resolveGlobalKbDigest,
  withGlobalKbDigest,
  type GlobalKbDigestEntry,
} from '../step-engine/steps/_global-kb-digest.js';
import { hasReadyLspBridge } from '../lsp/configured-lsp.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import { resolveInvocationWorkerTree } from '../repo/worktree-git-boundary.js';
import {
  instructionsNameAgentPath,
  readPersonaBodies,
  recordOversizedPersonas,
  resolveAgentIsolationEnabled,
  resolvePersonaMaskPolicy,
} from './agent-isolation.js';
import {
  agentRulesHash,
  resolveAgentRulesInjectionEnabled,
  withAgentRules,
} from './agent-rules.js';
import {
  resolveInvocationUsesWorktreeGitBoundary,
  withWorktreeGitBoundary,
  taskHasRepository,
} from '../repo/worktree-git-boundary.js';
import { withDdevGeneratedBoundary } from '../repo/ddev-generated-boundary.js';
import {
  emptyMcpSurface,
  resolveMcpSurface,
  withMcpSurface,
  type McpSurface,
} from '../sandbox/mcp-surface.js';
import { resolveAppReach, withAppReach, type AppReach } from '../queues/cli-exec/app-reach.js';
import {
  resolveModelLimits,
  visionDisallowedTools,
  withModelCapabilityBoundary,
} from '../cli-adapters/model-capabilities.js';

export type DispatchMode = 'cli' | 'subagent_emulated' | 'skip';

export type DispatchInput =
  | {
      kind: 'prompt';
      prompt: string;
      capabilities: StepCapability[];
    }
  | {
      kind: 'subagent';
      spec: SubAgentSpec;
      capabilities: StepCapability[];
    };

export interface DispatchInvocationCli {
  kind: 'cli';
  spec: CliCommandSpec;
}

export interface DispatchInvocationSubAgent {
  kind: 'subagent';
  spec: SubAgentInvocation;
}

export type DispatchInvocation = DispatchInvocationCli | DispatchInvocationSubAgent;

export interface DispatchPlan {
  mode: DispatchMode;
  providerId: string | null;
  providerName: string | null;
  adapter: BaseCliAdapter | null;
  provider: CliProviderRecord | null;
  invocation: DispatchInvocation | null;
  /** The prompt after adapting shared capability-sensitive guidance to the
   *  provider that was actually selected. Present for kind:'prompt' plans. */
  effectivePrompt?: string;
  /** The effort level that will actually reach the CLI, decided HERE — the one place that
   *  holds the adapter, the provider and the resolved invokeOpts at once. Same doctrine as
   *  model_identity: decide it where the evidence is, and let every insert site record the
   *  decision rather than re-derive it. Null on a 'skip' plan, which runs nothing. */
  effort?: EffortDecision | null;
  reason: string;
}

export interface DispatchRequest {
  providers: CliProviderRecord[];
  preferredProviderId?: string | null;
  input: DispatchInput;
  invokeOpts: InvokeOpts;
  /** When true, a steering-capable adapter builds an interactive stream-json
   *  invocation (mid-run steering). Set ONLY by the single watched cli step's
   *  dispatch when global + per-repo steering are enabled; never by
   *  agent_mining / subagent dispatches. ANDed with adapter.supportsSteering and
   *  applied only to a kind:'prompt' invocation. */
  steeringRequested?: boolean;
  /** Persona ids the caller assigns beyond what the prompt's markers say: a mining dispatch
   *  whose agent IS a persona (03's roster) names it here, since its prompt carries no marker.
   *  Unioned with `agentGuidanceIds(prompt)` onto the spec's `assignedAgentIds`. */
  assignedAgentIds?: string[];
  /** Whether this task has at least one configured language server with a
   *  bridge implemented by Haive. Fail-closed when omitted so a provider's
   *  coarse capability alone never advertises tools that are not configured. */
  lspConfigured?: boolean;
  /** Invocation-specific worktree override. Must match the worktreeRel later
   *  placed on CliExecJobPayload so prompt and mount use the same boundary. */
  worktreeRel?: string;
  /** Computed by resolveTaskDispatch from the actual invocation target. Exposed
   *  on the pure resolver only for deterministic unit tests. */
  worktreeGitBoundary?: boolean;
  /** Whether the task has a REPOSITORY. Computed by resolveTaskDispatch; exposed on the pure
   *  resolver only for deterministic unit tests. False makes the MCP surface block say there is
   *  no checkout instead of advising grep over one — the same rule as every other boundary
   *  here: a prompt must not assert a surface the sandbox does not have. */
  hasRepo?: boolean;
  /** The step's declared MCP narrowing, passed straight to resolveMcpSurface so the
   *  advertised surface matches the one cli-exec will wire for the same invocation. */
  toolProfile?: 'rag_only' | 'none';
  /** Computed by resolveTaskDispatch. Exposed on the pure resolver only for
   *  deterministic unit tests; null means "advertise nothing". */
  mcpSurface?: McpSurface | null;
  /** Whether the sandbox can issue HTTP requests at the task's running app, and at what
   *  address. Computed by resolveTaskDispatch; exposed on the pure resolver only for
   *  deterministic unit tests. Null means say nothing about the app. */
  appReach?: AppReach | null;
  /** Stack-matching global KB titles to advertise. Computed by
   *  resolveTaskDispatch; exposed on the pure resolver only for deterministic
   *  unit tests. Empty means there is nothing to advertise. */
  globalKbDigest?: GlobalKbDigestEntry[];
  /** Order providers with a learned `vision: false` LAST, without excluding any.
   *  The soft counterpart to the `vision` capability, for an input that has both
   *  a visual and a textual form (a PDF beside its extracted text): seeing it is
   *  better, and not seeing it still works, so refusing a blind provider outright
   *  would be wrong. */
  preferVision?: boolean;
  /** The task's codex app-server verdicts, or null when the admin switch is off — the per-task
   *  half of codex's steering capability (steeringTransportReady). Computed by
   *  resolveTaskDispatch, which also takes the verdict on a provider's first steerable dispatch;
   *  exposed on the pure resolver only for deterministic unit tests. Absent means none recorded,
   *  which builds `codex exec`. */
  codexAppServer?: CodexAppServerVerdicts | null;
  /** The step's opt-out from per-call agent isolation (`LlmInvocationSpec.agentPool`), passed by
   *  `resolveLlmPhase`. `'*'` means this dispatch needs the whole agent pool visible. */
  agentPool?: '*';
  /** The global agent-isolation switch, resolved by `resolveTaskDispatch`; exposed on the pure
   *  resolver only for deterministic unit tests, like `codexAppServer`. Absent or false means
   *  today's behaviour for every newly dispatched invocation. */
  agentIsolation?: boolean;
  /** Whether the SELECTED provider's repository instruction chain names an agent directory, or
   *  could not be scanned — either way isolation ends. Resolved by `resolveTaskDispatch` after the
   *  provider is known (the file to read is `adapter.rulesFile`) and fed back into one second
   *  `resolveDispatch` pass; exposed on the pure resolver only for tests. */
  instructionsNameAgentPath?: boolean;
  /** Persona bodies read at dispatch from the selected provider's agents directory, keyed by marker
   *  id. Resolved alongside the verdict above and carried on the same second pass. Scanned VERBATIM
   *  by `agentIsolationApplies`: a body that names an agent path ends isolation, because a replacer's
   *  return value is never rescanned and a marker block inside a body reaches the model as written. */
  agentBodies?: Record<string, string>;
  /** The global switch for putting the provider's effective agent rules at the top of the prompt,
   *  resolved by `resolveTaskDispatch`; exposed on the pure resolver only for tests, like
   *  `agentIsolation`. Absent or false means no block. */
  agentRulesInjection?: boolean;
  /** Set by a dispatch the rules have no business in: the step recap, `01-env-detect` and the model
   *  health canary, whose prompts carry their whole task and whose replies are parsed as they are. */
  skipAgentRules?: boolean;
  registry?: CliAdapterRegistry;
}

/**
 * Is this invocation agent-ISOLATED? Pure, so the rule is one readable predicate and testable
 * without a database.
 *
 * All seven must hold. Each is a case where hiding the agent directories would take away something
 * the invocation needs, rather than a preference:
 *
 * - the kill switch is on;
 * - it is a `kind: 'prompt'` dispatch — the sub-agent kinds rebuild each sub-step's spec worker-side
 *   from `{cwd, extraEnv, effortLevel}` and no step builds one, so they behave exactly as today;
 * - it declares no `file_write` — a tmpfs mask is writable, so an invocation that edits the project's
 *   tree would lose an edit to `.claude/agents/x.md` when the container exits;
 * - it declares no `subagents` — a dispatch that may spawn native sub-agents keeps the catalog it
 *   spawns from;
 * - neither the prompt (with Haive's own marker blocks stripped) nor any persona body it carries nor
 *   the repository's instruction chain names an agent directory or a file inside one;
 * - the step did not declare `agentPool: '*'`;
 * - nothing the dispatcher adds after this decision names one either: the MCP surface's user server
 *   keys, the global-KB digest's titles, and `injectedRules`, the provider's rules block. The rules
 *   are passed only once the provider is known, so the async pre-check runs without them and can
 *   only be more permissive than the final pass.
 */
export function agentIsolationApplies(req: DispatchRequest, injectedRules?: string): boolean {
  if (req.agentIsolation !== true) return false;
  if (req.input.kind !== 'prompt') return false;
  if (req.agentPool === '*') return false;
  if (req.input.capabilities.includes('file_write')) return false;
  if (req.input.capabilities.includes('subagents')) return false;
  // A scan that matched OR could not be completed. Both end isolation.
  if (req.instructionsNameAgentPath === true) return false;
  // Haive's own marker pointers name `.claude/agents/<id>.md` by construction, so they are removed
  // before the scan; a user-forged marker-shaped block is removed with them and never reaches the
  // model. Bodies are scanned as they are, because they DO reach it unrewritten. A re-fed prompt's
  // stored rules block goes too: `adaptPrompt` drops it, and the current rules are scanned below.
  if (
    promptNamesAgentPath(
      stripAgentGuidanceBlocks(withAgentRules(req.input.prompt, null).prompt),
      SANDBOX_WORKDIR,
    )
  )
    return false;
  for (const body of Object.values(req.agentBodies ?? {})) {
    if (promptNamesAgentPath(body, SANDBOX_WORKDIR)) return false;
  }
  // EXTERNAL text the dispatcher appends AFTER this decision, which the prompt argument cannot answer
  // for. `adaptPrompt` splices in the MCP surface and the global-KB digest once this has returned, and
  // both carry strings Haive did not write: a repository's own `mcpServers` keys, taken verbatim from
  // its `.claude/mcp_settings.json` by `loadUserMcpServers`, and author-written KB titles. So a
  // repository could name a server `.claude/agents/foo`, or an author title an entry that way, and reach
  // an isolated invocation's final prompt with a path whose directory the mask then hides.
  //
  // Scanned here rather than after the appends because the decision has to be ONE boolean for the
  // prompt and the mounts alike; `resolveTaskDispatch` resolves both fields before `resolveDispatch`,
  // so they are already on the request and this stays pure and IO-free.
  //
  // ALL user server keys, not only the ones this run would render. `reachableUserServerNames` is what
  // knows the difference, and it needs the emitted-server set, which depends on render options a pure
  // rule does not have — duplicating its shadowing logic would put a second copy of that rule in the
  // tree. Shadowing is also run-time state: a name shadowed today renders tomorrow, so isolation keyed
  // on it would flicker between runs of one repository. The superset costs a dispatch its context
  // saving; the alternative is a scan that disagrees with what renders.
  const externalText = [
    ...Object.keys(req.mcpSurface?.userServers ?? {}),
    ...(req.globalKbDigest ?? []).flatMap((entry) => [entry.title, entry.category]),
    ...(injectedRules ? [injectedRules] : []),
  ].join('\n');
  if (externalText.length > 0 && promptNamesAgentPath(externalText, SANDBOX_WORKDIR)) return false;
  return true;
}

/** Task-aware production entry point. Tests and pure selection callers may use
 *  resolveDispatch directly with an explicit lspConfigured value. */
export async function resolveTaskDispatch(
  db: Database,
  taskId: string,
  req: DispatchRequest,
): Promise<DispatchPlan> {
  const [
    lspConfigured,
    worktreeGitBoundary,
    mcpSurface,
    globalKbDigest,
    appReach,
    codexAppServer,
    hasRepo,
    agentIsolation,
    agentRulesInjection,
  ] = await Promise.all([
    hasReadyLspBridge(db, taskId),
    resolveInvocationUsesWorktreeGitBoundary(db, taskId, req.worktreeRel),
    req.toolProfile === 'none'
      ? emptyMcpSurface()
      : resolveMcpSurface(db, taskId, req.toolProfile === 'rag_only'),
    resolveGlobalKbDigest(db, taskId),
    resolveAppReach(db, taskId),
    resolveCodexAppServerVerdicts(db, taskId),
    taskHasRepository(db, taskId),
    resolveAgentIsolationEnabled(),
    resolveAgentRulesInjectionEnabled(),
  ]);
  const resolved: DispatchRequest = {
    ...req,
    lspConfigured,
    // Production callers cannot accidentally claim a boundary the mount will
    // not apply (or omit one it will): the DB-backed target wins any input.
    worktreeGitBoundary,
    mcpSurface,
    globalKbDigest,
    appReach,
    codexAppServer,
    hasRepo,
    agentIsolation,
    agentRulesInjection,
  };
  const plan = resolveDispatch(resolved);
  // A provider's first steerable codex dispatch in a task is where its app-server transport is
  // checked — for onboarding and workflow tasks that is the model-health canary. The plan is
  // resolved first so the provider ordering decides WHICH provider is probed, instead of a second
  // copy of that ordering here. A probe that reaches no verdict leaves this dispatch on
  // `codex exec`, and the next steerable dispatch tries again.
  const { provider, adapter } = plan;
  if (provider === null || adapter === null) return plan;

  const verdict =
    codexAppServer !== null &&
    req.steeringRequested === true &&
    req.input.kind === 'prompt' &&
    provider.name === 'codex' &&
    currentCodexAppServerVerdict(codexAppServer, provider) === null
      ? await ensureCodexAppServerVerdict(db, taskId, provider, adapter)
      : null;

  // Per-call agent isolation resolves against the SELECTED provider: the instruction file to scan
  // is `adapter.rulesFile` and the agents directory to read is that provider's own. Gathered here
  // and fed back into ONE second pass, together with any codex verdict — early-returning on each
  // would skip the others the moment a task needs both.
  const isolation = await resolveAgentIsolation(db, taskId, resolved, provider, adapter);

  if (verdict === null && isolation === null) return plan;
  return resolveDispatch({
    ...resolved,
    ...(verdict ? { codexAppServer: { ...codexAppServer!, [provider.id]: verdict } } : {}),
    ...(isolation ?? {}),
  });
}

/** The instruction verdict and the persona bodies, or null when nothing new was learned.
 *
 *  Runs only when the pure rule already holds on everything that does not need IO, so a dispatch
 *  that is not a candidate — a coder, a sub-agent split, a step declaring `agentPool: '*'`, or a
 *  prompt that already names an agent path — costs no query and no read. The instruction scan comes
 *  FIRST because a match ends isolation and leaves no body worth reading. */
async function resolveAgentIsolation(
  db: Database,
  taskId: string,
  resolved: DispatchRequest,
  provider: CliProviderRecord,
  adapter: BaseCliAdapter,
): Promise<Pick<DispatchRequest, 'instructionsNameAgentPath' | 'agentBodies'> | null> {
  if (!agentIsolationApplies(resolved)) return null;

  const workerTree = await resolveInvocationWorkerTree(db, taskId, resolved.worktreeRel);
  // No repository tree: nothing is mounted, so no agent directory can be read or masked, and the
  // instructions that would name one do not exist either.
  if (workerTree === null) return { instructionsNameAgentPath: false };

  const namesAgentPath = await instructionsNameAgentPath({
    workerTree,
    rulesFile: adapter.rulesFile,
    rulesFileMode: adapter.rulesFileMode === 'import' ? 'import' : 'native',
  });
  if (namesAgentPath) return { instructionsNameAgentPath: true };

  // The same four-condition gate today's pointer survives (Decision 1): outside it the prompt is
  // unchanged, so there is no body to read and nothing to paste.
  const metadata = getCliProviderMetadata(provider.name);
  const ids = resolved.input.kind === 'prompt' ? agentGuidanceIds(resolved.input.prompt) : [];
  if (
    ids.length === 0 ||
    !metadata.projectAgentsDir ||
    metadata.agentFileFormat !== 'markdown' ||
    !adapter.supportsLsp ||
    resolved.lspConfigured !== true
  ) {
    return { instructionsNameAgentPath: false };
  }

  // Fails CLOSED, unlike the rest of isolation: a policy that cannot be evaluated pastes nothing,
  // because a body already in a prompt cannot be retracted.
  const mask = await resolvePersonaMaskPolicy(db, taskId, workerTree);
  if (mask === null) return { instructionsNameAgentPath: false };

  const { bodies, oversized } = await readPersonaBodies({
    workerTree,
    projectAgentsDir: metadata.projectAgentsDir,
    ids,
    policy: mask.policy,
    loadTracked: mask.loadTracked,
  });
  await recordOversizedPersonas(db, taskId, oversized);
  return { instructionsNameAgentPath: false, agentBodies: bodies };
}

/** The task's codex app-server verdicts, or null when the admin switch is off or unreadable. Null
 *  keeps every codex run on `codex exec`, which is also what a config fault must do. */
async function resolveCodexAppServerVerdicts(
  db: Database,
  taskId: string,
): Promise<CodexAppServerVerdicts | null> {
  let enabled: boolean;
  try {
    enabled = await configService.getBoolean(CONFIG_KEYS.CODEX_APP_SERVER_ENABLED, true);
  } catch {
    enabled = false;
  }
  return enabled ? loadCodexAppServerVerdicts(db, taskId) : null;
}

export function resolveDispatch(req: DispatchRequest): DispatchPlan {
  const registry = req.registry ?? cliAdapterRegistry;
  const enabled = req.providers.filter((p) => p.enabled);

  if (enabled.length === 0) {
    return skipPlan('no enabled cli providers');
  }

  const ordered = orderProviders(
    enabled,
    req.preferredProviderId ?? null,
    req.preferVision === true,
  );
  const needsSubagents = req.input.capabilities.includes('subagents');
  const needsVision = req.input.capabilities.includes('vision');

  for (const provider of ordered) {
    if (!registry.has(provider.name)) continue;
    const adapter = registry.get(provider.name);

    const plan = tryBuildPlan(adapter, provider, req, needsSubagents, needsVision);
    if (plan) return plan;
  }

  // Name the capability that went unmet. The runner turns this straight into the
  // step's failure message, and "no provider matched required capabilities" tells
  // the reader nothing about what to change.
  return skipPlan(
    needsVision
      ? 'this task has attachments that can only be read by LOOKING at them (an image, or a document no text could be extracted from) and no enabled CLI provider can see images — configure a vision-capable model, or remove those files'
      : 'no provider matched required capabilities',
  );
}

/** Known-blind: a provider whose CURRENT model has already rejected image input.
 *  `resolveModelLimits` returns null once the model is changed, so switching to a
 *  vision model clears the verdict with no separate invalidation step. */
function isKnownBlind(provider: CliProviderRecord): boolean {
  return resolveModelLimits(provider)?.vision === false;
}

function orderProviders(
  providers: CliProviderRecord[],
  preferredId: string | null,
  preferVision: boolean,
): CliProviderRecord[] {
  const preferredFirst =
    preferredId && providers.some((p) => p.id === preferredId)
      ? [
          providers.find((p) => p.id === preferredId)!,
          ...providers.filter((p) => p.id !== preferredId),
        ]
      : providers;
  if (!preferVision) return preferredFirst;
  // A stable partition, so the explicit preference still wins WITHIN each half:
  // the user's chosen provider stays first unless it is the blind one, in which
  // case a sighted provider gets the work and the choice is honoured as far as it
  // can be.
  return [
    ...preferredFirst.filter((p) => !isKnownBlind(p)),
    ...preferredFirst.filter(isKnownBlind),
  ];
}

function tryBuildPlan(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  req: DispatchRequest,
  needsSubagents: boolean,
  needsVision: boolean,
): DispatchPlan | null {
  if (!adapter.supportsCliAuth) return null;
  // A hard exclusion, not a warning. The remedy for a blind model
  // (NO_VISION_BOUNDARY_PROMPT) tells the agent not to open images at all, so
  // handing it work that DEPENDS on one produces a confident answer that ignored
  // the input — the one failure mode declaring this capability exists to stop.
  if (needsVision && isKnownBlind(provider)) return null;
  return buildCliSidePlan(adapter, provider, req, needsSubagents);
}

function buildCliSidePlan(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  req: DispatchRequest,
  needsSubagents: boolean,
): DispatchPlan | null {
  const providerMetadata = getCliProviderMetadata(provider.name);
  // Invariant across every invocation this plan builds, and read by TWO consumers below:
  // the retrieval protocol's rag arm and the global KB digest. One const so they cannot
  // disagree — a prompt that says "discover with rag_search" while the digest is withheld
  // describes a surface neither half is looking at.
  const ragWired = adapter.supportsMcp && req.mcpSurface?.rag.enabled === true;
  const rules = agentRulesFor(req, provider);
  // One decision for this plan, so the prompt and the mounts cannot disagree: the same boolean
  // chooses whether a persona body replaces the pointer and whether exec masks the directories.
  const isolated = agentIsolationApplies(req, rules.text ?? undefined);
  const adaptPrompt = (prompt: string, rulesText: string | null = rules.text): string => {
    // A stored prompt dispatched again opens with its old rules block; every adapter below prepends,
    // so one that newly applies would bury that block where the replacement at the end cannot see it.
    const capabilityAdapted = adaptPromptForCliCapabilities(withAgentRules(prompt, null).prompt, {
      supportsLsp: adapter.supportsLsp && req.lspConfigured === true,
      ragWired,
      projectAgentsDir: providerMetadata.projectAgentsDir,
      agentFileFormat: providerMetadata.agentFileFormat,
      isolated,
      agentBodies: req.agentBodies,
    });
    // Both boundaries ride the same predicate: an invocation isolated to a worktree is
    // exactly the one that gets the read-only `.git` and `#ddev-generated` masks, so a
    // prompt can never claim a boundary the mount does not enforce (or omit one it does).
    const gitBounded = withWorktreeGitBoundary(capabilityAdapted, req.worktreeGitBoundary === true);
    const ddevBounded = withDdevGeneratedBoundary(gitBounded, req.worktreeGitBoundary === true);
    // What the agent CAN reach, stated rather than left to be inferred — the same
    // surface object cli-exec materializes into the sandbox's MCP config. `null` for an
    // adapter that gets no MCP config at all (amp), which now renders the absences
    // rather than nothing: a prompt body that names `rag_search` needs contradicting
    // most exactly where no surface was resolved.
    const mcpBounded = withMcpSurface(
      ddevBounded,
      adapter.supportsMcp ? (req.mcpSurface ?? null) : null,
      // ANDed with the adapter, like `supportsMcp` above and for the same reason: codex,
      // gemini, amp and antigravity ignore `disableTools` outright, so claiming "no search, no
      // file reading, no shell" to one of them tells an agent that still has all three — and
      // amp and antigravity keep their blanket permission flags besides — that it cannot touch
      // a worktree it can.
      {
        noBuiltInTools:
          req.invokeOpts?.disableTools === true && adapter.supportsDisableTools === true,
        noRepo: req.hasRepo === false,
        // Same predicate as the boundary above, so the prompt cannot claim a user's own `git`
        // server is shadowed by one the worktree gate stops us from wiring.
        hasWorktree: req.worktreeGitBoundary === true,
      },
    );
    // Whether the app can actually be reached, and how. Same reason as the boundaries above:
    // handing an agent a URL without saying what can dial it asserts a capability the sandbox
    // may not have, and a measured run showed agents burning their budget on curl and then
    // falling back to their provider's own web tool, which can never reach a private host.
    // Applied at this choke point so it reaches sub-agent and synthesis prompts too.
    const reachBounded = withAppReach(mcpBounded, req.appReach ?? null);
    // House standards from other projects, as titles. They live behind rag_search and
    // nowhere else — grep cannot reach them — so they are worth prompt tokens exactly
    // when that tool is actually wired for this invocation. Gated on the resolved
    // surface rather than on prompt wording, so a step that gets no rag server never
    // advertises a door it does not have. Applied at the same choke point as the
    // boundaries above, which is what puts it in front of a model like muse that
    // never picks the tool on its own.
    const digested = ragWired
      ? withGlobalKbDigest(reachBounded, req.globalKbDigest ?? [])
      : reachBounded;
    // Learned model limitations. Applied here, after the provider is resolved, so it
    // reaches the prompt, every sub-agent prompt and the synthesis prompt alike — and
    // pairs with the tool deny merged into invokeOpts below.
    const bounded = withModelCapabilityBoundary(digested, provider);
    // LAST, so the operator's own rules sit outermost and no rewrite above ever touches them.
    return withAgentRules(bounded, rulesText).prompt;
  };

  // A model that cannot read images must not be handed the screenshot tool: the prompt
  // boundary above asks, this enforces. Merged once, before both the prompt and the
  // sub-agent branches, so neither path can drift from the other.
  const visionDenied = visionDisallowedTools(provider);
  const invokeOpts: InvokeOpts =
    visionDenied.length === 0
      ? req.invokeOpts
      : {
          ...req.invokeOpts,
          disallowedTools: [...(req.invokeOpts.disallowedTools ?? []), ...visionDenied],
        };

  if (req.input.kind === 'prompt') {
    if (needsSubagents && !adapter.supportsSubagents) {
      return null;
    }
    // Steering applies only to a kind:'prompt' dispatch that asked for it, on an adapter that
    // supports it AND whose steering transport is ready for this provider in this task — for codex
    // that is its app-server, verified per task. Sub-agent paths never set steeringRequested.
    const steeringMode =
      (req.steeringRequested ?? false) &&
      adapter.supportsSteering &&
      adapter.steeringTransportReady(provider, { codexAppServer: req.codexAppServer ?? null });
    // Read off the ORIGINAL prompt: adaptPrompt rewrites every marker away, and the stored
    // prompt is the rewritten one.
    const assignedAgentIds = assignedPersonaIds(req, [req.input.prompt]);
    let effectivePrompt = adaptPrompt(req.input.prompt);
    let agentRules = rules.stamp;
    let spec: CliCommandSpec;
    try {
      spec = adapter.buildCliInvocation(provider, effectivePrompt, { ...invokeOpts, steeringMode });
    } catch (err) {
      // gemini takes its prompt only as an argument: the rules must never be what pushes a prompt
      // that fits past that limit, so the dispatch goes out without them and says so.
      if (!(err instanceof PromptTooLargeError) || !agentRules.injected) throw err;
      effectivePrompt = adaptPrompt(req.input.prompt, null);
      spec = adapter.buildCliInvocation(provider, effectivePrompt, { ...invokeOpts, steeringMode });
      agentRules = { ...agentRules, injected: false, reason: 'prompt-too-large' };
    }
    spec.agentRules = agentRules;
    if (assignedAgentIds.length > 0) spec.assignedAgentIds = assignedAgentIds;
    if (isolated) spec.maskAgentDefinitions = true;
    // Recorded from the bodies actually pasted, and NOT gated on isolation: exec rechecks whatever
    // paths are recorded, and a future path pastes template personas outside isolation too. Only
    // the ids the rewrite could paste are listed, so a marker that fell back to its inline protocol
    // contributes nothing to recheck.
    if (isolated && providerMetadata.projectAgentsDir && req.agentBodies) {
      // Every key here came from this prompt's own marker ids — the reader was handed
      // `agentGuidanceIds(prompt)` and returns only ids it could read — so the keys ARE the pasted
      // set and need no re-filtering.
      const dir = providerMetadata.projectAgentsDir;
      const pasted = Object.keys(req.agentBodies).map((id) => `${dir}/${id}.md`);
      if (pasted.length > 0) spec.pastedPersonaPaths = pasted;
    }
    return {
      mode: 'cli',
      providerId: provider.id,
      providerName: provider.name,
      adapter,
      provider,
      invocation: { kind: 'cli', spec },
      effectivePrompt,
      // Same invokeOpts the spec was built from, so the recorded level is the one the CLI got.
      effort: adapter.effortDecision(provider, { ...invokeOpts, steeringMode }),
      reason: 'cli',
    };
  }

  const subAgentSpec = {
    ...req.input.spec,
    // No step builds a sub-agent spec, so these carry no rules block rather than one per prompt.
    subAgents: req.input.spec.subAgents.map((subAgent) => ({
      ...subAgent,
      prompt: adaptPrompt(subAgent.prompt, null),
    })),
    synthesisPrompt: adaptPrompt(req.input.spec.synthesisPrompt, null),
  };
  const assignedAgentIds = assignedPersonaIds(req, [
    ...req.input.spec.subAgents.map((subAgent) => subAgent.prompt),
    req.input.spec.synthesisPrompt,
  ]);
  const split = splitSubAgentForProvider(adapter, provider, subAgentSpec, invokeOpts);
  const invocation =
    assignedAgentIds.length > 0 ? { ...split.invocation, assignedAgentIds } : split.invocation;
  return {
    mode: split.mode === 'native' ? 'cli' : 'subagent_emulated',
    providerId: provider.id,
    providerName: provider.name,
    adapter,
    provider,
    invocation: { kind: 'subagent', spec: invocation },
    effort: adapter.effortDecision(provider, invokeOpts),
    reason: split.reason,
  };
}

/** The provider's effective rules for this dispatch, or null when none go in, and the stamp that
 *  records which it was. The hash is recorded either way, so a run can be matched to the rules its
 *  provider had even when they were not injected. */
function agentRulesFor(
  req: DispatchRequest,
  provider: CliProviderRecord,
): { text: string | null; stamp: AgentRulesStamp } {
  const effective = resolveEffectiveRules(provider.rulesContent ?? '');
  const hash = agentRulesHash(effective);
  if (req.agentRulesInjection !== true) {
    return { text: null, stamp: { hash, injected: false, reason: 'disabled' } };
  }
  if (req.skipAgentRules === true) {
    return { text: null, stamp: { hash, injected: false, reason: 'opt-out' } };
  }
  return { text: effective, stamp: { hash, injected: true } };
}

/** The caller's explicit ids plus every marker id in the given prompts, unique and in code-unit
 *  order. The marker half must come from the prompts BEFORE `adaptPrompt`: the rewrite turns each
 *  marker into the pointer sentence or its fallback line, and the stored prompt is the rewritten
 *  one, so this is the only moment the assignment can be read. */
function assignedPersonaIds(req: DispatchRequest, prompts: string[]): string[] {
  const ids = new Set(req.assignedAgentIds ?? []);
  for (const prompt of prompts) {
    for (const id of agentGuidanceIds(prompt)) ids.add(id);
  }
  return [...ids].sort();
}

function skipPlan(reason: string): DispatchPlan {
  return {
    mode: 'skip',
    providerId: null,
    providerName: null,
    adapter: null,
    provider: null,
    invocation: null,
    reason,
  };
}
