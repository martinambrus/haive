import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { shellQuote } from './shell-quote.js';

describe('shellQuote', () => {
  const NUL = String.fromCharCode(0);
  const VALUES = [
    'plain',
    '',
    'a b',
    "it's",
    "'",
    "''",
    '$(id)',
    '`id`',
    '${HOME}',
    'a;b|c&d>e<f',
    '*?[a]~#!',
    'back\\slash',
    '"double"',
    'line\nbreak',
    'tab\there',
    '-n',
    'café',
  ];
  const wordsOf = (script: string): string[] =>
    execFileSync('bash', ['-c', script], { encoding: 'utf8' }).split(NUL).slice(0, -1);

  // The control: the check below has to be able to fail, or a green run proves nothing.
  it('sees the words bash makes of values left unquoted, and they are not the values', () => {
    const values = ['a b', '$(echo hi)'];
    expect(wordsOf(`printf '%s\\0' ${values.join(' ')}`)).toEqual(['a', 'b', 'hi']);
  });

  it('hands bash every value back as one word, unchanged', () => {
    expect(wordsOf(`printf '%s\\0' ${VALUES.map(shellQuote).join(' ')}`)).toEqual(VALUES);
  });
});
