import { describe, expect, it } from 'vitest';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

// Ruby 3.4 compiles each exact fixture and Ripper records its slash-token roles.
const cases = [
  ['', '[4].map { |value| value /2 }'],
  ['', '[4].map do |value|\n value /2\nend'],
  ['', '->(value) { value /2 }'],
  ['', '-> value { value /2 }'],
  ['', '->(value) do\n value /2\nend'],
  ['', 'lambda { |value| value /2 }'],
  ['', 'proc do |value| value /2 end'],
  ['', '[4].map { |value = 4| value /2 }'],
  ['', '[4].map { |value: 4| value /2 }'],
  ['', '[4].map { |*values| values /2 }'],
  ['', '[4].map { |**values| values /2 }'],
  ['', '[4].map { |&handler| handler /2 }'],
  ['', '[4].map { |(value, other)| other /2 }'],
  ['', '[4].map { |value; local| local = 4; local /2 }'],
  ['', '[4].map { |; local| local /2 }'],
  ['', '->(value = %q!{!) { value /2 }'],
  ['', '->(value: 4) { value /2 }'],
  ['', '->(*values) { values /2 }'],
  ['', '->(**values) { values /2 }'],
  ['', '->(&handler) { handler /2 }'],
  ['', '[4].map { |value| value /2 }; value /}!/'],
  ['', '[4].map do |value| value /2 end; value /}!/'],
  ['', '(->(value) { value /2 }).call(4); value /}!/'],
  ['', '[4].map { |value| [6].map { |other| other /2 }; value /2 }'],
  ['', '[4].map { |value| [6].map { |other| other /2 }; other /}!/ }'],
  ['', '[4].map { |value| [6].map { |value| value /2 }; value /2 }'],
  ['', '[4].map { local = 4; local /2 }; local /}!/'],
  ['', '[4].map { _1 /2 }'],
  ['', '[4].map { _2 /2 }'],
  ['', '[4].map do _1 /2 end'],
  ['', '[4].map { || it /}!/ }'],
  ['', '[4].map { |value| it /}!/ }'],
  ['', '->() { it /}!/ }'],
  ['', 'it /}!/'],
  ['', '[4].map { value /}!/ }'],
  ['', '[4].map { wrap /a\n} b/ }'],
  ['', '[4].map do |value|\n if value\n value /2\n end\n value /2\nend'],
  ['', '[4].map do |value|\n value /2 if true\n value /2\nend'],
  ['', '[4].map { |value| { a: value /2 } }'],
  ['', 'while false do it /}!/ end'],
  ['', '[4].map { it() / 2 }'],
  ['', '[4].map { |value| %Q!#{value /2}! }'],
  ['(value)', '[4].map { value /2 }'],
  ['(it)', '[4].map { it /2 }'],
  ['(value)', '[4].map { |other| value /2 }; value /2'],
  ['', '[4].map { it; it /}!/ }'],
  ['', '[4].map { it / 2 }'],
  ['', '[4].map { (it) /2 }'],
  ['', '[4].map { it /a\n} b/ }'],
  ['', '_1 /2'],
  ['', '_1() /2'],
  ['', '[4].map { it = 4; it /2 }'],
  ['', '-> { it / 2 }'],
  ['', '[4].map do it / 2 end'],
  ['', 'lambda { it / 2 }'],
  ['', '[4].map { |value = %q!{!| value /2 }'],
  ['', '[4].map { |value = (1 | 2); local| local /2 }'],
  ['', '[4].map { |value = (1 | 2)| value /2 }; value /}!/'],
  ['', '[4].map { |value| { do: 1 }; value /2 }; value /}!/'],
  ['', '[4].map do |value| { end: 1 }; value /2 end; value /}!/'],
  ['', '[4].map do |value| helper(if: 1); value /2 end; value /}!/'],
  ['', '->(value = helper(1, wrap: 4)) { wrap /}!/ }'],
  ['', '[4].map { |value = helper(1, wrap: 4)| wrap /}!/ }'],
  ['', '[4].map { |value, # parameter\n other| other /2 }'],
  ['', '[4].map do |value|\n [6].map do |other| other /2 end\n value /2\nend; other /}!/'],
  ['', '-> value = 4 { value /2 }'],
  ['', '-> value: 4 { value /2 }'],
  ['', '[4].map { |value| next { a: (local = 4) }; local /2 }; local /}!/'],
];

describe('Ruby interpolation block bindings and command regexp scope', () => {
  it.each(cases)('keeps independent definitions after %s %s', (parameters, expression) => {
    const declaration = `def first${parameters} = %Q!#{${expression}}!\n`;
    const source = `${declaration}def after = /x/\ndef last = 2\n`;
    const found = extractCodeSections(source, 'fixture.rb');
    expect(found.map((section) => section.sectionId)).toEqual([
      'function-first',
      'function-after',
      'function-last',
    ]);
    expect(found[0]?.content).toBe(declaration);
    expect(found[0]?.breadcrumb).toEqual(['function first']);
    expect(found[1]?.content).toBe('def after = /x/\n');
    expect(found[1]?.breadcrumb).toEqual(['function after']);
    expect(found[2]?.content).toBe('def last = 2\n');
    expect(found[2]?.breadcrumb).toEqual(['function last']);
    expect(found.map((section) => section.content).join('')).toBe(source);
  });
});
