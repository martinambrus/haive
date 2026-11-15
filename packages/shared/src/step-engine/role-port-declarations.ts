import { z } from 'zod';
import {
  STEP_ROLE_REGISTRY,
  parseRegistryOutputContractRef,
  type StepOutputContractRef,
  type StepRoleId,
} from './output-contracts.js';

const roleContract = z.strictObject({
  role: z.custom<StepRoleId>(
    (v) => typeof v === 'string' && Object.hasOwn(STEP_ROLE_REGISTRY, v),
    'unknown host role',
  ),
  contract: z.custom<StepOutputContractRef>(
    (v) => parseRegistryOutputContractRef(v) !== null,
    'unknown host data contract',
  ),
});
const exact = (v: z.infer<typeof roleContract>) => {
  const entry = STEP_ROLE_REGISTRY[v.role];
  return (
    entry && entry.contract.id === v.contract.id && entry.contract.version === v.contract.version
  );
};
const dataOnly = (v: z.infer<typeof roleContract>) => {
  const entry = STEP_ROLE_REGISTRY[v.role];
  return entry && !('hostPolicy' in entry);
};
export const providesRoleSchema = roleContract
  .refine(exact, 'role contract mismatch')
  .refine(dataOnly, 'host-policy role is not a module data port');
export const consumesRoleSchema = roleContract
  .extend({
    input: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    optional: z.boolean(),
  })
  .refine(exact, 'role contract mismatch')
  .refine(dataOnly, 'host-policy role is not a module data port');
/** Prompt ports are data only, including review/audit data. They never declare replaces
 * or executable outputContract. Module declarations retain their narrower gate. */
export const promptRolePortDeclarationsSchema = z.object({
  providesRoles: z
    .array(roleContract.refine(exact, 'role contract mismatch'))
    .max(32)
    .refine((v) => new Set(v.map((p) => p.role)).size === v.length, 'duplicate provided role')
    .optional(),
  consumesRoles: z
    .array(
      roleContract
        .extend({
          input: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
          optional: z.boolean(),
        })
        .refine(exact, 'role contract mismatch'),
    )
    .max(32)
    .refine((v) => new Set(v.map((p) => p.input)).size === v.length, 'duplicate input')
    .optional(),
});
export const rolePortDeclarationsSchema = z.object({
  providesRoles: z
    .array(providesRoleSchema)
    .max(32)
    .refine((v) => new Set(v.map((p) => p.role)).size === v.length, 'duplicate provided role')
    .optional(),
  consumesRoles: z
    .array(consumesRoleSchema)
    .max(32)
    .refine((v) => new Set(v.map((p) => p.input)).size === v.length, 'duplicate input')
    .optional(),
});
export type RolePortDeclarations = z.infer<typeof rolePortDeclarationsSchema>;

/** Author choices use step identities so reordering never silently retargets an input.
 * Null denotes the static/pre-triage candidate; every derived path has its own choices. */
export const dataRoleBindingsSchema = z
  .array(
    z.strictObject({
      executionPath: z.string().min(1).max(64).nullable(),
      consumerStepId: z.string().min(1).max(128),
      input: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      producerStepId: z.string().min(1).max(128),
    }),
  )
  .max(8192)
  .refine(
    (v) =>
      new Set(v.map((b) => JSON.stringify([b.executionPath, b.consumerStepId, b.input]))).size ===
      v.length,
    'duplicate input binding',
  );
export type DataRoleBindingsDraft = z.infer<typeof dataRoleBindingsSchema>;
