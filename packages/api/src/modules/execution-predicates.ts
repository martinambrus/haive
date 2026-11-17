import {
  moduleExecutionPredicates,
  type ExecutionPredicateDeclaration,
  type ModuleExecutionPredicates,
  type ModuleManifest,
} from '@haive/shared/modularity';

let predicates: ReadonlyMap<string, ExecutionPredicateDeclaration> = new Map();

/** Replace the boot registry only after all module declarations pass validation. */
export function registerModuleExecutionPredicates(
  entries: readonly { executionPredicates?: ModuleExecutionPredicates }[],
  loaded: readonly { manifest: ModuleManifest }[],
): void {
  const next = new Map<string, ExecutionPredicateDeclaration>();
  entries.forEach((entry, index) => {
    for (const [id, declaration] of moduleExecutionPredicates(
      loaded[index]!.manifest.id,
      entry.executionPredicates,
    ))
      next.set(id, declaration);
  });
  predicates = next;
}

/** Trusted code only; module lifecycle policy is checked by admission's existing locks. */
export const executionPredicates = (): ReadonlyMap<string, ExecutionPredicateDeclaration> =>
  predicates;
