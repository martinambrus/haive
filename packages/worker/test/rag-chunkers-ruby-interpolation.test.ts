import { describe, expect, it } from 'vitest';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

// Every source compiles with the retained Ruby 3.4 oracle; these controls need no runtime.
const cases = [
  ['', '%Q!#{%q!{!}!'],
  ['', '%Q!#{%q!}!}!'],
  ['', '%Q!#{%q!(!}!'],
  ['', '%Q!#{%q{(}}!'],
  ['', '%Q!#{%q[(]}!'],
  ['', '%Q!#{%q!escaped\\! {!}!'],
  ['', '%Q!#{"{"}!'],
  ['', '%Q!#{"}"}!'],
  ['', "%Q!#{'{'}!"],
  ['', '%Q!#{`echo {`}!'],
  ['', '%Q!#{/[{}]/}!'],
  ['', '%Q!#{/}/}!'],
  ['', '%Q!#{/\\}/}!'],
  ['', '%Q!#{Regexp.new /[{}]/}!'],
  ['', '%Q!#{wrap /}/}!'],
  ['', '%Q!#{{ key: %q!{! }}!'],
  ['', '%Q!#{8 / 2}!'],
  ['', '%Q!#{8 % 3}!'],
  ['', '%Q!#{"#{%q!{!}"}!'],
  ['', '%Q!#{%Q[#{%q!{!}]}!'],
  ['', '%Q!#{/#{%q!{!}/}!'],
  ['', '%Q!#{`echo #{%q!{!}`}!'],
  ['', '%Q!#{%q!{! # ignored } {\n}!'],
  ['', '%Q!#{%r!{!}!'],
  ['(value)', '%Q!#{value /2 /\n  2}!'],
  ['', '%q(#{%q!{!})'],
  ['', '%Q!\\#{literal {!'],
  ['', '%Q!#{%q!{!}#{{ key: %q!}! }}!'],
  [
    '',
    '%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%Q!#{%q!{!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!}!',
  ],
];

describe('Ruby percent interpolation keeps nested literals opaque', () => {
  it.each(cases)('retains the next method after %s %s', (parameters, expression) => {
    const declaration = `def first${parameters} = ${expression}\n`;
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
