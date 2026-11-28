/**
 * A stored system secret exists but the encryption key in use cannot read it. That is not an
 * absent secret: nothing may generate, default or overwrite it, and a caller that tolerates a
 * missing row must not tolerate this. Decide on the class (`instanceof`), never on the message.
 * `secretKeys` names the rows (never their values); `cause` is the decrypt failure when a single
 * row was read.
 */
export class SecretUnreadableError extends Error {
  readonly secretKeys: readonly string[];

  constructor(message: string, secretKeys: readonly string[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretUnreadableError';
    this.secretKeys = secretKeys;
  }
}
