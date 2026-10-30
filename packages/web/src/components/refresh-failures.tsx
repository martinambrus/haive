import type { RefreshCliVersionsJobResult } from '@haive/shared/constants';

/** One entry per distinct reason, in the order each reason first appeared. A feed outage is
 *  reported once per provider with the same text, so listing them apart would repeat it. */
export function groupRefreshFailures(
  errors: RefreshCliVersionsJobResult['errors'],
): { names: string[]; error: string }[] {
  const byReason = new Map<string, string[]>();
  for (const { name, error } of errors) {
    const names = byReason.get(error);
    if (names) names.push(name);
    else byReason.set(error, [name]);
  }
  return [...byReason].map(([error, names]) => ({ names, error }));
}

/** Which sources a refresh job could not update, and why. The error text arrives already
 *  sanitized by the worker, so it is shown as returned. Gated on `ok`, the job's own verdict. */
export function RefreshFailures({
  result,
}: {
  result: RefreshCliVersionsJobResult | null | undefined;
}) {
  if (!result || result.ok) return null;
  // mt-2: the provider form's version row spaces its helper lines by top margin.
  return (
    <div
      role="alert"
      className="mt-2 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300"
    >
      <p className="font-semibold">Some sources could not be refreshed</p>
      <ul className="mt-1 space-y-1">
        {groupRefreshFailures(result.errors).map((group) => (
          <li key={group.error} className="break-words">
            <span className="font-mono">{group.names.join(', ')}</span> — {group.error}
          </li>
        ))}
      </ul>
    </div>
  );
}
