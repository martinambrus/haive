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

export type RenderContextColumnRead =
  | { kind: 'absent' }
  | { kind: 'refused'; problems: string[] }
  | { kind: 'column'; column: RenderContextColumn };

/** A NULL or missing column is absent. One the schema refuses is refused, with what it found, and
 *  every reader treats it as absent. */
export function readRenderContextColumn(value: unknown): RenderContextColumnRead {
  if (value === null || value === undefined) return { kind: 'absent' };
  const parsed = renderContextColumnSchema.safeParse(value);
  if (parsed.success) return { kind: 'column', column: parsed.data };
  return {
    kind: 'refused',
    problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'the column'} ${i.message}`),
  };
}

export type RenderContextOrigin<R extends SnapshotRowFacts> =
  | { from: 'column'; column: RenderContextColumn; rtkRecorded: boolean }
  | { from: 'snapshot'; row: R; rtkRecorded: boolean }
  | { from: 'history'; refused: string[] | null };

/** Where an upgrade's render context comes from: the column, else the newest live snapshot, else
 *  the history. With a column, the RTK choice is its stored flag, never whether it holds one. */
export function renderContextOrigin<R extends SnapshotRowFacts>(input: {
  column: RenderContextColumnRead;
  rows: readonly R[];
}): RenderContextOrigin<R> {
  const { column } = input;
  if (column.kind === 'column') {
    return { from: 'column', column: column.column, rtkRecorded: column.column.rtkChoiceRecorded };
  }
  const row = pickSnapshotRow(input.rows);
  if (row) return { from: 'snapshot', row, rtkRecorded: row.rtkRecorded === true };
  return { from: 'history', refused: column.kind === 'refused' ? column.problems : null };
}

/** The providers the column's render context reads: its own when it holds a list, else the ones the
 *  caller has enabled, which is what 01 completes it from. */
export function renderContextProviderNames(
  column: RenderContextColumn,
  enabledNames: readonly string[],
): string[] {
  return column.enabledCliProviders
    ? column.enabledCliProviders.map((p) => p.name)
    : [...enabledNames];
}
