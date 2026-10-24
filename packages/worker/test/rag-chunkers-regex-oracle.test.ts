import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { maskNonCode } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

function regexRanges(text: string): Array<[number, number]> {
  const file = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Array<[number, number]> = [];
  const walk = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      out.push([node.getStart(file) + 1, text.lastIndexOf('/', node.end - 1)]);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return out;
}

function commentRanges(text: string): Array<[number, number]> {
  const file = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const seen = new Set<number>();
  const out: Array<[number, number]> = [];
  const take = (pos: number): void => {
    if (seen.has(pos)) return;
    seen.add(pos);
    for (const r of [
      ...(ts.getLeadingCommentRanges(text, pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, pos) ?? []),
    ]) {
      const block = r.kind === ts.SyntaxKind.MultiLineCommentTrivia;
      out.push([r.pos + 2, block ? r.end - 2 : r.end]);
    }
  };
  const walk = (node: ts.Node): void => {
    take(node.pos);
    for (const child of node.getChildren(file)) walk(child);
  };
  walk(file);
  return out;
}

/** The text with the body of every regex literal and every comment the TypeScript parser finds blanked. */
function oracleMask(text: string): string {
  const blank = new Set<number>();
  for (const [from, to] of [...regexRanges(text), ...commentRanges(text)]) {
    for (let k = from; k < to; k += 1) blank.add(k);
  }
  return [...text]
    .map((c, k) => (blank.has(k) && !/[\r\n\u2028\u2029]/.test(c) ? ' ' : c))
    .join('');
}

