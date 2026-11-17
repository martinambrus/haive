import { describe, expect, it } from 'vitest';
import { composeSandboxImage, type ComposeInput } from '../src/sandbox/image-composer.js';
import { composeSandboxImage as preLspComposition } from './fixtures/pre-lsp-composer.js';
import { buildLspMarketplaceCommands } from '../src/cli-adapters/_lsp-marketplace.js';

const base = {
  envTemplateDockerfile: 'FROM ubuntu:24.04\n',
  provider: { name: 'claude-code' as const, cliVersion: '1.2.3', sandboxDockerfileExtra: null },
};
// Kept structurally compatible so the controls execute against the pre-feature composer too.
function compose(lspServers?: unknown, lspServerVersions?: unknown) {
  return composeSandboxImage({ ...base, lspServers, lspServerVersions } as ComposeInput);
}

describe('optional composed LSP layer', () => {
  it('preserves pre-feature assembly structurally for every empty selection', () => {
    for (const selection of [undefined, null, []]) {
      for (const input of [
        base,
        { ...base, envTemplateDockerfile: null, baseImageId: 'sha256:base', rtkVersion: '0.42.4' },
      ]) {
        expect(
          composeSandboxImage({
            ...input,
            lspServers: selection,
            lspServerVersions: { vtsls: 'unused; malicious' },
          }),
        ).toEqual(preLspComposition(input));
      }
    }
  });

  it('reuses a tag for equivalent sorted, deduplicated language/server selections', () => {
    const a = compose(['typescript', 'php-extended', 'vtsls'], {
      typescript: '0.3.0',
      php: '1.18.4',
    });
    const b = compose(['intelephense', 'vtsls'], { vtsls: '0.3.0', intelephense: '1.18.4' });
    expect(a).toEqual(b);
    expect(
      a.dockerfileBody.match(/npm install -g --prefix \/usr\/local intelephense@1.18.4/g),
    ).toHaveLength(1);
  });

  it('changes the tag for a version or selection change', () => {
    const original = compose(['vtsls'], { vtsls: '0.3.0' });
    expect(original.tag).not.toBe(compose(['vtsls'], { vtsls: '0.3.1' }).tag);
    expect(original.tag).not.toBe(compose(['vtsls', 'pyright'], { vtsls: '0.3.0' }).tag);
    expect(original.tag).not.toBe(compose([]).tag);
  });

  it('does not add an LSP integration for a CLI without the plugin bridge', () => {
    expect(() =>
      composeSandboxImage({
        ...base,
        provider: { ...base.provider, name: 'codex' },
        lspServers: ['vtsls'],
      }),
    ).toThrow('codex does not expose Haive LSP plugin support');
  });

  it.each([42, [], '0.3.0'].map((versions) => ({ versions })))(
    'refuses a malformed version map $versions',
    ({ versions }) => {
      expect(() => compose(['vtsls'], versions)).toThrow(/invalid LSP versions/i);
    },
  );

  it('still incorporates base identity, provider, RTK and extras with LSP selected', () => {
    const input = { ...base, envTemplateDockerfile: null, lspServers: ['vtsls'] } as ComposeInput;
    const original = composeSandboxImage(input);
    for (const changed of [
      { baseImageId: 'sha256:changed' },
      { rtkVersion: '0.42.4' },
      { provider: { ...base.provider, cliVersion: '1.2.4' } },
      { provider: { ...base.provider, sandboxDockerfileExtra: 'RUN echo extra' } },
    ])
      expect(composeSandboxImage({ ...input, ...changed }).tag).not.toBe(original.tag);
  });

  it.each(['unknown', 'phpactor', 'constructor', '__proto__'])(
    'explicitly refuses selected server %s without a vetted recipe',
    (server) => expect(() => compose([server])).toThrow(/unsupported selected LSP server/i),
  );

  it.each([{}, 'vtsls', [42], [null], ['vtsls', {}]].map((selection) => ({ selection })))(
    'refuses malformed selection $selection',
    ({ selection }) => {
      expect(() => compose(selection)).toThrow(/LSP selection/i);
    },
  );

  it.each([
    '1.2.3;id',
    '$(id)',
    '`id`',
    '1.2.3\nRUN touch /tmp/injected',
    '1.2.3\rRUN id',
    '--registry=evil',
    'https://evil/pkg',
    'file:/tmp/pkg',
    '../pkg',
    '1.2.3 && id',
    "1.2.3'",
    '*',
    '^1.2.3',
    '1.2.3\n',
    ' 1.2.3',
    'v1.2.3 ',
    '-latest',
    '１.2.3',
    'ｌatest',
    '1.2.3\u2028',
    '1.2.3\0',
    'a'.repeat(65),
  ])('refuses version injection or non-exact token %j', (pin) =>
    expect(() => compose(['vtsls'], { vtsls: pin })).toThrow(/LSP.*version/i),
  );

  it.each([42, {}, []].map((pin) => ({ pin })))(
    'refuses a non-string selected pin $pin',
    ({ pin }) => {
      expect(() => compose(['vtsls'], { vtsls: pin })).toThrow(/LSP.*version/i);
    },
  );

  it('accepts shared-policy tokens without rewriting them', () => {
    for (const pin of ['1.2.3', '1.2.3-rc.1', '1.2.3+build.4', 'latest', 'next']) {
      expect(compose(['vtsls'], { vtsls: pin }).dockerfileBody).toContain(
        `@vtsls/language-server@${pin}`,
      );
    }
  });

  it('does not silently resolve conflicting pins for aliases of the same binary', () => {
    expect(() =>
      compose(['php', 'php-extended'], { php: '1.18.4', 'intelephense-extended': '1.18.5' }),
    ).toThrow(/conflicting LSP versions/i);
  });

  it('treats empty pins as unpinned and does not hash unselected version entries', () => {
    expect(compose(['vtsls'], { vtsls: '', unrelated: '1;evil' })).toEqual(compose(['vtsls']));
    expect(compose(['vtsls'], { vtsls: null })).toEqual(compose(['vtsls']));
  });

  it('satisfies or verifies Node/npm without assuming the base supplies it', () => {
    const body = compose(['php']).dockerfileBody;
    expect(body).toContain('apk add --no-cache nodejs npm');
    expect(body).toContain('https://deb.nodesource.com/setup_22.x');
    expect(body).toContain('apt-get install -y --no-install-recommends nodejs');
    expect(body).not.toContain('apt-get install -y --no-install-recommends nodejs npm');
    expect(body).toContain('LSP layer: Node.js and npm are required');
    expect(body).toContain('node -e');
    expect(body).toContain('npm --version');
    expect(body.indexOf('node -e')).toBeLessThan(
      body.indexOf('npm install -g @anthropic-ai/claude-code'),
    );
    expect(body).toContain('npm install -g --prefix /usr/local intelephense');
    expect(body).toContain('ENV PATH="/usr/local/bin:${PATH}"');
  });

  it('matches marketplace binaries and the local PHP plugin, checking launchers without starting stdio servers', () => {
    const body = compose(['php-extended', 'typescript', 'python']).dockerfileBody;
    for (const binary of ['intelephense', 'vtsls', 'pyright-langserver']) {
      expect(body).toContain(`command -v ${binary}`);
      expect(body).not.toContain(`${binary} --version`);
    }
    expect(body).toContain('npm install -g --prefix /usr/local pyright');
    expect(body).not.toContain('phpactor');
    const commands = buildLspMarketplaceCommands({
      exec: 'claude',
      opts: {
        repoRoot: '/haive/workdir',
        lspLanguages: ['php-extended', 'typescript', 'python'],
        drupalLspPath: '/haive/workdir/.claude/plugins/drupal-php-lsp',
      },
    });
    const installs = commands
      .filter((c) => c.args[0] === 'plugin' && c.args[1] === 'install')
      .map((c) => c.args[2]);
    expect(installs).toEqual([
      'vtsls@claude-code-lsps',
      'pyright@claude-code-lsps',
      'drupal-php-lsp@drupal-lsp-marketplace',
    ]);
  });
});
