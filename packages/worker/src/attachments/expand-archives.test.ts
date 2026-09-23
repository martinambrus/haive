import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, afterEach } from 'vitest';
import type { Database } from '@haive/database';
import {
  ensureArchivesExpanded,
  EXPANSION_ERROR_CHARS,
  expansionErrorLine,
} from './expand-archives.js';

const exec = promisify(execFile);

/** Rows the module reads, plus the two writes it makes. Drizzle's builders are
 *  stubbed to the exact shape this module calls — anything else would be a
 *  different module's contract. */
function stubDb(rows: Record<string, unknown>[]) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const db = {
    query: { taskAttachments: { findMany: async () => rows } },
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        inserted.push(v);
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          updated.push(v);
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as Database;
  return { db, inserted, updated };
}

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The uploads dir in the layout the api actually writes:
 *  `<repoRoot>/.haive/task-uploads/<taskId>`.
 *
 *  The shape is load-bearing, not decoration. `splitAttachmentStoredPath` recovers the containment
 *  ANCHOR — the repository root — by removing exactly that suffix from a row's `storedPath`, and
 *  answers null for anything else, because the uploads dir itself sits under `.haive/` and is
 *  mounted read-write into the sandbox, so it can never be an anchor. A flat temp dir here (what
 *  this fixture used to build) is a layout the api never produces, and it made every row unreadable
 *  to that helper. The tracked path stays the OUTERMOST directory so the cleanup removes the lot. */
async function uploadsDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'haive-attach-'));
  dirs.push(root);
  const dir = path.join(root, 'repo', '.haive', 'task-uploads', 'task-1');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A `.tar` built from a directory tree, written into the uploads dir as an
 *  attachment would be. tar rather than zip only because it carries symlinks and
 *  traversal names verbatim — the module's own logic is format-agnostic. */
async function tarball(uploads: string, name: string, build: (src: string) => Promise<void>) {
  const src = await mkdtemp(path.join(tmpdir(), 'haive-src-'));
  dirs.push(src);
  await build(src);
  const dest = path.join(uploads, name);
  await exec('tar', ['-cf', dest, '-C', src, '.']);
  return dest;
}

function archiveRow(uploads: string, filename: string) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    taskId: 'task-1',
    userId: 'user-1',
    filename,
    storedPath: path.join(uploads, filename),
    sizeBytes: 1,
    contentType: null,
    description: null,
    expandedFromId: null,
    expandedAt: null,
    expansionNote: null,
    createdAt: new Date(),
  };
}

