import { describe, expect, it } from 'vitest';
import { AGENT_DIRECTORIES, promptNamesAgentPath, unmanagedAgentsDir } from './catalog.js';

const WORKDIR = '/haive/workdir';

describe('AGENT_DIRECTORIES', () => {
  it('is the catalog union, not one provider s directory', () => {
    // grok reads `.claude/agents` and `.agents/agents` besides its own, which is why the mask needs
    // the union rather than the dispatched provider's directory alone.
    expect(AGENT_DIRECTORIES).toContain('.claude/agents');
    expect(AGENT_DIRECTORIES).toContain('.codex/agents');
    expect(AGENT_DIRECTORIES.length).toBeGreaterThan(2);
    // Derived from the catalog, so no duplicates even though claude-code and zai share a directory.
    expect(new Set(AGENT_DIRECTORIES).size).toBe(AGENT_DIRECTORIES.length);
  });

  it('excludes the -legacy quarantine siblings', () => {
    for (const dir of AGENT_DIRECTORIES) {
      expect(AGENT_DIRECTORIES).not.toContain(unmanagedAgentsDir(dir));
    }
  });
});

describe('promptNamesAgentPath', () => {
  it('matches a directory, with or without a trailing slash, and a file inside it', () => {
    expect(promptNamesAgentPath('review everything in .claude/agents/', WORKDIR)).toBe(true);
    expect(promptNamesAgentPath('look at .claude/agents please', WORKDIR)).toBe(true);
    expect(promptNamesAgentPath('open .claude/agents/peer-reviewer.md', WORKDIR)).toBe(true);
    expect(promptNamesAgentPath('and .codex/agents/x.toml too', WORKDIR)).toBe(true);
  });

  it('matches the absolute sandbox form, and only under the workdir', () => {
    expect(promptNamesAgentPath('cat /haive/workdir/.claude/agents/x.md', WORKDIR)).toBe(true);
    // Outside the mount root it is not a path the agent can open in this sandbox.
    expect(promptNamesAgentPath('cat /etc/.claude/agents/x.md', WORKDIR)).toBe(false);
    // With no workdir supplied only relative paths can match.
    expect(promptNamesAgentPath('cat /haive/workdir/.claude/agents/x.md', null)).toBe(false);
  });

  it('anchors on whole segments from the root', () => {
    // The three cases a `startsWith` implementation gets wrong.
    expect(promptNamesAgentPath('see docs/.claude/agents/x.md', WORKDIR)).toBe(false);
    expect(promptNamesAgentPath('see .claude-agents/x.md', WORKDIR)).toBe(false);
    expect(promptNamesAgentPath('the .claude directory', WORKDIR)).toBe(false);
  });

  it('does NOT match the -legacy quarantine, which stays visible', () => {
    // A sibling, not a subdirectory: `agents-legacy` is a different segment from `agents`. The exec
    // mask deliberately leaves the user's own definitions there readable, so naming one must not
    // end isolation.
    expect(promptNamesAgentPath('see .claude/agents-legacy/mine.md', WORKDIR)).toBe(false);
    expect(promptNamesAgentPath(`see ${unmanagedAgentsDir('.claude/agents')}/`, WORKDIR)).toBe(
      false,
    );
  });

  it('finds a path among prose, punctuation and quotes', () => {
    expect(promptNamesAgentPath('Read `.claude/agents/x.md`, then stop.', WORKDIR)).toBe(true);
    expect(promptNamesAgentPath('paths: (".claude/agents/x.md")', WORKDIR)).toBe(true);
    expect(promptNamesAgentPath('./.claude/agents/x.md', WORKDIR)).toBe(true);
  });

  it('answers false for text that names no path at all', () => {
    expect(promptNamesAgentPath('Review the change set and report findings.', WORKDIR)).toBe(false);
    expect(promptNamesAgentPath('', WORKDIR)).toBe(false);
  });
});
