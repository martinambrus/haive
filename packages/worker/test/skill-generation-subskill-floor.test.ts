import { describe, expect, it } from 'vitest';
import {
  hasSubSkills,
  parseSkillEntries,
  type SkillEntry,
  type SkillSubSkill,
} from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';

const goodSub: SkillSubSkill = {
  slug: 'attribution',
  name: 'task-tracking-attribution',
  title: 'Attribution',
  description: 'Per-task attribution.',
  summary: 'recompute per window',
  body: '## Purpose\n\nWindows get scored.',
};

function skill(id: string, subSkills?: SkillSubSkill[]): SkillEntry {
  return { id, title: id, description: 'd', overview: 'o', ...(subSkills ? { subSkills } : {}) };
}

describe('hasSubSkills', () => {
  it('is true when at least one valid sub-skill is present', () => {
    expect(hasSubSkills(skill('x', [goodSub]))).toBe(true);
  });

  it('is false when subSkills is absent (truncated pass that never reached subSkills)', () => {
    expect(hasSubSkills(skill('x'))).toBe(false);
  });

  it('is false when subSkills is an empty array', () => {
    expect(hasSubSkills(skill('x', []))).toBe(false);
  });

  it('is false when every sub-skill is malformed (sanitize drops them to zero)', () => {
    const malformed = [
      { ...goodSub, slug: 'no-body', body: '' as unknown as string },
      { ...goodSub, slug: 'no-summary', summary: '' as unknown as string },
    ];
    expect(hasSubSkills(skill('x', malformed))).toBe(false);
  });
});

describe('apply() sub-skill floor partition (filter(hasSubSkills))', () => {
  it('keeps complete skills and drops zero-sub-skill skills', () => {
    const entries = [
      skill('complete', [goodSub]),
      skill('truncated'),
      skill('also-good', [goodSub]),
    ];
    const kept = entries.filter(hasSubSkills).map((e) => e.id);
    const dropped = entries.filter((e) => !hasSubSkills(e)).map((e) => e.id);
    expect(kept).toEqual(['complete', 'also-good']);
    expect(dropped).toEqual(['truncated']);
  });

  it('drops every LLM skill when all are zero-sub-skill (the all-truncated signal)', () => {
    const entries = [skill('a'), skill('b')];
    expect(entries.filter(hasSubSkills)).toEqual([]);
    expect(entries.filter((e) => !hasSubSkills(e)).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('parseSkillEntries jsonrepair salvage', () => {
  it('parses a clean fenced skills object', () => {
    const raw =
      '```json\n{"skills":[{"id":"a","title":"A","description":"d","overview":"o"}]}\n```';
    expect(parseSkillEntries(raw).map((s) => s.id)).toEqual(['a']);
  });

  it('recovers skills from malformed JSON with trailing commas', () => {
    const raw =
      '```json\n{ "skills": [ { "id": "a", "title": "A", "description": "d", "overview": "o", }, ] }\n```';
    expect(parseSkillEntries(raw).map((s) => s.id)).toEqual(['a']);
  });

  it('recovers skills from a truncated stream (unterminated tail)', () => {
    const raw = '```json\n{"skills":[{"id":"a","title":"A","description":"d","overview":"o"';
    expect(parseSkillEntries(raw).map((s) => s.id)).toEqual(['a']);
  });

  it('returns [] for prose with no skill JSON', () => {
    expect(parseSkillEntries('I could not identify any capability domains.')).toEqual([]);
  });

  it('returns [] when the skills array holds no valid skill object', () => {
    expect(parseSkillEntries('```json\n{"skills":["not an object"]}\n```')).toEqual([]);
  });
});
