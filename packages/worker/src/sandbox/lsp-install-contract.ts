/** Absent metadata means the saved environment owns installation. Version 2 is
 * reserved for composed installation; no production writer emits it yet. This
 * lives in declaredDeps (jsonb), so introducing it needs no database migration. */
export interface LspInstallContract {
  lspInstallContractVersion?: 1 | 2;
}

/** Refuse newer metadata before reusing a saved Dockerfile or smoke evidence.
 * The cutover must teach generation and verification version 2 together. */
export function assertEnvironmentLspInstallContract(deps: {
  lspInstallContractVersion?: unknown;
}): void {
  const version = deps.lspInstallContractVersion;
  if (version === undefined || version === 1) return;
  throw new Error(
    `Unsupported LSP install contract ${JSON.stringify(version)}: this worker supports environment installation (1); composed installation is not enabled`,
  );
}
