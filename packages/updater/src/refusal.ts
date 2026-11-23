/** Named refusal: preflight attempts are journalled when ownership permits; proven lease loss writes nothing; child cleanup leaves recovery pending. */
export class UpgradeRefusal extends Error {
  constructor(
    public readonly refusal: string,
    message: string,
  ) {
    super(message);
  }
}
