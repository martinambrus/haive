import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { haltFailed } from '../src/step-engine/merge-resolver.js';
import type { AdvanceStepParams, TaskStepRow } from '../src/step-engine/step-runner.js';

describe('merge failure display text', () => {
  it.each(['/var/lib/haive/repos/user/repo', '/host-fs/private/repo'])(
    'scrubs storage paths at the halt sink (%s)',
    async (root) => {
      const fake = createFakeDb({ taskSteps: schema.taskSteps });
      fake.insert(schema.taskSteps, {
        id: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
        status: 'running',
      });
      const current = fake.rows(schema.taskSteps)[0] as unknown as TaskStepRow;
      const result = await haltFailed(
        fake.db as unknown as Database,
        current,
        {} as AdvanceStepParams,
        null,
        'Nothing was merged: EIO: open ' + root + '/.git; config /etc/nginx/x.conf:5',
        'merge failed',
      );
      expect(fake.rows(schema.taskSteps)[0]).toMatchObject({
        status: 'failed',
        errorMessage: 'Nothing was merged: EIO: open [path]; config /etc/nginx/x.conf:5',
      });
      expect(result).toMatchObject({
        resolved: false,
        result: {
          status: 'failed',
          error: 'Nothing was merged: EIO: open [path]; config /etc/nginx/x.conf:5',
        },
      });
    },
  );
});
