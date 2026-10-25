import { describe, expect, it } from 'vitest';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

// Parent primary Ruby 3.4 receipts confirm all four exact PR reproductions compile.
const cases = [
  ['quoted-interpolation', 'def first = "#{foo("(")}"\ndef after = 2\n'],
  ['backtick', 'def first = `echo (`\ndef after = 2\n'],
  [
    'begin-body',
    'def first = begin\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  123\nend\ndef after = 2\n',
  ],
  [
    'if-body',
    'def first = if true\n  # body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment body-comment \n  123\nend\ndef after = 2\n',
  ],
];

describe('Ruby endless quoted and keyword expression boundaries', () => {
  it.each(cases)('keeps the entire method for %s', (_name, source) => {
    const found = extractCodeSections(source, 'fixture.rb');
    expect(found.map((section) => section.sectionId)).toEqual(['function-first', 'function-after']);
    expect(found[0]?.content).toBe(source.slice(0, source.indexOf('def after')));
    expect(found[0]?.breadcrumb).toEqual(['function first']);
    expect(found[1]?.content).toBe('def after = 2\n');
    expect(found[1]?.breadcrumb).toEqual(['function after']);
    expect(found.map((section) => section.content).join('')).toBe(source);
  });
});
