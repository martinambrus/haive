import type { BaseCliAdapter } from '../cli-adapters/base-adapter.js';
import type {
  CliProviderRecord,
  InvokeOpts,
  SubAgentInvocation,
  SubAgentSpec,
} from '../cli-adapters/types.js';

export function buildNativeSubAgentInvocation(
  adapter: BaseCliAdapter,
  provider: CliProviderRecord,
  spec: SubAgentSpec,
  opts: InvokeOpts,
): SubAgentInvocation {
  if (!adapter.supportsSubagents) {
    throw new Error(`${adapter.providerName} does not support native sub-agents`);
  }
  return adapter.buildSubAgentInvocation(provider, spec, opts);
}
