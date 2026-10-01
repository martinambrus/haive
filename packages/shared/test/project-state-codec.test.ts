import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  FOREIGN_TEMPLATE,
  PROJECT_STATE_FORMAT,
  ProjectStateError,
  canonicalJson,
  claimFileName,
  emptyProjectState,
  gitBlobId,
  localTemplateId,
  normalizeProjectState,
  parseProjectState,
  portableBundleSource,
  portableTemplateId,
  projectStateHash,
  renderProjectState,
  sameValue,
  type ProjectStateClaim,
  type ProjectStateRecord,
} from '../src/project-state/index.js';

const claim = (path: string, extra: Partial<ProjectStateClaim> = {}): ProjectStateClaim => ({
  path,
  templateId: `agent.${path}`,
  kind: 'agent',
  schemaVersion: 1,
  templateHash: `t-${path}`,
  writtenHash: `w-${path}`,
  haiveVersion: '0.0.0-dev',
  ...extra,
});

const record = (): ProjectStateRecord => ({
  environment: {
    envDetectData: { project: { name: 'p', framework: 'drupal' } },
    confirmedValues: { framework: 'drupal' },
  },
  render: {
    projectInfo: { name: 'p' },
    framework: 'drupal',
    acceptedAgentIds: ['security-auditor', 'code-reviewer'],
    customAgentSpecs: [],
    lspLanguages: ['php-extended'],
  },
  cli: ['claude-code'],
  settings: { 'rtk-enabled': false, 'scope-exclude-globs': ['vendor/**', 'build/**'] },
  claims: [claim('.claude/agents/code-reviewer.md'), claim('AGENTS.md')],
  bundles: [{ source: 'git:https://example.com/b.git#main', name: 'b' }],
});

const withFile = (files: Map<string, string>, rel: string, text: string | null) => {
  const next = new Map(files);
  if (text === null) next.delete(rel);
  else next.set(rel, text);
  return next;
};

