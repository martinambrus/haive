import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/context.js';
import { DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS, parseStatsQuery } from '../src/routes/stats/_query.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-09-06T12:00:00Z');

describe('parseStatsQuery', () => {
  it('defaults to the last N days ending now, in UTC', () => {
    const q = parseStatsQuery({}, NOW);
    expect(q.toMs).toBe(NOW);
    expect(q.fromMs).toBe(NOW - DEFAULT_RANGE_DAYS * DAY_MS);
    // UTC, not the server's zone: a server-local default would silently re-bucket every chart
    // if the container TZ changed.
    expect(q.timeZone).toBe('UTC');
    expect(q).toMatchObject({
      repositoryId: null,
      cliProviderId: null,
      taskClass: null,
      allUsers: false,
    });
  });

  it('anchors the default window on an explicit `to`', () => {
    const to = Date.parse('2026-01-31T00:00:00Z');
    const q = parseStatsQuery({ to: '2026-01-31T00:00:00Z' }, NOW);
    expect(q.toMs).toBe(to);
    expect(q.fromMs).toBe(to - DEFAULT_RANGE_DAYS * DAY_MS);
  });

  it('accepts an explicit range', () => {
    const q = parseStatsQuery({ from: '2026-09-01T00:00:00Z', to: '2026-09-06T00:00:00Z' }, NOW);
    expect(q.fromMs).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(q.toMs).toBe(Date.parse('2026-09-06T00:00:00Z'));
  });

  it('rejects an inverted range', () => {
    expect(() =>
      parseStatsQuery({ from: '2026-09-06T00:00:00Z', to: '2026-09-01T00:00:00Z' }, NOW),
    ).toThrow(HttpError);
  });

  it('accepts a zero-length range', () => {
    // Legitimate: "today so far" collapses to this at midnight, and it must return empty
    // rather than 400.
    const q = parseStatsQuery({ from: '2026-09-06T00:00:00Z', to: '2026-09-06T00:00:00Z' }, NOW);
    expect(q.toMs - q.fromMs).toBe(0);
  });

  it('rejects a range past the cap', () => {
    // The timeline endpoint fetches one row per invocation across the window; an unbounded
    // range is a request that quietly takes a minute.
    const to = '2026-09-06T00:00:00Z';
    const justOver = new Date(Date.parse(to) - (MAX_RANGE_DAYS + 1) * DAY_MS).toISOString();
    const justUnder = new Date(Date.parse(to) - MAX_RANGE_DAYS * DAY_MS).toISOString();
    expect(() => parseStatsQuery({ from: justOver, to }, NOW)).toThrow(HttpError);
    expect(() => parseStatsQuery({ from: justUnder, to }, NOW)).not.toThrow();
  });

  it('rejects an unparseable timestamp', () => {
    for (const bad of ['yesterday', 'NaN', '2026-13-45']) {
      expect(() => parseStatsQuery({ from: bad }, NOW)).toThrow(HttpError);
      expect(() => parseStatsQuery({ to: bad }, NOW)).toThrow(HttpError);
    }
  });

  it('accepts a real IANA zone and rejects anything Intl does not know', () => {
    expect(parseStatsQuery({ tz: 'Europe/Bratislava' }, NOW).timeZone).toBe('Europe/Bratislava');
    expect(parseStatsQuery({ tz: 'America/New_York' }, NOW).timeZone).toBe('America/New_York');
    // An unknown zone throws a RangeError deep inside the bucket walk if it is not caught
    // here, with a message naming neither the zone nor the parameter.
    for (const bad of ['Mars/Olympus', 'CET+2', 'Europe/Bratislava; drop table']) {
      expect(() => parseStatsQuery({ tz: bad }, NOW)).toThrow(HttpError);
    }
  });

  it('treats an empty string as absent for every optional parameter', () => {
    // A browser that clears a filter sends `?repositoryId=`, which must mean "no filter"
    // rather than "a repository whose id is the empty string".
    const q = parseStatsQuery(
      {
        from: '',
        to: '',
        tz: '',
        repositoryId: '',
        cliProviderId: '',
        taskClass: '',
        allUsers: '',
      },
      NOW,
    );
    expect(q).toMatchObject({
      toMs: NOW,
      timeZone: 'UTC',
      repositoryId: null,
      cliProviderId: null,
      taskClass: null,
      allUsers: false,
    });
  });

  it('validates the uuid facets before they reach Postgres', () => {
    // Postgres errors on a malformed uuid literal rather than returning no rows.
    const id = '3b6e06c0-a43a-4fee-8636-98304d2aa733';
    expect(parseStatsQuery({ repositoryId: id }, NOW).repositoryId).toBe(id);
    expect(parseStatsQuery({ cliProviderId: id }, NOW).cliProviderId).toBe(id);
    expect(() => parseStatsQuery({ repositoryId: 'nope' }, NOW)).toThrow(HttpError);
    expect(() => parseStatsQuery({ cliProviderId: "' or 1=1--" }, NOW)).toThrow(HttpError);
  });

  it('accepts the known task classes and rejects a raw task type', () => {
    expect(parseStatsQuery({ taskClass: 'work' }, NOW).taskClass).toBe('work');
    expect(parseStatsQuery({ taskClass: 'other' }, NOW).taskClass).toBe('other');
    // `workflow` is a tasks.type value, not a class — accepting it would filter nothing.
    expect(() => parseStatsQuery({ taskClass: 'workflow' }, NOW)).toThrow(HttpError);
  });

  it('reads allUsers as a flag without deciding whether it is allowed', () => {
    // Authorization is the route's job: this parser has no access to the caller's role.
    expect(parseStatsQuery({ allUsers: '1' }, NOW).allUsers).toBe(true);
    expect(parseStatsQuery({ allUsers: 'true' }, NOW).allUsers).toBe(true);
    expect(parseStatsQuery({ allUsers: '0' }, NOW).allUsers).toBe(false);
    expect(parseStatsQuery({ allUsers: 'yes' }, NOW).allUsers).toBe(false);
  });
});
