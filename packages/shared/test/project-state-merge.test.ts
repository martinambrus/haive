import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  claimFileName,
  mergeProjectState,
  normalizeProjectState,
  renderProjectState,
  type ProjectStateClaim,
  type ProjectStateRecord,
} from '../src/project-state/index.js';

const claim = (p: string, writtenHash = `w-${p}`): ProjectStateClaim => ({
  path: p,
  templateId: `agent.${p}`,
  kind: 'agent',
  schemaVersion: 1,
  templateHash: `t-${p}`,
  writtenHash,
  haiveVersion: '0.0.0-dev',
});

const base = (): ProjectStateRecord => ({
  environment: {
    envDetectData: { project: { name: 'p' } },
    confirmedValues: { framework: 'drupal' },
  },
  render: {
    projectInfo: { name: 'p' },
    framework: 'drupal',
    acceptedAgentIds: ['code-reviewer'],
    customAgentSpecs: [],
    lspLanguages: ['php-extended'],
  },
  cli: ['claude-code'],
  settings: { 'rtk-enabled': true, 'rtk-version': '0.30.0', 'scope-exclude-globs': ['vendor/**'] },
  claims: [claim('AGENTS.md'), claim('.claude/agents/code-reviewer.md')],
  bundles: [],
});

const edit = (fn: (r: ProjectStateRecord) => void): ProjectStateRecord => {
  const r = base();
  fn(r);
  return r;
};

const RTK = 'settings/rtk-enabled.json';

describe('mergeProjectState, unit by unit', () => {
  it.each([
    ['neither side changed it', true, true, true, []],
    ['only this install changed it', false, true, false, []],
    ['only the other install changed it', true, false, false, []],
    ['both changed it alike', false, false, false, []],
  ])('keeps the right value when %s', (_name, local, incoming, expected, conflicts) => {
    const result = mergeProjectState({
      base: base(),
      local: edit((r) => (r.settings['rtk-enabled'] = local)),
      incoming: edit((r) => (r.settings['rtk-enabled'] = incoming)),
    });
    expect(result.merged.settings['rtk-enabled']).toBe(expected);
    expect(result.conflicts).toEqual(conflicts);
  });

  it('holds a value both sides changed differently as a conflict, the local one standing', () => {
    const result = mergeProjectState({
      base: base(),
      local: edit((r) => (r.settings['rtk-version'] = '0.31.0')),
      incoming: edit((r) => (r.settings['rtk-version'] = '0.32.0')),
    });
    expect(result.merged.settings['rtk-version']).toBe('0.31.0');
    expect(result.conflicts).toEqual([
      { unit: 'settings/rtk-version.json', base: '0.30.0', local: '0.31.0', incoming: '0.32.0' },
    ]);
  });

  it('takes a removal the other side made to a value this one left alone', () => {
    const result = mergeProjectState({
      base: base(),
      local: base(),
      incoming: edit((r) => delete r.settings['rtk-version']),
    });
    expect('rtk-version' in result.merged.settings).toBe(false);
  });

  it('holds a removal against a change as a conflict', () => {
    const result = mergeProjectState({
      base: base(),
      local: edit((r) => (r.settings['rtk-version'] = '0.31.0')),
      incoming: edit((r) => delete r.settings['rtk-version']),
    });
    expect(result.conflicts).toEqual([
      { unit: 'settings/rtk-version.json', base: '0.30.0', local: '0.31.0', incoming: undefined },
    ]);
  });

  it('merges a project file key by key, so changes to different keys both land', () => {
    const result = mergeProjectState({
      base: base(),
      local: edit((r) => (r.render!.framework = 'drupal7')),
      incoming: edit((r) => r.render!.acceptedAgentIds.push('security-auditor')),
    });
    expect(result.merged.render).toMatchObject({
      framework: 'drupal7',
      acceptedAgentIds: ['code-reviewer', 'security-auditor'],
    });
    expect(result.conflicts).toEqual([]);
  });

  it('names the key of a project file both sides changed', () => {
    const result = mergeProjectState({
      base: base(),
      local: edit((r) => (r.render!.framework = 'drupal7')),
      incoming: edit((r) => (r.render!.framework = 'laravel')),
    });
    expect(result.conflicts.map((c) => c.unit)).toEqual(['project/render.json#framework']);
  });

  it('holds a project file removed on one side and changed on the other as one conflict', () => {
    const result = mergeProjectState({
      base: base(),
      local: edit((r) => (r.render!.framework = 'drupal7')),
      incoming: edit((r) => (r.render = null)),
    });
    expect(result.conflicts.map((c) => c.unit)).toEqual(['project/render.json']);
    expect(result.merged.render?.framework).toBe('drupal7');
  });

  it('moves each member of a set as the side that changed it says, and never conflicts', () => {
    const result = mergeProjectState({
      base: base(),
      local: edit((r) => {
        r.cli.push('codex');
        r.settings['scope-exclude-globs'] = [];
      }),
      incoming: edit((r) => {
        r.cli = ['gemini'];
        r.settings['scope-exclude-globs'] = ['vendor/**', 'build/**'];
      }),
    });
    expect(result.merged.cli).toEqual(['codex', 'gemini']);
    expect(result.merged.settings['scope-exclude-globs']).toEqual(['build/**']);
    expect(result.conflicts).toEqual([]);
  });

  it('reads a set in another order as the same set', () => {
    const result = mergeProjectState({
      base: base(),
      local: edit((r) => (r.render!.acceptedAgentIds = ['code-reviewer'])),
      incoming: edit((r) => {
        r.render!.lspLanguages = ['php-extended'];
        r.cli = ['claude-code', 'claude-code'];
      }),
    });
    expect(result.merged).toEqual(normalizeProjectState(base()));
  });
});