describe('canonicalJson', () => {
  it('sorts keys at every depth and ends with one newline', () => {
    const text = canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 'x' } });
    expect(text).toBe(
      '{\n  "a": {\n    "c": "x",\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});

describe('claimFileName', () => {
  it('flattens the path, drops leading dots and ends with its own hash', () => {
    expect(claimFileName('.claude/agents/code-reviewer.md')).toMatch(
      /^artifacts\/claude__agents__code-reviewer\.md~[0-9a-f]{32}\.json$/,
    );
  });

  it('keeps two paths that slug alike apart', () => {
    expect(claimFileName('.a/b')).not.toBe(claimFileName('a/b'));
  });

  it('keeps two paths apart whose slugs agree and whose hashes share eight hex digits', () => {
    const a = '.a/.a/a/.a/.a/a/a/.a/a/.a/a/a/.a/.a/.a/a/.a/a/a/a';
    const b = 'a/a/a/.a/a/a/.a/.a/.a/.a/.a/.a/.a/a/.a/.a/.a/a/a/a';
    const parsed = parseProjectState(
      renderProjectState({ ...emptyProjectState(), claims: [claim(a), claim(b)] }),
    );
    expect(parsed.ok && parsed.record.claims.map((c) => c.path)).toEqual([a, b]);
  });

  it('stays inside a file name the filesystem accepts', () => {
    const name = claimFileName(`${'d'.repeat(120)}/${'é'.repeat(150)}.md`).split('/')[1]!;
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
  });
});

describe('renderProjectState and parseProjectState', () => {
  it('render the same bytes whatever order the record arrives in', () => {
    const a = record();
    const b = record();
    b.render!.acceptedAgentIds.reverse();
    b.settings = { 'scope-exclude-globs': ['build/**', 'vendor/**'], 'rtk-enabled': false };
    b.claims.reverse();
    expect(renderProjectState(b)).toEqual(renderProjectState(a));
  });

  it('write every file in canonical form', () => {
    for (const [rel, text] of renderProjectState(record())) {
      expect(text.endsWith('\n'), rel).toBe(true);
      expect(text.includes('\r'), rel).toBe(false);
      expect(canonicalJson(JSON.parse(text))).toBe(text);
    }
  });

  it('read back what they write, byte for byte', () => {
    const files = renderProjectState(record());
    const parsed = parseProjectState(files);
    expect(parsed).toMatchObject({ ok: true, ignored: [] });
    if (!parsed.ok) return;
    expect(parsed.record).toEqual(normalizeProjectState(record()));
    expect(renderProjectState(parsed.record)).toEqual(files);
  });

  it('carry only the schema keys of a claim handed in with more', () => {
    const r = record();
    r.claims = [{ ...claim('AGENTS.md'), id: 'row-1' } as ProjectStateClaim];
    expect(renderProjectState(r).get(claimFileName('AGENTS.md'))).not.toContain('row-1');
  });

  it('refuse to write a claim that is not a repository path, or one claimed twice', () => {
    const outside = record();
    outside.claims.push(claim('../outside'));
    expect(() => renderProjectState(outside)).toThrow(ProjectStateError);
    const twice = record();
    twice.claims.push(claim('AGENTS.md'));
    expect(() => renderProjectState(twice)).toThrow(/claimed twice/);
  });

  it('leave out and list files no kind claims, as a newer release may write them', () => {
    let files = renderProjectState(record());
    files = withFile(files, 'settings/agent-rules.md', '# rules\n');
    files = withFile(files, 'future/thing.json', '{}\n');
    files = withFile(files, 'artifacts/nested/x.json', '{}\n');
    const parsed = parseProjectState(files);
    expect(parsed.ok && parsed.ignored).toEqual([
      'artifacts/nested/x.json',
      'future/thing.json',
      'settings/agent-rules.md',
    ]);
  });

  it('refuse a record with conflict markers in any file, naming it', () => {
    const files = withFile(
      renderProjectState(record()),
      'settings/rtk-enabled.json',
      '<<<<<<< ours\ntrue\n=======\nfalse\n>>>>>>> theirs\n',
    );
    expect(parseProjectState(files)).toEqual({
      ok: false,
      reason: 'invalid',
      problems: ['settings/rtk-enabled.json: holds merge conflict markers'],
    });
  });

  it('refuse a record from a newer format, saying so apart from damage', () => {
    const files = withFile(
      renderProjectState(record()),
      'format.json',
      canonicalJson({ schemaVersion: PROJECT_STATE_FORMAT + 1 }),
    );
    expect(parseProjectState(files)).toMatchObject({ ok: false, reason: 'newer-format' });
  });

  it.each([
    [
      'no format.json',
      (f: Map<string, string>) => withFile(f, 'format.json', null),
      'format.json is missing',
    ],
    [
      'a file that is not JSON',
      (f: Map<string, string>) => withFile(f, 'settings/rtk-enabled.json', '{'),
      'settings/rtk-enabled.json: is not JSON',
    ],
    [
      'a setting holding null',
      (f: Map<string, string>) => withFile(f, 'settings/rtk-enabled.json', 'null\n'),
      'settings/rtk-enabled.json: holds no value',
    ],
    [
      'a set setting that is not a list of strings',
      (f: Map<string, string>) => withFile(f, 'settings/scope-exclude-globs.json', '[1]\n'),
      'settings/scope-exclude-globs.json: is not a list of strings',
    ],
    [
      'a CLI file naming another CLI',
      (f: Map<string, string>) =>
        withFile(f, 'cli/codex.json', canonicalJson({ provider: 'claude-code' })),
      'cli/codex.json: names "claude-code"',
    ],
    [
      'a claim under another file name',
      (f: Map<string, string>) => {
        const name = claimFileName('AGENTS.md');
        return withFile(withFile(f, name, null), 'artifacts/elsewhere~00000000.json', f.get(name)!);
      },
      'artifacts/elsewhere~00000000.json: is not the file for "AGENTS.md"',
    ],
    [
      'a claim outside the repository',
      (f: Map<string, string>) => withFile(f, claimFileName('../x'), canonicalJson(claim('../x'))),
      `${claimFileName('../x')}: "../x" is not a repository path`,
    ],
  ])('refuse %s, whole', (_name, damage, problem) => {
    const parsed = parseProjectState(damage(renderProjectState(record())));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toContain(problem);
  });

  it('refuse a claim missing a field, naming it', () => {
    const name = claimFileName('AGENTS.md');
    const { writtenHash: _gone, ...partial } = claim('AGENTS.md');
    const parsed = parseProjectState(
      withFile(renderProjectState(record()), name, canonicalJson(partial)),
    );
    expect(!parsed.ok && parsed.problems.join('\n')).toContain(`${name}: writtenHash`);
  });
});

describe('renderProjectState refuses what JSON cannot carry', () => {
  it('refuses a setting holding NaN', () => {
    const r = record();
    r.settings.x = NaN;
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
    expect(() => renderProjectState(r)).toThrow(/settings\/x\.json/);
  });

  it('refuses a setting holding a bigint', () => {
    const r = record();
    r.settings.x = 10n;
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
  });

  it('refuses a setting holding an array with an undefined element', () => {
    const r = record();
    r.settings.x = { a: [1, undefined] };
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
  });

  it('refuses a setting holding a Date', () => {
    const r = record();
    r.settings.x = { when: new Date(0) };
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
  });

  it('refuses a setting holding Infinity', () => {
    const r = record();
    r.settings.x = { a: Infinity };
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
  });

  it('refuses a setting whose value points back at itself', () => {
    const r = record();
    const x: Record<string, unknown> = {};
    x.self = x;
    r.settings.x = x;
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
  });

  it('refuses render.projectInfo holding NaN', () => {
    const r = record();
    r.render!.projectInfo = { n: NaN };
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
    expect(() => renderProjectState(r)).toThrow(/project\/render\.json/);
  });

  it('refuses environment.envDetectData holding a bigint', () => {
    const r = record();
    r.environment!.envDetectData = { big: 1n };
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
    expect(() => renderProjectState(r)).toThrow(/project\/environment\.json/);
  });

  it('refuses a claim with an invalid schemaVersion', () => {
    const withNaN = record();
    withNaN.claims[0]!.schemaVersion = NaN;
    expect(() => renderProjectState(withNaN)).toThrow(ProjectStateError);
    const withNegative = record();
    withNegative.claims[0]!.schemaVersion = -1;
    expect(() => renderProjectState(withNegative)).toThrow(ProjectStateError);
  });

  it('renders a setting holding an undefined property without it, and reads that back', () => {
    const r = record();
    r.settings.x = { a: 1, b: undefined };
    const parsed = parseProjectState(renderProjectState(r));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.settings.x).toEqual({ a: 1 });
  });

  it('writes a negative zero as 0, which the record holds equal to it', () => {
    const r = record();
    r.settings.x = { a: -0 };
    const files = renderProjectState(r);
    const parsed = parseProjectState(files);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.is((parsed.record.settings.x as { a: number }).a, 0)).toBe(true);
    expect(sameValue(parsed.record.settings.x, r.settings.x)).toBe(true);
    expect(renderProjectState(parsed.record)).toEqual(files);
  });

  it('refuses a record whose settings carries an own __proto__ key', () => {
    const r = record();
    r.settings = JSON.parse('{"__proto__": 1}');
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
    expect(() => renderProjectState(r)).toThrow(/__proto__/);
  });
});

