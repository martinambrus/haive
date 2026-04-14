import type {
  CliCommandSpec,
  SubAgentInvocation,
  SubAgentInvocationStep,
} from '../cli-adapters/types.js';
import type { CliExecutionResult, CliSpawner, SpawnOptions } from './runner.js';

export interface SubAgentStepTrace {
  id: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  parsed: unknown;
  error?: string;
}

export interface SubAgentRunResult {
  collected: Record<string, unknown>;
  synthesis: unknown;
  trace: SubAgentStepTrace[];
  exitCode: number;
}

export type PromptToCliSpec = (prompt: string) => CliCommandSpec;

export async function runSequentialSubAgent(
  invocation: SubAgentInvocation,
  buildCli: PromptToCliSpec,
  spawner: CliSpawner,
  opts: SpawnOptions = {},
): Promise<SubAgentRunResult> {
  if (invocation.mode !== 'sequential') {
    throw new Error('runSequentialSubAgent called with non-sequential invocation');
  }

  const collected: Record<string, unknown> = {};
  const trace: SubAgentStepTrace[] = [];

  for (const step of invocation.steps) {
    const traceEntry = await runOneStep(step, buildCli, spawner, opts);
    trace.push(traceEntry);
    if (traceEntry.exitCode !== 0 || traceEntry.error) {
      return {
        collected,
        synthesis: null,
        trace,
        exitCode: traceEntry.exitCode ?? 1,
      };
    }
    if (step.collectInto) {
      collected[step.collectInto] = traceEntry.parsed;
    }
  }

  const synthesisPrompt = appendCollectedContext(invocation.synthesis.prompt, collected);
  const synthesisTrace = await runOneStep(
    { ...invocation.synthesis, prompt: synthesisPrompt },
    buildCli,
    spawner,
    opts,
  );
  trace.push(synthesisTrace);

  return {
    collected,
    synthesis: synthesisTrace.parsed,
    trace,
    exitCode: synthesisTrace.exitCode ?? 1,
  };
}

async function runOneStep(
  step: SubAgentInvocationStep,
  buildCli: PromptToCliSpec,
  spawner: CliSpawner,
  opts: SpawnOptions,
): Promise<SubAgentStepTrace> {
  const spec = buildCli(step.prompt);
  const result: CliExecutionResult = await spawner(spec, opts);
  const parsed = safeParse(step.expectJsonOutput, result.stdout);
  return {
    id: step.id,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    parsed,
    ...(result.error ? { error: result.error } : {}),
  };
}

function safeParse(expectJson: boolean, raw: string): unknown {
  if (!expectJson) return raw;
  const fenced = extractFromJsonFence(raw);
  if (fenced !== null) return fenced;
  try {
    return JSON.parse(raw.trim());
  } catch {
    return { __rawOutput: raw };
  }
}

function extractFromJsonFence(raw: string): unknown | null {
  const customFenceMatch = raw.match(/<<<JSON>>>([\s\S]*?)<<<ENDJSON>>>/);
  if (customFenceMatch) {
    try {
      return JSON.parse(customFenceMatch[1]!.trim());
    } catch {
      return { __rawFence: customFenceMatch[1] };
    }
  }
  const codeFenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeFenceMatch) {
    try {
      return JSON.parse(codeFenceMatch[1]!.trim());
    } catch {
      return { __rawFence: codeFenceMatch[1] };
    }
  }
  return null;
}

function appendCollectedContext(basePrompt: string, collected: Record<string, unknown>): string {
  const serialized = Object.entries(collected)
    .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
    .join('\n');
  if (!serialized) return basePrompt;
  return [basePrompt, '', 'Collected sub-agent outputs:', serialized].join('\n');
}
