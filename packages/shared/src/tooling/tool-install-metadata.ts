import type { VersionSource } from '../cli-providers/install-metadata.js';

/** Tools (non-CLI binaries/packages) baked into per-repo environment images
 *  whose versions can be pinned + upgrade-checked, mirroring CLI_INSTALL_METADATA.
 *  rust-analyzer and jdtls are NOT pinnable (rustup toolchain / rolling Eclipse
 *  snapshot) — they carry `versionSource: { kind: 'none' }` and never report an
 *  upgrade. */
export type ToolName =
  | 'rtk'
  | 'chrome-devtools-mcp'
  | 'intelephense'
  | 'vtsls'
  | 'pyright'
  | 'gopls'
  | 'solargraph'
  | 'rust-analyzer'
  | 'jdtls';

export interface ToolInstallMetadata {
  displayName: string;
  versionSource: VersionSource;
  versionPinnable: boolean;
}

export const TOOL_INSTALL_METADATA: Record<ToolName, ToolInstallMetadata> = {
  rtk: {
    displayName: 'RTK proxy',
    // rtk release tags are `vX.Y.Z`; strip the `v` so the semver sorter matches.
    versionSource: { kind: 'github-releases', repo: 'rtk-ai/rtk', tagPrefix: 'v' },
    versionPinnable: true,
  },
  'chrome-devtools-mcp': {
    displayName: 'Chrome DevTools MCP',
    versionSource: { kind: 'npm', package: 'chrome-devtools-mcp' },
    versionPinnable: true,
  },
  intelephense: {
    displayName: 'Intelephense (PHP)',
    versionSource: { kind: 'npm', package: 'intelephense' },
    versionPinnable: true,
  },
  vtsls: {
    displayName: 'vtsls (TypeScript)',
    versionSource: { kind: 'npm', package: '@vtsls/language-server' },
    versionPinnable: true,
  },
  pyright: {
    displayName: 'Pyright (Python)',
    versionSource: { kind: 'pypi', package: 'pyright' },
    versionPinnable: true,
  },
  gopls: {
    displayName: 'gopls (Go)',
    // gopls release tags are `gopls/vX.Y.Z` in golang/tools.
    versionSource: { kind: 'github-releases', repo: 'golang/tools', tagPrefix: 'gopls/v' },
    versionPinnable: true,
  },
  solargraph: {
    displayName: 'Solargraph (Ruby)',
    versionSource: { kind: 'gem', gem: 'solargraph' },
    versionPinnable: true,
  },
  'rust-analyzer': {
    displayName: 'rust-analyzer (Rust)',
    versionSource: { kind: 'none' },
    versionPinnable: false,
  },
  jdtls: {
    displayName: 'jdtls (Java)',
    versionSource: { kind: 'none' },
    versionPinnable: false,
  },
};

export const TOOL_NAME_LIST = Object.keys(TOOL_INSTALL_METADATA) as ToolName[];
