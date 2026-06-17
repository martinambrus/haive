import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TASK_STATUSES,
  OPEN_TASK_STATUSES,
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

  it('passes through an exact valid status, including the enum-only "paused"', () => {
    expect(expandTaskStatusFilter('completed')).toEqual(['completed']);
    expect(expandTaskStatusFilter('cancelled')).toEqual(['cancelled']);
    // 'paused' is a live DB status the shared TaskStatus union omits; the filter
    // must still honour it so a hand-built ?status=paused works.
    expect(expandTaskStatusFilter('paused')).toEqual(['paused']);
  });

  it('falls back to no filter for an unrecognized token', () => {
    expect(expandTaskStatusFilter('bogus')).toBeNull();
  });
});
