import { gitRun } from './git-exec.js';

export interface BlobRequest {
  oid: string;
  size: number;
}

/** Read only object ids, never path expressions: newlines in names cannot enter the batch protocol.
 * Sizes come from ls-tree or batch-check and are validated before Git can allocate blob output.
 * gitRun retains the ordinary hardened argv, environment, timeout and bounded pipe capture. */
export async function readGitBlobs(
  repoPath: string,
  requests: readonly BlobRequest[],
  maxTotalBytes: number,
): Promise<Map<string, Buffer>> {
  const unique = new Map<string, number>();
  let total = 0;
  for (const { oid, size } of requests) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) || !Number.isSafeInteger(size) || size < 0)
      throw new Error('invalid Git blob request');
    const previous = unique.get(oid);
    if (previous !== undefined) {
      if (previous !== size) throw new Error('inconsistent Git blob size');
      continue;
    }
    total += size;
    if (total > maxTotalBytes) throw new Error('Git blobs exceed the byte limit');
    unique.set(oid, size);
  }
  if (unique.size === 0) return new Map();
  const result = await gitRun(repoPath, ['cat-file', '--batch'], undefined, {
    input: Buffer.from([...unique.keys()].join('\n') + '\n'),
    encoding: 'latin1',
    maxBuffer: total + unique.size * 128,
  });
  if (result.code !== 0) throw new Error(`git cat-file --batch failed (exit ${result.code})`);
  const data = Buffer.from(result.stdout, 'latin1');
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const [oid, size] of unique) {
    const end = data.indexOf(10, offset);
    if (
      end === -1 ||
      end - offset > 127 ||
      data.toString('latin1', offset, end) !== `${oid} blob ${size}`
    )
      throw new Error('invalid Git blob batch header');
    offset = end + 1;
    if (offset + size >= data.length || data[offset + size] !== 10)
      throw new Error('truncated Git blob batch');
    blobs.set(oid, data.subarray(offset, offset + size));
    offset += size + 1;
  }
  if (offset !== data.length) throw new Error('unexpected Git blob batch output');
  return blobs;
}

/** Inspect sizes without reading content, so an oversized staged entry is refused before allocation.
 * Missing objects and non-blobs have no blob size: callers refuse those paths normally. */
export async function gitBlobSizes(
  repoPath: string,
  oids: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(oids)];
  if (unique.some((oid) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)))
    throw new Error('invalid Git blob id');
  if (unique.length === 0) return new Map();
  const result = await gitRun(repoPath, ['cat-file', '--batch-check'], undefined, {
    input: Buffer.from(unique.join('\n') + '\n'),
    maxBuffer: unique.length * 128,
  });
  if (result.code !== 0) throw new Error(`git cat-file --batch-check failed (exit ${result.code})`);
  const lines = result.stdout.split('\n');
  if (lines.pop() !== '' || lines.length !== unique.length)
    throw new Error('invalid Git size batch');
  const sizes = new Map<string, number>();
  for (const [i, oid] of unique.entries()) {
    const line = lines[i]!;
    if (line === `${oid} missing`) continue;
    const match = /^([0-9a-f]+) (blob|tree|commit|tag) (\d+)$/.exec(line);
    const size = Number(match?.[3]);
    if (!match || match[1] !== oid || !Number.isSafeInteger(size) || size < 0)
      throw new Error('invalid Git size batch entry');
    if (match[2] === 'blob') sizes.set(oid, size);
  }
  return sizes;
}
