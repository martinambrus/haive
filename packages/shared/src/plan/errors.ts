/** Why a plan write was refused. Kept as a typed kind rather than a message so
 *  each caller can map it to its own surface without string-matching: the api
 *  turns `conflict` into a 409 and `invalid` into a 400, while a worker step
 *  turns `invalid` into a RetryableParseError so the runner re-prompts the model.
 *  Shared cannot import either package's error types, and neither should have to
 *  parse the other's prose. */
export type PlanPatchErrorKind =
  /** The patch does not satisfy the contract, or asks for something structurally
   *  impossible (an unresolvable ref, a move that would create a cycle, a second
   *  root). Retryable by an LLM: re-prompting can produce a valid patch. */
  | 'invalid'
  /** expectedVersion did not match — someone else wrote this node first. NOT
   *  retryable without showing a human the other write. */
  | 'conflict'
  /** A referenced node/edge is not in this repository. */
  | 'not_found';

export class PlanPatchError extends Error {
  readonly kind: PlanPatchErrorKind;
  /** The op index that failed, so a caller can point at it. */
  readonly opIndex: number | null;

  constructor(kind: PlanPatchErrorKind, message: string, opIndex: number | null = null) {
    super(message);
    this.name = 'PlanPatchError';
    this.kind = kind;
    this.opIndex = opIndex;
  }
}
