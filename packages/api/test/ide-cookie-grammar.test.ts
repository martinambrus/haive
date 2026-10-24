import { describe, expect, it } from 'vitest';
import { withoutSessionCookies } from '../src/auth/cookies.js';

describe('IDE cookie grammar controls', () => {
  it.each([
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
