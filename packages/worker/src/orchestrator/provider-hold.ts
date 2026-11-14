interface HoldProvider {
  id: string;
  enabled: boolean;
  label: string;
  name: string;
}

/** The provider with this id when it is listed and switched off; null for no id, an id no provider
 *  has (a deleted provider's references are nulled by the database) or an enabled provider. */
export function disabledProvider<P extends HoldProvider>(
  providers: readonly P[],
  id: string | null,
): P | null {
  if (!id) return null;
  return providers.find((p) => p.id === id && p.enabled === false) ?? null;
}

export function providerLabel(provider: Pick<HoldProvider, 'label' | 'name'>): string {
  return provider.label || provider.name;
}

/** Display copy for a step held on a disabled provider; nothing may key on it. */
export function providerHoldMessage(
  providers: readonly HoldProvider[],
  id: string | null,
): string | null {
  const off = disabledProvider(providers, id);
  if (!off) return null;
  return `Waiting for the CLI provider — "${providerLabel(off)}" is disabled. Enable the provider again or switch this step's CLI to continue.`;
}
