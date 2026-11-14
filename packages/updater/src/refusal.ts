/** A preflight refusal is journalled as refused and exits 3, before any hold. */
export class UpgradeRefusal extends Error {
  constructor(
    public readonly refusal: string,
    message: string,
  ) {
    super(message);
  }
}