describe('mergeProjectState, claims both sides changed', () => {
  const PATH = 'AGENTS.md';
  const changed = (hash: string) => edit((r) => (r.claims[0] = claim(PATH, hash)));
  const removed = () => edit((r) => r.claims.splice(0, 1));
  const claimOf = (r: ProjectStateRecord) => r.claims.find((c) => c.path === PATH);

  it('follow the bytes on disk to the side whose writtenHash they hold', () => {
    const local = changed('w-local');
    const incoming = changed('w-incoming');
    const toIncoming = mergeProjectState({
      base: base(),
      local,
      incoming,
      diskHash: () => 'w-incoming',
    });
    expect(claimOf(toIncoming.merged)?.writtenHash).toBe('w-incoming');
    expect(toIncoming.conflicts).toEqual([]);
    const toLocal = mergeProjectState({ base: base(), local, incoming, diskHash: () => 'w-local' });
    expect(claimOf(toLocal.merged)?.writtenHash).toBe('w-local');
  });

  it('are a conflict when the bytes hold neither, or nothing says what they hold', () => {
    const local = changed('w-local');
    const incoming = changed('w-incoming');
    for (const diskHash of [() => 'w-other', undefined]) {
      const result = mergeProjectState({ base: base(), local, incoming, diskHash });
      expect(result.conflicts.map((c) => c.unit)).toEqual([claimFileName(PATH)]);
      expect(claimOf(result.merged)?.writtenHash).toBe('w-local');
    }
  });

  it('follow a removal the bytes agree with: no file there', () => {
    const result = mergeProjectState({
      base: base(),
      local: changed('w-local'),
      incoming: removed(),
      diskHash: () => null,
    });
    expect(claimOf(result.merged)).toBeUndefined();
    expect(result.conflicts).toEqual([]);
  });
});

describe('mergeProjectState with no base (a first import)', () => {
  it('takes what the other install holds, reports what it replaced and keeps local additions', () => {
    const result = mergeProjectState({
      base: null,
      local: edit((r) => {
        r.settings['rtk-enabled'] = false;
        r.settings['local-only'] = 'kept';
        r.cli = ['codex'];
      }),
      incoming: base(),
    });
    expect(result.merged.settings).toMatchObject({ 'rtk-enabled': true, 'local-only': 'kept' });
    expect(result.merged.cli).toEqual(['claude-code', 'codex']);
    expect(result.overwritten).toEqual([RTK]);
    expect(result.conflicts).toEqual([]);
  });
});

