import { isCoreStepId } from './contracts.js';
import type { ExecutionPredicateDeclaration } from './execution-contract.js';

/** Default export of a module's ./execution-predicates: local ids and schemas only.
 * Share each schema object with ./steps; never import the step graph here. */
export type ModuleExecutionPredicates = readonly (ExecutionPredicateDeclaration & {
  readonly id: string;
})[];

/** Boot validation, shared by both hosts. Stored catalog JSON is never a schema source. */
export function moduleExecutionPredicates(
  moduleId: string,
  declarations: ModuleExecutionPredicates | undefined,
): ReadonlyMap<string, ExecutionPredicateDeclaration> {
  const predicates = new Map<string, ExecutionPredicateDeclaration>();
  if (declarations === undefined) return predicates;
  if (!Array.isArray(declarations))
    throw new Error(`Module ${moduleId} execution-predicates must export an array`);
  for (const declaration of declarations) {
    if (
      !declaration ||
      typeof declaration !== 'object' ||
      Array.isArray(declaration) ||
      Object.keys(declaration).some((key) => key !== 'id' && key !== 'argsSchema') ||
      typeof declaration.argsSchema?.safeParse !== 'function'
    )
      throw new Error(`Module ${moduleId} execution-predicates must be schema-only declarations`);
    if (typeof declaration.id !== 'string' || !isCoreStepId(declaration.id))
      throw new Error(`Module ${moduleId} invalid local predicate id ${String(declaration.id)}`);
    const id = `module.${moduleId}.${declaration.id}`;
    if (predicates.has(id)) throw new Error(`Module ${moduleId} duplicate predicate ${id}`);
    predicates.set(id, { argsSchema: declaration.argsSchema });
  }
  return predicates;
}
