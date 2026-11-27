/** Atomic fs-safe writers create this name beside the destination before renaming it.
 *  Keep those partial files out of every root add, even if the writer is still active. */
export const PROJECTION_TEMP_EXCLUDE = ':(top,exclude,glob)**/.*.haive-tmp-*';
export const FS_RECOVERY_EXCLUDES = [
  PROJECTION_TEMP_EXCLUDE,
  ':(top,exclude,glob)**/.*.haive-alias-*',
  ':(top,exclude,glob)**/.*.haive-park-*',
];

/** Shared by the real add and scratch-index checks of what it would stage. */
export function stageAllArgs(excluded: readonly string[] = []): string[] {
  return [
    'add',
    '-A',
    '--',
    '.',
    ...FS_RECOVERY_EXCLUDES,
    ...excluded.map((p) => `:(top,exclude,literal)${p.slice(0, -1)}`),
  ];
}
