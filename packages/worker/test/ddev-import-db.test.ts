import { mkdtemp, writeFile } from 'node:fs/promises';
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

async function dumpWith(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'haive-dump-'));
  const file = path.join(dir, 'db.backup');
  await writeFile(file, bytes);
  return file;
}

describe('sniffDumpFormat', () => {
  it('recognises a pg_dump custom-format archive by its PGDMP magic', async () => {
    expect(await sniffDumpFormat(await dumpWith(CUSTOM_HEAD))).toEqual({
      pgRestore: true,
      gzipped: false,
    });
  });

  it('recognises a pg_dump tar-format archive by its leading toc.dat member', async () => {
    expect(await sniffDumpFormat(await dumpWith(tarHeader('toc.dat')))).toEqual({
      pgRestore: true,
      gzipped: false,
    });
  });

  it('leaves a plain tarball wrapped around a .sql to ddev import-db', async () => {
    expect(await sniffDumpFormat(await dumpWith(tarHeader('dump.sql')))).toEqual({
      pgRestore: false,
      gzipped: false,
    });
  });

  it('sees through gzip to a custom-format archive', async () => {
    expect(await sniffDumpFormat(await dumpWith(gzipSync(CUSTOM_HEAD)))).toEqual({
      pgRestore: true,
      gzipped: true,
    });
  });

  it('sees through gzip to a tar-format archive', async () => {
    expect(await sniffDumpFormat(await dumpWith(gzipSync(tarHeader('toc.dat'))))).toEqual({
      pgRestore: true,
      gzipped: true,
    });
  });

  it('leaves gzipped plain SQL to ddev import-db', async () => {
    const sql = gzipSync(Buffer.from('-- PostgreSQL database dump\nCREATE TABLE t (id int);\n'));
    expect(await sniffDumpFormat(await dumpWith(sql))).toEqual({
      pgRestore: false,
      gzipped: true,
    });
  });

  it('does not flag a plain SQL dump', async () => {
    const file = await dumpWith(Buffer.from('-- PostgreSQL database dump\n'));
    expect(await sniffDumpFormat(file)).toEqual({ pgRestore: false, gzipped: false });
  });

  it('does not flag a file too short to carry the magic', async () => {
    expect(await sniffDumpFormat(await dumpWith(Buffer.from('PGD')))).toEqual({
      pgRestore: false,
      gzipped: false,
    });
  });

  it('reports a corrupt gzip as plain rather than throwing', async () => {
    const truncated = gzipSync(CUSTOM_HEAD).subarray(0, 6);
    expect(await sniffDumpFormat(await dumpWith(truncated))).toEqual({
      pgRestore: false,
      gzipped: true,
    });
  });

  it('is plain for an unreadable path rather than throwing', async () => {
    expect(await sniffDumpFormat('/nonexistent/db.backup')).toEqual({
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
