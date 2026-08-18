import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildScreenshotManifest,
  humanizeSlug,
  joinScreenshots,
  SCREENSHOTS_DIR_REL,
  type ScreenshotManifest,
} from './_screenshots.js';

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'haive-shots-'));
}

async function writeShots(ws: string, names: string[]): Promise<void> {
  const dir = path.join(ws, SCREENSHOTS_DIR_REL);
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(path.join(dir, name), 'x', 'utf8');
}

async function readManifest(ws: string): Promise<ScreenshotManifest> {
  const raw = await readFile(path.join(ws, '.haive', 'screenshots.json'), 'utf8');
  return JSON.parse(raw) as ScreenshotManifest;
}

describe('humanizeSlug', () => {
  it('strips the numeric prefix and extension and reads as a sentence', () => {
    expect(humanizeSlug('03-submit-empty-form-validation-error.webp')).toBe(
      'Submit empty form validation error',
    );
  });

  it('falls back to the bare name when there is nothing to humanize', () => {
    expect(humanizeSlug('01-.webp')).toBe('01-');
  });
});

describe('joinScreenshots', () => {
  it('takes existence from disk, not from the agent report', () => {
    const shots = joinScreenshots(
      ['01-login.webp'],
      [
        { file: '01-login.webp', caption: 'Login page', result: 'pass' },
        { file: '99-never-written.webp', caption: 'Imagined', result: 'fail' },
      ],
      '/w/.haive/screenshots',
    );
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      file: '01-login.webp',
      path: '/w/.haive/screenshots/01-login.webp',
      caption: 'Login page',
      result: 'pass',
    });
  });

  it('captions an unreported file from its slug and defaults its result to info', () => {
    const shots = joinScreenshots(['02-cart-empty-state.webp'], [], '/w/.haive/screenshots');
    expect(shots[0].caption).toBe('Cart empty state');
    expect(shots[0].result).toBe('info');
    expect(shots[0].testCase).toBeNull();
  });

  it('lets a later pass replace an earlier caption for the same file', () => {
    const shots = joinScreenshots(
      ['01-login.webp'],
      [
        { file: '01-login.webp', caption: 'before fix', result: 'fail' },
        { file: '01-login.webp', caption: 'after fix', result: 'pass' },
      ],
      '/w/.haive/screenshots',
    );
    expect(shots[0].caption).toBe('after fix');
    expect(shots[0].result).toBe('pass');
  });

  it('matches a reported path against the file basename', () => {
    const shots = joinScreenshots(
      ['01-login.webp'],
      [{ file: '/haive/workdir/.haive/screenshots/01-login.webp', caption: 'Login' }],
      '/w/.haive/screenshots',
    );
    expect(shots[0].caption).toBe('Login');
  });

  it('normalizes an unknown result to info', () => {
    const shots = joinScreenshots(
      ['01-login.webp'],
      [{ file: '01-login.webp', result: 'PASSED' }],
      '/w/.haive/screenshots',
    );
    expect(shots[0].result).toBe('info');
  });
});

describe('buildScreenshotManifest', () => {
  it('writes an empty manifest when the directory does not exist', async () => {
    const ws = await workspace();
    const res = await buildScreenshotManifest(ws, [{ file: 'a.webp', caption: 'x' }]);
    expect(res.count).toBe(0);
    expect(await readManifest(ws)).toEqual({ count: 0, truncated: false, shots: [] });
  });

  it('lists only image files, sorted by name', async () => {
    const ws = await workspace();
    await writeShots(ws, ['02-second.webp', '01-first.png', 'notes.txt']);
    const res = await buildScreenshotManifest(ws, []);
    expect(res.count).toBe(2);
    const manifest = await readManifest(ws);
    expect(manifest.shots.map((s) => s.file)).toEqual(['01-first.png', '02-second.webp']);
  });

  it('rewrites the manifest so a removed file drops out', async () => {
    const ws = await workspace();
    await writeShots(ws, ['01-first.webp']);
    await buildScreenshotManifest(ws, [{ file: '01-first.webp', caption: 'one' }]);
    await rm(path.join(ws, SCREENSHOTS_DIR_REL, '01-first.webp'));
    await buildScreenshotManifest(ws, [{ file: '01-first.webp', caption: 'one' }]);
    expect((await readManifest(ws)).shots).toHaveLength(0);
  });
});
