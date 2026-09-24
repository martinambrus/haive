import { describe, expect, it } from 'vitest';
import {
  buildCliRulesBlock,
  CLI_RULES_END,
  CLI_RULES_START,
  extractRegion,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import { cliRulesRegionRecord } from '../src/step-engine/steps/onboarding/_rules-files.js';

const render = buildCliRulesBlock(['Keep changes small.']) as string;
const onDisk = (block: string): string =>
  extractRegion(`# Project\n\n${block}\nNotes of our own.\n`, CLI_RULES_START, CLI_RULES_END) ?? '';
const hash = (s: string): string => sha256Hex(normalizeContent(s));

describe('cliRulesRegionRecord', () => {
  it('claims the region as Haive output when it is the render', () => {
    expect(cliRulesRegionRecord(onDisk(render), render, new Set())).toEqual({
      content: normalizeContent(onDisk(render)),
      templateContentHash: hash(render),
      writtenHash: hash(render),
      haiveWritten: true,
    });
  });

  it('claims an older render an earlier onboarding or upgrade recorded', () => {
    const older = buildCliRulesBlock(['An older rule.']) as string;
    const record = cliRulesRegionRecord(onDisk(older), render, new Set([hash(older)]));
    expect(record).toEqual({
      content: normalizeContent(onDisk(older)),
      templateContentHash: hash(older),
      writtenHash: hash(older),
      haiveWritten: true,
    });
  });

  it('records a region nobody rendered as it is and keeps the render hash', () => {
    const edited = render.replace('Keep changes small.', 'Keep changes tiny.');
    expect(edited).not.toBe(render);
    const record = cliRulesRegionRecord(onDisk(edited), render, new Set([hash('other')]));
    expect(record).toEqual({
      content: normalizeContent(onDisk(edited)),
      templateContentHash: hash(edited),
      writtenHash: hash(render),
      haiveWritten: false,
    });
  });

  it('keeps only the region, never the text around it', () => {
    const { content } = cliRulesRegionRecord(onDisk(render), render, new Set());
    expect(content.startsWith(CLI_RULES_START)).toBe(true);
    expect(content).not.toContain('# Project');
    expect(content).not.toContain('Notes of our own.');
  });
});
