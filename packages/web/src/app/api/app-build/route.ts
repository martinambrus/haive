import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** The identity of the CODE this server would serve right now — deliberately not the identity
 *  of the server PROCESS.
 *
 *  That distinction is the whole feature. A process stamp (start time, a boot uuid) changes only
 *  on restart, and the incident this exists for had no restart: the dev server ran five hours
 *  straight, compiled an edit into its chunks, and a tab open across that kept executing the old
 *  modules because its hot-reload channel had quietly stopped applying updates. Measured, not
 *  assumed — the container and the `next dev` process both predated the edit by hours. A restart
 *  stamp would have stayed silent through exactly the case it was built for.
 *
 *  So the stamp comes from the source: the newest mtime under `src/` in dev, the build id in
 *  production. It moves when the code moves, which is what a stale tab is behind.
 *
 *  In production a moved stamp is proof on its own: nothing hot-updates a running page, so the
 *  page is the previous build. In dev it proves only that the code moved, since a healthy hot
 *  reload moves the stamp too, having already applied the change — and the bundler offers no
 *  signal to tell those apart (see the measurements in components/stale-build-banner.tsx). The
 *  banner's dev copy is worded to that limit.
 *
 *  Asset URLs were the obvious alternative and do not work: MEASURED, Turbopack dev chunk names
 *  are path-derived, not content-hashed — a real content edit left the document referencing the
 *  same `packages_web_src_components_16wn9rr._.js`. Comparing what a tab loaded against what the
 *  server serves now would compare two identical strings forever.
 */

/** Never prerender or cache: the answer is about right now. */
export const dynamic = 'force-dynamic';

/** Re-scan at most this often. Several tabs polling share one scan, and the source cannot
 *  change meaningfully faster than a human saves a file. */
const SCAN_CACHE_MS = 5_000;

/** What a stamp we could not read reports. A constant, so the client compares it against itself
 *  and never fires: a banner that cannot prove a change must not claim one. */
const UNKNOWN_STAMP = 'unknown';

let cached: { at: number; stamp: string } | null = null;

async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtimeMs(full));
    else if (entry.isFile()) newest = Math.max(newest, (await stat(full)).mtimeMs);
  }
  return newest;
}

async function readStamp(): Promise<string> {
  try {
    if (process.env.NODE_ENV === 'production') {
      // `output: 'standalone'` puts .next beside the server entry, so cwd resolves it.
      return (await readFile(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')).trim();
    }
    return String(Math.round(await newestMtimeMs(join(process.cwd(), 'src'))));
  } catch {
    return UNKNOWN_STAMP;
  }
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  if (cached === null || now - cached.at > SCAN_CACHE_MS) {
    cached = { at: now, stamp: await readStamp() };
  }
  return Response.json({ stamp: cached.stamp }, { headers: { 'Cache-Control': 'no-store' } });
}
