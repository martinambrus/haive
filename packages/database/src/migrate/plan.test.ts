import { describe, expect, it } from 'vitest';
import { localMigrations, planPending } from './plan.js';

const files = (...names: string[]) =>
  localMigrations(names.map((filename) => ({ filename, checksum: `sum-${filename}` })));

describe('planPending', () => {
  it('applies everything when nothing is recorded', () => {
    const plan = planPending(files('0000_baseline.sql', '0153_a.sql'), []);
    expect(plan.toApply.map((m) => m.id)).toEqual(['0000_baseline', '0153_a']);
  });

  it('applies only the tail', () => {
    const plan = planPending(files('0000_baseline.sql', '0153_a.sql'), [
      { id: '0000_baseline', checksum: 'sum-0000_baseline.sql' },
    ]);
    expect(plan.toApply.map((m) => m.id)).toEqual(['0153_a']);
  });

  // A mismatch on an early file must stop everything, not just that file: applying file 200
  // while file 3 is in dispute is how two installs end up claiming the same schema.
  it('surfaces a checksum mismatch and applies nothing', () => {
    const plan = planPending(files('0000_baseline.sql', '0153_a.sql'), [
      { id: '0000_baseline', checksum: 'something-else' },
    ]);
    expect(plan.mismatched).toEqual([
      { id: '0000_baseline', recorded: 'something-else', actual: 'sum-0000_baseline.sql' },
    ]);
    expect(plan.toApply).toEqual([]);
  });

  // A database ahead of the code is exactly what a rollback to older images produces. The caller
  // warns; it is not an error on its own.
  it('reports journal rows with no file as unknown', () => {
    const plan = planPending(files('0000_baseline.sql'), [
      { id: '0000_baseline', checksum: 'sum-0000_baseline.sql' },
      { id: '0199_from_the_future', checksum: 'x' },
    ]);
    expect(plan.unknown).toEqual(['0199_from_the_future']);
    expect(plan.toApply).toEqual([]);
  });

  it('unknown rows AND pending files together are a fork the caller must refuse', () => {
    const plan = planPending(files('0000_baseline.sql', '0153_a.sql'), [
      { id: '0000_baseline', checksum: 'sum-0000_baseline.sql' },
      { id: '0199_from_the_future', checksum: 'x' },
    ]);
    expect(plan.unknown).toEqual(['0199_from_the_future']);
    expect(plan.toApply.map((m) => m.id)).toEqual(['0153_a']);
  });

  // Both sequence defects from the real corpus, as fixtures. The point is that the journal key is
  // a filename stem, so a duplicated number is two representable rows, and a gap needs no
  // handling at all because nothing computes an expected next number.
  it('represents the duplicated 0142 as two rows and ignores the 0065 gap', () => {
    const local = files(
      '0064_a.sql',
      '0066_b.sql',
      '0142_review_dimensions.sql',
      '0142_task_summary_cli.sql',
    );
    const plan = planPending(local, [
      { id: '0064_a', checksum: 'sum-0064_a.sql' },
      { id: '0142_review_dimensions', checksum: 'sum-0142_review_dimensions.sql' },
    ]);
    expect(plan.toApply.map((m) => m.id)).toEqual(['0066_b', '0142_task_summary_cli']);
    expect(plan.mismatched).toEqual([]);
    expect(plan.unknown).toEqual([]);
  });
});
