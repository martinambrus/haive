import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TASK_STATUSES,
  OPEN_TASK_STATUSES,
  PAUSED_FILTER_TOKEN,
  WAITING_SLOT_FILTER_TOKEN,
  expandTaskStatusFilter,
} from '../src/schemas/tasks.js';

describe('expandTaskStatusFilter', () => {
  it('treats empty / null / undefined as no filter (all)', () => {
    expect(expandTaskStatusFilter('')).toBeNull();
    expect(expandTaskStatusFilter(null)).toBeNull();
    expect(expandTaskStatusFilter(undefined)).toBeNull();
  });

  it('expands the compound tokens the dropdown and repo deep-links emit', () => {
    // 'open' = non-terminal; 'active' = open minus waiting_user; 'unfinished'
    // = open plus failed. These back the repositories-page ?status=open|active
    // links, so they must stay in lockstep with the constant sets.
    expect(expandTaskStatusFilter('open')).toEqual([...OPEN_TASK_STATUSES]);
    expect(expandTaskStatusFilter('active')).toEqual([...ACTIVE_TASK_STATUSES]);
    expect(expandTaskStatusFilter('unfinished')).toEqual([...OPEN_TASK_STATUSES, 'failed']);
  });

  it('passes through an exact valid status', () => {
    expect(expandTaskStatusFilter('completed')).toEqual(['completed']);
    expect(expandTaskStatusFilter('cancelled')).toEqual(['cancelled']);
  });

  it('returns null for the derived tokens so the api adds their own predicate', () => {
    // Neither is a task status. A slot-parked task and a paused task both keep
    // `running` in the DB, so expanding either into a status IN (...) list would
    // select the wrong rows — the api branches on the constants instead.
    expect(expandTaskStatusFilter(WAITING_SLOT_FILTER_TOKEN)).toBeNull();
    expect(expandTaskStatusFilter(PAUSED_FILTER_TOKEN)).toBeNull();
  });

  it('keeps the derived tokens out of the compound sets', () => {
    // 'paused' used to sit in these lists as an enum member nothing wrote. A paused
    // task now belongs to open/active/unfinished through its REAL status, so the
    // literal must not come back — it would match zero rows and mask the predicate.
    expect(OPEN_TASK_STATUSES).not.toContain('paused');
    expect(ACTIVE_TASK_STATUSES).not.toContain('paused');
  });

  it('falls back to no filter for an unrecognized token', () => {
    expect(expandTaskStatusFilter('bogus')).toBeNull();
  });
});
