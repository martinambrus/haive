import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';

type Owner = Pick<Stats, 'uid' | 'gid' | 'mode'>;
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** The install is operator-owned, not a sandbox repository. Hold each directory while using it:
 * no intermediate component or final file inside it may redirect a root updater through a link. */
export class InstallDirectory {
  constructor(
    private readonly handle: FileHandle,
    public owner: Owner,
  ) {}

  static async open(path: string): Promise<InstallDirectory> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    return new InstallDirectory(handle, await handle.stat());
  }

  path(name: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..')
      throw new Error('unsafe install entry');
    return `/proc/self/fd/${this.handle.fd}/${name}`;
  }

  async child(name: string, create = false): Promise<InstallDirectory> {
    let created = false;
    if (create) {
      try {
        await mkdir(this.path(name), { mode: this.owner.mode & 0o777 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const dir = await InstallDirectory.open(this.path(name));
    if (created) {
      try {
        await dir.handle.chown(this.owner.uid, this.owner.gid);
        await dir.handle.chmod(this.owner.mode & 0o777);
        dir.owner = await dir.handle.stat();
        await dir.sync();
        await this.sync();
      } catch (error) {
        await dir.close();
        throw error;
      }
    }
    return dir;
  }

  async entry(name: string): Promise<Stats | undefined> {
    const info = await lstat(this.path(name)).catch((error: unknown) => {
      if (absent(error)) return undefined;
      throw error;
    });
    if (info && !info.isFile()) throw new Error(`refusing non-regular install file: ${name}`);
    return info;
  }

  async read(name: string): Promise<{ bytes: Buffer; owner: Owner } | undefined> {
    const file = await open(
      this.path(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: unknown) => {
      if (absent(error)) return undefined;
      throw error;
    });
    if (!file) return undefined;
    try {
      const owner = await file.stat();
      if (!owner.isFile()) throw new Error(`refusing non-regular install file: ${name}`);
      return { bytes: await file.readFile(), owner };
    } finally {
      await file.close();
    }
  }

  async atomic(name: string, bytes: Buffer, owner?: Owner): Promise<void> {
    const replaced = await this.entry(name);
    const mode = owner ?? replaced ?? { ...this.owner, mode: 0o644 };
    const temp = `.${name}.${randomUUID()}`;
    const file = await open(this.path(temp), 'wx', mode.mode & 0o7777);
    try {
      await file.chown(mode.uid, mode.gid);
      await file.chmod(mode.mode & 0o7777);
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      // A raced-in link is refused too; rename itself never follows a final component.
      await this.entry(name);
      await rename(this.path(temp), this.path(name));
      await this.sync();
    } finally {
      await file.close().catch(() => {});
      await unlink(this.path(temp)).catch((error: unknown) => {
        if (!absent(error)) throw error;
      });
    }
  }

  async remove(name: string): Promise<void> {
    if (await this.entry(name)) {
      await unlink(this.path(name));
      await this.sync();
    }
  }

  async names(): Promise<string[]> {
    return readdir(`/proc/self/fd/${this.handle.fd}`);
  }
  async sync(): Promise<void> {
    await this.handle.sync();
  }
  async close(): Promise<void> {
    await this.handle.close();
  }

  /** Prune only inside a held directory; a linked child is refused, never traversed. */
  async removeTree(name: string): Promise<void> {
    const info = await lstat(this.path(name)).catch((error: unknown) => {
      if (absent(error)) return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isDirectory()) {
      await this.remove(name);
      return;
    }
    const child = await this.child(name);
    try {
      for (const entry of await child.names()) await child.removeTree(entry);
    } finally {
      await child.close();
    }
    await rmdir(this.path(name));
    await this.sync();
  }
}

export async function inInstall<T>(
  path: string,
  work: (dir: InstallDirectory) => Promise<T>,
): Promise<T> {
  const dir = await InstallDirectory.open(path);
  try {
    return await work(dir);
  } finally {
    await dir.close();
  }
}

export async function inDirectories<T>(
  root: InstallDirectory,
  parts: string[],
  create: boolean,
  work: (dir: InstallDirectory) => Promise<T>,
): Promise<T> {
  if (!parts.length) return work(root);
  const child = await root.child(parts[0]!, create);
  try {
    return await inDirectories(child, parts.slice(1), create, work);
  } finally {
    await child.close();
  }
}
