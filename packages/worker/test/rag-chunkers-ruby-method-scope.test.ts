import { describe, expect, it } from 'vitest';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

// Actual Ruby 3.4 compile/Ripper receipts validate every exact fixture.
const cases = [
  ['', '[4].map { |value| def nested; value /}!/; end }'],
  ['', '[4].map do |value| def nested; value /}!/; end end'],
  ['', '[4].map { |value| def self.nested; value /}!/; end }'],
  ['', '[4].map { |value| def object.nested; value /}!/; end }'],
  ['', '[4].map { |value| def nested(value); value /2; end }'],
  ['', '[4].map { |value| def nested(other); value /}!/; other /2; end }'],
  ['', '[4].map { |value| def nested(value = %q!{!); value /2; end }'],
  ['', '[4].map { |value| def nested value; value /2; end }'],
  ['', '[4].map { |value| def nested value, other = %q!{!; other /2; end }'],
  ['', '[4].map { |value| def nested(value: 4); value /2; end }'],
  ['', '[4].map { |value| def nested(*values); values /2; end }'],
  ['', '[4].map { |value| def nested(**values); values /2; end }'],
  ['', '[4].map { |value| def nested(&handler); handler /2; end }'],
  ['', '[4].map { |value| def nested; value /}!/; end; value /2 }'],
  ['', '[4].map { |value| def nested; local = 4; local /2; end; local /}!/; value /2 }'],
  ['', '[4].map { |value| def nested(other); [4].map { other /2 }; value /}!/; end; value /2 }'],
  ['', '[4].map { |value| def nested(other); -> { other /2 }; value /}!/; end }'],
  ['', '[4].map { |value| def nested = value /}!/ }'],
  ['', '[4].map { |value| def nested(other) = other /2; value /2 }'],
  ['', '[4].map { |value| def self.nested = value /}!/; value /2 }'],
  ['', '[4].map do |value| def nested = value /}!/ end'],
  ['', '[4].map { |value| def nested(other = %q!{!) = other /2; other /}!/; value /2 }'],
  ['', '[4].map { |value| def nested(other) = other /\n 2\n value /2 }'],
  ['', '[4].map { |value| def nested(other) = begin\n other /2\n end\n value /2 }'],
  ['', '[4].map { |value| def outer(other); def inner; other /}!/; end; other /2; end; value /2 }'],
  ['', '[4].map { |value| { def: 4 }; value /2 }'],
  ['', '[4].map { |value| object.def; value /2 }'],
  ['', '[4].map { |value| :def; value /2 }'],
  ['', '[4].map { |value| def ready?; value /}!/; end }'],
  ['', '[4].map { |value| def update!; value /}!/; end }'],
  ['', '[4].map { |value| def nested=(other); other /2; value /}!/; end }'],
  ['', '[4].map { |value| def +(other); other /2; value /}!/; end }'],
  ['', '[4].map { |value| def self.==(other); other /2; value /}!/; end }'],
  ['', '[4].map { |value| def nested; "def fake"; value /}!/; end }'],
  ['', '[4].map { |value| def nested(other) value /}!/ end; value /2 }'],
  ['', '[4].map { |value| def nested(value) value /2 end; value /2 }'],
  ['', '[4].map { |value| def self.nested() end; value /2 }'],
  ['', '[4].map { |value| def nested(); local = 4; end; local /}!/; value /2 }'],
  ['', '[4].map { |value| (def nested = value /}!/); value /2 }'],
  ['', '[4].map { |value| def (value).nested; value /}!/; end; value /2 }'],
  ['', '[4].map { |value| def (value /2).nested; value /}!/; end }'],
  ['', '[4].map { |value| def (value).nested = value /}!/; value /2 }'],
];

describe('Ruby interpolation method scope isolation and restoration', () => {
  it.each(cases)('retains independent definitions after %s %s', (parameters, expression) => {
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
