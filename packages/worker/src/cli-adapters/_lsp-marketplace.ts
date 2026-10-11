import type { PluginInstallCommand, PluginInstallOpts } from './types.js';

// PHP is absent on purpose: the marketplace has only phpactor; PHP LSP is the local drupal-php-lsp (intelephense).
const LSP_PLUGINS: Record<string, string> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  java: 'jdtls',
};
const LSP_MARKETPLACE_REF = 'Piebald-AI/claude-code-lsps';
const LSP_MARKETPLACE_ID = 'claude-code-lsps';
const DRUPAL_LSP_MARKETPLACE_ID = 'drupal-lsp-marketplace';

export interface LspMarketplaceOpts {
  exec: string;
  opts: PluginInstallOpts;
  /** Append `--trust` to every plugin install. */
  trust?: boolean;
  /** Qualifier of the local drupal-php-lsp plugin; defaults to the manifest name. */
  localMarketplaceId?: (drupalLspPath: string) => string;
}

export function buildLspMarketplaceCommands(o: LspMarketplaceOpts): PluginInstallCommand[] {
  const { exec, opts } = o;
  const trustArgs = o.trust ? ['--trust'] : [];
  const cmds: PluginInstallCommand[] = [];
  const lspPlugins = opts.lspLanguages
    .map((lang) => LSP_PLUGINS[lang === 'php-extended' ? 'php' : lang])
    .filter((v): v is string => !!v);
  const uniqueLsp = [...new Set(lspPlugins)];
  if (uniqueLsp.length > 0) {
    cmds.push({
      description: `Add ${LSP_MARKETPLACE_REF} marketplace`,
      command: exec,
      args: ['plugin', 'marketplace', 'add', LSP_MARKETPLACE_REF],
      egressDomains: ['github.com'],
    });
    for (const name of uniqueLsp) {
      cmds.push({
        description: `Install LSP plugin ${name}`,
        command: exec,
        args: ['plugin', 'install', `${name}@${LSP_MARKETPLACE_ID}`, ...trustArgs],
      });
    }
  }
  if (opts.drupalLspPath) {
    const localId = o.localMarketplaceId?.(opts.drupalLspPath) ?? DRUPAL_LSP_MARKETPLACE_ID;
    cmds.push({
      description: 'Add local drupal-lsp marketplace',
      command: exec,
      args: ['plugin', 'marketplace', 'add', opts.drupalLspPath],
    });
    cmds.push({
      description: 'Install drupal-php-lsp plugin',
      command: exec,
      args: ['plugin', 'install', `drupal-php-lsp@${localId}`, ...trustArgs],
    });
  }
  return cmds;
}
