/** Provider names verified to launch the composed language-server image. */
export const COMPOSED_LSP_VERIFIED_PROVIDER_NAMES: readonly string[] = ['claude-code'];

export interface PreferredProviderRecord {
  id: string;
  name: string;
  label: string;
  enabled: boolean;
}

export interface SkippedSavedPreference {
  providerId: string;
  label: string | null;
}

/** The provider with this id when it is listed and switched off; null for no id, an id no provider
 *  has (a deleted provider's references are nulled by the database) or an enabled provider. */
export function disabledProvider<P extends PreferredProviderRecord>(
  providers: readonly P[],
  id: string | null,
): P | null {
  if (!id) return null;
  return providers.find((p) => p.id === id && p.enabled === false) ?? null;
}

export function providerLabel(provider: Pick<PreferredProviderRecord, 'label' | 'name'>): string {
  return provider.label || provider.name;
}

/** The providers a contract 2 task may launch: those holding an effective composed image, or,
 *  before the first build makes any image effective, the lock's verified providers, so the
 *  environment steps that build that image (and their AI repair) can still run. */
export function composedLspAllowedSet<P extends Pick<PreferredProviderRecord, 'id' | 'name'>>(
  providers: readonly P[],
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
export type PreferredProvider<P extends PreferredProviderRecord = PreferredProviderRecord> =
  | { kind: 'use'; providerId: string | null; skipped: SkippedSavedPreference | null }
  | { kind: 'disabled'; provider: P }
  | { kind: 'locked'; label: string | null };

export function resolvePreferredProvider<P extends PreferredProviderRecord>(req: {
  providers: readonly P[];
  preferredProviderId?: string | null;
  savedPreference?: { taskProviderId: string | null };
  composedLspProviderIds?: readonly string[] | null;
}): PreferredProvider<P> {
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