describe('a value nested past the bound', () => {
  const nested = (levels: number): unknown => {
    let value: unknown = [];
    for (let i = 1; i < levels; i++) value = [value];
    return value;
  };

  it('reads a file nested 10,000 deep as refused, not as a thrown error', () => {
    const files = withFile(
      renderProjectState(record()),
      'settings/deep.json',
      `${'['.repeat(10_000)}${']'.repeat(10_000)}\n`,
    );
    const parsed = parseProjectState(files);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.join('\n')).toContain('nests deeper than 64 levels');
  });

  it('refuses to write one with ProjectStateError', () => {
    const r = record();
    r.settings.deep = nested(10_000);
    expect(() => renderProjectState(r)).toThrow(ProjectStateError);
  });

  it('takes a value exactly at the bound and refuses one level more', () => {
    const at = record();
    at.settings.deep = nested(64);
    expect(parseProjectState(renderProjectState(at)).ok).toBe(true);
    const over = record();
    over.settings.deep = nested(65);
    expect(() => renderProjectState(over)).toThrow(/nests deeper than 64 levels/);
  });
});

describe('parseProjectState reads a setting only under a record name', () => {
  it('refuses a settings/__proto__.json file holding an object', () => {
    const files = withFile(
      renderProjectState(emptyProjectState()),
      'settings/__proto__.json',
      '{"x":1}\n',
    );
    const parsed = parseProjectState(files);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.join('\n')).toContain('__proto__');
  });

  it('refuses a settings/__proto__.json file holding a bare value', () => {
    const files = withFile(
      renderProjectState(emptyProjectState()),
      'settings/__proto__.json',
      '1\n',
    );
    const parsed = parseProjectState(files);
    expect(parsed.ok).toBe(false);
  });
});

