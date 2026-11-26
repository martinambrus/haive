import { expect, it } from 'vitest';
import {
  resolvePreferredProvider,
  disabledProvider,
  providerLabel,
  COMPOSED_LSP_VERIFIED_PROVIDER_NAMES,
  type PreferredProviderRecord as Provider,
  type SkippedSavedPreference,
} from '@haive/shared/cli-preferred-provider';
type Request = {
  providers: Provider[];
  preferredProviderId: string | null;
  savedPreference?: { taskProviderId: string | null };
  composedLspProviderIds: string[] | null;
};
// Frozen pre-extraction decision: compatibility oracle for moving the decision across package boundaries.
function composedLspAllowedSet(
  providers: readonly Provider[],
  composedIds: readonly string[] | null | undefined,
): Set<string> | null {
  if (!composedIds) return null;
  if (composedIds.length > 0) return new Set(composedIds);
  return new Set(
    providers.filter((p) => COMPOSED_LSP_VERIFIED_PROVIDER_NAMES.includes(p.name)).map((p) => p.id),
  );
}

/** What a request's preferred provider comes to before any plan is built: the provider the dispatch goes on with
 *  (null floats to the default order) and the saved pick the composed lock skipped, or the refusal. The step hold
 *  asks the same function, so a step parks exactly where a dispatch would refuse a switched-off provider. */
export type PreferredProvider =
  | { kind: 'use'; providerId: string | null; skipped: SkippedSavedPreference | null }
  | { kind: 'disabled'; provider: Provider }
  | { kind: 'locked'; label: string | null };

function legacyPreferredProvider(
  req: Pick<
    Request,
    'providers' | 'preferredProviderId' | 'savedPreference' | 'composedLspProviderIds'
  >,
): PreferredProvider {
  let preferredId = req.preferredProviderId ?? null;
  const composedSet = composedLspAllowedSet(req.providers, req.composedLspProviderIds);
  let skipped: SkippedSavedPreference | null = null;
  if (composedSet && preferredId && !composedSet.has(preferredId)) {
    const chosen = req.providers.find((p) => p.id === preferredId);
    const label = chosen ? providerLabel(chosen) : null;
    if (!req.savedPreference) {
      const off = disabledProvider(req.providers, preferredId);
      return off ? { kind: 'disabled', provider: off } : { kind: 'locked', label };
    }
    skipped = { providerId: preferredId, label };
    const own = req.savedPreference.taskProviderId;
    preferredId = own && composedSet.has(own) ? own : null;
  }
  const off = disabledProvider(req.providers, preferredId);
  return off
    ? { kind: 'disabled', provider: off }
    : { kind: 'use', providerId: preferredId, skipped };
}

it('shared preferred-provider decision preserves worker behaviour across the lock matrix', async () => {
  const providers = [
    { id: 'claude', name: 'claude-code', label: 'Claude', enabled: true },
    { id: 'codex', name: 'codex', label: 'Codex', enabled: true },
  ];
  for (const composedLspProviderIds of [null, [], ['claude'], ['codex']])
    for (const preferredProviderId of [null, 'claude', 'codex'])
      for (const taskProviderId of [null, 'claude', 'codex'])
        for (const off of [null, 'claude', 'codex'])
          for (const saved of [false, true]) {
            const req = {
              providers: providers.map((p) => ({ ...p, enabled: p.id !== off })),
              preferredProviderId,
              composedLspProviderIds,
              savedPreference: saved ? { taskProviderId } : undefined,
            };
            expect(resolvePreferredProvider(req)).toEqual(legacyPreferredProvider(req));
          }
});
