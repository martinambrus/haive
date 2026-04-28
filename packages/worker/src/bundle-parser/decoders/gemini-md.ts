import type { AgentSpec, SkillEntry } from '@haive/shared';
import { decodeClaudeAgent, decodeClaudeSkill } from './claude-md.js';

/** Gemini agents/skills use the same markdown + YAML-frontmatter layout as
 *  Claude (modulo the dir they live in). The decoder is therefore a thin
 *  alias around the Claude decoder; differences are captured at *emit* time
 *  (different target dir, identical body). Keeping a separate function makes
 *  the decoder registry readable and gives us a hook for any Gemini-specific
 *  frontmatter quirks that may surface later. */
export function decodeGeminiAgent(content: string, sourcePath: string): AgentSpec {
  return decodeClaudeAgent(content, sourcePath);
}

export function decodeGeminiSkill(
  content: string,
  sourcePath: string,
  subSkillContents: { sourcePath: string; content: string }[],
): SkillEntry {
  return decodeClaudeSkill(content, sourcePath, subSkillContents);
}
