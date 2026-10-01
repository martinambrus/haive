import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isBranchName } from '../src/git-args.js';

const gitAccepts = (name: string): boolean => {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const NAMES = [
  'main',
  'feature/x',
  'release/2026.10',
  '+topic',
  'x/HEAD',
  'naïve',
  '-x',
  '--upload-pack=touch /tmp/marker',
  'a:b',
  'a..b',
  'a b',
  'a\tb',
  'a~1',
  'a^',
  'a?',
  'a*',
  'a[b',
  'a\\b',
  '.a',
  'a/.b',
  'a.lock',
  'a/b.lock/c',
  'a/',
  '/a',
  'a//b',
  'a@{1}',
  'a.',
  'HEAD',
  '',
];

describe('isBranchName', () => {
  it.each(NAMES)('agrees with git check-ref-format --branch on %j', (name) => {
    expect(isBranchName(name)).toBe(gitAccepts(name));
  });

  it('refuses @ alone, which git reads as HEAD rather than a branch', () => {
    expect(isBranchName('@')).toBe(false);
  });
});
