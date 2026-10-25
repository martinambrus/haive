import { describe, expect, it } from 'vitest';
import { extractCodeSections } from '../src/step-engine/steps/onboarding/_rag-chunkers.js';

// Syntax of every source is independently compiled by Ruby 3.4 in the retained
// pr-ruby-fix receipt; no interpreter or services are required by these controls.
const expressions = [
  '%q{(}',
  '%q[(]',
  '%q<(>',
  '%q!(!',
  '%q/( /',
  '%q{outer{(}tail}',
  '%q{escaped\\} (}',
  '%q!escaped\\! (!',
  '%Q{(}',
  '%{(}',
  '%w{( ) [}',
  '%W{( ) [}',
  '%i{( ) [}',
  '%I{( ) [}',
  '%s{(}',
  '%r{[(]}',
  '%r![(]!i',
  '%x{(}',
  '%q{first\n(\nlast}',
  '%Q{#{"}"}(}',
  '%Q(#{")"}())',
  'Regexp.new /foo/',
  'Regexp.new /[(]/',
  'Regexp.new /path\\/with\\/slashes/i',
  'Regexp.new /foo/ # argument',
  'wrap /foo/',
  'wrap! /foo/',
  'self.wrap /foo/',
  'Patterns::Builder.new /foo/',
  'wrap /foo\nbar/',
  'wrap %q{(}',
  'wrap %r{[(]}',
  '8 % 3',
  '8 %\n  3',
  '8 % # remainder\n  3',
  '8 / 2',
  '8 /\n  2',
  '8 /2',
  'total! / 2',
  'total! /\n  2',
  'wrap() /\n  2',
  'wrap /x/.source.length /\n  2',
  'wrap /foo/ +\n  2',
  '%q{(}.length +\n  2',
  '%r{[(]}.source.length /\n  2',
  '(%q{(}.length +\n  2)',
  '(8 %\n  3)',
  'wrap(8 %\n  3)',
];

describe('Ruby endless literal boundaries and real operator continuation', () => {
  it.each(expressions)('keeps %s opaque through its own end', (expression) => {
    const source = `def first = ${expression}\ndef after = 2\n`;
    const found = extractCodeSections(source, 'fixture.rb');
    expect(found.map((section) => section.sectionId)).toEqual(['function-first', 'function-after']);
    expect(found[0]?.content).toBe(`def first = ${expression}\n`);
    expect(found[0]?.breadcrumb).toEqual(['function first']);
    expect(found[1]?.content).toBe('def after = 2\n');
    expect(found[1]?.breadcrumb).toEqual(['function after']);
    expect(found.map((section) => section.content).join('')).toBe(source);
  });

  it.each([
    ['(value)', 'value /2 /\n  2'],
    ['(value: 8)', 'value /2 /\n  2'],
    ['(value = 8)', 'value /2 /\n  2'],
    ['(value = helper(1, wrap: 3))', 'wrap /foo/'],
    ['(value = helper(1, other: 3), other = 8)', 'other /2 /\n  2'],
    ['(*values)', 'values /2 /\n  2'],
    ['(**values)', 'values /2 /\n  2'],
    ['(&callback)', 'callback /2 /\n  2'],
    ['((value, other))', 'other /2 /\n  2'],
    ['((value, (other, last)))', 'last /2 /\n  2'],
    ['', 'Patterns::Value /2 /\n  2'],
    ['', '(value /= 2; value /2 /\n  2)'],
    ['', ':value /2 /\n  2'],
    ['', '@value /2 /\n  2'],
    ['', '$value /2 /\n  2'],
    ['', 'self /2 /\n  2'],
    ['', 'Object /2 /\n  2'],
    ['', '(value = 8; value /2 /\n  2)'],
    ['', '8 %3'],
    ['', '1e3 /2 /\n  2'],
    ['', '0xFF /2 /\n  2'],
    ['', '1.5r /2 /\n  2'],
    ['', '?x /2 /\n  2'],
    ['', '?\\( /2 /\n  2'],
    ['', '?\\C-x /2 /\n  2'],
    ['', 'total /=\n  2'],
    ['', 'total %=\n  2'],
    ['', 'total /= /x/.source.length'],
    ['', 'wrap? /foo/'],
    ['', 'wrap / foo /\n  2'],
    ['', '%q ( '],
    ['', '%q_( _'],
    ['', '/x/ /2 /\n  2'],
  ])('keeps values and operator continuation %s %s', (parameters, expression) => {
    const declaration = `def first${parameters} = ${expression}\n`;
    const found = extractCodeSections(`${declaration}def after = 2\n`, 'fixture.rb');
    expect(found.map((section) => section.sectionId)).toEqual(['function-first', 'function-after']);
    expect(found[0]?.content).toBe(declaration);
    expect(found[1]?.content).toBe('def after = 2\n');
  });

  it.each(['%q{(}', 'Regexp.new /foo/'])(
    'retains singleton/module context for %s',
    (expression) => {
      const source = `module Patterns\n  def self.first = ${expression}\n  def after = 2\nend\n`;
      const found = extractCodeSections(source, 'fixture.rb');
      expect(found.map((section) => section.sectionId)).toEqual([
        'function-self.first',
        'function-after',
      ]);
      expect(found[0]?.content).toBe(`module Patterns\n  def self.first = ${expression}\n`);
      expect(found[0]?.breadcrumb).toEqual(['module Patterns', 'function self.first']);
      expect(found[1]?.content).toBe('  def after = 2\nend');
      expect(found[1]?.breadcrumb).toEqual(['module Patterns', 'function after']);
    },
  );
});
