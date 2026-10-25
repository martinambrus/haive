import { describe, expect, it } from 'vitest';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

const sections = (source: string, file: string) => extractCodeSections(source, file);
const named = (source: string, file: string) =>
  sections(source, file).filter((section) => !section.sectionId.startsWith('chunk-'));

// The source is valid TypeScript: a .ts assertion may precede literal text that looks like JSX.
describe('reader regression: actual JSX extension boundary', () => {
  it.each(['</T>', '</T> function fake() {}', '</T> ` punctuation'])(
    'keeps declarations after a TS assertion before %j',
    (closing) => {
      const source = [
        'type T = { n: number };',
        'declare const input: unknown;',
        'const value = <T>input;',
        'function after() {}',
        `const closing = ${JSON.stringify(closing)};`,
      ].join('\n');
      expect(named(source, 'assertion.ts').map((section) => section.sectionId)).toEqual([
        'function-after',
      ]);
      expect(named(source, 'assertion.ts')[0]?.breadcrumb).toEqual(['function after']);
      expect(named(source, 'assertion.ts')[0]?.content).toBe(source);
    },
  );

  it('keeps a generic TS arrow before raw closing-tag text', () => {
    const source =
      'const identity = <T>(value: T) => { return value; };\nfunction after() {}\nconst closing = "</T>";';
    expect(named(source, 'generic.ts').map((section) => section.sectionId)).toEqual([
      'function-identity',
      'function-after',
    ]);
  });

  it.each(['<T extends object>', '<T extends Array<object>>', '<T = object>', '<T,>'])(
    'keeps TSX generic arrow %s before a later closing-tag string',
    (parameters) => {
      const source = `const identity = ${parameters}(value: T) => { return value; };\nfunction after() {}\nconst closing = "</T>";`;
      expect(named(source, 'generic.tsx').map((section) => section.sectionId)).toEqual([
        'function-identity',
        'function-after',
      ]);
    },
  );

  it.each(['js', 'mjs', 'cjs', 'jsx', 'tsx'])('keeps JSX text mode for .%s', (extension) => {
    const source =
      'function Component() { return <p>` key</p>; }\nfunction middle() {}\nconst template = `real`;\nfunction after() {}';
    expect(named(source, `component.${extension}`).map((section) => section.sectionId)).toEqual([
      'function-Component',
      'function-middle',
      'function-after',
    ]);
  });

  it('keeps arrow-like JSX text as text', () => {
    const source =
      'function Component() { return <p title="hint">(x) =&gt; press ` key</p>; }\nfunction middle() {}\nconst template = `real`;\nfunction after() {}';
    expect(named(source, 'component.tsx').map((section) => section.sectionId)).toEqual([
      'function-Component',
      'function-middle',
      'function-after',
    ]);
  });

  it.each(['vue', 'svelte'])('keeps real script code in .%s', (extension) => {
    const markup = extension === 'vue' ? '<template><p>hello</p></template>' : '<p>hello</p>';
    const source = `<script lang="ts">\nfunction actual() {}\n</script>\n${markup}`;
    expect(named(source, `component.${extension}`).map((section) => section.sectionId)).toEqual([
      'function-actual',
    ]);
  });

  it('keeps Java on its existing reader', () => {
    const source = 'class Box { String closing = "</T>"; }';
    expect(named(source, 'Box.java').map((section) => section.sectionId)).toEqual(['class-Box']);
  });
});

describe('reader regression: Ruby endless regexp values and division', () => {
  it.each([
    '/x/',
    '/x/i',
    String.raw`/\//`,
    String.raw`/[()\/{}]/`,
    String.raw`/[\]\/{]/`,
    '/[(]/',
    String.raw`/path\/with\/slashes/`,
    String.raw`/[\/*]/`,
    '/x/ # regexp value',
    '/x#y/',
    '/x\ny/',
  ])('ends regexp RHS %s before the next def', (expression) => {
    const source = `def pattern = ${expression}\ndef after = 2`;
    const found = named(source, 'pattern.rb');
    expect(found.map((section) => section.sectionId)).toEqual([
      'function-pattern',
      'function-after',
    ]);
    expect(found[0]?.content).toBe(`def pattern = ${expression}\n`);
    expect(found[1]?.content).toBe('def after = 2');
  });

  it('retains module and singleton ownership around a regexp RHS', () => {
    const source = 'module Patterns\n  def self.pattern = /[(]/\n  def after = 2\nend';
    const found = named(source, 'pattern.rb');
    expect(found.map((section) => section.sectionId)).toEqual([
      'function-self.pattern',
      'function-after',
    ]);
    expect(found[0]?.content).toBe('module Patterns\n  def self.pattern = /[(]/\n');
    expect(found[0]?.breadcrumb).toEqual(['module Patterns', 'function self.pattern']);
    expect(found[1]?.content).toBe('  def after = 2\nend');
  });

  it.each([
    ['8 /\n  2', '8 /\n  2'],
    ['8 / # divide\n  2', '8 / # divide\n  2'],
    ['8 /\n  /x/.source.length', '8 /\n  /x/.source.length'],
    ['(8 /\n  2) /\n  2', '(8 /\n  2) /\n  2'],
    ['/[(]/.source.length /\n  2', '/[(]/.source.length /\n  2'],
    ['/x/ ==\n  /y/', '/x/ ==\n  /y/'],
  ])('continues operator RHS %s through its real value', (expression, expected) => {
    const source = `def value = ${expression}\ndef after = 2`;
    const found = named(source, 'value.rb');
    expect(found.map((section) => section.sectionId)).toEqual(['function-value', 'function-after']);
    expect(found[0]?.content).toBe(`def value = ${expected}\n`);
    expect(found[1]?.content).toBe('def after = 2');
  });
});
