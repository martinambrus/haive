import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import type { ReleaseManifest } from '@haive/shared/release';
import { UpgradeRefusal } from './refusal.js';

type EnvKeys = NonNullable<ReleaseManifest['bundle']>['env'];

/** Read assignments, skipping comments and assignment-shaped lines inside quoted values.
 * Values stay private to this module; callers receive only names. */
function values(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      let end = 1;
      for (;;) {
        while (end < value.length) {
          if (
            value[end] === '\\' &&
            (quote === '"' || value[end + 1] === quote || value[end + 1] === '\\')
          )
            end += 2;
          else if (value[end] === quote) break;
          else end++;
        }
        if (end < value.length) break;
        if (++i >= lines.length)
          throw new Error('could not read required env keys; check .env syntax');
        value += '\n' + lines[i];
      }
      value = value.slice(1, end);
    } else value = value.replace(/(?:^|\s)#.*$/, '').trim();
    result.set(match[1]!, value);
  }
  return result;
}

export class EnvKeyMissing extends UpgradeRefusal {
  constructor(public readonly key: string) {
    super('env-key-missing', `required .env key ${key} is missing or empty`);
  }
}

/** Validate every never key before generating anything. The operator's install is not a
 * sandbox-writable repository; match the updater's existing node:fs convention. */
export async function ensureEnvKeys(
  file: string,
  keys: EnvKeys,
  options: {
    check?: boolean;
    emit?: (event: string, fields: Record<string, unknown>) => void;
  } = {},
): Promise<string[]> {
  const input = await open(file, 'r');
  let text: string;
  let owner: Awaited<ReturnType<typeof input.stat>>;
  try {
    text = await input.readFile('utf8');
    owner = await input.stat();
  } finally {
    await input.close();
  }
  const current = values(text);
  const missing = keys.filter(({ key }) => !current.get(key));
  for (const entry of missing) if (entry.generate === 'never') throw new EnvKeyMissing(entry.key);
  if (options.check || missing.length === 0) return [];
  const added = missing.map(({ key }) => key);
  const lines = missing.map((entry) => {
    if (entry.generate !== 'hex') throw new EnvKeyMissing(entry.key);
    return `${entry.key}=${randomBytes(entry.bytes).toString('hex')}\n`;
  });
  const temp = `${file}.haive-tmp`;
  // Exclusive create: never follow a leftover link or overwrite a concurrent writer's temp file.
  const output = await open(temp, 'wx', owner.mode & 0o7777);
  try {
    await output.chown(owner.uid, owner.gid);
    await output.chmod(owner.mode & 0o7777);
    await output.writeFile(text + (text && !text.endsWith('\n') ? '\n' : '') + lines.join(''));
    await output.sync();
    await output.close();
    await rename(temp, file);
  } catch {
    // Never propagate a write/encoding error that might quote a generated value.
    throw new Error('could not atomically add required .env keys');
  } finally {
    await output.close().catch(() => {});
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw new Error('could not remove required env keys temporary file');
    });
  }
  options.emit?.('env-added', { envAdded: added });
  return added;
}
