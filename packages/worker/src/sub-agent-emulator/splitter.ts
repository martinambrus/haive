import type { BaseCliAdapter } from '../cli-adapters/base-adapter.js';
import type {
  CliProviderName,
  CliProviderRecord,
  InvokeOpts,
  SubAgentInvocation,
  SubAgentSpec,
} from '../cli-adapters/types.js';
import { buildAmpSequentialInvocation } from './amp-mode.js';
import { buildNativeSubAgentInvocation } from './claude-mode.js';
import { buildCodexSequentialInvocation } from './codex-mode.js';

export type SubAgentDispatchMode = 'native' | 'sequential';

export interface SplitResult {
  mode: SubAgentDispatchMode;
  invocation: SubAgentInvocation;
  providerName: CliProviderName;
  reason: string;
}

export function splitSubAgentForProvider(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  spec: SubAgentSpec,
  opts: InvokeOpts,
): SplitResult {
  if (adapter.supportsSubagents && adapter.buildSubAgentInvocation) {
    const invocation = buildNativeSubAgentInvocation(adapter, provider, spec, opts);
    return {
      mode: 'native',
      invocation,
      providerName: provider.name,
      reason: 'native_subagents',
    };
  }

  const invocation = buildSequentialForProvider(provider.name, spec);
  return {
    mode: 'sequential',
    invocation,
    providerName: provider.name,
    reason: 'sequential_emulation',
  };
}

function buildSequentialForProvider(name: CliProviderName, spec: SubAgentSpec): SubAgentInvocation {
  switch (name) {
    case 'amp':
      return buildAmpSequentialInvocation(spec);
    case 'codex':
    case 'gemini':
    case 'grok':
    case 'qwen':
    case 'kiro':
    case 'zai':
      return buildCodexSequentialInvocation(spec);
    case 'claude-code':
      return buildCodexSequentialInvocation(spec);
  }
}
