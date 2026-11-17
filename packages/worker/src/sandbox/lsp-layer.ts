import { assertVersionToken } from '@haive/shared';
import { ENSURE_NODE_USER_LINE } from '../cli-versions/codegen.js';
import { shellQuote } from './shell-quote.js';

/** Optional composed-image recipes, selected only by explicit contract-2 metadata.
 * No production writer opts in; existing templates keep their environment installers. */
export type ComposedLspServer =
  'intelephense' | 'vtsls' | 'pyright' | 'gopls' | 'rust-analyzer' | 'solargraph' | 'jdtls';
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
  ['go', 'gopls'],
  ['gopls', 'gopls'],
  ['rust', 'rust-analyzer'],
  ['rust-analyzer', 'rust-analyzer'],
  ['ruby', 'solargraph'],
  ['solargraph', 'solargraph'],
  ['java', 'jdtls'],
  ['jdtls', 'jdtls'],
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
    // Legacy and the Tooling UI do not pin these distributions. Ignore even stale
    // unsafe values: they enter neither shell text nor cache identity.
    if (server === 'rust-analyzer' || server === 'jdtls') continue;
    if (value === null || value === undefined || value === '') continue;
    assertVersionToken(value, `LSP ${server} version (edit the repository Tooling settings)`);
    // Match legacy's safe-token domain; registry availability is an install-time
    // concern. Canonicalize the optional Go release prefix only.
    const pin = server === 'gopls' ? value.replace(/^v/, '') : value;
    // A bare `v` canonicalizes to nothing: treat it as unpinned, like an empty value.
    if (!pin) continue;
    const previous = pins.get(server);
    if (previous && previous !== pin) throw new Error(`Conflicting LSP versions for ${server}`);
    pins.set(server, pin);
  }
  return [...selected].sort().map((server) => ({ server, version: pins.get(server) ?? null }));
}

const RECIPES: Record<
  'intelephense' | 'vtsls' | 'pyright',
  { package: string; binary: string; extras: string }
> = {
  intelephense: { package: 'intelephense', binary: 'intelephense', extras: '' },
  vtsls: { package: '@vtsls/language-server', binary: 'vtsls', extras: ' typescript' },
  // The npm distribution provides the same pyright-langserver executable as the old pip
  // wrapper, without downloading another Node runtime on the first sandbox-user invocation.
  pyright: { package: 'pyright', binary: 'pyright-langserver', extras: '' },
};

/** Validate once before rendering; all package/binary names are Haive-owned. Missing
 * native prerequisites skip visibly; a skipped server is not installation evidence. */
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
  // Step 02 bases are Ubuntu images without node. Provider codegen also ensures
  // the account later; reuse its idempotent line before any native launcher check.
  if (selection.some(({ server }) => !Object.hasOwn(RECIPES, server))) {
    lines.push(ENSURE_NODE_USER_LINE);
  }
  for (const { server, version } of selection) {
    if (
      server === 'gopls' ||
      server === 'rust-analyzer' ||
      server === 'solargraph' ||
      server === 'jdtls'
    ) {
      // A prerequisite skip must not inherit a stale launcher from the saved base.
      // Verification opens this recipe-owned path, never another PATH candidate.
      lines.push(
        `RUN rm -f /usr/local/bin/${server}`,
        `# haive-lsp-recipe: ${server}`,
        buildNativeRecipe(server, version),
      );
      continue;
    }
    const recipe = RECIPES[server];
    const pin = version ? `@${version}` : '';
    lines.push(
      `RUN npm_config_engine_strict=true npm install -g --prefix /usr/local ${recipe.package}${pin}${recipe.extras} \\`,
      `    && command -v ${recipe.binary}`,
    );
  }
  return lines.join('\n');
}

function run(commands: string[]): string {
  return ['RUN set -eu;', ...commands].join(' \\\n    ');
}

function requireTool(binary: string, message: string): string {
  return `command -v ${binary} >/dev/null 2>&1 || ${skip(message)}`;
}

function skip(message: string): string {
  return `{ echo ${shellQuote(`# ${message.replace(':', ' SKIPPED:')}`)} >&2; exit 0; };`;
}

