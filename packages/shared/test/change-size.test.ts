import { beforeAll, describe, expect, it } from 'vitest';
import { initializeChangeSize, type ChangeSizeCounter } from '../src/change-size.js';
import manifest from '../package.json' with { type: 'json' };

let counter: ChangeSizeCounter;
beforeAll(async () => {
  counter = await initializeChangeSize();
});
const file = (path: string, base: string, head: string) => counter([{ path, base, head }]);

it('keeps exported dependency versions equal to the exact manifest pins', async () => {
  const { CHANGE_SIZE_DEPENDENCIES } = await import('../src/change-size.js');
  expect(CHANGE_SIZE_DEPENDENCIES).toEqual({
    runtimeVersion: manifest.dependencies['web-tree-sitter'],
    grammarPackageVersion: manifest.dependencies['@vscode/tree-sitter-wasm'],
  });
});

describe('syntax change size', () => {
  it.each([
    ['a.py', 'value = 1\n', 'renamed = 1\n'],
    ['a.ts', 'const value = 1;', 'const renamed = 1;'],
    ['a.js', 'const value = 1;', 'const renamed = 1;'],
    ['a.tsx', 'const value = <div/>;', 'const renamed = <div/>;'],
    ['a.php', '<?php $value = 1;', '<?php $renamed = 1;'],
  ])('counts a renamed name as a replacement in %s', (path, base, head) => {
    expect(file(path, base, head).files[0]?.size).toMatchObject({
      added: 1,
      deleted: 1,
      net: 0,
      churn: 2,
      structuralChurn: 0,
      approximate: false,
    });
  });
  it.each([
    ['a.py', 'value=1\n', '# comment\nvalue = 1\n'],
    ['a.ts', 'const value=1;', '// comment\nconst value = 1;\n'],
    ['a.php', '<?php $value=1;', '<?php\n// comment\n$value = 1;\n'],
  ])('formatting and comments score zero in %s', (path, base, head) => {
    expect(file(path, base, head).total).toMatchObject({ churn: 0, nullFiles: 0 });
  });
  it('counts a literal replacement independently of its length', () => {
    expect(file('a.py', 'x = 1\n', 'x = 123456\n').files[0]?.size).toMatchObject({
      churn: 2,
      net: 0,
      structuralChurn: 0,
    });
  });
  it('pins the loop and generator has_negative projections (21 and 14 units)', () => {
    const loop =
      'def has_negative(values):\n    found = False\n    for value in values:\n        if value < 0:\n            found = True\n    return found\n';
    const one = 'def has_negative(values):\n    return any(value < 0 for value in values)\n';
    expect(file('a.py', '', loop).total.net).toBe(21);
    expect(file('a.py', '', one).total.net).toBe(14);
    expect(file('a.py', loop, one).total.net).toBe(-7);
  });
  it('records nulls for parse errors, unsupported languages, binary and over-limit bytes', () => {
    const result = counter([
      { path: 'broken.py', base: 'x=1\n', head: 'def (:' },
      { path: 'broken.ts', base: 'const = ;', head: '' },
      { path: 'a.go', base: '', head: 'package main' },
      { path: 'binary.py', base: '', head: '\0' },
    ]);
    expect(result.files.map((f) => f.size)).toEqual([null, null, null, null]);
    expect(result.total.nullFiles).toBe(4);
    expect(
      counter([{ path: 'a.py', base: '', head: 'x=1' }], { maxBytes: 2 }).total.nullFiles,
    ).toBe(1);
  });
  it('lists touched and excluded paths instead of counting tests, docs, locks or generated output', () => {
    const paths = [
      'src/a.py',
      'test_a.py',
      'tests/a.py',
      'a.test.ts',
      'docs/a.py',
      'generated/a.ts',
      'vendor/a.py',
      'dist/a.js',
      'pnpm-lock.yaml',
      'a.generated.ts',
    ];
    const result = counter(paths.map((path) => ({ path, base: '', head: 'x=1' })));
    expect(result.touched).toEqual(paths);
    expect(result.excluded).toEqual(paths.slice(1));
    expect(result.files.map((f) => f.path)).toEqual(['src/a.py']);
  });
  it('counts removals and new files symmetrically and a rename-only file pair as zero net', () => {
    const text = 'def f():\n    return 1\n';
    const add = file('new.py', '', text).total;
    expect(file('old.py', text, '').total).toMatchObject({
      added: 0,
      deleted: add.added,
      net: -add.net,
    });
    expect(
      counter([
        { path: 'old.py', base: text, head: '' },
        { path: 'new.py', base: '', head: text },
      ]).total.net,
    ).toBe(0);
  });
  it('counts block movement and operator changes', () => {
    expect(
      file('a.py', 'if x:\n    f()\ng()\n', 'if x:\n    f()\n    g()\n').total.churn,
    ).toBeGreaterThan(0);
    expect(file('a.py', 'x = a < b\n', 'x = a > b\n').total.structuralChurn).toBe(2);
    for (const [from, to] of [
      ['typeof', 'void'],
      ['void', 'delete'],
      ['delete', 'typeof'],
    ])
      expect(file('a.ts', `x = ${from} v.k;`, `x = ${to} v.k;`).total.structuralChurn).toBe(2);
  });
  it('uses minimum edits, including repeated units, and flags an over-budget approximation', () => {
    expect(file('a.py', 'a()\nb()\na()\n', 'a()\na()\n').total).toMatchObject({
      added: 0,
      deleted: 3,
      approximate: false,
    });
    const input = [{ path: 'a.py', base: 'a()\nb()\n', head: 'a()\nc()\n' }];
    expect(counter(input, { editBudget: 0 }).total.approximate).toBe(true);
    expect(counter(input, { editBudget: 0 }).total.churn).toBeGreaterThan(0);
  });
});

