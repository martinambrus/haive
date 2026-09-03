import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/context.js';
import {
  DEFAULT_INVOCATION_HISTORY_LIMIT,
  MAX_INVOCATION_HISTORY_LIMIT,
  parseInvocationHistoryQuery,
} from '../src/routes/tasks/_invocation-history.js';

const UUID = '7b0d3541-d3d8-4e9e-820f-cbc6cdb24118';

describe('parseInvocationHistoryQuery', () => {
  it('defaults to a bounded page with no cursor', () => {
    expect(parseInvocationHistoryQuery({})).toEqual({
      limit: DEFAULT_INVOCATION_HISTORY_LIMIT,
      cursor: null,
    });
  });

  it('treats empty strings as absent, so a bare ?historyCursor= is the head page', () => {
    expect(parseInvocationHistoryQuery({ historyLimit: '', historyCursor: '' })).toEqual({
      limit: DEFAULT_INVOCATION_HISTORY_LIMIT,
      cursor: null,
    });
  });

  it('accepts a limit inside the range, including the split column’s 1 and 0', () => {
    expect(parseInvocationHistoryQuery({ historyLimit: '1' }).limit).toBe(1);
    expect(parseInvocationHistoryQuery({ historyLimit: '0' }).limit).toBe(0);
    expect(
      parseInvocationHistoryQuery({ historyLimit: String(MAX_INVOCATION_HISTORY_LIMIT) }).limit,
    ).toBe(MAX_INVOCATION_HISTORY_LIMIT);
  });

  it('rejects a limit that is negative, fractional, over the cap, or not a number', () => {
    for (const bad of ['-1', '2.5', String(MAX_INVOCATION_HISTORY_LIMIT + 1), 'all', 'NaN']) {
      expect(() => parseInvocationHistoryQuery({ historyLimit: bad })).toThrow(HttpError);
    }
  });

  it('accepts a UUID cursor and rejects anything else', () => {
    expect(parseInvocationHistoryQuery({ historyCursor: UUID }).cursor).toBe(UUID);
    // Rejected here rather than at the database: an unparseable uuid literal is a Postgres
    // ERROR, which would surface as a 500 on a merely malformed query string.
    for (const bad of [' ', 'null', '123', `${UUID}'`, `${UUID}extra`]) {
      expect(() => parseInvocationHistoryQuery({ historyCursor: bad })).toThrow(HttpError);
    }
  });
});
