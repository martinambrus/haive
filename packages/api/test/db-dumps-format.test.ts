import { describe, expect, it } from 'vitest';
import { detectDumpFormat } from '../src/routes/db-dumps.js';

describe('detectDumpFormat', () => {
  it('detects .sql.gz before .sql (order matters)', () => {
    expect(detectDumpFormat('backup.sql.gz')).toBe('sql.gz');
    expect(detectDumpFormat('DUMP.SQL.GZ')).toBe('sql.gz');
  });

  it('detects plain .sql', () => {
    expect(detectDumpFormat('schema.sql')).toBe('sql');
  });

  it('detects .dump', () => {
    expect(detectDumpFormat('pg.dump')).toBe('dump');
  });

  it('rejects unsupported / extensionless names', () => {
    expect(detectDumpFormat('archive.zip')).toBeNull();
    expect(detectDumpFormat('noext')).toBeNull();
    expect(detectDumpFormat('data.csv')).toBeNull();
  });
});
