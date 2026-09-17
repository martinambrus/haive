import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildDdevImportCommand, sniffDumpFormat } from '../src/sandbox/ddev-runner.js';

/** Head of a real `pg_dump -Fc` archive: magic + version 1.16-0, 4-byte int,
 *  8-byte offset, format 1 (custom). */
const CUSTOM_HEAD = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 1, 16, 0, 4, 8, 1]);

/** A POSIX tar header block whose name field holds `member`. `pg_dump -Ft` writes
 *  the archive's own `toc.dat` as the first member; a user tarball around a dump
 *  writes the `.sql` (or a directory entry) instead. */
function tarHeader(member: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(member, 0, 'latin1');
  block.write('ustar\0', 257, 'latin1');
  return block;
}

/** A dump laid out the way the api writes one — `<storage root>/_uploads/<userId>/<name>` — since
 *  that shape is what the sniffer's anchor split requires. `mkdtemp` per call: the walk opens the
 *  anchor itself and will not create it, so a fixed name would pass off a leftover directory. */
async function dumpWith(bytes: Buffer): Promise<{ anchor: string; rel: string }> {
  const anchor = await mkdtemp(path.join(tmpdir(), 'haive-dump-'));
  const rel = '_uploads/u1/db.backup';
  await mkdir(path.join(anchor, '_uploads', 'u1'), { recursive: true });
  await writeFile(path.join(anchor, rel), bytes);
  return { anchor, rel };
}

/** Build a dump from `bytes` and classify it. */
async function sniffOf(bytes: Buffer) {
  const { anchor, rel } = await dumpWith(bytes);
  return sniffDumpFormat(anchor, rel);
}

describe('sniffDumpFormat', () => {
  it('recognises a pg_dump custom-format archive by its PGDMP magic', async () => {
    expect(await sniffOf(CUSTOM_HEAD)).toEqual({
      pgRestore: true,
      gzipped: false,
    });
  });

  it('recognises a pg_dump tar-format archive by its leading toc.dat member', async () => {
    expect(await sniffOf(tarHeader('toc.dat'))).toEqual({
      pgRestore: true,
      gzipped: false,
    });
  });

  it('leaves a plain tarball wrapped around a .sql to ddev import-db', async () => {
    expect(await sniffOf(tarHeader('dump.sql'))).toEqual({
      pgRestore: false,
      gzipped: false,
    });
  });

  it('sees through gzip to a custom-format archive', async () => {
    expect(await sniffOf(gzipSync(CUSTOM_HEAD))).toEqual({
      pgRestore: true,
      gzipped: true,
    });
  });

  it('sees through gzip to a tar-format archive', async () => {
    expect(await sniffOf(gzipSync(tarHeader('toc.dat')))).toEqual({
      pgRestore: true,
      gzipped: true,
    });
  });

  it('leaves gzipped plain SQL to ddev import-db', async () => {
    const sql = gzipSync(Buffer.from('-- PostgreSQL database dump\nCREATE TABLE t (id int);\n'));
    expect(await sniffOf(sql)).toEqual({
      pgRestore: false,
      gzipped: true,
    });
  });

  it('does not flag a plain SQL dump', async () => {
    const { anchor, rel } = await dumpWith(Buffer.from('-- PostgreSQL database dump\n'));
    expect(await sniffDumpFormat(anchor, rel)).toEqual({ pgRestore: false, gzipped: false });
  });

  it('does not flag a file too short to carry the magic', async () => {
    expect(await sniffOf(Buffer.from('PGD'))).toEqual({
      pgRestore: false,
      gzipped: false,
    });
  });

  it('reports a corrupt gzip as plain rather than throwing', async () => {
    const truncated = gzipSync(CUSTOM_HEAD).subarray(0, 6);
    expect(await sniffOf(truncated)).toEqual({
      pgRestore: false,
      gzipped: true,
    });
  });

  it('is plain for an unreadable path rather than throwing', async () => {
    expect(await sniffDumpFormat('/nonexistent', '_uploads/u1/db.backup')).toEqual({
      pgRestore: false,
      gzipped: false,
    });
  });

  it('does not read through a dump that is a link', async () => {
    // The target IS a valid pg archive, so following the link would report pgRestore. The dump
    // lives in the volume the DDEV and app runners mount whole, so the file at that name is not
    // necessarily the file the api wrote — and a refusal here is plain, which sends the import
    // down the `ddev import-db` path where the real problem is reported.
    const anchor = await mkdtemp(path.join(tmpdir(), 'haive-dump-link-'));
    await mkdir(path.join(anchor, '_uploads', 'u1'), { recursive: true });
    const target = path.join(anchor, 'real.backup');
    await writeFile(target, CUSTOM_HEAD);
    await symlink(target, path.join(anchor, '_uploads', 'u1', 'db.backup'));

    expect(await sniffDumpFormat(anchor, '_uploads/u1/db.backup')).toEqual({
      pgRestore: false,
      gzipped: false,
    });
  });
});

describe('buildDdevImportCommand', () => {
  const plain = { pgRestore: false, gzipped: false };
  const archive = { pgRestore: true, gzipped: false };
  const gzArchive = { pgRestore: true, gzipped: true };

  it('hands a plain dump straight to ddev import-db', () => {
    expect(buildDdevImportCommand('/repos/p', '/repos/_uploads/u/db-1.sql', plain)).toBe(
      'cd /repos/p && ddev import-db --file=/repos/_uploads/u/db-1.sql',
    );
  });

  it('leaves gzipped plain SQL to ddev, which inflates .sql.gz itself', () => {
    expect(
      buildDdevImportCommand('/repos/p', '/repos/_uploads/u/db-1.sql.gz', {
        pgRestore: false,
        gzipped: true,
      }),
    ).toBe('cd /repos/p && ddev import-db --file=/repos/_uploads/u/db-1.sql.gz');
  });

  it('pipes a pg_dump archive through pg_restore in the db container', () => {
    const cmd = buildDdevImportCommand('/repos/p', '/repos/_uploads/u/db-1.backup', archive);
    expect(cmd).toContain('ddev exec -s db pg_restore --no-owner --no-privileges -f -');
    expect(cmd).toContain('< /repos/_uploads/u/db-1.backup | ddev import-db');
    expect(cmd).not.toContain('gzip -dc');
    // Without pipefail a failing pg_restore is masked by a ddev import-db that
    // succeeds on the truncated stream it received.
    expect(cmd).toContain('set -o pipefail');
  });

  it('inflates a gzipped pg_dump archive before pg_restore', () => {
    const cmd = buildDdevImportCommand('/repos/p', '/repos/_uploads/u/db-1.gz', gzArchive);
    expect(cmd).toBe(
      'cd /repos/p && set -o pipefail && gzip -dc < /repos/_uploads/u/db-1.gz | ' +
        'ddev exec -s db pg_restore --no-owner --no-privileges -f - | ddev import-db',
    );
  });
});
