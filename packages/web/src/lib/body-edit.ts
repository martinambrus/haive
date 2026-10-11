/** Text equal to the loaded body or to the editor's re-serialization of it is no edit; sending it rewrites the stored text. */
export function bodyToSave(
  loaded: string,
  edited: string,
  baseline: string | null,
): string | undefined {
  return edited === loaded || edited === baseline ? undefined : edited;
}
