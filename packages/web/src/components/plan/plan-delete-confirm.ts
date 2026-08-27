/**
 * Whether what the user typed unlocks the plan delete.
 *
 * Trimmed, because a copy-paste of the name picks up whitespace and refusing
 * that would just teach people to fight the box. NOT lowercased: this is the
 * one control in the app whose whole purpose is to be hard to satisfy by
 * accident, and a case-insensitive match is one keystroke closer to accidental.
 *
 * Mirrors `planDeleteRefusal` in the api, which re-checks the same rule — the
 * endpoint cannot take the dialog's word that a human was asked. This copy only
 * decides when the button lights up.
 */
export function planDeleteConfirmed(typed: string, repoName: string): boolean {
  const expected = repoName.trim();
  // Nothing to type means nothing can confirm it — otherwise an unnamed
  // repository would arm the button with an empty box.
  if (expected.length === 0) return false;
  return typed.trim() === expected;
}
