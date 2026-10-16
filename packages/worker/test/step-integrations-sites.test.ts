import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const MODULE = 'step-engine/step-integrations.ts';
const RUNNER = 'step-engine/step-runner.ts';
const BOOT = 'step-engine/boot.ts';

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function sources(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}${entry}`;
      if (statSync(full).isDirectory()) walk(`${full}/`);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        found.set(full.slice(SRC.length), withoutComments(readFileSync(full, 'utf8')));
      }
    }
  };
  walk(SRC);
  return found;
}

const FILES = sources();
const mentioning = (identifier: string) =>
  [...FILES]
    .filter(([, text]) => new RegExp(`\\b${identifier}\\b`).test(text))
    .map(([file]) => file);

/** The text of a top-level function, from its signature to the closing brace at column zero. */
function bodyOf(file: string, signature: string): string {
  const text = FILES.get(file)!;
  const start = text.indexOf(signature);
  expect(start, `${signature} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end);
}

describe('[D7] the dispatch integrations are written at two sites and nowhere else', () => {
  it('[D7] the scan reads the worker source', () => {
    expect(FILES.size).toBeGreaterThan(300);
    expect(FILES.has(RUNNER)).toBe(true);
  });

  it.each([
    ['insertStampedRun', [MODULE, RUNNER]],
    ['resolveDispatchIntegrations', [MODULE, RUNNER]],
    ['stepIntegrationRequirements', [MODULE, RUNNER]],
    ['setComposableCatalog', [MODULE, BOOT]],
  ] as const)('[D7] %s is named only by %j', (identifier, allowed) => {
    expect(mentioning(identifier).sort()).toEqual([...allowed].sort());
  });

  it('[D7] only the step runner and the boot import the module', () => {
    const importers = [...FILES]
      .filter(([, text]) =>
        /from\s+'(?:\.\.?\/)+(?:step-engine\/)?step-integrations\.js'/.test(text),
      )
      .map(([file]) => file)
      .sort();

    expect(importers).toEqual([BOOT, RUNNER].sort());
  });

  it.each(['step-engine/merge-resolver.ts', 'step-engine/dag-executor.ts'])(
    '[D7] %s inserts its runs without a stamp',
    (file) => {
      expect(FILES.get(file)).not.toMatch(/\bintegrations\b/);
    },
  );

  it.each([
    [RUNNER, 'async function resolveAiFixPhase('],
    [RUNNER, 'async function maybeEnqueueStepSummary('],
  ])('[D7] the body of %s %s names none of the module', (file, signature) => {
    const body = bodyOf(file, signature);

    expect(body).not.toMatch(
      /\b(?:insertStampedRun|resolveDispatchIntegrations|stepIntegrationRequirements|integrations)\b/,
    );
  });
});