describe('expansionErrorLine', () => {
  const anchor = '/srv/haive/repo';

  it('keeps the first line of a multi-line failure', () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const err = new Error(`\ntar failed (exit 2): not a tar archive\nExiting with failure status`);
    expect(expansionErrorLine(err, anchor)).toBe('tar failed (exit 2): not a tar archive');
    expect(expansionErrorLine(new Error(`one${lineSeparator}two`), anchor)).toBe('one');
  });

  it('takes the repository’s host path out', () => {
    const inside = new Error(`a symlink in the path: ${anchor}/.haive/task-uploads/t/x`);
    expect(expansionErrorLine(inside, anchor)).toBe(
      'a symlink in the path: .haive/task-uploads/t/x',
    );
    expect(expansionErrorLine(new Error(`resolved outside the anchor: ${anchor}`), anchor)).toBe(
      'resolved outside the anchor: the repository',
    );
  });

  it('caps a long line and says it was cut', () => {
    const line = expansionErrorLine(new Error('x'.repeat(5000)), anchor);
    expect(line).toHaveLength(EXPANSION_ERROR_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('ensureArchivesExpanded', () => {
  it('does nothing when no attachment is an archive', async () => {
    const uploads = await uploadsDir();
    const { db, inserted } = stubDb([archiveRow(uploads, 'brief.md')]);
    expect(await ensureArchivesExpanded(db, 'task-1')).toEqual({
      expanded: 0,
      filesAdded: 0,
      notes: [],
    });
    expect(inserted).toHaveLength(0);
  });

  it('expands a tree into rows named by their relative path', async () => {
    const uploads = await uploadsDir();
    await tarball(uploads, 'spec.tar', async (src) => {
      await mkdir(path.join(src, 'docs', 'api'), { recursive: true });
      await writeFile(path.join(src, 'brief.md'), '# brief');
      await writeFile(path.join(src, 'docs', 'api', 'schema.json'), '{}');
    });
    const { db, inserted, updated } = stubDb([archiveRow(uploads, 'spec.tar')]);

    const result = await ensureArchivesExpanded(db, 'task-1');

    expect(result.filesAdded).toBe(2);
    expect(inserted.map((r) => r.filename).sort()).toEqual([
      'spec/brief.md',
      'spec/docs/api/schema.json',
    ]);
    // Every produced row points back at the archive, so removing it removes them.
    expect(inserted.every((r) => r.expandedFromId === archiveRow(uploads, 'x').id)).toBe(true);
    expect(await readFile(path.join(uploads, 'spec', 'docs', 'api', 'schema.json'), 'utf8')).toBe(
      '{}',
    );
    expect(updated[0]?.expandedAt).toBeInstanceOf(Date);
    // The temp extraction dir never survives the call.
    expect((await readdir(uploads)).some((n) => n.startsWith('.expanding-'))).toBe(false);
  });

  it('drops symlinks instead of following them, and says how many', async () => {
    const uploads = await uploadsDir();
    await tarball(uploads, 'evil.tar', async (src) => {
      await writeFile(path.join(src, 'real.md'), 'ok');
      await symlink('/etc/passwd', path.join(src, 'passwd-link'));
    });
    const { db, inserted, updated } = stubDb([archiveRow(uploads, 'evil.tar')]);

    const result = await ensureArchivesExpanded(db, 'task-1');

    expect(inserted.map((r) => r.filename)).toEqual(['evil/real.md']);
    // The note now comes from EXTRACTION's own report rather than from the walk's skip count: the
    // symlink is removed inside the staged tree, so `walkRegularFiles` never sees it to count. What
    // must not change is that the drop is still stated.
    expect(result.notes[0]?.note).toContain('not extracted');
    expect(result.notes[0]?.note).toContain('symlink');
    expect(updated[0]?.expansionNote).toContain('not extracted');
  });

  it('keeps a traversing member inside the uploads directory', async () => {
    const uploads = await uploadsDir();
    const outside = path.join(uploads, '..', 'escaped.txt');
    await tarball(uploads, 'slip.tar', async (src) => {
      await writeFile(path.join(src, 'fine.md'), 'ok');
    });
    // Appended after the fact: `tar -c ../x` refuses, so the member is added with
    // an explicit transform that puts the traversal in the stored NAME.
    await exec('tar', [
      '--append',
      '--file',
      path.join(uploads, 'slip.tar'),
      '--transform',
      's|.*|../escaped.txt|',
      '-C',
      uploads,
      'slip.tar',
    ]);
    const { db, inserted } = stubDb([archiveRow(uploads, 'slip.tar')]);

    await ensureArchivesExpanded(db, 'task-1');

    expect(inserted.every((r) => !String(r.filename).includes('..'))).toBe(true);
    expect(
      await readFile(outside, 'utf8').then(
        () => 'written',
        () => 'absent',
      ),
    ).toBe('absent');
  });

  it('refuses an archive over the file-count cap without inserting anything', async () => {
    const uploads = await uploadsDir();
    await tarball(uploads, 'huge.tar', async (src) => {
      await mkdir(path.join(src, 'many'), { recursive: true });
      for (let i = 0; i < 501; i += 1) {
        await writeFile(path.join(src, 'many', `f${i}.txt`), 'x');
      }
    });
    const { db, inserted, updated } = stubDb([archiveRow(uploads, 'huge.tar')]);

    const result = await ensureArchivesExpanded(db, 'task-1');

    // All-or-nothing: half a specification is worse than none, because nothing
    // downstream can tell which half it was given.
    expect(inserted).toHaveLength(0);
    expect(result.notes[0]?.note).toContain('over the 500');
    // Still stamped, or every step for the life of the task pays the extraction.
    expect(updated[0]?.expandedAt).toBeInstanceOf(Date);
  });

  it('does not let two members that sanitise to one name overwrite each other', async () => {
    const uploads = await uploadsDir();
    await tarball(uploads, 'clash.tar', async (src) => {
      await writeFile(path.join(src, 'a?.md'), 'first');
      await writeFile(path.join(src, 'a*.md'), 'second');
    });
    const { db, inserted } = stubDb([archiveRow(uploads, 'clash.tar')]);

    await ensureArchivesExpanded(db, 'task-1');

    const names = inserted.map((r) => r.filename).sort();
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('clash/a_.md');
  });

  it('names members whose path is too deep to store, instead of only logging them', async () => {
    const uploads = await uploadsDir();
    const deep = Array.from({ length: 16 }, (_, i) => `d${i + 1}`).join('/');
    await tarball(uploads, 'deep.tar', async (src) => {
      // A sibling at the root, so extraction does not flatten a single top-level folder away.
      await writeFile(path.join(src, 'top.md'), 'top');
      await mkdir(path.join(src, deep), { recursive: true });
      await writeFile(path.join(src, deep, 'deep.md'), 'deep');
    });
    const { db, inserted, updated } = stubDb([archiveRow(uploads, 'deep.tar')]);

    await ensureArchivesExpanded(db, 'task-1');

    expect(inserted.map((r) => r.filename)).toEqual(['deep/top.md']);
    expect(updated[0]?.expansionNote).toBe(
      `1 archive member(s) were not extracted (path too long or too deep to store): ${deep}/deep.md`,
    );
  });

  it('keeps a failed expansion’s note to one line with no host path', async () => {
    const uploads = await uploadsDir();
    await writeFile(path.join(uploads, 'broken.tar'), 'this is not a tar archive\n'.repeat(40));
    const { db, updated } = stubDb([archiveRow(uploads, 'broken.tar')]);

    await ensureArchivesExpanded(db, 'task-1');

    const note = String(updated[0]?.expansionNote);
    expect(note.startsWith('could not be expanded: ')).toBe(true);
    expect(note).not.toMatch(/[\r\n]/);
    const repoRoot = path.resolve(uploads, '..', '..', '..');
    expect(note).not.toContain(repoRoot);
  });

  it('reports a missing archive file rather than throwing', async () => {
    const uploads = await uploadsDir();
    const { db, updated } = stubDb([archiveRow(uploads, 'gone.zip')]);

    const result = await ensureArchivesExpanded(db, 'task-1');

    expect(result.notes[0]?.note).toContain('missing');
    expect(updated[0]?.expandedAt).toBeInstanceOf(Date);
  });
});
