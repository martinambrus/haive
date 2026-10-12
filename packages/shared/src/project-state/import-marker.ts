/** `source_step_id` of a ledger row an import of another install's project state wrote. */
export const PROJECT_STATE_IMPORT_STEP_ID = 'project-state-import';

export interface ImportMarkerShape {
  source: string;
  sourceStepId: string;
}

/** A marker is a `backfill` row written by the import; the database CHECK ties it to a NULL task. */
export function isImportMarker(row: ImportMarkerShape): boolean {
  return row.source === 'backfill' && row.sourceStepId === PROJECT_STATE_IMPORT_STEP_ID;
}
