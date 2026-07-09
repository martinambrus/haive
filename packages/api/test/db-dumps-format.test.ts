import { describe, expect, it } from 'vitest';
import { detectDumpFormat, dumpDiskExtension } from '../src/routes/db-dumps.js';

describe('detectDumpFormat', () => {
  it('detects .sql.gz before .sql (order matters)', () => {
    expect(detectDumpFormat('backup.sql.gz')).toBe('sql.gz');
    expect(detectDumpFormat('DUMP.SQL.GZ')).toBe('sql.gz');
  });

  it('detects plain .sql', () => {
    expect(detectDumpFormat('schema.sql')).toBe('sql');
  });

  it('labels .dump and every unrecognized / extensionless name as dump (never rejects)', () => {
    expect(detectDumpFormat('pg.dump')).toBe('dump');
    expect(detectDumpFormat('mydb.backup')).toBe('dump');
    expect(detectDumpFormat('archive.zip')).toBe('dump');
    expect(detectDumpFormat('noext')).toBe('dump');
    expect(detectDumpFormat('data.csv')).toBe('dump');
  });
});

describe('dumpDiskExtension', () => {
  it('preserves recognized and arbitrary single extensions', () => {
    expect(dumpDiskExtension('schema.sql')).toBe('sql');
    expect(dumpDiskExtension('backup.SQL.GZ')).toBe('sql.gz');
    expect(dumpDiskExtension('pg.dump')).toBe('dump');
    expect(dumpDiskExtension('mydb.backup')).toBe('backup');
    expect(dumpDiskExtension('data.zip')).toBe('zip');
  });

  it('falls back to dump for extensionless or trailing-dot names', () => {
    expect(dumpDiskExtension('noext')).toBe('dump');
    expect(dumpDiskExtension('trailingdot.')).toBe('dump');
    expect(dumpDiskExtension('/tmp/some/dir.d/plain')).toBe('dump');
  });

  it('rejects shell-unsafe extensions (the value is interpolated into a shell path)', () => {
    expect(dumpDiskExtension('evil.sql;rm -rf /')).toBe('dump');
    expect(dumpDiskExtension('x.$(curl evil)')).toBe('dump');
    expect(dumpDiskExtension('x.' + 'a'.repeat(20))).toBe('dump');
  });
});