describe('parseProjectState refuses a key JSON parsing would drop', () => {
  it('refuses a project file holding a __proto__ key', () => {
    const base = renderProjectState(emptyProjectState());
    const render = withFile(
      base,
      'project/render.json',
      '{"acceptedAgentIds":[],"customAgentSpecs":[],"framework":null,"lspLanguages":[],"projectInfo":{"__proto__":{"x":1}}}\n',
    );
    const environment = withFile(
      base,
      'project/environment.json',
      '{"confirmedValues":{},"envDetectData":{"__proto__":{"x":1}}}\n',
    );
    for (const files of [render, environment]) {
      const parsed = parseProjectState(files);
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.problems.join('\n')).toContain('__proto__');
    }
  });
});

describe('portable template ids', () => {
  const source = portableBundleSource({
    sourceType: 'git',
    gitUrl: 'https://example.com/b.git',
    gitBranch: 'main',
    name: 'b',
  });
  const bundles = [{ bundleId: 'bundle-a', source, items: new Map([['item-1', 'agents/x.md']]) }];

  it('tell two git bundles apart whose url and branch join to one string', () => {
    const inUrl = portableBundleSource({
      sourceType: 'git',
      gitUrl: 'git@example.com:repo#feature',
      gitBranch: 'x',
      name: 'b',
    });
    const inBranch = portableBundleSource({
      sourceType: 'git',
      gitUrl: 'git@example.com:repo',
      gitBranch: 'feature#x',
      name: 'b',
    });
    expect(inUrl).not.toBe(inBranch);
  });

  it("keep Haive's own ids as they are", () => {
    expect(portableTemplateId('agent.code-reviewer', bundles)).toBe('agent.code-reviewer');
    expect(localTemplateId('agent.code-reviewer', bundles)).toBe('agent.code-reviewer');
  });

  it('map a custom item by its source and path, and back to the ids this install gave it', () => {
    const portable = portableTemplateId('custom.bundle-a.item-1', bundles);
    expect(portable).toBe(`custom:${encodeURIComponent(source)}:agents%2Fx.md`);
    expect(localTemplateId(portable!, bundles)).toBe('custom.bundle-a.item-1');
    const elsewhere = [
      { bundleId: 'bundle-b', source, items: new Map([['item-9', 'agents/x.md']]) },
    ];
    expect(localTemplateId(portable!, elsewhere)).toBe('custom.bundle-b.item-9');
  });

  it('name an item this install does not hold, and a malformed id, as foreign', () => {
    expect(portableTemplateId('custom.bundle-z.item-1', bundles)).toBeNull();
    expect(localTemplateId(`custom:${encodeURIComponent(source)}:other.md`, bundles)).toBe(
      FOREIGN_TEMPLATE,
    );
    expect(localTemplateId('custom:no-separator', bundles)).toBe(FOREIGN_TEMPLATE);
    expect(localTemplateId('custom:%E0%A4%A:x', bundles)).toBe(FOREIGN_TEMPLATE);
  });
});

describe('hashes', () => {
  it("give a file the id git gives it in the repository's object format", () => {
    // MEASURED against git 2.54: `git hash-object` on a sha256 repository and on a sha1 one.
    expect(gitBlobId('hello\n', 'sha256')).toBe(
      '2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4',
    );
    expect(gitBlobId('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('give a file the id git gives it', () => {
    for (const content of ['hello\n', '', '{\n  "a": "é"\n}\n']) {
      const git = execFileSync('git', ['hash-object', '--stdin'], {
        input: content,
        encoding: 'utf8',
      });
      expect(gitBlobId(content)).toBe(git.trim());
    }
  });

  it('hash the record by its files, whatever order they are listed in', () => {
    const a = new Map([
      ['format.json', gitBlobId('x')],
      ['cli/codex.json', gitBlobId('y')],
    ]);
    const b = new Map([...a].reverse());
    expect(projectStateHash(b)).toBe(projectStateHash(a));
    expect(projectStateHash(new Map([...a, ['format.json', gitBlobId('z')]]))).not.toBe(
      projectStateHash(a),
    );
  });
});
