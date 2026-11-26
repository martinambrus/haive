import {
  disabledProvider,
  providerLabel,
  type PreferredProviderRecord as HoldProvider,
} from '@haive/shared/cli-preferred-provider';
export { disabledProvider, providerLabel } from '@haive/shared/cli-preferred-provider';

/** Display copy for a step held on a disabled provider; nothing may key on it. */
export function providerHoldMessage(
  providers: readonly HoldProvider[],
  id: string | null,
): string | null {
  const off = disabledProvider(providers, id);
  if (!off) return null;
  return `Waiting for the CLI provider — "${providerLabel(off)}" is disabled. Enable the provider again or switch this step's CLI to continue.`;
}
