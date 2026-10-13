/** Selectable LSP servers (env keys) for the per-repo tooling management page. */
export const LSP_SERVER_OPTIONS: { value: string; label: string }[] = [
  // Single PHP LSP option. The plain `intelephense` key was dropped — it and
  // `intelephense-extended` install the same intelephense binary + the same
  // drupal-php-lsp plugin (with CMS-extension handling), so they were duplicates.
  // The legacy `intelephense` key is still accepted by consumers and normalized to
  // this survivor by migration 0084.
  { value: 'intelephense-extended', label: 'Intelephense (PHP)' },
  { value: 'vtsls', label: 'vtsls (TypeScript / JavaScript)' },
  { value: 'pyright', label: 'Pyright (Python)' },
  { value: 'gopls', label: 'gopls (Go)' },
  { value: 'rust-analyzer', label: 'rust-analyzer (Rust)' },
  { value: 'solargraph', label: 'Solargraph (Ruby)' },
  { value: 'jdtls', label: 'jdtls (Java)' },
];

export const LSP_KEY_SET: ReadonlySet<string> = new Set(LSP_SERVER_OPTIONS.map((o) => o.value));
