import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_PATTERN,
  integrationRequirementSchema,
  isCategoryId,
  isProviderId,
} from '../modularity/contracts.js';
import type { IntegrationOperation } from '../modularity/integrations.js';
import { IntegrationToolNameError } from './errors.js';

export const integrationBindingSchema = z.object({
  requirementId: integrationRequirementSchema.shape.id,
  categoryId: z
    .string()
    .refine((id) => isCategoryId(id))
    .nullable(),
  providerId: z.string().refine((id) => isProviderId(id)),
  connectionId: z.string().uuid(),
  access: integrationRequirementSchema.shape.access,
});
export type IntegrationBinding = z.infer<typeof integrationBindingSchema>;

export interface IntegrationTool {
  binding: IntegrationBinding;
  op: IntegrationOperation;
}

export function parseIntegrationBindings(raw: unknown): IntegrationBinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = integrationBindingSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const toolName = (text: string): string => text.replace(/[^a-z0-9_]/g, '_');
const NAME_DIGEST_LENGTH = 8;

function prefixedToolName(requirementId: string, opId: string): string {
  const name = toolName(`${requirementId}_${opId}`);
  if (name.length <= TOOL_NAME_MAX_LENGTH) return name;
  const digest = createHash('sha256')
    .update(`${requirementId}\n${opId}`)
    .digest('hex')
    .slice(0, NAME_DIGEST_LENGTH);
  return `${name.slice(0, TOOL_NAME_MAX_LENGTH - NAME_DIGEST_LENGTH - 1)}_${digest}`;
}

export function integrationTools(
  bindings: readonly IntegrationBinding[],
  specOf: (providerId: string) => { operations?: readonly IntegrationOperation[] } | undefined,
  options: { writeAllowed: (binding: IntegrationBinding) => boolean },
): Map<string, IntegrationTool> {
  const declared = bindings.flatMap((binding) =>
    (specOf(binding.providerId)?.operations ?? [])
      .filter((op) => op.access === 'read' || binding.access === 'write')
      .map((op) => ({ binding, op, base: op.opId })),
  );
  // Names follow what bindings declare, not the write switch: a flip never renames a listed tool.
  const uses = new Map<string, number>();
  for (const { base } of declared) uses.set(base, (uses.get(base) ?? 0) + 1);

  const named = declared.map(({ binding, op, base }) => ({
    binding,
    op,
    name: (uses.get(base) ?? 0) > 1 ? prefixedToolName(binding.requirementId, op.opId) : base,
  }));
  const taken = new Set<string>();
  for (const { binding, op, name } of named) {
    if (!TOOL_NAME_PATTERN.test(name) || taken.has(name)) {
      throw new IntegrationToolNameError(
        `integration operation ${op.opId} of requirement ${binding.requirementId} cannot be listed as ${JSON.stringify(name)}: a tool name must match ${TOOL_NAME_PATTERN} and be unique`,
      );
    }
    taken.add(name);
  }

  const tools = new Map<string, IntegrationTool>();
  for (const { binding, op, name } of named) {
    if (op.access !== 'read' && !options.writeAllowed(binding)) continue;
    tools.set(name, { binding, op });
  }
  return tools;
}
