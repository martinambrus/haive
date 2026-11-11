/** Atomic fs-safe writers create this name beside the destination before renaming it.
 *  Keep those partial files out of every root add, even if the writer is still active. */
export const PROJECTION_TEMP_EXCLUDE = ':(top,exclude,glob)**/.*.haive-tmp-*';

/** Shared by the real add and scratch-index checks of what it would stage. */
export function stageAllArgs(excluded: readonly string[] = []): string[] {
  return [
    'add',
    '-A',
    '--',
    '.',
    PROJECTION_TEMP_EXCLUDE,
    ...excluded.map((p) => `:(top,exclude,literal)${p.slice(0, -1)}`),
  ];
}
