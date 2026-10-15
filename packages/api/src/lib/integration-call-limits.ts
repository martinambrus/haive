import { BODY_MAX_LENGTH, BRANCH_MAX_LENGTH, TITLE_MAX_LENGTH } from '@haive/shared/forge';

export const INTEGRATION_CALL_DEADLINE_MS = 30_000;
export const INTEGRATION_CALL_BUDGET = 50;
// The longest open_pull_request arguments with every character JSON-escaped as \uXXXX, plus the envelope.
export const INTEGRATION_CALL_BODY_LIMIT_BYTES =
  (BODY_MAX_LENGTH + TITLE_MAX_LENGTH + 2 * BRANCH_MAX_LENGTH) * 6 + 16 * 1024;
