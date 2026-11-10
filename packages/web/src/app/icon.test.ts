import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('ships the Haive H icon and a Next app-router favicon.ico', () => {
  const svg = readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');
  expect(svg).toContain('<title>Haive</title>');
  expect(svg).toContain('viewBox="0 0 32 32"');
  const ico = readFileSync(new URL('./favicon.ico', import.meta.url));
  expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 1, 0]);
});
