import { describe, expect, it } from 'vitest';
import { classifyDatabase, columnDrift, type ClassifyInput } from './adoption.js';

const EXPECTED = ['users', 'tasks', 'repositories', 'cli_providers'];
const OURS = ['id', 'checksum', 'applied_at', 'duration_ms', 'applied_by'];

function classify(overrides: Partial<ClassifyInput>) {
  return classifyDatabase({
    expectedTables: EXPECTED,
    presentTables: [],
    journalColumns: null,
    journalRowCount: 0,
    ...overrides,
  });
}

describe('classifyDatabase', () => {
  it('an empty database is fresh', () => {
    expect(classify({}).kind).toBe('fresh');
  });

  it('a full schema with no journal is legacy — a database the old push applier built', () => {
    expect(classify({ presentTables: EXPECTED }).kind).toBe('legacy');
  });

  it('a journal with rows is managed', () => {
    expect(
      classify({ presentTables: EXPECTED, journalColumns: OURS, journalRowCount: 3 }).kind,
    ).toBe('managed');
  });

  // The whole reason a single probe table is the wrong evidence: `push --force` is not
  // transactional, so an interrupted push leaves an arbitrary PREFIX of the schema, and `users`
  // is near the front of it.
  it('a partial schema is indeterminate, and names what is missing', () => {
    const result = classify({ presentTables: ['users', 'tasks'] });
    expect(result.kind).toBe('indeterminate');
    expect(result.missingTables).toEqual(['repositories', 'cli_providers']);
  });

  it('a single table present is indeterminate, never fresh', () => {
    expect(classify({ presentTables: ['users'] }).kind).toBe('indeterminate');
  });

  // A `schema_migrations` created by an EMPTY journal proves nothing, so the quorum still
  // decides. This is also what makes recovery automatic after `push --force` drops the journal.
  it('an empty journal falls through to the quorum', () => {
    expect(
      classify({ presentTables: EXPECTED, journalColumns: OURS, journalRowCount: 0 }).kind,
    ).toBe('legacy');
    expect(classify({ presentTables: [], journalColumns: OURS, journalRowCount: 0 }).kind).toBe(
      'fresh',
    );
    expect(
      classify({ presentTables: ['users'], journalColumns: OURS, journalRowCount: 0 }).kind,
    ).toBe('indeterminate');
  });

  // Once the journal has rows the quorum must NOT be consulted, or a later migration that
  // legitimately DROPs a baseline table would make a managed database read as half-built.
  it('a managed database with a dropped baseline table stays managed', () => {
    expect(
      classify({ presentTables: ['users'], journalColumns: OURS, journalRowCount: 9 }).kind,
    ).toBe('managed');
  });

  it('someone else’s schema_migrations is a foreign journal, never migrated', () => {
    const result = classify({
      presentTables: EXPECTED,
      journalColumns: ['version'], // Rails
      journalRowCount: 40,
    });
    expect(result.kind).toBe('foreign-journal');
    expect(result.missingJournalColumns).toEqual(['id', 'checksum', 'applied_at']);
  });

  // The invariant that matters most: nothing may be treated as empty while any of our schema is
  // there, because `fresh` is the verdict that runs CREATE TABLE.
  it('never returns fresh when any expected table is present', () => {
    for (let n = 1; n <= EXPECTED.length; n++) {
      const result = classify({ presentTables: EXPECTED.slice(0, n) });
      expect(result.kind).not.toBe('fresh');
    }
  });
});

describe('columnDrift', () => {
  it('reports columns the baseline has and the database does not', () => {
    const drift = columnDrift(
      new Set(['users.id', 'users.git_name', 'tasks.id']),
      new Set(['users.id', 'tasks.id']),
    );
    expect(drift.missing).toEqual(['users.git_name']);
  });

  // A developer whose database is AHEAD of the baseline is the normal case, not a fault.
  it('tolerates extra columns', () => {
    const drift = columnDrift(
      new Set(['users.id']),
      new Set(['users.id', 'users.something_newer']),
    );
    expect(drift.missing).toEqual([]);
  });
});
