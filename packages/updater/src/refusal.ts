/** Named refusal: preflight attempts are journalled when ownership permits; proven lease loss writes nothing. */
export class UpgradeRefusal extends Error {
  constructor(
    public readonly refusal: string,
    message: string,
  ) {
    super(message);
  }
}
