import type {
  SubAgentInvocation,
  SubAgentInvocationStep,
  SubAgentSpec,
} from '../cli-adapters/types.js';

const JSON_FENCE_OPEN = '<<<JSON>>>';
const JSON_FENCE_CLOSE = '<<<ENDJSON>>>';

export function buildCodexSequentialInvocation(spec: SubAgentSpec): SubAgentInvocation {
  const steps: SubAgentInvocationStep[] = spec.subAgents.map((sub, idx) => ({
    id: sub.name,
    prompt: wrapCodexPrompt({
      index: idx + 1,
      total: spec.subAgents.length,
      name: sub.name,
      body: sub.prompt,
    }),
    expectJsonOutput: true,
    collectInto: sub.outputKey,
  }));
  return {
    mode: 'sequential',
    steps,
    synthesis: {
      id: 'synthesis',
      prompt: wrapCodexSynthesis(
        spec.synthesisPrompt,
        spec.subAgents.map((s) => s.outputKey),
      ),
      expectJsonOutput: false,
    },
  };
}

function wrapCodexPrompt(params: {
  index: number;
  total: number;
  name: string;
  body: string;
}): string {
  return [
    `You are sub-agent ${params.index}/${params.total} named "${params.name}".`,
    '',
    'Task:',
    params.body,
    '',
    `Return ONE JSON object between ${JSON_FENCE_OPEN} and ${JSON_FENCE_CLOSE}.`,
    'Emit no prose outside the fences.',
  ].join('\n');
}

function wrapCodexSynthesis(body: string, keys: string[]): string {
  return [
    'Synthesize the sub-agent results.',
    '',
    'Available outputs: ' + keys.join(', '),
    '',
    'Instructions:',
    body,
  ].join('\n');
}
