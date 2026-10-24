import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');

const EXEMPT: Record<string, string> = {
  'auth/jwt.ts': 'defines verifyAccessToken',
  'middleware/maintenance.ts':
    'reads the role only to let administrators through a maintenance 503, and refuses nothing else',
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

function verdict(files: Array<{ name: string; text: string }>) {
  const callers = files.filter((f) => f.text.includes('verifyAccessToken('));
  return {
    callersWithoutTheFlag: callers
      .filter((f) => !(f.name in EXEMPT) && !f.text.includes('mustChangePassword'))
      .map((f) => f.name)
      .sort(),
    staleExemptions: Object.keys(EXEMPT).filter((name) => !callers.some((f) => f.name === name)),
  };
}

describe('every place that authenticates an access token', () => {
  it('also reads mustChangePassword, except the listed files', () => {
    const files = walk(SRC)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ name: relative(SRC, f), text: readFileSync(f, 'utf8') }));
    const { callersWithoutTheFlag, staleExemptions } = verdict(files);
    expect(
      { callersWithoutTheFlag, staleExemptions },
      'refuse a user who must change their password where the token is verified, or list the file in EXEMPT with its reason',
    ).toEqual({ callersWithoutTheFlag: [], staleExemptions: [] });
  });

  it('names a file that verifies a token and never reads the flag', () => {
    const { callersWithoutTheFlag } = verdict([
      { name: 'routes/zz-new.ts', text: 'await verifyAccessToken(token);' },
      { name: 'routes/zz-ok.ts', text: 'await verifyAccessToken(t); user.mustChangePassword;' },
    ]);
    expect(callersWithoutTheFlag).toEqual(['routes/zz-new.ts']);
  });

  it('is not a pass for a tree with no callers', () => {
    expect(verdict([]).staleExemptions).toEqual(Object.keys(EXEMPT));
  });
});
