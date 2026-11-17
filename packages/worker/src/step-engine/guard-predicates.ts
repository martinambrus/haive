import type { StepDefinition } from '@haive/shared/step';
import type { StepRegistry } from './registry.js';

type Predicate = NonNullable<StepDefinition['guardPredicates']>[string];

/** Every predicate a registered module step provides, keyed as the module loader keys it. */
export function registeredGuardPredicates(
  registry: Pick<StepRegistry, 'all'>,
): ReadonlyMap<string, Predicate> {
  const map = new Map<string, Predicate>();
  for (const def of registry.all()) {
    const type = def.metadata.workflowType as string;
    if (!type.startsWith('module.') || !def.guardPredicates) continue;
    for (const [name, predicate] of Object.entries(def.guardPredicates))
      map.set(`${type}.${name}`, predicate);
  }
  return map;
}
