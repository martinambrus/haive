import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFrontmatterFields, unquoteYamlScalar, yamlScalar } from './_yaml-scalar.js';

// Values a description, name or field has actually held, plus every shape that changes what a
// YAML parser reads: mapping and comment indicators, leading indicators, and scalars that would
// resolve to something other than a string under YAML 1.1 or 1.2.
const TRICKY = [
  'Security-focused review of a diff: injection, access control.',
  "For 'implement X like Y' requests: finds the reference implementation.",
  'Owns the "Excel export" button: grids',
  'back\\slash: x',
  'Ends with a colon:',
  'has a # comment',
  '- leading dash',
  '? q',
  '@at',
  '`tick`',
  '%pct',
  '*star',
  '&amp',
  '!bang',
  '|pipe',
  '>gt',
  '[a]',
  '{a}',
  "'quoted'",
  '"quoted"',
  'yes',
  'off',
  'true',
  'null',
  '~',
  '123',
  '0755',
  '0o17',
  '2026-01-01',
  'trailing ',
  ' leading',
  '',
  'two\nlines',
];

describe('yamlScalar', () => {
  it('keeps a value that already parses as itself byte-identical', () => {
    for (const plain of [
      'Performs behavior-preserving refactors in small, test-verified increments.',
      'BUNDLE TEST — Drupal 7 custom module development in sites/all/modules.',
      'code-reviewer',
      'has#hash',
      'x:y',
      'http://example.com/path',
    ]) {
      expect(yamlScalar(plain)).toBe(plain);
    }
  });

  it('double-quotes every value a plain scalar would misread', () => {
    for (const value of TRICKY) {
      expect(yamlScalar(value)).toBe(JSON.stringify(value));
    }
  });

  it('reads back as exactly the input under YAML 1.1 and 1.2', () => {
    for (const value of TRICKY) {
      for (const version of ['1.1', '1.2'] as const) {
        expect(parse(`description: ${yamlScalar(value)}`, { version }).description).toBe(value);
      }
    }
  });
});

describe('unquoteYamlScalar', () => {
  it('is the inverse of yamlScalar', () => {
    for (const value of TRICKY) {
      expect(unquoteYamlScalar(yamlScalar(value))).toBe(value);
    }
  });

  it('undoes the single-quote escape of a hand-written value', () => {
    expect(unquoteYamlScalar("'it''s here'")).toBe("it's here");
  });

  it('unwraps a double-quoted value carrying an escape JSON does not know', () => {
    expect(unquoteYamlScalar('"a\\x41"')).toBe('a\\x41');
  });

  it('leaves plain and half-quoted values alone', () => {
    expect(unquoteYamlScalar('plain value')).toBe('plain value');
    expect(unquoteYamlScalar('"open only')).toBe('"open only');
    expect(unquoteYamlScalar('"')).toBe('"');
  });
});

describe('readFrontmatterFields', () => {
  it('reads a folded description the way the legacy agent files write it', () => {
    const fields = readFrontmatterFields(
      [
        'name: issue-advisor',
        'description: >',
        '  Middle-loop recovery advisor for DAG execution. Diagnoses why an issue failed',
        '  the inner review loop and decides the optimal recovery strategy.',
        'model: opus',
      ].join('\n'),
    );
    expect(fields).toEqual({
      name: 'issue-advisor',
      description:
        'Middle-loop recovery advisor for DAG execution. Diagnoses why an issue failed the inner review loop and decides the optimal recovery strategy.',
      model: 'opus',
    });
  });

  it('keeps paragraph breaks in a folded scalar and newlines in a literal one', () => {
    const fields = readFrontmatterFields(
      [
        'folded: >-',
        '  one',
        '  two',
        '',
        '  three',
        'literal: |',
        '  a',
        '    b',
        'after: x',
      ].join('\n'),
    );
    expect(fields.folded).toBe('one two\nthree');
    expect(fields.literal).toBe('a\n  b');
    expect(fields.after).toBe('x');
  });

  it('still reads a plain value a YAML parser rejects, and decodes a quoted one', () => {
    const fields = readFrontmatterFields(
      [
        '# comment',
        'description: Reviews diffs: logic, style.',
        'field: "perf: hot paths"',
        "title: 'it''s'",
      ].join('\n'),
    );
    expect(fields).toEqual({
      description: 'Reviews diffs: logic, style.',
      field: 'perf: hot paths',
      title: "it's",
    });
  });

  it('folds one nested level into dotted keys, only under a key without a value', () => {
    const fields = readFrontmatterFields(
      ['kb-references:', '  patterns: a/b/', '  standards: "c.md"', 'name: x', '  stray: y'].join(
        '\n',
      ),
    );
    expect(fields).toEqual({
      'kb-references': '',
      'kb-references.patterns': 'a/b/',
      'kb-references.standards': 'c.md',
      name: 'x',
    });
  });
});