describe('the file layout keeps git merges unit by unit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'project-state-merge-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** git merge-file on one file's three versions; null when it conflicts. */
  function mergeFile(baseText: string, ours: string, theirs: string): string | null {
    const files = ['ours', 'base', 'theirs'].map((name, i) => {
      const file = path.join(dir, name);
      writeFileSync(file, [ours, baseText, theirs][i]!);
      return file;
    });
    const run = spawnSync('git', ['merge-file', '-p', ...files], { encoding: 'utf8' });
    if (run.status === null || run.status < 0) throw new Error(run.stderr);
    return run.status === 0 ? run.stdout : null;
  }

  /** What git's tree merge does with the rendered records: file by file, adds and removals by
   *  path. Null when any file conflicts. */
  function gitMerge(b: Map<string, string>, o: Map<string, string>, t: Map<string, string>) {
    const out = new Map<string, string>();
    for (const rel of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
      const [bv, ov, tv] = [b.get(rel), o.get(rel), t.get(rel)];
      let merged: string | undefined | null;
      if (ov === tv) merged = ov;
      else if (bv === ov) merged = tv;
      else if (bv === tv) merged = ov;
      else if (bv !== undefined && ov !== undefined && tv !== undefined)
        merged = mergeFile(bv, ov, tv);
      else merged = null;
      if (merged === null) return null;
      if (merged !== undefined) out.set(rel, merged);
    }
    return out;
  }

  // Each touches one file of the record, as two installs editing different things would.
  const EDITS: Array<[string, (r: ProjectStateRecord) => void]> = [
    ['RTK switched off', (r) => (r.settings['rtk-enabled'] = false)],
    ['RTK pinned', (r) => (r.settings['rtk-version'] = '0.31.0')],
    ['a CLI added', (r) => r.cli.push('codex')],
    ['a claim added', (r) => r.claims.push(claim('.claude/agents/architect.md'))],
    ['a claim rewritten', (r) => (r.claims[1] = claim('.claude/agents/code-reviewer.md', 'w-new'))],
    ['a claim removed', (r) => r.claims.splice(0, 1)],
    ['a bundle added', (r) => r.bundles.push({ source: 'zip:extras', name: 'extras' })],
    ['a framework chosen', (r) => (r.render!.framework = 'drupal7')],
  ];

  it.each(
    EDITS.flatMap(([a, fa], i) => EDITS.slice(i + 1).map(([b, fb]) => [a, b, fa, fb] as const)),
  )('merges "%s" against "%s" cleanly, to what the record merge gives', (_a, _b, fa, fb) => {
    const ours = edit(fa);
    const theirs = edit(fb);
    const merged = gitMerge(
      renderProjectState(base()),
      renderProjectState(ours),
      renderProjectState(theirs),
    );
    expect(merged).not.toBeNull();
    const expected = mergeProjectState({ base: base(), local: ours, incoming: theirs });
    expect(expected.conflicts).toEqual([]);
    expect(merged).toEqual(renderProjectState(expected.merged));
  });

  it('where one pretty JSON file holding the same units would conflict', () => {
    const asOneFile = (r: ProjectStateRecord) =>
      canonicalJson(
        Object.fromEntries([...renderProjectState(r)].map(([k, v]) => [k, JSON.parse(v)])),
      );
    const ours = edit((r) => (r.settings['rtk-enabled'] = false));
    const theirs = edit((r) => (r.settings['rtk-version'] = '0.31.0'));
    expect(mergeFile(asOneFile(base()), asOneFile(ours), asOneFile(theirs))).toBeNull();
    expect(
      gitMerge(renderProjectState(base()), renderProjectState(ours), renderProjectState(theirs)),
    ).not.toBeNull();
  });
});