describe('counter limits and exact alignment', () => {
  it('keeps unreadable and invalid UTF-8 input null and honors a small unit budget', () => {
    expect(counter([{ path: 'a.py', base: null, head: 'x=1' }]).total.nullFiles).toBe(1);
    expect(
      counter([{ path: 'a.py', base: '', head: new Uint8Array([0xff]) }]).total.nullFiles,
    ).toBe(1);
    expect(
      counter([{ path: 'a.py', base: '', head: 'x=1' }], { maxUnits: 2 }).total.nullFiles,
    ).toBe(1);
  });
  it('matches a reference LCS for repeated and reordered identifier sequences', () => {
    const sequences = ['', 'a', 'aa', 'ab', 'ba', 'aba', 'bab', 'abc', 'cba'];
    for (const a of sequences)
      for (const b of sequences) {
        // Each call has Expr, Call, Name. Build a reference independently of Myers.
        const units = (s: string) => [...s].flatMap((c) => ['expression_statement', 'call', c]);
        const x = units(a),
          y = units(b);
        const dp = Array.from({ length: x.length + 1 }, () => Array<number>(y.length + 1).fill(0));
        for (let i = 1; i <= x.length; i++)
          for (let j = 1; j <= y.length; j++)
            dp[i]![j] =
              x[i - 1] === y[j - 1]
                ? dp[i - 1]![j - 1]! + 1
                : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
        const text = (s: string) => [...s].map((c) => `${c}()\n`).join('');
        expect(file('a.py', text(a), text(b)).total.churn).toBe(
          x.length + y.length - 2 * dp[x.length]![y.length]!,
        );
      }
  });
});

it.each([
  ['a.py', "value = 'text'\n", 'value = "text"\n'],
  ['a.ts', "const value = 'text';", 'const value = "text";'],
  ['a.php', "<?php $value = 'text';", '<?php $value = "text";'],
])('ignores quote punctuation in %s', (path, base, head) => {
  expect(file(path, base, head).total).toMatchObject({ churn: 0, nullFiles: 0 });
});
it('ignores boolean values for structural churn and counts template expression names', () => {
  expect(file('a.py', 'x=True\n', 'x=False\n').total).toMatchObject({
    churn: 2,
    structuralChurn: 0,
  });
  expect(
    file('a.ts', 'const x = `hello ${name}`;', 'const x = `hello ${other}`;').total,
  ).toMatchObject({ churn: 2, structuralChurn: 0 });
});
it('excludes generated headers from the base and discloses their paths', () => {
  const result = file('a.py', '# @generated\nx=1\n', '# @generated\nx=2\n');
  expect(result.excluded).toEqual(['a.py']);
  expect(file('a.py', 'x=1\n', '# @generated\nx=2\n').excluded).toEqual([]);
});

it('counts every comparison in a chain and an arrow function as an expression', () => {
  expect(file('a.py', 'x = a < b\n', 'x = a < b < c\n').total).toMatchObject({
    net: 2,
    added: 2,
    deleted: 0,
  });
  expect(file('a.ts', '', 'const f = () => 1;').total).toMatchObject({ net: 5, nullFiles: 0 });
});

it.each([
  ['a.py', String.raw`x = r'\"'`, String.raw`x = r'"'`],
  ['a.php', String.raw`<?php $x = '\"';`, String.raw`<?php $x = '"';`],
])('preserves literal backslashes that have value in %s', (path, base, head) => {
  expect(file(path, base, head).total).toMatchObject({
    churn: 2,
    structuralChurn: 0,
    nullFiles: 0,
  });
});

it('counts object/array expressions, shorthand names, this and ellipsis', () => {
  expect(file('a.ts', 'const x = {};', 'const x = [];').total).toMatchObject({
    added: 1,
    deleted: 1,
    churn: 2,
    structuralChurn: 2,
    nullFiles: 0,
  });
  expect(file('a.ts', '', 'const x = { value };').total).toMatchObject({ net: 5, nullFiles: 0 });
  expect(file('a.ts', '', 'const x = this;').total).toMatchObject({ net: 4, nullFiles: 0 });
  expect(file('a.py', '', 'x = ...\n').total).toMatchObject({ net: 3, nullFiles: 0 });
});

it.each(['add', 'delete', 'insert'])(
  'keeps a 600-unit pure %s exact above the edit budget',
  (kind) => {
    const text = 'x=1\n'.repeat(200);
    const base = kind === 'add' ? '' : kind === 'insert' ? 'f()\n' : text;
    const head = kind === 'delete' ? '' : kind === 'insert' ? `f()\n${text}` : text;
    const size = file('a.py', base, head);
    expect(size.files[0]?.size).toMatchObject({ churn: 600, approximate: false });
    expect(size.total).toMatchObject({ churn: 600, approximate: false, nullFiles: 0 });
  },
);

it.each(['install', 'theme', 'profile', 'engine'])(
  'counts Drupal .%s files as PHP',
  (extension) => {
    expect(file(`example.${extension}`, '<?php $x=1;', '<?php $x=2;').total).toMatchObject({
      churn: 2,
      net: 0,
      nullFiles: 0,
    });
  },
);
