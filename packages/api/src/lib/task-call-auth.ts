import { verifyTaskToken, type TaskTokenAudience } from '@haive/shared/task-token';
import { HttpError } from '../context.js';

export interface TaskCallClaims {
  taskId: string;
  taskStepId: string;
  cliInvocationId: string;
}

export function claimsFromBearer(
  authHeader: string | undefined,
  audience: TaskTokenAudience,
): TaskCallClaims {
  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret) throw new HttpError(500, 'server misconfigured: CONFIG_ENCRYPTION_KEY unset');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const claims = token ? verifyTaskToken(token, audience, secret) : null;
  if (!claims?.taskStepId || !claims.cliInvocationId) {
    throw new HttpError(401, `invalid or missing ${audience} token`);
  }
  return {
    taskId: claims.taskId,
    taskStepId: claims.taskStepId,
    cliInvocationId: claims.cliInvocationId,
  };
}

export function assertInvocationLive<
  T extends {
    taskId: string;
    taskStepId: string | null;
    endedAt: Date | null;
    supersededAt: Date | null;
  },
>(row: T | undefined, claims: TaskCallClaims): asserts row is T {
  if (
    !row ||
    row.taskId !== claims.taskId ||
    row.taskStepId !== claims.taskStepId ||
    row.endedAt !== null ||
    row.supersededAt !== null
  ) {
    throw new HttpError(401, 'this invocation is not live', 'invocation-not-live');
  }
}
