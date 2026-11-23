/** Named refusal: preflight attempts are journalled as refused; child cleanup leaves recovery pending. */
export class UpgradeRefusal extends Error {
  constructor(
    public readonly refusal: string,
    message: string,
  ) {
    super(message);
  }
}
