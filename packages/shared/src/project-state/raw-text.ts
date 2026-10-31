// A leaf with no imports: conflicts.ts reaches it, and the web bundle reads conflicts.ts.

/** Settings whose file is the raw Markdown text itself (`settings/<name>.md`), not a JSON value. */
export const TEXT_SETTINGS: ReadonlySet<string> = new Set(['agent-rules']);

/** The file of a setting, relative to the state directory. It is also the setting's conflict unit. */
export const settingFileName = (name: string): string =>
  TEXT_SETTINGS.has(name) ? `settings/${name}.md` : `settings/${name}.json`;

/** The setting a file is the canonical file of, or null: `settings/agent-rules.json` and
 *  `settings/rtk-version.md` belong to no setting, so a reader leaves them alone. */
export function settingNameOfFile(rel: string): string | null {
  const named = /^settings\/([^/]+)\.(?:json|md)$/.exec(rel);
  return named !== null && settingFileName(named[1]!) === rel ? named[1]! : null;
}

const CONFLICT_MARKER = /^(?:<{7}|>{7}|\|{7})(?: |$)|^={7}$/m;

/** Whether a line of the text reads as a git merge conflict marker. */
export const hasConflictMarker = (text: string): boolean => CONFLICT_MARKER.test(text);

/** Why a text setting's value cannot be written as its file, or null. Only what would damage the
 *  record: the limits and the tidying of the text are the setting's own. */
export function rawTextProblem(text: unknown): string | null {
  if (typeof text !== 'string') return 'is not a string';
  if (!text.isWellFormed()) return 'holds a lone surrogate';
  if (text.includes('\u0000')) return 'holds a NUL character';
  if (hasConflictMarker(text)) return 'holds merge conflict markers';
  return null;
}