const CASES: string[] = [
  // division after an operand
  'const a = b / 2; function f1() { x(); } const c = d / 3;',
  'const a = 4 / 2; function f1() { x(); } const c = 5 / 3;',
  'const a = (b) / 2; function f1() { x(); } const c = (d) / 3;',
  'const a = b[0] / 2; function f1() { x(); } const c = d[1] / 3;',
  'const a = { v: 1 }.v / 2; function f1() { x(); } const c = e / 3;',
  'const a = f() / 2; function f1() { x(); } const c = g() / 3;',
  'const a = "s" / 2; function f1() { x(); } const c = "t" / 3;',
  'const a = b.c / 2; function f1() { x(); } const c = d.e / 3;',
  'const a = b /* c */ / 2; function f1() { x(); } const c = d / 3;',
  'const a = b // c\n / 2; function f1() { x(); } const c = d / 3;',
  // division after postfix ++ -- !
  'let n = 1; n++ / 2; function f1() { x(); } const r = n / 3;',
  'let n = 1; n-- / 2; function f1() { x(); } const r = n / 3;',
  'let n: number | undefined = 1; n! / 2; function save() { persist(); } const ratio = n / 3;',
  'let o: any; o.a! / 2; function f1() { x(); } const r = o.b! / 3;',
  'let o: any; o[0]! / 2; function f1() { x(); } const r = o[1]! / 3;',
  'let o: any; f()! / 2; function f1() { x(); } const r = g()! / 3;',
  // division after keyword-named properties
  'const n = obj. return / 2; function save() { persist(); } const ratio = n / 3;',
  'const a = obj.return / 2; function f1() { x(); } const c = d / 3;',
  'const a = obj. typeof / 2; function f1() { x(); } const c = d / 3;',
  'const a = obj?.in / 2; function f1() { x(); } const c = d / 3;',
  'const a = obj /* c */ . /* d */ return / 2; function f1() { x(); } const c = d / 3;',
  'const a = obj?.\n  of / 2; function f1() { x(); } const c = d / 3;',
  'const a = obj.new / 2; function f1() { x(); } const c = d.delete / 3;',
  // regex after a keyword or operator
  'function g() { return /a+/.test(s); } function f1() { x(); }',
  'const a = typeof /a+/; function f1() { x(); }',
  'switch (k) { case /a+/.test(s): break; } function f1() { x(); }',
  'do /a+/.test(s); while (0); function f1() { x(); }',
  'if (a) b; else /a+/.test(s); function f1() { x(); }',
  'const a = "k" in /a+/; function f1() { x(); }',
  'for (const q of /a+/g.exec(s) ?? []) {} function f1() { x(); }',
  'const a = new /a+/.constructor(); function f1() { x(); }',
  'delete /a+/.x; function f1() { x(); }',
  'void /a+/.test(s); function f1() { x(); }',
  'function g() { throw /a+/; } function f1() { x(); }',
  'function* g() { yield /a+/; } function f1() { x(); }',
  'async function g() { await /a+/.test(s); } function f1() { x(); }',
  'const a = /a+/.test(s); function f1() { x(); }',
  'const a = f(/a+/, /b+/g); function f1() { x(); }',
  'const a = [/a+/, /b+/]; function f1() { x(); }',
  'const a = !/a+/.test(s); function f1() { x(); }',
  'const a = b && /a+/.test(s); function f1() { x(); }',
  'const a = b || /a+/.test(s); function f1() { x(); }',
  'const a = b ? /a+/ : /b+/; function f1() { x(); }',
  'function g() { { /a+/.test(s); } } function f1() { x(); }',
  'x();\n/a+/.test(s); function f1() { x(); }',
  '/a+/.test(s); function f1() { x(); }',
  'const a = b instanceof /a+/.constructor; function f1() { x(); }',
  // regex shapes
  'const a = /[/]+/.test(s); function f1() { x(); }',
  'const a = /a\\/b/gi.test(s); function f1() { x(); }',
  'const a = /a+/dgimsuy; function f1() { x(); }',
  'const a = b /* c */ , /a+/ /* d */ ; function f1() { x(); }',
  // the rounds 3-4 inputs
  'const a = b++ / 2; function f1() { x(); } const c = d / 3;',
  'let n = 1; n++ / 2; function save() { persist(); } const ratio = n / 3;',
  // statement-position ambiguity a parser decides (a lexer cannot): ')' closing if/while/for
  'if (a) /a+/.test(s); function f1() { x(); }',
  'while (a) /a+/.test(s); function f1() { x(); }',
  'for (;;) /a+/.test(s); function f1() { x(); }',
  // a '}' that ends a block versus an object literal
  'function g() {}\n/a+/.test(s); function f1() { x(); }',
  'const a = {}\n/ 2; function f1() { x(); } const c = d / 3;',
  // contextual keywords used as identifiers
  'let of = 6; const n = of / 2; function save() { persist(); } const ratio = n / 3;',
  'let of = 6; let n = of / 2; function f1() { x(); } const c = d / 3;',
  'let of = 6; f(of / 2); function f1() { x(); } const c = d / 3;',
  'let of = 6; f(a, of / 2); function f1() { x(); } const c = d / 3;',
  'for (x of /a/g.exec(s)) {} function f1() { x(); }',
  'for (const [a] of /a/.exec(s)) {} function f1() { x(); }',
  'let yield_ = 1; const n = yield / 2; function f1() { x(); } const c = d / 3;',
  'function* g() { yield /a/ } function f1() { x(); }',
  'const n = await / 2; function f1() { x(); } const c = d / 3;',
  'async function f() { await /a/.test(s) } function f1() { x(); }',
  'let as = 4; as / 2; function f1() { x(); } const c = d / 3;',
  'let from = 4; from / 2; function f1() { x(); } const c = d / 3;',
  // a label before a comment is no URL scheme
  'function first(){ retry:// a ` in the comment\nwork(); }\nfunction second(){ return 1; }\nconst t = ``;',
  'switch (k) { case 1:// c `\n break; }\nfunction second(){ return 1; }\nconst t = ``;',
  // every ECMAScript line terminator ends a line
  'const a = 1; // c\rfunction f1() { x(); }\rconst b = 2;',
  'const a = 1; // c\u2028function f1() { x(); }\u2028const b = 2;',
  'const a = 1; // c\u2029function f1() { x(); }\u2029const b = 2;',
  '// c\r/a+/.test(s); function f1() { x(); }',
  "const s = 'a\rb'; function f1() { x(); }",
  'x = 1 /a/g.exec(s); function f1() { x(); }',
  // identifiers with combining marks and joiners
  'let caf\u00e9 = 6; const n = caf\u00e9 / 2; function save() { persist(); } const ratio = n / 3;',
  'let cafe\u0301 = 6; const n = cafe\u0301 / 2; function save() { persist(); } const ratio = n / 3;',
  'let na\u00efve = 6; const n = na\u00efve / 2; function save() { persist(); } const ratio = n / 3;',
  'let nai\u0308ve = 6; const n = nai\u0308ve / 2; function save() { persist(); } const ratio = n / 3;',
  'let $x\u200D = 6; const n = $x\u200D / 2; function save() { persist(); } const ratio = n / 3;',
];

const KNOWN_LIMITS = new Map<string, string>([
  ['if (a) /a+/.test(s); function f1() { x(); }', 'a ")" closing if/while/for needs a parser'],
  ['while (a) /a+/.test(s); function f1() { x(); }', 'a ")" closing if/while/for needs a parser'],
  ['for (;;) /a+/.test(s); function f1() { x(); }', 'a ")" closing if/while/for needs a parser'],
  ['function g() {}\n/a+/.test(s); function f1() { x(); }', 'a "}" ending a block needs a parser'],
]);

describe('maskNonCode regex literals against the TypeScript parser', () => {
  for (const text of CASES) {
    const limit = KNOWN_LIMITS.get(text);
    const run = limit ? it.fails : it;
    run(`${limit ? `[limit: ${limit}] ` : ''}${JSON.stringify(text)}`, () => {
      expect(maskNonCode(text, 'js')).toBe(oracleMask(text));
    });
  }
});

describe('maskNonCode URLs in markup text', () => {
  for (const text of [
    '<p>see https://x</p>\nfunction a(){ return 1; }\nconst t = ``;',
    '<p>https://x</p>\nfunction a(){ return 1; }\nconst t = ``;',
  ]) {
    it(JSON.stringify(text), () => {
      expect(maskNonCode(text, 'js')).toBe(text);
    });
  }
});
