/** Runs as ddev inside the task runner, under its lifecycle flock. Selection, cleanup,
 * snapshot creation and promotion must stay in this process when the host worker dies.
 * Filesystem paths here belong to that container; host repository IO remains fs-safe. */
export function accessSnapshotProgram(taskId: string): string {
  return String.raw`
const taskId = ${JSON.stringify(taskId)};
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const directory = '.ddev/db_snapshots';
const prefix = 'haive-access-' + taskId + '-';
const pending = 'haive-access-pending-' + taskId;
async function entries() {
  for (const name of ['.ddev', directory]) {
    try { if (!(await fs.lstat(name)).isDirectory()) throw new Error('Snapshot path is not a plain directory'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  const result = [];
  const listing = await fs.opendir(directory, { bufferSize: 32 });
  for await (const entry of listing) {
    if (result.length === 1024) throw new Error('Snapshot directory exceeds the 1024-entry limit');
    const stat = await fs.lstat(directory + '/' + entry.name);
    result.push({ name: entry.name, modified: stat.mtimeMs, plain: stat.isFile() || stat.isDirectory() });
  }
  return result;
}
async function ddev(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('ddev', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('DDEV snapshot command failed: ' + code)));
  });
}
async function cleanup(name) { await ddev(['snapshot', '--cleanup', '--name=' + name, '--yes']); }
async function main() {
  const before = await entries();
  const names = new Map();
  for (const entry of before) {
    const stamp = entry.plain && entry.name.startsWith(prefix) && /^(\d+)-/.exec(entry.name.slice(prefix.length));
    if (stamp) {
      const name = prefix + stamp[1];
      names.set(name, Math.max(names.get(name) || 0, entry.modified));
    }
  }
  const ordered = [...names.keys()].sort((a, b) => names.get(b) - names.get(a));
  const previous = ordered[0] || null;
  const next = previous === prefix + '0' ? prefix + '1' : prefix + '0';
  for (const stale of ordered.slice(1)) await cleanup(stale);
  if (before.some(entry => entry.name.startsWith(pending + '-'))) await cleanup(pending);
  // Provisional names never qualify as completed access snapshots. A failed or
  // interrupted command cannot displace the previous valid recovery point.
  await ddev(['snapshot', '--name=' + pending]);
  const created = (await entries()).filter(entry => entry.plain && entry.name.startsWith(pending + '-'));
  if (created.length !== 1) throw new Error('DDEV did not create exactly one plain snapshot');
  const source = created[0].name;
  await fs.rename(directory + '/' + source, directory + '/' + next + source.slice(pending.length));
  process.stdout.write('HAIVE_ACCESS_SNAPSHOT=' + JSON.stringify({ next, previous }) + '\n');
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
`;
}

export function parseAccessSnapshotResult(
  taskId: string,
  output: string,
): { next: string; previous: string | null } {
  const prefix = `haive-access-${taskId}-`;
  const marker = 'HAIVE_ACCESS_SNAPSHOT=';
  const line = output.split('\n').findLast((entry) => entry.startsWith(marker));
  const result = line ? (JSON.parse(line.slice(marker.length)) as Record<string, unknown>) : null;
  if (
    !result ||
    (result.next !== `${prefix}0` && result.next !== `${prefix}1`) ||
    (result.previous !== null &&
      (typeof result.previous !== 'string' ||
        !result.previous.startsWith(prefix) ||
        !/^\d+$/.test(result.previous.slice(prefix.length))))
  ) {
    throw new Error('DDEV access snapshot transaction returned invalid metadata');
  }
  return { next: result.next, previous: result.previous as string | null };
}
