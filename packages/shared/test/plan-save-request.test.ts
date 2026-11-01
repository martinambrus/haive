import { expect, it } from 'vitest';
import { planSnapshotSaveRequestSchema } from '../src/schemas/plan.js';

it('rejects NUL in a plan Save commit message before Git can stage anything', () => {
  for (const commitMessage of ['\0subject', 'sub\0ject', 'subject\0']) {
    const result = planSnapshotSaveRequestSchema.safeParse({ commitMessage });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['commitMessage']);
  }
  expect(planSnapshotSaveRequestSchema.parse({})).toEqual({ push: false });
  expect(planSnapshotSaveRequestSchema.parse({ push: true, commitMessage: '  subject  ' })).toEqual(
    { push: true, commitMessage: 'subject' },
  );
});
