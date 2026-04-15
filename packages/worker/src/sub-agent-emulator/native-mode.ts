import type { SubAgentInvocation } from '../cli-adapters/types.js';

export function assembleNativePrompt(invocation: SubAgentInvocation): string {
  const agentLines = invocation.steps
    .map((step, idx) => `${idx + 1}. ${step.id}: ${step.prompt}`)
    .join('\n\n');
  return [
    'Spawn the following sub-agents in parallel. Each runs in its own isolated context and returns a structured result:',
    '',
    agentLines,
    '',
    'After every sub-agent completes, perform the synthesis step using their collected outputs:',
    '',
    invocation.synthesis.prompt,
  ].join('\n');
}
