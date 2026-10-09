/** Why a read of the store failed, as a class that is safe to record: the error's message names the host. */
export type GlobalKbErrorClass = 'timeout' | 'refused' | 'auth' | 'other';

export class GlobalKbDeadlineError extends Error {
  readonly code = 'GLOBAL_KB_DEADLINE';

  constructor(deadlineMs: number) {
    super(`global KB call exceeded ${deadlineMs} ms`);
    this.name = 'GlobalKbDeadlineError';
  }
}

const CLASS_BY_CODE: Readonly<Record<string, GlobalKbErrorClass>> = {
  CONNECT_TIMEOUT: 'timeout',
  ETIMEDOUT: 'timeout',
  '57014': 'timeout',
  GLOBAL_KB_DEADLINE: 'timeout',
  ECONNREFUSED: 'refused',
  ECONNRESET: 'refused',
  EHOSTUNREACH: 'refused',
  ENETUNREACH: 'refused',
  ENOTFOUND: 'refused',
  EAI_AGAIN: 'refused',
  '28000': 'auth',
  '28P01': 'auth',
  SASL_SIGNATURE_MISMATCH: 'auth',
};

const CAUSE_DEPTH = 5;

/** Walks `cause`: drizzle wraps the driver error that carries the code. */
export function classifyGlobalKbError(err: unknown): GlobalKbErrorClass {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < CAUSE_DEPTH && current != null && typeof current === 'object';
    depth++
  ) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && Object.hasOwn(CLASS_BY_CODE, code)) return CLASS_BY_CODE[code]!;
    current = cause;
  }
  return 'other';
}
