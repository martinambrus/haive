import { getCliProviderMetadata, type CliProviderName } from '@haive/shared';

/** Absent metadata means the saved environment owns installation. Version 2 is
 * composed installation; step 01 writes it for new eligible environments. This
 * lives in declaredDeps (jsonb), so introducing it needs no database migration. */
export interface LspInstallContract {
  lspInstallContractVersion?: 1 | 2;
}

/** Accept only contracts this worker knows: 1 (environment installation) and 2
 * (composed installation). Any other value must stop before a saved Dockerfile is reused. */
export function assertKnownLspInstallContract(deps: { lspInstallContractVersion?: unknown }): void {
  const version = deps.lspInstallContractVersion;
  if (version === undefined || version === 1 || version === 2) return;
  throw new Error(
    `Unsupported LSP install contract ${JSON.stringify(version)}: this worker supports environment installation (1) and composed installation (2)`,
  );
}

/** Cache consumers ship before the writer/generator cutover. Validate even an empty
 * selection: an unsupported CLI must never advertise a contract-2 composition. */
export function resolveComposedLspInstallContract(
  version: unknown,
  providerName: CliProviderName,
): 1 | 2 {
  if (version === undefined || version === 1) return 1;
  if (version !== 2) {
    throw new Error(`Unsupported LSP install contract ${JSON.stringify(version)}`);
  }
  const metadata = getCliProviderMetadata(providerName);
  if (
    metadata?.name !== providerName ||
    !metadata.supportsLsp ||
    metadata.defaultExecutable !== 'claude'
  ) {
    throw new Error(
      `${providerName} does not expose Haive LSP plugin support for composed installation`,
    );
  }
  return 2;
}