function launcher(binary: string, script: string[]): string {
  return `printf '%s\\n' ${['#!/bin/sh', ...script].map(shellQuote).join(' ')} > /usr/local/bin/${binary}; chmod 0755 /usr/local/bin/${binary};`;
}

/** These recipes are inactive until the environment/template cutover. Go and Ruby
 * are verified prerequisites, never silently replaced with distro defaults. Rust
 * owns an isolated stable toolchain; none of its launch paths traverse /root.
 * Requirements and pin policies: see docs/architecture/sandbox.md. */
function buildNativeRecipe(
  server: 'gopls' | 'rust-analyzer' | 'solargraph' | 'jdtls',
  version: string | null,
): string {
  // su may reset PATH. Pass the image PATH as an argument, never interpolate its
  // contents into shell source; keep su's sandbox-user HOME/default environment.
  // The `PATH=` prefix keeps an argument that su would otherwise parse as an option
  // (a PATH starting with `-`) from ever starting with `-`.
  const asNode = (command: string) =>
    `su -s /bin/sh node -c ${shellQuote(`PATH="\${1#PATH=}"; export PATH; ${command}`)} haive-lsp "PATH=$PATH"`;
  const requireSu = requireTool(
    'su',
    `${server}: su and the sandbox node user are required for launcher verification`,
  );
  switch (server) {
    case 'gopls':
      return run([
        requireTool('go', 'gopls: a compatible Go >=1.21 runtime is required in the base image'),
        'go_version="$(GOTOOLCHAIN=local go env GOVERSION)";',
        'go_major="$(printf \'%s\' "$go_version" | sed -n \'s/^go\\([0-9]*\\)\\..*/\\1/p\')";',
        'go_minor="$(printf \'%s\' "$go_version" | sed -n \'s/^go[0-9]*\\.\\([0-9]*\\).*/\\1/p\')";',
        `[ "\${go_major:-0}" -gt 1 ] || { [ "\${go_major:-0}" -eq 1 ] && [ "\${go_minor:-0}" -ge 21 ]; } || ${skip('gopls: Go >=1.21 is required in the base image')}`,
        requireSu,
        `${asNode('GOTOOLCHAIN=local go version')} || ${skip('gopls: the sandbox user needs Go on the image PATH')}`,
        `GOTOOLCHAIN=local GOBIN=/usr/local/bin go install golang.org/x/tools/gopls@${version ? `v${version}` : 'latest'} || { echo 'gopls: selected release requires a compatible Go toolchain in the base image; update Go or pin an older gopls in Tooling' >&2; exit 1; };`,
        'chmod 0755 /usr/local/bin/gopls;',
        `${asNode('go version && gopls version')};`,
      ]);
    case 'rust-analyzer':
      return run([
        requireTool(
          'curl',
          'rust-analyzer: curl is required to install the isolated stable toolchain',
        ),
        requireSu,
        'mkdir -p /opt/haive-lsp/rust;',
        'curl -fsSL https://sh.rustup.rs -o /tmp/haive-lsp-rustup.sh;',
        'RUSTUP_HOME=/opt/haive-lsp/rust/rustup CARGO_HOME=/opt/haive-lsp/rust/cargo sh /tmp/haive-lsp-rustup.sh -y --no-modify-path --default-toolchain stable --profile minimal --component rust-analyzer,rust-src;',
        'rm /tmp/haive-lsp-rustup.sh;',
        'lsp_rust_bin="$(RUSTUP_HOME=/opt/haive-lsp/rust/rustup /opt/haive-lsp/rust/cargo/bin/rustup which --toolchain stable rust-analyzer)";',
        'lsp_rust_bin="${lsp_rust_bin%/*}";',
        // Direct toolchain binaries avoid an unprivileged rustup proxy trying to update a root-owned toolchain.
        // Direct rustc/cargo infer their sysroot from their own toolchain location.
        // No rustup proxies run, so no rustup context is needed; Cargo keeps its
        // writable user cache (or caller-supplied CARGO_HOME).
        `printf '%s\\n' '#!/bin/sh' "export PATH=\\\"$lsp_rust_bin:\\$PATH\\\"" "exec \\\"$lsp_rust_bin/rust-analyzer\\\" \\\"\\$@\\\"" > /usr/local/bin/rust-analyzer;`,
        'chmod a+rx /opt/haive-lsp; chmod -R a+rX /opt/haive-lsp/rust; chmod 0755 /usr/local/bin/rust-analyzer;',
        `${asNode('rust-analyzer --version')};`,
      ]);
    case 'solargraph':
      return run([
        // Match step 02's measured floor; RubyGems may resolve older compatible
        // dependencies on 3.0 even when the current gemspec requires newer Ruby.
        requireTool('ruby', 'solargraph: Ruby >=3.0 is required in the base image'),
        `ruby -e ${shellQuote('exit(Gem::Version.new(RUBY_VERSION) >= Gem::Version.new("3.0") ? 0 : 1)')} || ${skip('solargraph: Ruby >=3.0 is required in the base image')}`,
        requireTool('gem', 'solargraph: RubyGems is required in the base image'),
        requireTool('make', 'solargraph: make is required for native gems in the base image'),
        requireTool('cc', 'solargraph: a C compiler is required for native gems in the base image'),
        `ruby -rrbconfig -e ${shellQuote('exit(File.file?(File.join(RbConfig::CONFIG.fetch("rubyhdrdir"), "ruby.h")) ? 0 : 1)')} || ${skip('solargraph: Ruby development headers are required in the base image')}`,
        requireSu,
        `${asNode('ruby --version')} || ${skip('solargraph: the sandbox user needs Ruby on the image PATH')}`,
        `gem install solargraph${version ? ` --version ${version}` : ''} --no-document --install-dir /opt/haive-lsp/solargraph --bindir /opt/haive-lsp/solargraph/bin;`,
        launcher('solargraph', [
          'export GEM_HOME=/opt/haive-lsp/solargraph GEM_PATH=/opt/haive-lsp/solargraph',
          'exec ruby /opt/haive-lsp/solargraph/bin/solargraph "$@"',
        ]),
        'chmod a+rx /opt/haive-lsp; chmod -R a+rX /opt/haive-lsp/solargraph;',
        `${asNode('solargraph --version')};`,
      ]);
    case 'jdtls': {
      // Upstream README requires Java 25; its Python launcher still checks only 21.
      // Use the README floor and check the same JAVA_HOME preference as that launcher.
      const checkJava =
        'import os,re,shutil,subprocess,sys; sys.version_info >= (3,9) or sys.exit("jdtls: Python >=3.9 is required"); home=os.path.join(os.environ["JAVA_HOME"],"bin/java") if "JAVA_HOME" in os.environ else ""; java=home if os.path.isfile(home) else shutil.which("java"); java or sys.exit("jdtls: Java >=25 is required in the base image"); out=subprocess.check_output([java,"-version"],stderr=subprocess.STDOUT,text=True); match=re.search(r\'version\\s+"([0-9]+)\',out); (match and int(match[1]) >= 25) or sys.exit("jdtls: Java >=25 is required in the base image")';
      return run([
        requireTool('python3', 'jdtls: Python >=3.9 and Java >=25 are required in the base image'),
        requireSu,
        `${asNode(`python3 -c ${shellQuote(checkJava)}`)} || ${skip('jdtls: compatible Python >=3.9 and Java >=25 are required for the sandbox user')}`,
        requireTool('curl', 'jdtls: curl is required in the base image'),
        requireTool('tar', 'jdtls: tar is required in the base image'),
        'curl -fsSL https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz -o /tmp/haive-lsp-jdtls.tar.gz;',
        'mkdir -p /opt/haive-lsp/jdtls;',
        'tar -xzf /tmp/haive-lsp-jdtls.tar.gz -C /opt/haive-lsp/jdtls; rm /tmp/haive-lsp-jdtls.tar.gz;',
        launcher('jdtls', ['exec python3 /opt/haive-lsp/jdtls/bin/jdtls "$@"']),
        'chmod a+rx /opt/haive-lsp; chmod -R a+rX /opt/haive-lsp/jdtls;',
        `${asNode('jdtls --help')};`,
      ]);
    }
  }
}
