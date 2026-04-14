import type { StepCapability } from '@haive/shared';
import type { BaseCliAdapter } from '../cli-adapters/base-adapter.js';
import { CliAdapterRegistry, cliAdapterRegistry } from '../cli-adapters/registry.js';
import type {
  ApiCallSpec,
  CliCommandSpec,
  CliProviderRecord,
  InvokeOpts,
  SubAgentInvocation,
  SubAgentSpec,
} from '../cli-adapters/types.js';
import { splitSubAgentForProvider } from '../sub-agent-emulator/splitter.js';

export type DispatchMode = 'cli' | 'api' | 'subagent_emulated' | 'skip';

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

export interface DispatchInvocationApi {
  kind: 'api';
  spec: ApiCallSpec;
}

export interface DispatchInvocationSubAgent {
  kind: 'subagent';
  spec: SubAgentInvocation;
}

export type DispatchInvocation =
  | DispatchInvocationCli
  | DispatchInvocationApi
  | DispatchInvocationSubAgent;

export interface DispatchPlan {
  mode: DispatchMode;
  providerId: string | null;
  providerName: string | null;
  adapter: BaseCliAdapter | null;
  provider: CliProviderRecord | null;
  invocation: DispatchInvocation | null;
  reason: string;
}

export interface DispatchRequest {
  providers: CliProviderRecord[];
  preferredProviderId?: string | null;
  input: DispatchInput;
  invokeOpts: InvokeOpts;
  registry?: CliAdapterRegistry;
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
  const authMode = provider.authMode;
  const subscriptionFirst = authMode === 'subscription' || authMode === 'mixed';
  const apiFirst = authMode === 'api_key' || authMode === 'mixed';

  if (subscriptionFirst && adapter.supportsCliAuth) {
    const plan = buildCliSidePlan(adapter, provider, req, needsSubagents);
    if (plan) return plan;
  }

  if (apiFirst && adapter.supportsApi && adapter.buildApiInvocation) {
    if (req.input.kind === 'prompt') {
      if (needsSubagents && !adapter.supportsSubagents) {
        // API path cannot emulate sub-agents in one call; fall through
      } else {
        const spec = adapter.buildApiInvocation(provider, req.input.prompt, req.invokeOpts);
        return {
          mode: 'api',
          providerId: provider.id,
          providerName: provider.name,
          adapter,
          provider,
          invocation: { kind: 'api', spec },
          reason: 'api_byok',
        };
      }
    }
  }

  if (subscriptionFirst && adapter.supportsCliAuth) {
    return null;
  }

  if (adapter.supportsCliAuth) {
    return buildCliSidePlan(adapter, provider, req, needsSubagents);
  }

  return null;
}

function buildCliSidePlan(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  req: DispatchRequest,
  needsSubagents: boolean,
): DispatchPlan | null {
  if (req.input.kind === 'prompt') {
    if (needsSubagents && !adapter.supportsSubagents) {
      return null;
    }
    const spec = adapter.buildCliInvocation(provider, req.input.prompt, req.invokeOpts);
    return {
      mode: 'cli',
      providerId: provider.id,
      providerName: provider.name,
      adapter,
      provider,
      invocation: { kind: 'cli', spec },
      reason: 'cli_subscription',
    };
  }

  const split = splitSubAgentForProvider(adapter, provider, req.input.spec, req.invokeOpts);
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
