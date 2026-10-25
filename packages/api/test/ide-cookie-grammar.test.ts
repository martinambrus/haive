import { describe, expect, it } from 'vitest';
import { withoutSessionCookies } from '../src/auth/cookies.js';

describe('IDE cookie grammar controls', () => {
  it.each([
    ['prefs={"theme":"dark"}; haive_access=A; a=1', 'prefs={"theme":"dark"}; a=1'],
    ['name=café; haive_refresh=R; a=1', 'name=café; a=1'],
    ['name=cafÃ©; haive_refresh=R; a=1', 'name=cafÃ©; a=1'],
    ['foo; haive_access=A; a=1', 'foo; a=1'],
    ['=foo; a b=1; p=a"b; p=a\\b; haive_access=A', 'a b=1; p=a"b; p=a\\b'],
    ['p="abc; haive_access=secret; b=2', null],
    [' haive_access =secret; a=1', 'a=1'],
    ['\thaive_refresh\t=secret; a=1', 'a=1'],
    ['=haive_access=secret; a=1', 'a=1'],
    ['haive_access="secret; injected=a=b"; app=ok', 'app=ok'],
    ['app="value; haive_access=secret"; theme=dark', 'theme=dark'],
    ['app="value; invented=a=b"; haive_refresh=R; theme=dark', 'theme=dark'],
    ['haive_access="unterminated; injected=secret', null],
    ['app="a=b=="; haive_access=A; encoded=%2f%3B', 'app="a=b=="; encoded=%2f%3B'],
    ['haive_access="a=b"; app=""; app=duplicate', 'app=""; app=duplicate'],
  ])('filters %s without inventing pairs', (input, expected) => {
    expect(withoutSessionCookies(input)).toBe(expected);
  });
});
