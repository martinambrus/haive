import { z } from 'zod';
import { cliProviderNameSchema } from '../schemas/cli-providers.js';
import { newestArtifactsFirst } from '../templates/manifest.js';
import { recordedCliTargets } from './render-targets.js';
import { renderSchema, type ProjectRender } from './record.js';

export const agentTargetSchema = z.strictObject({
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
  cliTargets: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).optional(),
  legacyAgentFallback: z.boolean().optional(),
  agentTargets: z.array(agentTargetSchema).optional(),
  enabledCliProviders: z.array(enabledCliProviderSchema).optional(),
  rtkEnabled: z.boolean().optional(),
  rtkChoiceRecorded: z.boolean(),
});

export type RenderContextColumn = z.infer<typeof renderContextColumnSchema>;

const renderContextSnapshotSchema = renderContextColumnSchema.omit({ rtkChoiceRecorded: true });

/** Whether a stored snapshot decodes as a render context, by the schema the column is read with. */
export function isRenderContextSnapshot(value: unknown): boolean {
  return renderContextSnapshotSchema.safeParse(value).success;
}

/** Whether this install's RTK switch is a choice: the render context recorded one, or a person
 *  switched RTK on the Tooling page (`repositories.rtk_choice_made_at`), whatever the context says. */
export const isRtkChoiceRecorded = (
  contextRecorded: boolean,
  choiceMadeAt: Date | null | undefined,
): boolean => contextRecorded || choiceMadeAt != null;

/** RTK's block and settings files go only where the render context recorded an RTK choice and the
 *  switch is off: a context from before RTK made none, and its `false` is only a default. */
export function rtkLeftoversToRemove(choiceRecorded: boolean, rtkEnabled: boolean): boolean {
  return choiceRecorded && !rtkEnabled;
}

/** The RTK block is offered back only where the render context recorded an RTK choice and the
 *  switch is on: the mirror image of `rtkLeftoversToRemove`. */
export function rtkBlockToRestore(choiceRecorded: boolean, rtkEnabled: boolean): boolean {
  return choiceRecorded && rtkEnabled;
}

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
 *  RTK would keep the live RTK switch out of the plan), else the newest holding a snapshot. Once a
 *  person switched RTK (`rtkChoiceMadeAt`) no snapshot is needed for that, so the newest holding one. */
export function pickSnapshotRow<R extends SnapshotRowFacts>(
  rows: readonly R[],
  rtkChoiceMadeAt?: Date | null,
): R | null {
  const newest = newestArtifactsFirst(rows);
  const recorded = isRtkChoiceRecorded(false, rtkChoiceMadeAt)
    ? undefined
    : newest.find((r) => r.rtkRecorded === true);
  return recorded ?? newest.find((r) => r.hasSnapshot === true) ?? null;
}

export type HistoryOrigin =
  { kind: 'onboarding'; rtkRecorded: boolean } | { kind: 'blank' } | { kind: 'none' };

/** Where a repository with no usable row recovers its context: the step 07 output of its last
 *  completed onboarding, else the blank scaffold's. An onboarding without that output has none. */
export function historyOrigin(input: {
  /** Null when no onboarding completed. */
  onboarding: { detected: boolean; rtkRecorded: boolean } | null;
  source: string;
  /** `repositories.rtk_choice_made_at`. Left out by a caller that reads only the kind. */
  rtkChoiceMadeAt?: Date | null;
}): HistoryOrigin {
  const { onboarding, source, rtkChoiceMadeAt } = input;
  if (onboarding === null) return source === 'blank' ? { kind: 'blank' } : { kind: 'none' };
  if (!onboarding.detected) return { kind: 'none' };
  return {
    kind: 'onboarding',
    rtkRecorded: isRtkChoiceRecorded(onboarding.rtkRecorded, rtkChoiceMadeAt),
  };
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
 *  the history. With a column, the RTK choice is its stored flag or a person's switch, never
 *  whether it holds one. */
export function renderContextOrigin<R extends SnapshotRowFacts>(input: {
  column: RenderContextColumnRead;
  rows: readonly R[];
  /** `repositories.rtk_choice_made_at`, which the caller reads with the repository. */
  rtkChoiceMadeAt: Date | null | undefined;
}): RenderContextOrigin<R> {
  const { column, rtkChoiceMadeAt } = input;
  if (column.kind === 'column') {
    return {
      from: 'column',
      column: column.column,
      rtkRecorded: isRtkChoiceRecorded(column.column.rtkChoiceRecorded, rtkChoiceMadeAt),
    };
  }
  const row = pickSnapshotRow(input.rows, rtkChoiceMadeAt);
  if (row) {
    return {
      from: 'snapshot',
      row,
      rtkRecorded: isRtkChoiceRecorded(row.rtkRecorded === true, rtkChoiceMadeAt),
    };
  }
  return { from: 'history', refused: column.kind === 'refused' ? column.problems : null };
}

/** The providers the column's render context reads: its own when it holds a list, else the ones the
 *  caller has enabled, which is what 01 completes it from. */
export function renderContextProviderNames(
  column: RenderContextColumn,
  enabledNames: readonly string[],
): string[] {
  if (column.cliTargets !== undefined) return [...column.cliTargets];
  return column.enabledCliProviders
    ? column.enabledCliProviders.map((p) => p.name)
    : [...enabledNames];
}

/** Newer snapshots may omit membership without removing it. Stop on a recorded [] and never
 * consult this install's providers; context/RTK origin is selected separately by pickSnapshotRow. */
export interface RecoveredCliMembership {
  cliTargets: string[];
  snapshot: Omit<RenderContextColumn, 'rtkChoiceRecorded'>;
}
export function recoverCliMembership(
  rows: ReadonlyArray<{ id: string; generatedAt: Date | null; formValuesSnapshot: unknown }>,
): RecoveredCliMembership | undefined {
  for (const row of newestArtifactsFirst(rows)) {
    const parsed = renderContextSnapshotSchema.safeParse(row.formValuesSnapshot);
    if (!parsed.success) continue;
    const names = recordedCliTargets(parsed.data);
    if (names !== undefined) return { cliTargets: names, snapshot: parsed.data };
  }
  return undefined;
}
export function recoverCliTargets(
  rows: ReadonlyArray<{ id: string; generatedAt: Date | null; formValuesSnapshot: unknown }>,
): string[] | undefined {
  return recoverCliMembership(rows)?.cliTargets;
}
