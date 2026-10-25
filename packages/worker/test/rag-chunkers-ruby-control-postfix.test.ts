import { describe, expect, it } from 'vitest';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

// Ruby 3.4 compile/Ripper receipts distinguish actual modifiers from prefix bodies.
const cases = [
  ['return-if', 'return if true'],
  ['return-unless', 'return unless true'],
  ['return-while', 'return while true'],
  ['return-until', 'return until true'],
  ['yield-if', 'yield if true'],
  ['yield-unless', 'yield unless true'],
  ['yield-while', 'yield while true'],
  ['yield-until', 'yield until true'],
  ['next-if', '[1].map { next if true }'],
  ['next-unless', '[1].map { next unless true }'],
  ['next-while', '[1].map { next while true }'],
  ['next-until', '[1].map { next until true }'],
  ['break-if', '[1].map { break if true }'],
  ['break-unless', '[1].map { break unless true }'],
  ['break-while', '[1].map { break while true }'],
  ['break-until', '[1].map { break until true }'],
  ['redo-if', '[1].map { redo if true }'],
  ['redo-unless', '[1].map { redo unless true }'],
  ['redo-while', '[1].map { redo while true }'],
  ['redo-until', '[1].map { redo until true }'],
  ['retry-if', 'begin; raise; rescue; retry if true; end'],
  ['retry-unless', 'begin; raise; rescue; retry unless true; end'],
  ['retry-while', 'begin; raise; rescue; retry while true; end'],
  ['retry-until', 'begin; raise; rescue; retry until true; end'],
  ['return-argument', 'return 1 if true'],
  ['return-call-argument', 'return foo(1) unless false'],
  ['yield-argument', 'yield 1 while false'],
  ['next-argument', '[1].map { next 1 if true }'],
  ['break-argument', '[1].map { break 1 unless false }'],
  [
    'return-prefix-if-argument',
    'return(if true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  1\nend)',
  ],
  [
    'yield-prefix-if-argument',
    'yield(if true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  1\nend)',
  ],
  [
    'next-prefix-if-argument',
    '[1].map { next(if true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  1\nend) }',
  ],
  [
    'return-begin-argument',
    'return begin\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  1\nend',
  ],
  [
    'break-begin-argument',
    '[1].map { break begin\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  1\nend }',
  ],
  [
    'prefix-if-after-return-newline',
    'begin\n return\n if true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  1\n end\n 2\nend',
  ],
  [
    'prefix-unless-after-yield-newline',
    'begin\n yield\n unless false\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  1\n end\n 2\nend',
  ],
  [
    'prefix-if-after-grouped-return-newline',
    '(return\n if true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n 1\n end)',
  ],
  ['return-continuation', 'return \\\n if true'],
  ['next-continuation', '[1].map { next \\\n if true }'],
  ['return-chained-modifiers', 'return if true unless false'],
  [
    'nested-postfix-inside-prefix-if',
    'if true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n return if true\nelse\n yield unless false\nend',
  ],
  [
    'ordinary-prefix-if',
    'if true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n 123\nend',
  ],
  [
    'ordinary-prefix-unless',
    'unless false\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n 123\nend',
  ],
  [
    'ordinary-prefix-while',
    'while false\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n 123\nend',
  ],
  [
    'ordinary-prefix-until',
    'until true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n 123\nend',
  ],
];

describe('Ruby control keyword postfix versus prefix contexts', () => {
  it.each(cases)('retains exact method boundaries for %s', (_name, expression) => {
    const declaration = `def first = ${expression}\n`;
    const source = `${declaration}def after = 2\n`;
    const found = extractCodeSections(source, 'fixture.rb');
    expect(found.map((section) => section.sectionId)).toEqual(['function-first', 'function-after']);
    expect(found[0]?.content).toBe(declaration);
    expect(found[0]?.breadcrumb).toEqual(['function first']);
    expect(found[1]?.content).toBe('def after = 2\n');
    expect(found[1]?.breadcrumb).toEqual(['function after']);
    expect(found.map((section) => section.content).join('')).toBe(source);
  });
});
