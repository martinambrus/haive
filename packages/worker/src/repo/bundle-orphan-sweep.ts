import path from 'node:path';
import { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { BUNDLE_JOB_NAMES, QUEUE_NAMES, logger, type BundleJobPayload } from '@haive/shared';
import { lstatNoFollow, readdirNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { getBullRedis } from '../redis.js';

export const BUNDLE_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BUNDLE_ORPHAN_INTERVAL_MS = 60 * 60 * 1000;
export const BUNDLE_ORPHAN_MAX_BUNDLES = 100;
export const BUNDLE_ORPHAN_MAX_DIRECTORY_ENTRIES = 1000;
export const BUNDLE_ORPHAN_MAX_QUEUE_JOBS = 1000;
export const BUNDLE_ORPHAN_QUEUE_TIMEOUT_MS = 5000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID = new RegExp(`^${UUID}$`);
const STAGE = new RegExp(`^\\.haive-extract-\\d+-${UUID}$`);
const ARCHIVE = new RegExp(`^source(?:\\.${UUID})?\\.(?:zip|tar|tar\\.gz)$`);
const SIDECAR = new RegExp(`^source(?:\\.${UUID})?\\.(?:zip|tar|tar\\.gz)\\.replacement\\.json$`);
type LiveJobs = Partial<BundleJobPayload>[];
type BundleQueueReader = Pick<Queue<BundleJobPayload>, 'getRanges' | 'getJob'>;
let queue: Queue<BundleJobPayload> | undefined;

/** A range snapshot retains missing hashes, unlike getJobs' filtered hydration. Unknown,
 * capped and timed-out reads must all hold cleanup, never prove the absence of an owner. */
export async function readLiveBundleJobs(
  source: BundleQueueReader,
  {
    maxJobs = BUNDLE_ORPHAN_MAX_QUEUE_JOBS,
    timeoutMs = BUNDLE_ORPHAN_QUEUE_TIMEOUT_MS,
  }: { maxJobs?: number; timeoutMs?: number } = {},
): Promise<LiveJobs | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const ids = await source.getRanges(
          ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'],
          0,
          maxJobs - 1,
        );
        if (ids.length >= maxJobs) return null;
        const jobs = await Promise.all(ids.map((id) => source.getJob(id)));
        const live: LiveJobs = [];
        for (const job of jobs) {
          if (!job) return null;
          if (job.name === BUNDLE_JOB_NAMES.GIT_SYNC_TICK) continue;
          if (typeof job.data?.bundleId !== 'string') return null;
          live.push(job.data);
        }
        return live;
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch (err) {
    logger.warn({ err }, 'bundle orphan sweep could not read the bundle queue');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultReadJobs(): Promise<LiveJobs | null> {
  queue ??= new Queue<BundleJobPayload>(QUEUE_NAMES.BUNDLE, { connection: getBullRedis() });
  return readLiveBundleJobs(queue);
}

export interface BundleOrphanSweepOptions {
  root?: string;
  now?: () => number;
  maxAgeMs?: number;
  intervalMs?: number;
  maxBundlesPerPass?: number;
  maxDirectoryEntries?: number;
  readJobs?: () => Promise<LiveJobs | null>;
}

/** The trusted volume root is the anchor, as in ingest/recovery. Only the two UUID directory
 * levels are visited; extracted content and uploads are never searched for matching names. */
export class BundleOrphanSweeper {
  private lastPass: number | undefined;
  private afterBundle = '';
  private inFlight = false;

  constructor(private readonly opts: BundleOrphanSweepOptions = {}) {}

  private async list(root: string, rel: string) {
    try {
      return (
        (await readdirNoFollow(root, rel, {
          strict: true,
          maxEntries: this.opts.maxDirectoryEntries ?? BUNDLE_ORPHAN_MAX_DIRECTORY_ENTRIES,
        })) ?? []
      ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      logger.warn({ err, rel }, 'bundle orphan sweep skipped an unreadable or capped directory');
      return [];
    }
  }

  private async *directories(root: string) {
    for (const user of await this.list(root, '')) {
      if (!user.isDirectory() || !ID.test(user.name)) continue;
      for (const bundle of await this.list(root, user.name)) {
        if (!bundle.isDirectory() || !ID.test(bundle.name)) continue;
        yield { userId: user.name, bundleId: bundle.name, rel: `${user.name}/${bundle.name}` };
      }
    }
  }

  async sweep(db: Database): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    if (
      this.inFlight ||
      (this.lastPass !== undefined &&
        now - this.lastPass < (this.opts.intervalMs ?? BUNDLE_ORPHAN_INTERVAL_MS))
    )
      return;
    this.inFlight = true;
    this.lastPass = now;
    try {
      const jobs = await (this.opts.readJobs ?? defaultReadJobs)();
      if (jobs === null) {
        logger.warn('bundle orphan sweep skipped because bundle queue ownership is unknown');
        return;
      }
      const busy = new Set(jobs.map((job) => job.bundleId));
      const jobArchives = new Set(
        jobs.flatMap((job) => [job.archivePath, job.replacement?.previousArchive?.archivePath]),
      );
      const root = this.opts.root ?? process.env.BUNDLE_STORAGE_ROOT ?? '/var/lib/haive/bundles';
      const cutoff = now - (this.opts.maxAgeMs ?? BUNDLE_ORPHAN_MAX_AGE_MS);
      let visited = 0;
      for await (const dir of this.directories(root)) {
        if (dir.rel <= this.afterBundle) continue;
        if (visited >= (this.opts.maxBundlesPerPass ?? BUNDLE_ORPHAN_MAX_BUNDLES)) return;
        visited += 1;
        this.afterBundle = dir.rel;
        if (busy.has(dir.bundleId)) continue;
        try {
          // A stage has no durable name until beforeSwap. Keep ALL artifacts of a syncing
          // bundle/job, including the previous archive and stage/old needed by rollback.
          // Uploads also own an archive before promotion, while its row still names the partial.
          const [bundle] = await db
            .select()
            .from(schema.customBundles)
            .where(
              and(
                eq(schema.customBundles.id, dir.bundleId),
                eq(schema.customBundles.userId, dir.userId),
              ),
            )
            .limit(1);
          if (bundle?.status === 'syncing') continue;
          const [upload] = await db
            .select({ id: schema.customBundleUploads.id })
            .from(schema.customBundleUploads)
            .where(
              and(
                eq(schema.customBundleUploads.bundleId, dir.bundleId),
                eq(schema.customBundleUploads.userId, dir.userId),
                inArray(schema.customBundleUploads.status, ['uploading', 'completing']),
              ),
            )
            .limit(1);
          if (upload) continue;
          for (const entry of await this.list(root, dir.rel)) {
            const stage = STAGE.test(entry.name);
            const archive = ARCHIVE.test(entry.name);
            const sidecar = SIDECAR.test(entry.name);
            if (!stage && !archive && !sidecar) continue;
            const rel = `${dir.rel}/${entry.name}`;
            const absolute = path.join(root, rel);
            const archivePath = sidecar ? absolute.slice(0, -'.replacement.json'.length) : absolute;
            const current = bundle?.archivePath === absolute;
            // Keep a failed row's current source too: a redelivered job may still retry it.
            if (
              current ||
              jobArchives.has(archivePath) ||
              (bundle?.status === 'failed' &&
                sidecar &&
                bundle.archivePath === path.join(root, rel.slice(0, -'.replacement.json'.length)))
            )
              continue;
            try {
              const info = await lstatNoFollow(root, rel, { strict: true });
              if (!info || info.stats.mtimeMs >= cutoff) continue;
              if (info.kind !== (stage ? 'directory' : 'file')) continue;
              if (!stage) {
                // Check references by path as well as by bundle id. Even an unusual row naming
                // another directory's source is not evidence that the source is ours to remove.
                const [owner] = await db
                  .select({ id: schema.customBundles.id })
                  .from(schema.customBundles)
                  .where(
                    and(
                      eq(schema.customBundles.archivePath, archivePath),
                      sidecar
                        ? inArray(schema.customBundles.status, ['syncing', 'failed'])
                        : undefined,
                    ),
                  )
                  .limit(1);
                if (owner) continue;
              }
              // Initial symlinks are left alone. If a name races into a link, fs-safe can
              // only unlink that link; recursive removal never follows it outside the anchor.
              await removeNoFollow(root, rel, { recursive: stage, repairPermissions: true });
            } catch (err) {
              logger.warn({ err, rel }, 'bundle orphan sweep could not remove an entry');
            }
          }
        } catch (err) {
          logger.warn(
            { err, bundleId: dir.bundleId },
            'bundle orphan sweep skipped a bundle whose ownership could not be read',
          );
        }
      }
      // Rotate the bounded pass so live bundles cannot starve later orphan directories.
      this.afterBundle = '';
    } catch (err) {
      logger.warn({ err }, 'bundle orphan sweep failed; retained entries for a later pass');
    } finally {
      this.inFlight = false;
    }
  }
}
