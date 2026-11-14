import { expect, it } from 'vitest';
import {
  fencedAgentBlock,
  UNTRUSTED_OPEN,
  UNTRUSTED_CLOSE,
  LINE_BREAK,
  fenceSafe,
} from '../src/step/prompts.js';
import { isListableName } from '../src/step/review.js';

it('pins the exact banners emitted around agent-authored text', () => {
  expect(fencedAgentBlock('quoted ==== text')).toBe(
    '===== BEGIN UNTRUSTED AGENT TEXT =====\nquoted === text\n===== END UNTRUSTED AGENT TEXT =====',
  );
  expect(fencedAgentBlock('body').split('\n')).toEqual([UNTRUSTED_OPEN, 'body', UNTRUSTED_CLOSE]);
});

it('keeps listable names equivalent to the original line and fence guards', () => {
  const cases: [string, boolean][] = [
    ['plain name.ts', true],
    ['API===Security.md', true],
    ['API====Security.md', false],
    ['API=====Security.md', false],
    ['line\nbreak', false],
    ['line\rbreak', false],
    ['line\u0085break', false],
    ['line\u2028break', false],
    ['line\u2029break', false],
    ['tab\tname', true],
  ];
  for (const [name, expected] of cases) {
    expect(isListableName(name), JSON.stringify(name)).toBe(expected);
    expect(isListableName(name)).toBe(!LINE_BREAK.test(name) && fenceSafe(name) === name);
    expect(isListableName(name)).toBe(!LINE_BREAK.test(name) && !/={4,}/.test(name));
  }
});
