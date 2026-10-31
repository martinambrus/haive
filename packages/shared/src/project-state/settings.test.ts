import { describe, expect, it } from 'vitest';
import {
  PORTABLE_SETTING_NAMES,
  environmentColumnOf,
  environmentUnitOf,
  intakeSettings,
  isUnsettableSetting,
  normalizeAgentRulesOverride,
  normalizeEnvironment,
  normalizeSetting,
  portableSettingsOf,
  settingColumnUpdate,
  settingsDifferingFrom,
  isPortableSettingName,
  toolingUnitFrom,
  toolingUnitOf,
  TOOLING_UNIT_NAME,
  withoutMachineLocalTooling,
  withoutUnchosenRtk,
  type PortableSettingColumns,
} from './settings.js';
import { rawTextProblem } from './raw-text.js';

const empty: PortableSettingColumns = {
  scopeExcludeGlobs: null,
  rtkEnabled: null,
  rtkVersion: null,
  lspServers: null,
  lspServerVersions: null,
  chromeDevtoolsMcpVersion: null,
  reviewDimensions: null,
  agentRulesOverride: null,
};

describe('portableSettingsOf', () => {
  it('holds an entry per column that has a value, under its record name', () => {
    const settings = portableSettingsOf({
      scopeExcludeGlobs: ['vendor'],
      rtkEnabled: false,
      rtkVersion: '0.42.4',
      lspServers: ['vtsls'],
      lspServerVersions: { vtsls: '1.0.0', pyright: null },
      chromeDevtoolsMcpVersion: '0.9.0',
      reviewDimensions: ['security'],
      agentRulesOverride: '# Rules\n',
    });

    expect(Object.keys(settings).sort()).toEqual([...PORTABLE_SETTING_NAMES].sort());
    expect(settings['rtk-enabled']).toBe(false);
    expect(settings['lsp-server-versions']).toEqual({ vtsls: '1.0.0', pyright: null });
    expect(settings['agent-rules']).toBe('# Rules\n');
  });

  it('keeps an empty rules override a value: NULL follows the default, any text is a choice', () => {
    expect(portableSettingsOf({ ...empty, agentRulesOverride: '' })).toEqual({ 'agent-rules': '' });
    expect(portableSettingsOf({ ...empty, agentRulesOverride: 'x' })).toEqual({
      'agent-rules': 'x',
    });
    for (const none of [null, undefined, 7, false, {}, ['x']]) {
      expect(portableSettingsOf({ ...empty, agentRulesOverride: none })).toEqual({});
    }
  });

  it('leaves a column holding nothing out, so its file is not written', () => {
    expect(portableSettingsOf(empty)).toEqual({});
    expect(portableSettingsOf({ ...empty, scopeExcludeGlobs: undefined })).toEqual({});
  });

  it('keeps an empty list a value: never chosen and chosen empty are different', () => {
    expect(portableSettingsOf({ ...empty, scopeExcludeGlobs: [] })).toEqual({
      'scope-exclude-globs': [],
    });
  });

  it('takes nothing a reader could not, whatever a jsonb column holds', () => {
    expect(
      portableSettingsOf({
        ...empty,
        scopeExcludeGlobs: ['a', 1],
        lspServers: 'vtsls',
        lspServerVersions: { vtsls: 3 },
        rtkVersion: 4,
      }),
    ).toEqual({});
  });

  it('reads the named columns only: the app login and the verify commands never come along', () => {
    const row = {
      ...empty,
      scopeExcludeGlobs: ['vendor'],
      appAuth: { loginUrl: 'https://example.test/login' },
      verifyCommands: { test: 'run it' },
    };

    const settings = portableSettingsOf(row);

    expect(Object.keys(settings)).toEqual(['scope-exclude-globs']);
    expect(PORTABLE_SETTING_NAMES).not.toContain('app-auth');
    expect(PORTABLE_SETTING_NAMES).not.toContain('verify-commands');
    expect(PORTABLE_SETTING_NAMES).not.toContain('verify_commands');
  });
});

