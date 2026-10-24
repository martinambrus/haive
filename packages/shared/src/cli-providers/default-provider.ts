export interface DefaultProviderCandidate {
  readonly id: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

/** Enabled providers, oldest first; the lower id breaks a createdAt tie. */
export function orderByDefaultPriority<T extends DefaultProviderCandidate>(
  providers: readonly T[],
): T[] {
  return providers
    .filter((p) => p.enabled)
    .sort((a, b) => {
      const byAge = a.createdAt.getTime() - b.createdAt.getTime();
      if (byAge !== 0) return byAge;
      if (a.id < b.id) return -1;
      return a.id > b.id ? 1 : 0;
    });
}

/** The default provider: the oldest enabled one, the lower id breaking a createdAt tie. */
export function resolveDefaultCliProvider<T extends DefaultProviderCandidate>(
  providers: readonly T[],
): T | null {
  return orderByDefaultPriority(providers)[0] ?? null;
}

/** The CLI a task runs on: its own when it names one (even a disabled one), else the default. */
export function resolveTaskCliProviderId(
  taskCliProviderId: string | null,
  providers: readonly DefaultProviderCandidate[],
): string | null {
  return taskCliProviderId ?? resolveDefaultCliProvider(providers)?.id ?? null;
}
