import { describe, expect, it } from 'vitest';
import { isImportMarker, PROJECT_STATE_IMPORT_STEP_ID } from '../src/project-state/index.js';

describe('isImportMarker', () => {
  it('names the step the database CHECK names', () => {
    expect(PROJECT_STATE_IMPORT_STEP_ID).toBe('project-state-import');
  });

  it('is true for a backfill row written by the import', () => {
    expect(isImportMarker({ source: 'backfill', sourceStepId: PROJECT_STATE_IMPORT_STEP_ID })).toBe(
      true,
    );
  });

  it('is false for the import step under another source and for another step under backfill', () => {
    expect(isImportMarker({ source: 'upgrade', sourceStepId: PROJECT_STATE_IMPORT_STEP_ID })).toBe(
      false,
    );
    expect(isImportMarker({ source: 'backfill', sourceStepId: '01-upgrade-plan' })).toBe(false);
  });
});
