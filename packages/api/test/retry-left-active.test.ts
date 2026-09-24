import { describe, expect, it } from 'vitest';
import { rowsLeftActive } from '../src/routes/tasks/steps.js';

const row = (id: string, status: string) => ({ id, status });

describe('rowsLeftActive', () => {
  it('names every active row outside the set the action resets', () => {
    const rows = [
      row('clicked', 'failed'),
      row('downstream', 'waiting_cli'),
      row('other-round-cli', 'waiting_cli'),
      row('other-round-apply', 'running'),
      row('other-round-form', 'waiting_form'),
    ];
    expect(rowsLeftActive(rows, ['clicked', 'downstream']).map((r) => r.id)).toEqual([
      'other-round-cli',
      'other-round-apply',
      'other-round-form',
    ]);
  });

  it('leaves settled and unstarted rows alone', () => {
    const rows = ['pending', 'done', 'failed', 'skipped'].map((status) => row(status, status));
    expect(rowsLeftActive(rows, [])).toEqual([]);
  });
});
