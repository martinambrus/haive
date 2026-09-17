import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { collectReviewFindings } from '../src/step-engine/steps/onboarding/11-final-review.js';

// These counts are what the final-review gate tells the user was produced. Every probe behind them
// used to be `stat`-based, so a link counted as whatever it pointed at — a skill whose definition
// lives outside the tree was reported as installed, and the gate said onboarding had produced it.

let repo: string;
let outside: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'haive-review-'));
  outside = await mkdtemp(path.join(tmpdir(), 'haive-review-out-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
  await rm(outside, { recursive: true, force: true }).catch(() => {});
});

const AGENTS = { dir: '.claude/agents', ext: '.md' as const };

async function seed(rel: string, body = 'x'): Promise<void> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, 'utf8');
}

describe('collectReviewFindings counts', () => {
  it('counts real knowledge-base files, skills and agents', async () => {
    await seed(`${KB_DIR}/BUSINESS_LOGIC.md`, '# kb\n');
    await seed('.claude/skills/testing/SKILL.md', '# skill\n');
    await seed('.claude/agents/peer-reviewer.md', '# agent\n');

    const out = await collectReviewFindings(repo, AGENTS);
    expect(out.counts).toEqual({ knowledgeBase: 1, skills: 1, agents: 1 });
  });

  it('does not count a skill whose SKILL.md is a link', async () => {
    await writeFile(path.join(outside, 'SKILL.md'), '# elsewhere\n', 'utf8');
    await mkdir(path.join(repo, '.claude/skills/linked'), { recursive: true });
    await symlink(
      path.join(outside, 'SKILL.md'),
      path.join(repo, '.claude/skills/linked/SKILL.md'),
    );
    // A real skill beside it still counts, so this is a refusal of the one entry rather than a walk
    // that gave up.
    await seed('.claude/skills/real/SKILL.md', '# skill\n');

    const out = await collectReviewFindings(repo, AGENTS);
    expect(out.counts.skills).toBe(1);
  });

  it('counts nothing for an agents directory that is a link', async () => {
    await writeFile(path.join(outside, 'their-agent.md'), '# theirs\n', 'utf8');
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await symlink(outside, path.join(repo, '.claude/agents'));

    const out = await collectReviewFindings(repo, AGENTS);
    expect(out.counts.agents).toBe(0);
    // And the gate says so rather than silently reporting zero.
    expect(out.findings.some((f) => f.id === 'no-agents')).toBe(true);
  });

  it('counts zero for directories that do not exist, which is the first-run case', async () => {
    const out = await collectReviewFindings(repo, AGENTS);
    expect(out.counts).toEqual({ knowledgeBase: 0, skills: 0, agents: 0 });
  });
});
