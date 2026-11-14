import { z } from 'zod';
import { parseStepId } from './contracts.js';

export const MAX_DERIVED_CHANGES = 64;
export const derivedStepIdSchema = z
  .string()
  .max(128)
  .refine((id) => parseStepId(id) !== null, 'invalid step id');
export const derivedChangeSchema = z.union([
  z.object({ replace: derivedStepIdSchema, with: derivedStepIdSchema }).strict(),
  z.object({ insertAfter: derivedStepIdSchema, step: derivedStepIdSchema }).strict(),
  z.object({ remove: derivedStepIdSchema }).strict(),
]);
export type DerivedChange = z.infer<typeof derivedChangeSchema>;

export function createDerivedChangesSchema(maxChanges = MAX_DERIVED_CHANGES) {
  return z.array(derivedChangeSchema).max(maxChanges);
}
export const derivedChangesSchema = createDerivedChangesSchema();
