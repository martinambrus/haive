import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '../src');
const modulesDir = join(srcRoot, 'modules');
const routesDir = join(srcRoot, 'routes');

describe('modules layer', () => {
  it('imports nothing from the routes layer', () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const file = join(modulesDir, entry.name);
      const text = readFileSync(file, 'utf8');
      for (const ref of ts.preProcessFile(text, true, true).importedFiles) {
        const spec = ref.fileName;
        if (!spec.startsWith('.')) continue;
        const target = resolve(modulesDir, spec);
        if (target === routesDir || target.startsWith(routesDir + sep)) {
          offenders.push(`${entry.name} imports '${spec}'`);
        }
      }
    }
    expect(offenders, `modules must not import from routes/: ${offenders.join('; ')}`).toEqual([]);
  });
});
