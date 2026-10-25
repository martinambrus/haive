import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

const named = (source: string) =>
  extractCodeSections(source, 'fixture.tsx').filter((s) => !s.sectionId.startsWith('chunk-'));
const suffix =
  '\nfunction middle() {}\nconst later = `template`;\nfunction after() {}\nconst extra = () => { return 1; };';
function validTsx(source: string) {
  const file = ts.createSourceFile(
    'fixture.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
}

const tagContexts = [
  [
    'async function',
    'await',
    (element: string) => `async function Component() { return ${element}; }`,
  ],
  [
    'generator function',
    'yield',
    (element: string) => `function* Component() { return ${element}; }`,
  ],
  [
    'async generator await',
    'await',
    (element: string) => `async function* Component() { return ${element}; }`,
  ],
  [
    'async generator yield',
    'yield',
    (element: string) => `async function* Component() { return ${element}; }`,
  ],
  [
    'async arrow',
    'await',
    (element: string) => `const Component = async () => { return ${element}; };`,
  ],
  [
    'async class method',
    'await',
    (element: string) => `class Box { async Component() { return ${element}; } }`,
  ],
  [
    'generator class method',
    'yield',
    (element: string) => `class Box { *Component() { return ${element}; } }`,
  ],
  [
    'nested async function',
    'await',
    (element: string) => `function holder() { async function Component() { return ${element}; } }`,
  ],
  [
    'nested generator function',
    'yield',
    (element: string) => `function holder() { function* Component() { return ${element}; } }`,
  ],
  [
    'exported async function',
    'await',
    (element: string) => `export async function Component() { return ${element}; }`,
  ],
  [
    'module async function',
    'await',
    (element: string) => `export {};\nasync function Component() { return ${element}; }`,
  ],
  [
    'module generator function',
    'yield',
    (element: string) => `export {};\nfunction* Component() { return ${element}; }`,
  ],
] as const;
const bodies = [
  '` text',
  '(child) ` text',
  '(child): string ` text',
  "(child): {(() => 'child')()} ` text",
  '{(() => <span>child</span>)()} ` text',
];

describe('contextual TSX tag names stay JSX without scope inference', () => {
  for (const [context, tag, wrap] of tagContexts) {
    it.each(bodies)(`keeps ${tag} tag in ${context} with %s`, (body) => {
      const declaration = wrap(`<${tag} extends object>${body}</${tag}>`);
      const source = declaration + suffix;
      validTsx(source);
      const found = named(source);
      expect(found.map((s) => s.sectionId)).toEqual([
        'function-Component',
        'function-middle',
        'function-after',
        'function-extra',
      ]);
      expect(found[0]?.content).toBe(declaration);
      expect(found[1]?.content).toBe('function middle() {}');
    });
  }
});

const genericContexts = [
  ['script await', 'await', (declaration: string) => declaration],
  ['script yield', 'yield', (declaration: string) => declaration],
  [
    'ordinary nested await',
    'await',
    (declaration: string) => `function holder() { ${declaration} }`,
  ],
  [
    'ordinary nested yield',
    'yield',
    (declaration: string) => `function holder() { ${declaration} }`,
  ],
  [
    'ordinary function inside async',
    'await',
    (declaration: string) => `async function holder() { function ordinary() { ${declaration} } }`,
  ],
  [
    'ordinary function inside generator',
    'yield',
    (declaration: string) => `function* holder() { function ordinary() { ${declaration} } }`,
  ],
  [
    'yield in async',
    'yield',
    (declaration: string) => `async function holder() { ${declaration} }`,
  ],
  ['await in generator', 'await', (declaration: string) => `function* holder() { ${declaration} }`],
  [
    'module ordinary await',
    'await',
    (declaration: string) => `export {};\nfunction holder() { ${declaration} }`,
  ],
  [
    'module ordinary yield',
    'yield',
    (declaration: string) => `export {};\nfunction holder() { ${declaration} }`,
  ],
] as const;

describe('contextual names stay generic arrows where legal', () => {
  for (const [context, parameter, wrap] of genericContexts) {
    it.each(['', ': any'])(
      `keeps generic ${parameter} in ${context} with return %j`,
      (returnType) => {
        const declaration = `const identity = <const ${parameter} /* parameter */ extends object>(value: ${parameter})${returnType} => { return value; };`;
        const source = wrap(declaration) + suffix;
        validTsx(source);
        const found = named(source);
        expect(found.map((s) => s.sectionId)).toEqual([
          'function-identity',
          'function-middle',
          'function-after',
          'function-extra',
        ]);
        expect(found[0]?.content).toContain(declaration);
        expect(found[0]?.content).not.toContain('function middle');
      },
    );
  }
});

describe('bounded generic structural evidence handles annotations and trivia', () => {
  it.each([
    ': any',
    ': "</await>"',
    ': `kind-${string}`',
    ': { value: unknown; nested: { flag: boolean } }',
    ': (input: string) => number',
    ' /* parameters */ : /* return */ any /* arrow */',
  ])('keeps declarations after generic return annotation %s', (annotation) => {
    const declaration = `const identity = <await /* head */ extends object>(value: any)${annotation} => { return value; };`;
    const source = declaration + suffix;
    validTsx(source);
    const found = named(source);
    // Some complex signatures remain outside the existing body-range recognizer. They
    // must still stay code, preserving every following supported declaration.
    expect(found.map((s) => s.sectionId)).toEqual(
      expect.arrayContaining(['function-middle', 'function-after', 'function-extra']),
    );
    expect(found.find((s) => s.sectionId === 'function-middle')?.content).toContain(
      'function middle() {}',
    );
  });
  it.each([
    ['<await extends (input: string) => number>', '(value: any)', false],
    ['<await extends ">" | "<">', '(value: any)', true],
    ['<await extends object>', '(value: any /* ) > misleading */)', true],
  ] as const)('keeps structural tokens in %s %s opaque', (parameters, values, hasIdentity) => {
    const declaration = `const identity = ${parameters}${values} => { return value; };`;
    const source = declaration + suffix;
    validTsx(source);
    expect(named(source).map((s) => s.sectionId)).toEqual([
      ...(hasIdentity ? ['function-identity'] : []),
      'function-middle',
      'function-after',
      'function-extra',
    ]);
  });
});
