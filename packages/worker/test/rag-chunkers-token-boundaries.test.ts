import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

const named = (source: string, file: string) =>
  extractCodeSections(source, file).filter((section) => !section.sectionId.startsWith('chunk-'));

function validTsx(source: string): void {
  const parsed = ts.createSourceFile(
    'fixture.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  expect(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  ).toEqual([]);
}

describe('TSX generic prefix tokens versus opening tags', () => {
  it.each([
    '<const T extends object>',
    '<const T,>',
    '<const T = object>',
    '<T /* note */ extends object>',
    '<T // note\n extends object>',
    '<const /* note */ T /* second */ extends Array<object>>',
    '< /* note */ const T extends object>',
    '<\nconst T extends object>',
    '<T /* > misleading punctuation */ extends object>',
    '<名 extends object>',
    '<const 𝒜 extends Array<object>>',
    '<T, U>',
    '<T,>',
    '<T = object>',
    '<T extends Array<Array<object>>>',
  ])('keeps generic prefix %s in code', (parameters) => {
    const declaration = `const identity = ${parameters}(value: any) => { return value; };`;
    const source = `${declaration}\nfunction after() {}`;
    validTsx(source);
    const found = named(source, 'fixture.tsx');
    expect(found.map((section) => section.sectionId)).toEqual([
      'function-identity',
      'function-after',
    ]);
    expect(found[0]?.content).toBe(declaration);
    expect(found[1]?.content).toBe('function after() {}');
  });

  it.each([
    '<Box extends />',
    '<Box extends="yes">` text</Box>',
    '<Box extends>` text</Box>',
    '<const T>` text</const>',
    '<class extends object>` text</class>',
    '<Box title="(x) => value">` text</Box>',
    '<Box>{(() => { return <span>` text</span>; })()}</Box>',
  ])('keeps real JSX %s in text/expression mode', (element) => {
    const declaration = `function Component() { return ${element}; }`;
    const source = `${declaration}\nfunction middle() {}\nconst later = \`template\`;\nfunction after() {}`;
    validTsx(source);
    const found = named(source, 'fixture.tsx');
    expect(found.map((section) => section.sectionId)).toEqual([
      'function-Component',
      'function-middle',
      'function-after',
    ]);
    expect(found[0]?.content).toBe(declaration);
  });
});

// This is ordinary JSX, not a TSX generic arrow. The retained Babel JSX-only
// oracle validates the fixture without TypeScript's extra generic-arrow ambiguity.
describe('plain JSX does not use TypeScript generic-prefix tokens', () => {
  it.each(['js', 'mjs', 'cjs', 'jsx'])('keeps constraint-like attributes in .%s', (extension) => {
    const declaration = 'function Component() { return <Box extends object>` text</Box>; }';
    const source = `${declaration}\nfunction middle() {}\nconst later = \`template\`;\nfunction after() {}`;
    const found = named(source, `fixture.${extension}`);
    expect(found.map((section) => section.sectionId)).toEqual([
      'function-Component',
      'function-middle',
      'function-after',
    ]);
    expect(found[0]?.content).toBe(declaration);
  });
});

describe('Ruby completed method tokens versus continuation operators', () => {
  it.each([
    'total',
    'total!',
    'ready?',
    'account.total!',
    'account.ready?',
    'account&.total!',
    'account&.ready?',
    'café!',
    '名?',
    'total! # completed value',
    'ready? # completed value',
    '!ready?',
    '!!total!',
    '~total!',
    'account.and',
    'account.or',
    'account.not',
    'account.defined?',
    ':ready?',
    ':total!',
  ])('ends completed RHS %s before the next method', (expression) => {
    const source = `def first = ${expression}\ndef after = 2`;
    const found = named(source, 'fixture.rb');
    expect(found.map((section) => section.sectionId)).toEqual(['function-first', 'function-after']);
    expect(found[0]?.content).toBe(`def first = ${expression}\n`);
    expect(found[1]?.content).toBe('def after = 2');
  });

  it.each([
    'total! / 2',
    'ready? / 2',
    'account.total! / 2',
    'account.ready? / 2',
    'total!() / 2',
    'account.ready?() / 2',
  ])('keeps division after %s out of following strings', (expression) => {
    const source = `def ratio = ${expression}\ndef after = "x/y"\n`;
    const found = named(source, 'fixture.rb');
    expect(found.map((section) => section.sectionId)).toEqual(['function-ratio', 'function-after']);
    expect(found[0]?.content).toBe(`def ratio = ${expression}\n`);
    expect(found[1]?.content).toBe('def after = "x/y"\n');
  });

  it.each([
    'total! +\n  2',
    'total! /\n  2',
    'account.total! / # divide\n  2',
    'ready? &&\n  true',
    'ready? ||\n  false',
    'total! !=\n  2',
    'ready? !~\n  /x/',
    'total !=\n  2',
    'total!=\n  2',
    'value!~\n  /x/',
    'ready? ?\n  1 :\n  2',
    '(ready? and\n  true)',
    '(ready? or\n  false)',
    '(not\n  ready?)',
    '(not /[(]/)',
    '(defined? /[(]/)',
    'total! /\n  /x/.source.length',
  ])('continues actual operator RHS %s through its value', (expression) => {
    const source = `def first = ${expression}\ndef after = 2`;
    const found = named(source, 'fixture.rb');
    expect(found.map((section) => section.sectionId)).toEqual(['function-first', 'function-after']);
    expect(found[0]?.content).toBe(`def first = ${expression}\n`);
    expect(found[1]?.content).toBe('def after = 2');
  });
});
