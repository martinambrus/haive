import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  knowledgeAcquisitionStep,
  parseKbEntries,
} from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-kb-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

function makeCtx(repo: string): StepContext {
  return {
    taskId: 't1',
    taskStepId: 'ts1',
    userId: 'u1',
    repoPath: repo,
    workspacePath: repo,
    cliProviderId: null,
    db: {} as unknown as Database,
    logger: logger.child({ test: 'knowledge-acquisition' }),
    emitProgress: async () => {},
  };
}

describe('parseKbEntries', () => {
  it('parses a single JSON fenced block into an entry', () => {
    const raw = [
      'Some preamble',
      '```json',
      JSON.stringify({
        id: 'testing',
        title: 'Testing',
        sections: [{ heading: 'Framework', body: 'Vitest is used.' }],
      }),
      '```',
      'trailing prose',
    ].join('\n');
    const entries = parseKbEntries(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('testing');
    expect(entries[0]!.sections[0]!.heading).toBe('Framework');
  });

  it('parses multiple fenced blocks', () => {
    const raw = [
      '```json',
      JSON.stringify({
        id: 'testing',
        title: 'Testing',
        sections: [{ heading: 'a', body: 'b' }],
      }),
      '```',
      '```json',
      JSON.stringify({
        id: 'deployment',
        title: 'Deployment',
        sections: [{ heading: 'c', body: 'd' }],
      }),
      '```',
    ].join('\n');
    const entries = parseKbEntries(raw);
    expect(entries.map((e) => e.id)).toEqual(['testing', 'deployment']);
  });

  it('parses { entries: [...] } wrapper', () => {
    const raw = [
      '```json',
      JSON.stringify({
        entries: [
          { id: 'arch', title: 'Architecture', sections: [{ heading: 'a', body: 'b' }] },
          { id: 'db', title: 'Database', sections: [{ heading: 'c', body: 'd' }] },
        ],
      }),
      '```',
    ].join('\n');
    const entries = parseKbEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).toEqual(['arch', 'db']);
  });

  it('accepts an array of entries as object input', () => {
    const entries = parseKbEntries([
      {
        id: 'testing',
        title: 'Testing',
        sections: [{ heading: 'a', body: 'b' }],
      },
    ]);
    expect(entries).toHaveLength(1);
  });

  it('accepts entries with optional confidence and sourceFiles', () => {
    const entries = parseKbEntries([
      {
        id: 'arch',
        title: 'Architecture',
        sections: [{ heading: 'a', body: 'b' }],
        confidence: 'high',
        sourceFiles: ['src/index.ts'],
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('arch');
  });

  it('unwraps Claude Code { result: "..." } wrapper', () => {
    const inner = [
      '```json',
      JSON.stringify({
        entries: [{ id: 'x', title: 'X', sections: [{ heading: 'a', body: 'b' }] }],
      }),
      '```',
    ].join('\n');
    const entries = parseKbEntries({ result: inner });
    expect(entries).toHaveLength(1);
  });

  it('returns empty array for null, undefined, or malformed input', () => {
    expect(parseKbEntries(null)).toEqual([]);
    expect(parseKbEntries(undefined)).toEqual([]);
    expect(parseKbEntries('```json\n{not valid json}\n```')).toEqual([]);
  });
});

describe('knowledgeAcquisitionStep.apply', () => {
  it('writes LLM entries as markdown when selected', async () => {
    const ctx = makeCtx(tmpRoot);
    const raw = [
      '```json',
      JSON.stringify({
        entries: [
          {
            id: 'architecture',
            title: 'Architecture',
            confidence: 'high',
            sourceFiles: ['src/index.ts', 'src/app.ts'],
            sections: [
              { heading: 'Module structure', body: 'Uses layered architecture.' },
              { heading: 'Dependency injection', body: 'Constructor-based DI throughout.' },
            ],
          },
          {
            id: 'testing-strategy',
            title: 'Testing Strategy',
            confidence: 'medium',
            sourceFiles: ['vitest.config.ts'],
            sections: [{ heading: 'Framework', body: 'Vitest drives unit tests.' }],
          },
        ],
      }),
      '```',
    ].join('\n');
    const result = await knowledgeAcquisitionStep.apply(ctx, {
      detected: { framework: 'nodejs', language: 'typescript' },
      formValues: { selectedTopics: ['architecture'] },
      llmOutput: raw,
    });
    expect(result.llmAvailable).toBe(true);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]!.source).toBe('llm');
    const md = await readFile(
      path.join(tmpRoot, '.claude', 'knowledge_base', 'architecture.md'),
      'utf8',
    );
    expect(md).toContain('# Architecture');
    expect(md).toContain('## Module structure');
    expect(md).toContain('Uses layered architecture.');
    expect(md).toContain('## Source files');
    expect(md).toContain('`src/index.ts`');
  });

  it('writes stub files from manual topics when LLM unavailable', async () => {
    const ctx = makeCtx(tmpRoot);
    const result = await knowledgeAcquisitionStep.apply(ctx, {
      detected: { framework: null, language: null },
      formValues: { manualTopics: 'Testing strategy\nDeployment' },
      llmOutput: null,
    });
    expect(result.llmAvailable).toBe(false);
    expect(result.written).toHaveLength(2);
    expect(result.written[0]!.source).toBe('stub');
    const md = await readFile(
      path.join(tmpRoot, '.claude', 'knowledge_base', 'testing-strategy.md'),
      'utf8',
    );
    expect(md).toContain('# Testing strategy');
    expect(md).toContain('LLM synthesis was skipped');
  });

  it('writes nothing when no topics selected or entered', async () => {
    const ctx = makeCtx(tmpRoot);
    const result = await knowledgeAcquisitionStep.apply(ctx, {
      detected: { framework: null, language: null },
      formValues: {},
      llmOutput: null,
    });
    expect(result.written).toHaveLength(0);
  });

  it('filters to only selected LLM entries', async () => {
    const ctx = makeCtx(tmpRoot);
    const entries = [
      { id: 'a', title: 'A', sections: [{ heading: 'x', body: 'y' }] },
      { id: 'b', title: 'B', sections: [{ heading: 'x', body: 'y' }] },
      { id: 'c', title: 'C', sections: [{ heading: 'x', body: 'y' }] },
    ];
    const result = await knowledgeAcquisitionStep.apply(ctx, {
      detected: { framework: null, language: null },
      formValues: { selectedTopics: ['a', 'c'] },
      llmOutput: entries,
    });
    expect(result.written.map((w) => w.id)).toEqual(['a', 'c']);
  });
});
