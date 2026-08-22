import type { Database } from '@haive/database';
import { getCliProviderMetadata, type StepCapability } from '@haive/shared';
import type { BaseCliAdapter } from '../cli-adapters/base-adapter.js';
import { CliAdapterRegistry, cliAdapterRegistry } from '../cli-adapters/registry.js';
import type {
  CliCommandSpec,
  CliProviderRecord,
  InvokeOpts,
  SubAgentInvocation,
  SubAgentSpec,
} from '../cli-adapters/types.js';
import { splitSubAgentForProvider } from '../sub-agent-emulator/splitter.js';
import { adaptPromptForCliCapabilities } from '../step-engine/steps/_retrieval-guidance.js';
import {
  resolveGlobalKbDigest,
  withGlobalKbDigest,
  type GlobalKbDigestEntry,
} from '../step-engine/steps/_global-kb-digest.js';
import { hasReadyLspBridge } from '../lsp/configured-lsp.js';
import {
  resolveInvocationUsesWorktreeGitBoundary,
  withWorktreeGitBoundary,
} from '../repo/worktree-git-boundary.js';
import { withDdevGeneratedBoundary } from '../repo/ddev-generated-boundary.js';
import { resolveMcpSurface, withMcpSurface, type McpSurface } from '../sandbox/mcp-surface.js';
import { resolveAppReach, withAppReach, type AppReach } from '../queues/cli-exec/app-reach.js';
import {
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
  /** The step's declared MCP narrowing, passed straight to resolveMcpSurface so the
   *  advertised surface matches the one cli-exec will wire for the same invocation. */
  toolProfile?: 'rag_only';
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
  registry?: CliAdapterRegistry;
}

/** Task-aware production entry point. Tests and pure selection callers may use
 *  resolveDispatch directly with an explicit lspConfigured value. */
export async function resolveTaskDispatch(
  db: Database,
  taskId: string,
  req: DispatchRequest,
): Promise<DispatchPlan> {
  const [lspConfigured, worktreeGitBoundary, mcpSurface, globalKbDigest, appReach] =
    await Promise.all([
      hasReadyLspBridge(db, taskId),
      resolveInvocationUsesWorktreeGitBoundary(db, taskId, req.worktreeRel),
      resolveMcpSurface(db, taskId, req.toolProfile === 'rag_only'),
      resolveGlobalKbDigest(db, taskId),
      resolveAppReach(db, taskId),
    ]);
  return resolveDispatch({
    ...req,
    lspConfigured,
    // Production callers cannot accidentally claim a boundary the mount will
    // not apply (or omit one it will): the DB-backed target wins any input.
    worktreeGitBoundary,
    mcpSurface,
    globalKbDigest,
    appReach,
  });
}

export function resolveDispatch(req: DispatchRequest): DispatchPlan {
  const registry = req.registry ?? cliAdapterRegistry;
  const enabled = req.providers.filter((p) => p.enabled);

  if (enabled.length === 0) {
    return skipPlan('no enabled cli providers');
  }

  const ordered = orderProviders(enabled, req.preferredProviderId ?? null);
  const needsSubagents = req.input.capabilities.includes('subagents');

  for (const provider of ordered) {
    if (!registry.has(provider.name)) continue;
    const adapter = registry.get(provider.name);

    const plan = tryBuildPlan(adapter, provider, req, needsSubagents);
    if (plan) return plan;
  }

  return skipPlan('no provider matched required capabilities');
}

function orderProviders(
  providers: CliProviderRecord[],
  preferredId: string | null,
): CliProviderRecord[] {
  if (!preferredId) return providers;
  const preferred = providers.find((p) => p.id === preferredId);
  if (!preferred) return providers;
  return [preferred, ...providers.filter((p) => p.id !== preferredId)];
}

function tryBuildPlan(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  req: DispatchRequest,
  needsSubagents: boolean,
): DispatchPlan | null {
  if (!adapter.supportsCliAuth) return null;
  return buildCliSidePlan(adapter, provider, req, needsSubagents);
}

function buildCliSidePlan(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  req: DispatchRequest,
  needsSubagents: boolean,
): DispatchPlan | null {
  const providerMetadata = getCliProviderMetadata(provider.name);
  const adaptPrompt = (prompt: string): string => {
    const capabilityAdapted = adaptPromptForCliCapabilities(prompt, {
      supportsLsp: adapter.supportsLsp && req.lspConfigured === true,
      projectAgentsDir: providerMetadata.projectAgentsDir,
      agentFileFormat: providerMetadata.agentFileFormat,
    });
    // Both boundaries ride the same predicate: an invocation isolated to a worktree is
    // exactly the one that gets the read-only `.git` and `#ddev-generated` masks, so a
    // prompt can never claim a boundary the mount does not enforce (or omit one it does).
    const gitBounded = withWorktreeGitBoundary(capabilityAdapted, req.worktreeGitBoundary === true);
    const ddevBounded = withDdevGeneratedBoundary(gitBounded, req.worktreeGitBoundary === true);
    // What the agent CAN reach, stated rather than left to be inferred — the same
    // surface object cli-exec materializes into the sandbox's MCP config. Suppressed
    // for an adapter that gets no MCP config at all (amp), since there would be
    // nothing behind the claim.
    const mcpBounded = withMcpSurface(
      ddevBounded,
      adapter.supportsMcp ? (req.mcpSurface ?? null) : null,
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
    const ragWired = adapter.supportsMcp && req.mcpSurface?.rag.enabled === true;
    const digested = ragWired
      ? withGlobalKbDigest(reachBounded, req.globalKbDigest ?? [])
      : reachBounded;
    // Learned model limitations. Applied here, after the provider is resolved, so it
    // reaches the prompt, every sub-agent prompt and the synthesis prompt alike — and
    // pairs with the tool deny merged into invokeOpts below.
    return withModelCapabilityBoundary(digested, provider);
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
    // Steering applies only to this single watched cli step (kind 'prompt') AND
    // only when the resolved adapter supports it. Subagent/agent_mining paths
    // never set steeringRequested.
    const steeringMode = (req.steeringRequested ?? false) && adapter.supportsSteering;
    const effectivePrompt = adaptPrompt(req.input.prompt);
    const spec = adapter.buildCliInvocation(provider, effectivePrompt, {
      ...invokeOpts,
      steeringMode,
    });
    return {
      mode: 'cli',
      providerId: provider.id,
      providerName: provider.name,
      adapter,
      provider,
      invocation: { kind: 'cli', spec },
      effectivePrompt,
      reason: 'cli',
    };
  }

  const subAgentSpec = {
    ...req.input.spec,
    subAgents: req.input.spec.subAgents.map((subAgent) => ({
      ...subAgent,
      prompt: adaptPrompt(subAgent.prompt),
    })),
    synthesisPrompt: adaptPrompt(req.input.spec.synthesisPrompt),
  };
  const split = splitSubAgentForProvider(adapter, provider, subAgentSpec, invokeOpts);
  return {
    mode: split.mode === 'native' ? 'cli' : 'subagent_emulated',
    providerId: provider.id,
    providerName: provider.name,
    adapter,
    provider,
    invocation: { kind: 'subagent', spec: split.invocation },
    reason: split.reason,
  };
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
