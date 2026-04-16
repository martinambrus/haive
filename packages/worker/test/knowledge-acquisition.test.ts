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
  scanKnowledgeTopics,
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

describe('scanKnowledgeTopics', () => {
  it('flags testing hints from __tests__ and jest config', async () => {
    await mkdir(path.join(tmpRoot, '__tests__'));
    await writeFile(path.join(tmpRoot, 'jest.config.js'), 'module.exports = {}');
    const topics = await scanKnowledgeTopics(tmpRoot);
    const testing = topics.find((t) => t.id === 'testing');
    expect(testing?.hints).toContain('__tests__');
    expect(testing?.hints).toContain('jest.config.js');
  });

  it('flags deployment hints from Dockerfile', async () => {
    await writeFile(path.join(tmpRoot, 'Dockerfile'), 'FROM node:20\n');
    const topics = await scanKnowledgeTopics(tmpRoot);
    const deploy = topics.find((t) => t.id === 'deployment');
    expect(deploy?.hints).toContain('Dockerfile');
  });

  it('returns empty hint arrays when nothing matches', async () => {
    const topics = await scanKnowledgeTopics(tmpRoot);
    for (const t of topics) {
      expect(t.hints).toEqual([]);
    }
  });
});

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

  it('returns empty array for null, undefined, or malformed input', () => {
    expect(parseKbEntries(null)).toEqual([]);
    expect(parseKbEntries(undefined)).toEqual([]);
    expect(parseKbEntries('```json\n{not valid json}\n```')).toEqual([]);
  });
});

describe('knowledgeAcquisitionStep.apply', () => {
  it('writes stub files when llmOutput is null', async () => {
    await mkdir(path.join(tmpRoot, '__tests__'));
    const ctx = makeCtx(tmpRoot);
    const result = await knowledgeAcquisitionStep.apply(ctx, {
      detected: {
        topics: [
          { id: 'testing', label: 'Testing', hints: ['__tests__'] },
          { id: 'documentation', label: 'Docs', hints: [] },
        ],
      },
      formValues: { selectedTopics: ['testing', 'documentation'] },
      llmOutput: null,
    });
    expect(result.source).toBe('stub');
    expect(result.written).toHaveLength(2);
    const testingMd = await readFile(
      path.join(tmpRoot, '.claude', 'knowledge_base', 'testing.md'),
      'utf8',
    );
    expect(testingMd).toContain('Testing');
    expect(testingMd).toContain('`__tests__`');
    const docsMd = await readFile(
      path.join(tmpRoot, '.claude', 'knowledge_base', 'documentation.md'),
      'utf8',
    );
    expect(docsMd).toContain('No indicators detected');
  });

  it('writes llm entries as markdown when provided', async () => {
    const ctx = makeCtx(tmpRoot);
    const raw = [
      '```json',
      JSON.stringify({
        id: 'testing',
        title: 'Testing',
        sections: [
          { heading: 'Framework', body: 'Vitest drives unit tests.' },
          { heading: 'Fixtures', body: 'Located under __tests__.' },
        ],
      }),
      '```',
    ].join('\n');
    const result = await knowledgeAcquisitionStep.apply(ctx, {
      detected: {
        topics: [{ id: 'testing', label: 'Testing', hints: ['__tests__'] }],
      },
      formValues: { selectedTopics: ['testing'] },
      llmOutput: raw,
    });
    expect(result.source).toBe('llm');
    const md = await readFile(
      path.join(tmpRoot, '.claude', 'knowledge_base', 'testing.md'),
      'utf8',
    );
    expect(md).toContain('# Testing');
    expect(md).toContain('## Framework');
    expect(md).toContain('Vitest drives unit tests.');
    expect(md).toContain('## Fixtures');
  });

  it('falls back to stub for topics without matching llm entries', async () => {
    const ctx = makeCtx(tmpRoot);
    const raw = [
      '```json',
      JSON.stringify({
        id: 'testing',
        title: 'Testing',
        sections: [{ heading: 'a', body: 'b' }],
      }),
      '```',
    ].join('\n');
    const result = await knowledgeAcquisitionStep.apply(ctx, {
      detected: {
        topics: [
          { id: 'testing', label: 'Testing', hints: [] },
          { id: 'database', label: 'Database', hints: ['prisma/schema.prisma'] },
        ],
      },
      formValues: { selectedTopics: ['testing', 'database'] },
      llmOutput: raw,
    });
    expect(result.source).toBe('llm');
    const db = await readFile(
      path.join(tmpRoot, '.claude', 'knowledge_base', 'database.md'),
      'utf8',
    );
    expect(db).toContain('`prisma/schema.prisma`');
    expect(db).toContain('LLM synthesis was skipped');
  });
});
