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
import { hasReadyLspBridge } from '../lsp/configured-lsp.js';

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
  registry?: CliAdapterRegistry;
}

/** Task-aware production entry point. Tests and pure selection callers may use
 *  resolveDispatch directly with an explicit lspConfigured value. */
export async function resolveTaskDispatch(
  db: Database,
  taskId: string,
  req: DispatchRequest,
): Promise<DispatchPlan> {
  return resolveDispatch({
    ...req,
    lspConfigured: await hasReadyLspBridge(db, taskId),
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
  const adaptPrompt = (prompt: string): string =>
    adaptPromptForCliCapabilities(prompt, {
      supportsLsp: adapter.supportsLsp && req.lspConfigured === true,
      projectAgentsDir: providerMetadata.projectAgentsDir,
      agentFileFormat: providerMetadata.agentFileFormat,
    });

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
      ...req.invokeOpts,
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
  const split = splitSubAgentForProvider(adapter, provider, subAgentSpec, req.invokeOpts);
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
