const tagTurns = new Map<string, Promise<void>>();

/** Run `fn` once every earlier call for `tag` in this process has settled. A removal reads that no
 *  provider names the tag before it removes the image, and a cache hit marked ready in between
 *  would be left naming an image that is gone. Provider image builds and removals, composed-image
 *  ensures and the composed-image reaper all take turns here. */
export function withImageTagLock<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  const turn = (tagTurns.get(tag) ?? Promise.resolve()).then(fn);
  const settled = turn.then(
    () => {},
    () => {},
  );
  tagTurns.set(tag, settled);
  void settled.then(() => {
    if (tagTurns.get(tag) === settled) tagTurns.delete(tag);
  });
  return turn;
}
