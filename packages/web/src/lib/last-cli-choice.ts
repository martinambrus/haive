/** The New Task form's remembered CLI dropdown values, as `GET /tasks/last-cli` returns
 *  them. `null` = this repo has no recorded choice. */
export type LastCliChoice = { providerId: string | null } | null;
export type LastSummaryCliChoice = { providerId: string | null; llmEnabled: boolean } | null;

/** Sentinel `<option>` value for "no AI summary". Not a uuid, so it can never collide
 *  with a provider id. */
export const SUMMARY_CLI_OFF = 'off';

/** Both dropdowns use '' for their no-provider option — "(none — deterministic steps
 *  only)" on the main one, "(inherit — same CLI as the step)" on the summary one. */
const NO_PROVIDER = '';

function knownProvider(id: string | null, providerIds: readonly string[]): string {
  return id && providerIds.includes(id) ? id : NO_PROVIDER;
}

/** `<select>` value for the main CLI dropdown.
 *
 *  A repo with no recorded choice resolves to the default rather than keeping what the
 *  dropdown already shows: the memory is per REPOSITORY, and carrying the previous
 *  repo's pick across a repo switch would silently run this task on a CLI nobody chose
 *  for it. A remembered provider that is no longer in the loaded list falls back the
 *  same way rather than selecting an `<option>` that does not exist — a provider can be
 *  deleted between two tasks. */
export function resolveCliChoiceValue(
  choice: LastCliChoice,
  providerIds: readonly string[],
): string {
  if (!choice) return NO_PROVIDER;
  return knownProvider(choice.providerId, providerIds);
}

/** `<select>` value for the Summary CLI dropdown.
 *
 *  Off is checked FIRST: the form never sends a provider together with
 *  `llmEnabled: false`, but `POST /tasks` accepts both, and "no recap at all" is the
 *  stronger statement of the two. */
export function resolveSummaryChoiceValue(
  choice: LastSummaryCliChoice,
  providerIds: readonly string[],
): string {
  if (!choice) return NO_PROVIDER;
  if (!choice.llmEnabled) return SUMMARY_CLI_OFF;
  return knownProvider(choice.providerId, providerIds);
}
