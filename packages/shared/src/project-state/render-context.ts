import { z } from 'zod';
import { cliProviderNameSchema } from '../schemas/cli-providers.js';
import { newestArtifactsFirst } from '../templates/manifest.js';
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

/** What a reader knows of one live artifact row's render-context snapshot. */
export interface SnapshotRowFacts {
  id: string;
  generatedAt: Date | null;
  /** Null when the database answered NULL: the row holds no snapshot at all. */
  hasSnapshot: boolean | null;
  /** The snapshot holds a boolean `rtkEnabled`. Null for a snapshot without one. */
  rtkRecorded: boolean | null;
}

/** The row an upgrade renders from: the newest that recorded an RTK choice (a snapshot from before
 *  RTK would keep the live RTK switch out of the plan), else the newest holding a snapshot. */
export function pickSnapshotRow<R extends SnapshotRowFacts>(rows: readonly R[]): R | null {
  const newest = newestArtifactsFirst(rows);
  return (
    newest.find((r) => r.rtkRecorded === true) ?? newest.find((r) => r.hasSnapshot === true) ?? null
  );
}

export type HistoryOrigin =
  { kind: 'onboarding'; rtkRecorded: boolean } | { kind: 'blank' } | { kind: 'none' };

/** Where a repository with no usable row recovers its context: the step 07 output of its last
 *  completed onboarding, else the blank scaffold's. An onboarding without that output has none. */
export function historyOrigin(input: {
  /** Null when no onboarding completed. */
  onboarding: { detected: boolean; rtkRecorded: boolean } | null;
  source: string;
}): HistoryOrigin {
  const { onboarding, source } = input;
  if (onboarding === null) return source === 'blank' ? { kind: 'blank' } : { kind: 'none' };
  if (!onboarding.detected) return { kind: 'none' };
  return { kind: 'onboarding', rtkRecorded: onboarding.rtkRecorded };
}
