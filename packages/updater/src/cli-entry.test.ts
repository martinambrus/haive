import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
it('runs main through a symlink to the built CLI, while importing it has no side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'updater-entry-'));
  try {
    // Emit into disposable scratch so a clean checkout needs no pre-existing dist output.
    const sourceDir = new URL('.', import.meta.url);
    for (const name of await readdir(sourceDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = await readFile(new URL(name, sourceDir), 'utf8');
      await writeFile(
        join(dir, name.replace(/\.ts$/, '.js')),
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
        }).outputText,
      );
    }
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(dir, 'node_modules'),
    );
    const cli = join(dir, 'cli.js');
    const alias = join(dir, 'updater.js');
    await symlink(cli, alias);
    for (const entry of [cli, alias]) {
      const result = await exec(process.execPath, [entry]).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (error: Error & { code: number; stdout: string; stderr: string }) => error,
      );
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        event: 'error',
        message: expect.stringContaining('is required'),
      });
      expect(result.stderr).toBe('');
    }
    const result = await exec(process.execPath, [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(cli).href)}); process.stdout.write('imported');`,
    ]);
    expect(result.stdout).toBe('imported');
    expect(result.stderr).toBe('');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
