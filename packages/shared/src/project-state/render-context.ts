import { z } from 'zod';
import { cliProviderNameSchema } from '../schemas/cli-providers.js';
import { renderSchema, type ProjectRender } from './record.js';

const agentTargetSchema = z.strictObject({
  dir: z.string(),
  format: z.enum(['markdown', 'toml']),
  supportsLsp: z.boolean().optional(),
});

const enabledCliProviderSchema = z.strictObject({
  name: cliProviderNameSchema,
  rulesFile: z.string(),
  rulesFileMode: z.enum(['native', 'import', 'copy']),
});

/** `repositories.render_context`: the render unit, the per-install fields this install derives
 *  (absent when filled from a record alone) and whether `rtkEnabled` was chosen, not defaulted. */
export const renderContextColumnSchema = z.strictObject({
  ...renderSchema.shape,
  agentTargets: z.array(agentTargetSchema).optional(),
  enabledCliProviders: z.array(enabledCliProviderSchema).optional(),
  rtkEnabled: z.boolean().optional(),
  rtkChoiceRecorded: z.boolean(),
});

export type RenderContextColumn = z.infer<typeof renderContextColumnSchema>;

/** The render unit of a context: its five portable fields, and nothing else it holds. The values
 *  pass through as they are; the codec refuses a render unit that is not valid. */
export function portableRender(context: { [K in keyof ProjectRender]: unknown }): ProjectRender {
  return {
    projectInfo: context.projectInfo,
    framework: context.framework,
    acceptedAgentIds: context.acceptedAgentIds,
    customAgentSpecs: context.customAgentSpecs,
    lspLanguages: context.lspLanguages,
  } as ProjectRender;
}
