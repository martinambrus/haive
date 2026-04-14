import type {
  SubAgentInvocation,
  SubAgentInvocationStep,
  SubAgentSpec,
} from '../cli-adapters/types.js';

export function buildAmpSequentialInvocation(spec: SubAgentSpec): SubAgentInvocation {
  const steps: SubAgentInvocationStep[] = spec.subAgents.map((sub) => ({
    id: sub.name,
    prompt: wrapAmpPrompt(sub.name, sub.prompt),
    expectJsonOutput: true,
    collectInto: sub.outputKey,
  }));
  return {
    mode: 'sequential',
    steps,
    synthesis: {
      id: 'synthesis',
      prompt: wrapAmpSynthesis(spec.synthesisPrompt),
      expectJsonOutput: false,
    },
  };
}

function wrapAmpPrompt(name: string, body: string): string {
  return [
    `Sub-agent: ${name}`,
    '',
    body,
    '',
    'Respond with a single JSON object. Wrap it in a fenced block tagged json.',
  ].join('\n');
}

function wrapAmpSynthesis(body: string): string {
  return [
    'Synthesis step. Read the collected outputs and produce the final answer.',
    '',
    body,
  ].join('\n');
}
