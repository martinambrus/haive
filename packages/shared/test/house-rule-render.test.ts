import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as render from '../src/global-kb/house-rule-render.js';
import * as rules from '../src/global-kb/house-rules.js';

const source = readFileSync(
  new URL('../src/global-kb/house-rule-render.ts', import.meta.url),
  'utf8',
);

const MODULE_SPECIFIER = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*(['"])([^'"\n]+)\1/g;
const specifiers = [...source.matchAll(MODULE_SPECIFIER)].map((match) => match[2]!);

describe('the browser-safe house-rule render module', () => {
  it('names the modules it takes, so the checks below cannot pass by matching nothing', () => {
    expect(specifiers).toContain('../utils/collapse-line.js');
  });

  it('has no node: import, since the web bundles it', () => {
    expect(specifiers.filter((specifier) => specifier.startsWith('node:'))).toEqual([]);
  });

  it('does not import house-rules, which imports node:crypto', () => {
    expect(specifiers.filter((specifier) => /(^|\/)house-rules(\.js)?$/.test(specifier))).toEqual(
      [],
    );
  });

  it('takes the schema as types only, since the schema module pulls in the database drivers', () => {
    expect(source).toMatch(/^import type \{[^}]*\} from '\.\/schema\.js';$/m);
    expect(source).not.toMatch(/^import (?!type\b)[^;]*from '\.\/schema\.js';$/m);
  });
});

describe('house-rules.ts re-exporting the render', () => {
  it('hands out the very bindings the render module holds', () => {
    expect(rules.renderHouseRuleEntry).toBe(render.renderHouseRuleEntry);
    expect(rules.houseRuleShortIds).toBe(render.houseRuleShortIds);
    expect(rules.HOUSE_RULES_END).toBe(render.HOUSE_RULES_END);
  });

  it('keeps the byte count, which needs Buffer, out of the render module', () => {
    expect(typeof rules.houseRuleBytes).toBe('function');
    expect(Object.keys(render)).not.toContain('houseRuleBytes');
  });
});
