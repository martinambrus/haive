import { describe, expect, it } from 'vitest';
import {
  PORTABLE_SETTING_NAMES,
  TEXT_SETTINGS,
  TOOLING_UNIT_NAME,
  hasConflictMarker,
  rawTextProblem,
  settingFileName,
  settingNameOfFile,
} from '../src/project-state/index.js';

describe('the files of the record’s settings', () => {
  it('holds the rules text as a Markdown file and every other setting as JSON', () => {
    expect([...TEXT_SETTINGS]).toEqual(['agent-rules']);
    expect(settingFileName('agent-rules')).toBe('settings/agent-rules.md');
    for (const name of PORTABLE_SETTING_NAMES.filter((n) => !TEXT_SETTINGS.has(n))) {
      expect(settingFileName(name)).toBe(`settings/${name}.json`);
    }
    expect(settingFileName(TOOLING_UNIT_NAME)).toBe('settings/onboarding-tooling.json');
    expect(settingFileName('from-the-future')).toBe('settings/from-the-future.json');
  });

  it('keeps every text setting among the portable ones', () => {
    for (const name of TEXT_SETTINGS) expect(PORTABLE_SETTING_NAMES).toContain(name);
  });

  it('reads a name off the file written for it, and off no other', () => {
    for (const name of [...PORTABLE_SETTING_NAMES, TOOLING_UNIT_NAME, 'from-the-future']) {
      expect(settingNameOfFile(settingFileName(name))).toBe(name);
    }
  });

  it.each([
    'settings/agent-rules.json',
    'settings/rtk-version.md',
    'settings/from-the-future.md',
    'settings/lsp-servers.json#x',
    'settings/agent-rules.md#x',
    'settings/agent-rules.md/x',
    'settings/agent-rules.json.md',
    'settings/agent-rules.MD',
    'settings/agent-rules.txt',
    'settings/agent-rules.md\n',
    'settings/.md',
    'settings/',
    'settings',
    'x/settings/agent-rules.md',
    '/settings/agent-rules.md',
    'cli/agent-rules.md',
    'agent-rules.md',
  ])('reads no setting off %s', (rel) => {
    expect(settingNameOfFile(rel)).toBeNull();
  });

  it('knows a prototype name as no text setting', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(TEXT_SETTINGS.has(name)).toBe(false);
      expect(settingFileName(name)).toBe(`settings/${name}.json`);
    }
  });
});

describe('hasConflictMarker', () => {
  it.each([
    '<<<<<<< ours',
    '>>>>>>> theirs',
    '||||||| base',
    '<<<<<<<',
    '=======',
    'a\n=======\nb',
    'a\r\n=======\r\nb',
    'a\r=======',
    'a\u2028=======',
    'a\u2029<<<<<<< x',
  ])('finds a marker line in %j', (text) => {
    expect(hasConflictMarker(text)).toBe(true);
  });

  it.each([
    '',
    '========',
    '======',
    '<<<<<<<<',
    '<<<<<<<x',
    '>>>>>>>x',
    'a =======',
    '======= a',
    '=======x',
    ' =======',
    '<<<<<<',
  ])('finds none in %j', (text) => {
    expect(hasConflictMarker(text)).toBe(false);
  });

  it('answers the same however often it is asked', () => {
    for (let i = 0; i < 3; i++) expect(hasConflictMarker('=======')).toBe(true);
  });
});

describe('rawTextProblem', () => {
  it.each(['', 'a', 'a\n', 'a\r\n b \t\n\n\n\nc', '\uFEFFa', '😀', '=======x', '```\n=====\n```'])(
    'finds none in %j',
    (text) => {
      expect(rawTextProblem(text)).toBeNull();
    },
  );

  it.each([
    [7, 'is not a string'],
    [null, 'is not a string'],
    [undefined, 'is not a string'],
    [['a'], 'is not a string'],
    ['a\uD800', 'holds a lone surrogate'],
    ['\uDC00', 'holds a lone surrogate'],
    ['a\u0000b', 'holds a NUL character'],
    ['\u0000', 'holds a NUL character'],
    ['a\n=======\n', 'holds merge conflict markers'],
    ['<<<<<<< ours\nx', 'holds merge conflict markers'],
  ])('names the problem with %j', (text, problem) => {
    expect(rawTextProblem(text)).toBe(problem);
  });
});
