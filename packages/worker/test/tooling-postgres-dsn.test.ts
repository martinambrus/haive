import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { toolingInfrastructureStep } from '../src/step-engine/steps/onboarding/04-tooling-infrastructure.js';

it.each(['sslrootcert', 'sslcert', 'sslkey', 'host'])(
  'refuses %s in a tooling answer before any filesystem or database access',
  async (parameter) => {
    const dsn = `postgres://user:${randomBytes(12).toString('hex')}@db.invalid/store?${parameter}=%2Fprivate%2Ffile`;
    await expect(
      toolingInfrastructureStep.apply(
        {} as StepContext,
        {
          detected: { cliSupportsLsp: false },
          formValues: { ragMode: 'external', ragConnectionString: dsn },
        } as never,
      ),
    ).rejects.toMatchObject({
      code: 'user_postgres_dsn_refused',
      parameter,
      message: `PostgreSQL connection parameter "${parameter}" is not allowed. Remove it from the saved connection string and save again.`,
    });
  },
);
