import type { GlobalKbEnforceSpec, GlobalKbEnforcementState } from './api-client';

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

/** States in which an admin's approval is still on the row, so archiving, deleting or replacing
 *  the entry takes a rule away. */
export function holdsApproval(state: GlobalKbEnforcementState | undefined): boolean {
  const name = state?.state;
  return (
    name === 'enforced' ||
    name === 'edited' ||
    name === 'not_active' ||
    name === 'switched_off' ||
    name === 'other_namespace'
  );
}

/** An edit to text or scope changes what an admin approved, so the rule lapses on save. */
export function lapsesOnEdit(state: GlobalKbEnforcementState | undefined): boolean {
  return state?.state === 'enforced' || state?.state === 'switched_off';
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
