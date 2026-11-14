/** Every CLI provider ONE step will actually spend, not just the one it defaults to.
 *
 *  A fan-out step resolves a provider PER SEAT (worker `step-runner.ts`, `resolveSeat`), so
 *  08c-code-review can run its five reviewers and three refutation lenses on five different
 *  models at once; a loop step resolves one per ROLE. The task header used to read the
 *  step's single `preferredCliProviderId` — the `'default'` row only — and therefore named a
 *  CLI that no agent of a seat-configured step was running.
 *
 *  Mirrors `resolvePreferredCli`'s fall-through exactly: an unset seat, or one whose provider
 *  row no longer exists, falls to the step default, and that falls to the task provider. A
 *  pick whose provider row exists is kept even when it is switched off, since the worker
 *  holds the step on it — so callers pass EVERY provider row, not only the enabled ones.
 *  The task's own provider is the fallback of last resort and is passed through as-is.
 *
 *  The step default is kept even when every seat is set: it is the fallthrough for a seat
 *  the user never touched, it runs the mining summary pass, and keeping it means this can
 *  only ever ADD a meter to the header, never remove the one shown today.
 *
 *  Pure and unit-tested, like usage-chip-state and step-banners. Keep this resolver free of
 *  runtime dependencies; the web Vitest config resolves `@/` imports when needed. */

/** The fields of a `TaskStep` this reads. Structural rather than the whole type so tests can
 *  build one without the fifty unrelated columns. */
export interface StepCliProviderSource {
  preferredCliProviderId: string | null;
  roundCliUnavailable?: true;
  miningSeats?: { id: string; label: string }[];
  miningSeatProviders?: Record<string, string | null>;
  cliRoles?: { id: string; label: string }[];
  cliRoleProviders?: Record<string, string | null>;
}

export function stepCliProviderIds(args: {
  step: StepCliProviderSource | null;
  taskCliProviderId: string | null;
  listedProviderIds: ReadonlySet<string>;
}): string[] {
  const { step, taskCliProviderId, listedProviderIds } = args;
  // A round override is the only candidate; an unavailable one refuses dispatch.
  if (step?.roundCliUnavailable) return [];
  // A pref pointing at a deleted provider is ignored, exactly as the worker ignores it — the
  // seat runs on the fallback, so the fallback is what the header must name. A disabled one
  // still has its row, so it is kept: the worker holds the step on it.
  const usable = (id: string | null | undefined): string | null =>
    id && listedProviderIds.has(id) ? id : null;

  const stepDefault = usable(step?.preferredCliProviderId) ?? taskCliProviderId ?? null;

  const out: string[] = [];
  const push = (id: string | null) => {
    if (id && !out.includes(id)) out.push(id);
  };
  push(stepDefault);
  for (const seat of step?.miningSeats ?? []) {
    push(usable(step?.miningSeatProviders?.[seat.id]) ?? stepDefault);
  }
  for (const role of step?.cliRoles ?? []) {
    push(usable(step?.cliRoleProviders?.[role.id]) ?? stepDefault);
  }
  return out;
}