describe('environmentUnitOf', () => {
  const mirror = {
    schemaVersion: 1,
    envDetectData: { project: { name: 'acme' } },
    confirmedValues: { a: 1 },
  };

  it('is the mirror without its schema version', () => {
    expect(environmentUnitOf(mirror)).toEqual({
      envDetectData: mirror.envDetectData,
      confirmedValues: mirror.confirmedValues,
    });
  });

  it('is null for no column, another schema version or a malformed mirror', () => {
    expect(environmentUnitOf(null)).toBeNull();
    expect(environmentUnitOf(undefined)).toBeNull();
    expect(environmentUnitOf({ ...mirror, schemaVersion: 2 })).toBeNull();
    expect(environmentUnitOf({ ...mirror, confirmedValues: [] })).toBeNull();
    expect(environmentUnitOf({ schemaVersion: 1, envDetectData: {} })).toBeNull();
    expect(environmentUnitOf([])).toBeNull();
  });
});

describe('normalizeSetting', () => {
  const ok = (name: string, value: unknown) => normalizeSetting(name, value);

  it('keeps the scope list as the exclusions route stores it: trimmed, unique, without managed dirs, sorted', () => {
    expect(ok('scope-exclude-globs', ['/vendor/', 'b', '', 'a', 'b'])).toEqual({
      ok: true,
      value: ['a', 'b', 'vendor'],
    });
    expect(ok('scope-exclude-globs', ['.haive-data', 'x'])).toEqual({ ok: true, value: ['x'] });
    expect(ok('scope-exclude-globs', 'vendor')).toEqual({ ok: false });
  });

  it('keeps the LSP lists as the tooling route stores them', () => {
    expect(ok('lsp-servers', ['vtsls', 'made-up', 'vtsls'])).toEqual({
      ok: true,
      value: ['vtsls'],
    });
    expect(ok('lsp-server-versions', { vtsls: ' 1.0 ', pyright: '', x: '1', gopls: null })).toEqual(
      {
        ok: true,
        value: { vtsls: '1.0' },
      },
    );
    expect(ok('lsp-server-versions', [])).toEqual({ ok: false });
  });

  it('keeps review dimensions known and canonical, and refuses none', () => {
    expect(ok('review-dimensions', ['security', 'nope'])).toEqual({
      ok: true,
      value: ['security'],
    });
    expect(ok('review-dimensions', ['nope'])).toEqual({ ok: false });
    expect(ok('review-dimensions', [])).toEqual({ ok: false });
  });

  it('takes a boolean for RTK and a non-empty string for a version, and no other name', () => {
    expect(ok('rtk-enabled', false)).toEqual({ ok: true, value: false });
    expect(ok('rtk-enabled', 'false')).toEqual({ ok: false });
    expect(ok('rtk-version', ' 0.42.4 ')).toEqual({ ok: true, value: '0.42.4' });
    expect(ok('chrome-devtools-mcp-version', '')).toEqual({ ok: false });
    expect(ok('app-auth', {})).toEqual({ ok: false });
  });

  it('keeps the rules override as normalised text, and says why it refuses one', () => {
    expect(ok('agent-rules', 'a  \r\nb')).toEqual({ ok: true, value: 'a\nb\n' });
    expect(ok('agent-rules', '')).toEqual({ ok: true, value: '' });
    expect(ok('agent-rules', 7)).toEqual({ ok: false, reason: expect.stringMatching(/text/) });
    expect(ok('agent-rules', 'x\n=======\n')).toEqual({
      ok: false,
      reason: expect.stringMatching(/conflict marker/),
    });
  });
});

