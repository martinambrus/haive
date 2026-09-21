/** picomatch ships no types and `@types/picomatch` is not in this workspace's lockfile, so the
 *  surface we use is declared here rather than pulling a second dependency for one call shape.
 *  Only the matcher factory is declared; add to this as usage grows. */
declare module 'picomatch' {
  interface PicomatchOptions {
    /** Match leading-dot basenames and descend into dotted directories. tinyglobby passes this,
     *  so anything that must agree with its scan has to pass it too. */
    dot?: boolean;
    nocase?: boolean;
  }
  type Matcher = (test: string) => boolean;
  function picomatch(glob: string | readonly string[], options?: PicomatchOptions): Matcher;
  export = picomatch;
}
