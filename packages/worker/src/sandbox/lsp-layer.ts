import { assertVersionToken } from '@haive/shared';

/** Optional composed-image recipes. Deliberately not activated by the production cache yet:
 * stored environment templates still own their installers until the verification cutover. */
export type ComposedLspServer = 'intelephense' | 'vtsls' | 'pyright';
export interface SelectedLspServer {
  server: ComposedLspServer;
  version: string | null;
}

const ALIASES = new Map<string, ComposedLspServer>([
  ['php', 'intelephense'],
  ['php-extended', 'intelephense'],
  ['intelephense', 'intelephense'],
  ['intelephense-extended', 'intelephense'],
  ['typescript', 'vtsls'],
  ['vtsls', 'vtsls'],
  ['python', 'pyright'],
  ['pyright', 'pyright'],
]);

/** One canonical selection for recipes and cache identity. Absent/empty means legacy bytes.
 * Aliases of a selected binary share its pin, including pins recorded under an older key. */
export function normalizeLspSelection(servers: unknown, versions?: unknown): SelectedLspServer[] {
  if (servers === undefined || servers === null) return [];
  if (!Array.isArray(servers)) throw new Error('Invalid LSP selection: expected a server list');
  const selected = new Set<ComposedLspServer>();
  for (const key of servers) {
    if (typeof key !== 'string')
      throw new Error('Invalid LSP selection: server keys must be strings');
    const server = ALIASES.get(key);
    if (!server) throw new Error(`Unsupported selected LSP server: ${JSON.stringify(key)}`);
    selected.add(server);
  }
  if (selected.size === 0) return [];
  if (
    versions !== undefined &&
    versions !== null &&
    (typeof versions !== 'object' || Array.isArray(versions))
  ) {
    throw new Error('Invalid LSP versions: expected a version map');
  }
  const pins = new Map<ComposedLspServer, string>();
  for (const [key, value] of Object.entries(versions ?? {})) {
    const server = ALIASES.get(key);
    if (!server || !selected.has(server)) continue;
    if (value === null || value === undefined || value === '') continue;
    assertVersionToken(value, `LSP ${server} version (edit the repository Tooling settings)`);
    const pin = value;
    const previous = pins.get(server);
    if (previous && previous !== pin) throw new Error(`Conflicting LSP versions for ${server}`);
    pins.set(server, pin);
  }
  return [...selected].sort().map((server) => ({ server, version: pins.get(server) ?? null }));
}

const RECIPES: Record<ComposedLspServer, { package: string; binary: string; extras: string }> = {
  intelephense: { package: 'intelephense', binary: 'intelephense', extras: '' },
  vtsls: { package: '@vtsls/language-server', binary: 'vtsls', extras: ' typescript' },
  // The npm distribution provides the same pyright-langserver executable as the old pip
  // wrapper, without downloading another Node runtime on the first sandbox-user invocation.
  pyright: { package: 'pyright', binary: 'pyright-langserver', extras: '' },
};

/** Validate once before rendering; all package/binary names are Haive-owned. Runtime
 * checks fail the build explicitly instead of claiming an unusable server installed. */
export function buildLspLayer(servers: unknown, versions?: unknown): string {
  const selection = normalizeLspSelection(servers, versions);
  if (selection.length === 0) return '';
  const lines = [
    `# haive-lsp-selection: ${JSON.stringify(selection)}`,
    'ENV PATH="/usr/local/bin:${PATH}"',
    'RUN set -eu; \\',
    '    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)\'; then \\',
    '        if command -v apk >/dev/null 2>&1; then \\',
    '            apk add --no-cache nodejs npm; \\',
    '        elif command -v apt-get >/dev/null 2>&1; then \\',
    '            apt-get update; \\',
    '            apt-get install -y --no-install-recommends curl ca-certificates gnupg bash; \\',
    '            curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/haive-lsp-nodesource.sh; \\',
    '            bash /tmp/haive-lsp-nodesource.sh; \\',
    '            apt-get install -y --no-install-recommends nodejs; \\',
    '            rm /tmp/haive-lsp-nodesource.sh; \\',
    '            rm -rf /var/lib/apt/lists/*; \\',
    '        else \\',
    '            echo "LSP layer: Node.js and npm are required; no supported package manager" >&2; exit 1; \\',
    '        fi; \\',
    '    fi; \\',
    '    node -e \'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("LSP layer: Node.js >=20 is required"); process.exit(1); }\'; \\',
    '    npm --version',
  ];
  for (const { server, version } of selection) {
    const recipe = RECIPES[server];
    const pin = version ? `@${version}` : '';
    lines.push(
      `RUN npm_config_engine_strict=true npm install -g --prefix /usr/local ${recipe.package}${pin}${recipe.extras} \\`,
      `    && command -v ${recipe.binary}`,
    );
  }
  return lines.join('\n');
}
