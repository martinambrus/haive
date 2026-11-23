import type { StepDefinition } from './step-definition.js';

/** Fan-out repair cannot capture the LLM phase's before/after evidence. Use this
 * capability both when publishing the catalog and when resolving a pinned target. */
export function fixConsumerCapability(
  step: Pick<StepDefinition, 'fixConsumer' | 'agentMining'> | undefined,
): StepDefinition['fixConsumer'] {
  return step?.agentMining === undefined ? step?.fixConsumer : undefined;
}