describe('normalizeAgentRulesOverride', () => {
  const CAP = 64 * 1024;
  const normalized = (input: unknown) => normalizeAgentRulesOverride(input);

  // [what the text has, what it is sent as, what is stored]
  const ACCEPTED: Array<[string, string, string]> = [
    ['no trailing newline', 'Rules', 'Rules\n'],
    ['its one trailing newline', 'Rules\n', 'Rules\n'],
    ['CRLF line ends', 'a\r\nb\r\n', 'a\nb\n'],
    ['a lone CR for a line end', 'a\rb\r', 'a\nb\n'],
    ['a BOM', '\uFEFFRules\n', 'Rules\n'],
    ['two BOMs, both going or the stored text would change again', '\uFEFF\uFEFFRules', 'Rules\n'],
    ['trailing spaces and tabs', 'a \t\nb\t \n', 'a\nb\n'],
    ['three or more blank lines', 'a\n\n\n\n\nb\n', 'a\n\nb\n'],
    ['its indentation and inner spaces', '  - a  b\n', '  - a  b\n'],
    ['a fenced block', '```ts\nconst a = 1;\n```\n', '```ts\nconst a = 1;\n```\n'],
    ['no text at all, an explicit empty override', '', ''],
    ['only spaces and newlines', '   \n\t\n', ''],
    ['only a BOM', '\uFEFF', ''],
    ['only no-break space and a line separator', '\u00a0\u2028', ''],
    ['a line of eight = (a rule, no marker)', 'Title\n========\n', 'Title\n========\n'],
    ['a line of six =', 'Title\n======\n', 'Title\n======\n'],
    ['seven < followed by a letter', '<<<<<<<x\n', '<<<<<<<x\n'],
    ['seven = inside a line', 'a ======= b\n', 'a ======= b\n'],
    ['a comment that is no Haive marker', '<!-- note -->\nx\n', '<!-- note -->\nx\n'],
    ['the word haive without a comment', 'haive: yes\n', 'haive: yes\n'],
    [
      'text over the cap before its trailing spaces are dropped',
      `${'a'.repeat(CAP - 1)}${' '.repeat(50)}\r\n`,
      `${'a'.repeat(CAP - 1)}\n`,
    ],
    ['exactly the cap in bytes', 'a'.repeat(CAP - 1), `${'a'.repeat(CAP - 1)}\n`],
    [
      'exactly the cap in bytes, in multibyte characters',
      `${'é'.repeat(CAP / 2 - 1)}a`,
      `${'é'.repeat(CAP / 2 - 1)}a\n`,
    ],
  ];

  it.each(ACCEPTED)('stores text with %s', (_what, input, stored) => {
    expect(normalized(input)).toEqual({ ok: true, value: stored });
  });

  it('stores what it stored again unchanged, and only text the record can write', () => {
    for (const [, input] of ACCEPTED) {
      const first = normalized(input);
      expect(first.ok).toBe(true);
      if (!first.ok) continue;
      expect(normalized(first.value)).toEqual(first);
      expect(rawTextProblem(first.value)).toBeNull();
    }
  });

  const REFUSED: Array<[string, unknown, RegExp]> = [
    ['a number', 7, /text/],
    ['null', null, /text/],
    ['undefined', undefined, /text/],
    ['a list', ['a'], /text/],
    ['a NUL', 'a\u0000b', /NUL/],
    ['a lone high surrogate', 'a\uD83D', /lone surrogate/],
    ['a lone low surrogate', '\uDC00a', /lone surrogate/],
    ['an opening Haive marker', '<!-- haive:cli-rules -->\nx\n', /Haive region marker/],
    ['a closing Haive marker', 'x\n<!-- /haive:rtk-ref -->\n', /Haive region marker/],
    ['a Haive marker spaced out', 'x <!--\n  /  haive:project-info -->', /Haive region marker/],
    ['a setext underline of seven =', 'Title\n=======\n', /conflict marker/],
    ['seven = alone', '=======', /conflict marker/],
    ['seven = after CRLF', 'a\r\n=======\r\n', /conflict marker/],
    ['seven = after a lone CR', 'a\r=======\rb', /conflict marker/],
    ['seven = after U+2028', 'a\u2028=======\nb', /conflict marker/],
    ['seven = after U+2029', 'a\u2029=======', /conflict marker/],
    ['seven = once its trailing spaces are dropped', 'a\n=======  \n', /conflict marker/],
    ['seven = once its trailing tab is dropped', 'a\n=======\t\n', /conflict marker/],
    ['an ours marker', '<<<<<<< ours\n', /conflict marker/],
    ['a theirs marker', '>>>>>>> theirs\n', /conflict marker/],
    ['a base marker', '||||||| base\n', /conflict marker/],
    ['a bare opening marker', 'x\n<<<<<<<\n', /conflict marker/],
    ['one byte over the cap', 'a'.repeat(CAP), /64 KiB/],
    ['two-byte characters, few of them but over the cap in bytes', 'é'.repeat(CAP / 2), /64 KiB/],
    ['four-byte characters, over the cap in bytes', '😀'.repeat(CAP / 4), /64 KiB/],
  ];

  it.each(REFUSED)('refuses %s, saying why', (_what, input, reason) => {
    expect(normalized(input)).toEqual({ ok: false, reason: expect.stringMatching(reason) });
  });

  it('finds a Haive marker in linear time after a long run of whitespace', () => {
    const started = performance.now();
    const refused = normalized(`<!--${'\u00a0'.repeat(100_000)}x`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(refused).toEqual({ ok: false, reason: expect.stringMatching(/64 KiB/) });
  });

  it('names the rule behind a refused marker line', () => {
    const refused = normalized('x\n=======\n');
    expect(!refused.ok && refused.reason).toMatch(/exactly seven =, <, > or \|/);
  });
});

describe('settingColumnUpdate', () => {
  it('names the column and the stored value', () => {
    expect(settingColumnUpdate('review-dimensions', ['security'])).toEqual({
      reviewDimensions: ['security'],
    });
    expect(settingColumnUpdate('rtk-enabled', false)).toEqual({ rtkEnabled: false });
  });

  it('unsets a column that can be unset, and writes nothing for one that cannot', () => {
    expect(settingColumnUpdate('rtk-version', undefined)).toEqual({ rtkVersion: null });
    expect(settingColumnUpdate('rtk-enabled', undefined)).toBeNull();
    expect(settingColumnUpdate('scope-exclude-globs', undefined)).toBeNull();
  });

  it('writes nothing for an unknown name or a value no column holds', () => {
    expect(settingColumnUpdate('app-auth', { loginUrl: 'x' })).toBeNull();
    expect(settingColumnUpdate('lsp-servers', 'vtsls')).toBeNull();
  });

  it('writes the rules override as normalised text, and NULL (the default) for no value', () => {
    expect(settingColumnUpdate('agent-rules', 'Be brief.\r\n')).toEqual({
      agentRulesOverride: 'Be brief.\n',
    });
    expect(settingColumnUpdate('agent-rules', '')).toEqual({ agentRulesOverride: '' });
    expect(isUnsettableSetting('agent-rules')).toBe(true);
    expect(settingColumnUpdate('agent-rules', undefined)).toEqual({ agentRulesOverride: null });
    expect(settingColumnUpdate('agent-rules', 7)).toBeNull();
    expect(settingColumnUpdate('agent-rules', 'x\n=======\n')).toBeNull();
  });
});

describe('intakeSettings', () => {
  it('passes a valid setting normalised, and a rejected one as this install holds it', () => {
    const intake = intakeSettings(
      { 'review-dimensions': ['nope'], 'rtk-version': '1', 'lsp-servers': ['vtsls', 'x'] },
      { 'review-dimensions': ['security'] },
    );
    expect(intake.incoming).toEqual({
      'review-dimensions': ['security'],
      'rtk-version': '1',
      'lsp-servers': ['vtsls'],
    });
    expect(intake.accepted).toEqual({ 'rtk-version': '1', 'lsp-servers': ['vtsls'] });
    expect(intake.rejected).toEqual(['review-dimensions']);
  });

  it('holds RTK and the scope list as this install has them where the checkout has none', () => {
    const intake = intakeSettings(
      {},
      { 'rtk-enabled': true, 'scope-exclude-globs': ['a'], 'rtk-version': '1' },
    );
    expect(intake.incoming).toEqual({ 'rtk-enabled': true, 'scope-exclude-globs': ['a'] });
    expect(intake.rejected).toEqual([]);
  });

  it('ignores a name that is not portable', () => {
    expect(intakeSettings({ 'app-auth': {}, 'from-the-future': 1 }, {}).incoming).toEqual({});
  });

  it('takes the checkout’s rules normalised, an empty text included', () => {
    for (const [text, stored] of [
      ['a\r\n', 'a\n'],
      ['', ''],
    ] as const) {
      const intake = intakeSettings({ 'agent-rules': text }, { 'agent-rules': 'mine\n' });
      expect(intake.incoming).toEqual({ 'agent-rules': stored });
      expect(intake.accepted).toEqual({ 'agent-rules': stored });
      expect(intake.rejected).toEqual([]);
    }
  });

  it('leaves rules no column could hold as this install has them', () => {
    const intake = intakeSettings({ 'agent-rules': 'a\n=======\n' }, { 'agent-rules': 'mine\n' });
    expect(intake.incoming).toEqual({ 'agent-rules': 'mine\n' });
    expect(intake.accepted).toEqual({});
    expect(intake.rejected).toEqual(['agent-rules']);
  });

  it('carries no rules where the checkout has none, so the merge sees them unset', () => {
    const intake = intakeSettings({}, { 'agent-rules': 'mine\n' });
    expect(Object.hasOwn(intake.incoming, 'agent-rules')).toBe(false);
    expect(intake.rejected).toEqual([]);
  });
});

describe('settingsDifferingFrom', () => {
  it('tells an empty rules override from none, so the writer writes the empty file', () => {
    expect(settingsDifferingFrom({ 'agent-rules': '' }, {}, new Set())).toEqual(['agent-rules']);
    expect(settingsDifferingFrom({ 'agent-rules': '' }, { 'agent-rules': '' }, new Set())).toEqual(
      [],
    );
  });
});

describe('the environment', () => {
  it('drops the prompt-only fields and carries the schema version into the column', () => {
    const env = normalizeEnvironment({
      envDetectData: { project: 1, __digest: 'x' },
      confirmedValues: { a: 1 },
    });
    expect(env).toEqual({ envDetectData: { project: 1 }, confirmedValues: { a: 1 } });
    expect(environmentColumnOf(env)).toEqual({ schemaVersion: 1, ...env });
    expect(environmentUnitOf(environmentColumnOf(env))).toEqual(env);
  });
});

describe('withoutUnchosenRtk', () => {
  const settings = { 'rtk-enabled': true, 'rtk-version': '1' };

  it('drops the RTK switch while the choice is not recorded, and nothing else', () => {
    expect({ ...withoutUnchosenRtk(settings, false) }).toEqual({ 'rtk-version': '1' });
  });

  it('keeps it once recorded, and never changes its input', () => {
    expect({ ...withoutUnchosenRtk(settings, true) }).toEqual(settings);
    withoutUnchosenRtk(settings, false);
    expect(settings['rtk-enabled']).toBe(true);
  });
});

describe('the onboarding tooling unit', () => {
  const local = {
    ragMode: 'internal',
    ollamaUrl: 'http://10.0.0.5:11434',
    ragConnectionString: 'postgres://u:p@h/d',
    acceptedMcpSettingsMark: 'mark',
    importedMcpServerNames: ['x'],
  };

  it('is no portable setting, so no merge or conflict row can name it', () => {
    expect(TOOLING_UNIT_NAME).toBe('onboarding-tooling');
    expect(isPortableSettingName(TOOLING_UNIT_NAME)).toBe(false);
    expect(PORTABLE_SETTING_NAMES).not.toContain(TOOLING_UNIT_NAME);
  });

  it('drops the infrastructure addresses and this install’s MCP consent, and nothing else', () => {
    expect(
      withoutMachineLocalTooling({ ...local, importedMcpSettingsJson: '{}', embeddingModel: 'm' }),
    ).toEqual({ ragMode: 'internal', embeddingModel: 'm' });
  });

  it('is the column’s tooling without them, never mutating the column', () => {
    const column = { schemaVersion: 1, tooling: { ...local } };

    expect(toolingUnitOf(column)).toEqual({ ragMode: 'internal' });
    expect(column.tooling).toEqual(local);
  });

  it('carries a server list held for consent as mcpSettingsJson, unless the column has its own', () => {
    const held = {
      importedMcpSettingsJson: '{"mcpServers":{"x":{}}}',
      importedMcpServerNames: ['x'],
    };

    expect(toolingUnitOf({ schemaVersion: 1, tooling: { ragMode: 'none', ...held } })).toEqual({
      ragMode: 'none',
      mcpSettingsJson: '{"mcpServers":{"x":{}}}',
    });
    expect(
      toolingUnitOf({ schemaVersion: 1, tooling: { ...held, mcpSettingsJson: '{"own":1}' } }),
    ).toEqual({ mcpSettingsJson: '{"own":1}' });
  });

  it.each([
    ['nothing', null],
    ['another schema version', { schemaVersion: 2, tooling: { ragMode: 'none' } }],
    ['no tooling object', { schemaVersion: 1, tooling: [] }],
    ['a list', []],
    ['a unit past the file limit', { schemaVersion: 1, tooling: { pad: 'x'.repeat(1024 * 1024) } }],
    [
      'a unit past the file limit in bytes, though not in characters',
      { schemaVersion: 1, tooling: { pad: 'é'.repeat(512 * 1024) } },
    ],
  ])('has no unit for a column holding %s', (_what, column) => {
    expect(toolingUnitOf(column)).toBeNull();
  });

  it('keeps a unit of multi-byte text that stays inside the file limit in bytes', () => {
    const tooling = { pad: 'é'.repeat(512 * 1024 - 100) };

    expect(toolingUnitOf({ schemaVersion: 1, tooling })).toEqual(tooling);
  });

  it('reads a checkout’s value only when it is an object', () => {
    expect(toolingUnitFrom({ ragMode: 'none' })).toEqual({ ragMode: 'none' });
    for (const value of [null, [], 'x', 1, undefined]) expect(toolingUnitFrom(value)).toBeNull();
  });
});
