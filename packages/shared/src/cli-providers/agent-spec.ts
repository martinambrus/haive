import { z } from 'zod';

export const agentColorSchema = z.enum(['blue', 'purple', 'green', 'gold', 'red', 'orange']);
export type AgentColor = z.infer<typeof agentColorSchema>;

export const agentModelSchema = z.enum(['opus', 'sonnet', 'haiku']);
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentExpertiseSchema = z.enum(['expert', 'senior', 'mid']);
export type AgentExpertise = z.infer<typeof agentExpertiseSchema>;

export const agentKbRefsSchema = z.object({
  patterns: z.string().optional(),
  standards: z.string().optional(),
  reference: z.string().optional(),
});
export type AgentKbRefs = z.infer<typeof agentKbRefsSchema>;

const agentExecutionStepSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

/** Canonical IR for an agent definition. Originally lived inside the worker
 *  package as part of `_agent-templates.ts`; promoted to `@haive/shared` so
 *  the bundle parser, web UI, and database layer can all consume the same
 *  shape. The renderer in the worker (`buildAgentFileMarkdown` /
 *  `buildAgentFileToml`) is the source of truth for how this maps to disk. */
export const agentSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  color: agentColorSchema,
  field: z.string().min(1),
  tools: z.array(z.string()),
  model: agentModelSchema.optional(),
  expertise: agentExpertiseSchema.optional(),
  coreMission: z.string().min(1),
  responsibilities: z.array(z.string()),
  whenInvoked: z.array(z.string()),
  executionSteps: z.array(agentExecutionStepSchema),
  outputFormat: z.string(),
  qualityCriteria: z.array(z.string()),
  antiPatterns: z.array(z.string()),
  kbReferences: agentKbRefsSchema.optional(),
});
export type AgentSpec = z.infer<typeof agentSpecSchema>;
