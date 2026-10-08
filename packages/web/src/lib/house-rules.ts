import type { GlobalKbEnforceSpec, GlobalKbEnforcementState, GlobalKbEntry } from './api-client';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

export interface HouseRuleBadge {
  label: string;
  variant: BadgeVariant;
}

/** The pill for an entry's enforcement, keyed on the api's computed state and never on copy. */
export function houseRuleBadge(state: GlobalKbEnforcementState | undefined): HouseRuleBadge | null {
  switch (state?.state) {
    case 'enforced':
      return { label: `Enforced · ${state.mode ?? 'always'}`, variant: 'info' };
    case 'edited':
      return { label: 'Lapsed · edited', variant: 'warning' };
    case 'not_active':
      return { label: 'Lapsed · not active', variant: 'warning' };
    case 'superseded':
      return { label: 'Superseded', variant: 'default' };
    case 'cleared':
      return { label: 'Not enforced', variant: 'default' };
    case 'switched_off':
    case 'other_namespace':
      return { label: 'Paused', variant: 'default' };
    default:
      return null;
  }
}

/** An admin's approval is still on the row, in any state or namespace; an edit, archive, delete or replacement ends it. */
export function carriesLiveApproval(entry: GlobalKbEntry): boolean {
  return entry.enforcedHash != null;
}

/** The api answers 409 to enforcing an entry of another namespace, while its DELETE clears an approval wherever the entry lives. */
export function enforcementOffers(
  entry: GlobalKbEntry,
  namespace: string | null,
): { enforce: boolean; unenforce: boolean } {
  return {
    enforce: namespace !== null && entry.namespace === namespace,
    unenforce: carriesLiveApproval(entry),
  };
}

/** One glob per line: a brace glob holds commas, so the list is never split on them. */
export function globsFromLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function describeEnforceSpec(spec: GlobalKbEnforceSpec | null | undefined): string {
  if (!spec) return 'none';
  return spec.mode === 'always' ? 'always' : `files: ${spec.globs.join(', ')}`;
}
