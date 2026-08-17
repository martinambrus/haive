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
  if (adapter.supportsSubagents) {
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
    case 'zai':
    case 'antigravity':
    case 'ollama':
    case 'muse':
    case 'openrouter':
      return buildCodexSequentialInvocation(spec);
    // grok has native subagents (supportsSubagents=true), so the splitter always
    // takes the native path for it and this arm is unreachable — kept for the
    // exhaustive switch, same as antigravity below.
    case 'grok':
    case 'claude-code':
      return buildCodexSequentialInvocation(spec);
  }
}
