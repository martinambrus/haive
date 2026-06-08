import { describe, expect, it } from 'vitest';
import {
  extractFencedJson,
  extractFencedJsonObjects,
  findBalancedEnd,
} from '../src/step-engine/steps/_fenced-json.js';

describe('findBalancedEnd', () => {
  it('matches a simple object close', () => {
    const s = '{"a":1}';
    expect(findBalancedEnd(s, 0)).toBe(s.length - 1);
  });

  it('matches a simple array close', () => {
    const s = '[1,2,3]';
    expect(findBalancedEnd(s, 0)).toBe(s.length - 1);
  });

  it('ignores brackets inside string values', () => {
    const s = '{"a":"} not the end ]"}';
    expect(findBalancedEnd(s, 0)).toBe(s.length - 1);
  });

  it('ignores escaped quotes inside strings', () => {
    const s = '{"a":"he said \\"}\\" loudly"}';
    expect(findBalancedEnd(s, 0)).toBe(s.length - 1);
  });

  it('returns -1 when the value never closes', () => {
    expect(findBalancedEnd('{"a":1', 0)).toBe(-1);
  });
});

describe('extractFencedJson', () => {
  it('parses a fenced object whose string field contains nested ``` fences (regression)', () => {
    const body = [
      '## Config',
      '```yaml',
      'key: value',
      '```',
      '```php',
      '<?php echo 1;',
      '```',
    ].join('\n');
    const raw = [
      'Some preamble.',
      '```json',
      JSON.stringify({ verdict: 'NEEDS_REVISION', score: 3, amendedSpec: body }),
      '```',
      'trailing prose with a stray ``` fence',
    ].join('\n');
    const slice = extractFencedJson(raw);
    expect(slice).not.toBeNull();
    const parsed = JSON.parse(slice as string);
    expect(parsed.score).toBe(3);
    expect(parsed.amendedSpec).toBe(body);
  });

  it('ignores trailing prose after the value', () => {
    const raw = '```json\n{"a":1}\n```\nthen some text { with a brace';
    expect(JSON.parse(extractFencedJson(raw) as string)).toEqual({ a: 1 });
  });

  it('recovers a fence-less bare object', () => {
    expect(JSON.parse(extractFencedJson('here: {"a":1} done') as string)).toEqual({ a: 1 });
  });

  it('returns a top-level array whole, not just the first object', () => {
    const raw = '```json\n[{"id":"a"},{"id":"b"}]\n```';
    const parsed = JSON.parse(extractFencedJson(raw) as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].id).toBe('b');
  });

  it('returns an object wrapping an array intact', () => {
    const raw = '```json\n{"entries":[{"id":"a"},{"id":"b"}]}\n```';
    const parsed = JSON.parse(extractFencedJson(raw) as string);
    expect(parsed.entries).toHaveLength(2);
  });

  it('returns null when there is no bracketed value', () => {
    expect(extractFencedJson('no json here at all')).toBeNull();
  });

  it('returns null when the value is truncated/unbalanced', () => {
    expect(extractFencedJson('```json\n{"a":1, "b":')).toBeNull();
  });
});

describe('extractFencedJsonObjects', () => {
  it('returns every object across multiple fenced blocks', () => {
    const raw = [
      '```json',
      '{"id":"one","body":"x"}',
      '```',
      'and another',
      '```json',
      '{"id":"two","body":"y"}',
      '```',
    ].join('\n');
    const objs = extractFencedJsonObjects(raw).map((s) => JSON.parse(s));
    expect(objs.map((o) => o.id)).toEqual(['one', 'two']);
  });

  it('salvages each object from a top-level array', () => {
    const raw = '```json\n[{"id":"a"},{"id":"b"},{"id":"c"}]\n```';
    const objs = extractFencedJsonObjects(raw).map((s) => JSON.parse(s));
    expect(objs.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('finds an object whose string field has nested ``` fences', () => {
    const body = ['```ts', 'const x = 1;', '```'].join('\n');
    const raw = ['```json', JSON.stringify({ id: 'a', body }), '```'].join('\n');
    const objs = extractFencedJsonObjects(raw).map((s) => JSON.parse(s));
    expect(objs).toHaveLength(1);
    expect(objs[0].body).toBe(body);
  });
});
