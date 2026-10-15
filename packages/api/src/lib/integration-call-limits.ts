import { BODY_MAX_LENGTH, BRANCH_MAX_LENGTH, TITLE_MAX_LENGTH } from '@haive/shared/forge';

export const INTEGRATION_CALL_DEADLINE_MS = 30_000;
export const INTEGRATION_CALL_BUDGET = 50;
// The longest open_pull_request arguments, every character a JSON-escaped surrogate pair (12 bytes), plus the envelope.
export const INTEGRATION_CALL_BODY_LIMIT_BYTES =
  (BODY_MAX_LENGTH + TITLE_MAX_LENGTH + 2 * BRANCH_MAX_LENGTH) * 12 + 16 * 1024;
