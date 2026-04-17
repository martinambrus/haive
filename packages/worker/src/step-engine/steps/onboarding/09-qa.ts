import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectResult } from '@haive/shared';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, loadPreviousStepOutput, pathExists } from './_helpers.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface KbFileSummary {
  id: string;
  title: string;
  relPath: string;
  sectionHeadings: string[];
}

export interface AgentQuestion {
  id: string;
  topic: string;
  question: string;
  context: string;
  suggestedKbFile?: string;
}

export interface KnowledgeQaPrepDetect {
  framework: string | null;
  language: string | null;
  kbFiles: KbFileSummary[];
  /** Transient — file tree handed to the LLM prompt; stripped before persisting. */
  __fileTree?: string;
}

export interface KnowledgeQaPrepApply {
  agentQuestions: AgentQuestion[];
  explicitNoQuestions: boolean;
}

const MAX_AGENT_QUESTIONS = 30;
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.ddev',
]);

/* ------------------------------------------------------------------ */
/* KB scanning                                                         */
/* ------------------------------------------------------------------ */

function parseKbFile(text: string): { title: string; sectionHeadings: string[] } {
  const lines = text.split('\n');
  let title = '';
  const sectionHeadings: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!title) {
      const h1 = /^#\s+(.+)$/.exec(line);
      if (h1 && h1[1]) {
        title = h1[1].trim();
        continue;
      }
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2 && h2[1]) sectionHeadings.push(h2[1].trim());
  }
  return { title, sectionHeadings };
}

async function listKbFiles(repoRoot: string): Promise<KbFileSummary[]> {
  const kbDir = path.join(repoRoot, '.claude', 'knowledge_base');
  if (!(await pathExists(kbDir))) return [];
  const out: KbFileSummary[] = [];
  await collectKbDir(kbDir, kbDir, out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

async function collectKbDir(rootDir: string, current: string, out: KbFileSummary[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectKbDir(rootDir, full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    let text: string;
    try {
      text = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseKbFile(text);
    const relInsideKb = path.relative(rootDir, full);
    out.push({
      id: relInsideKb.replace(/\.md$/, ''),
      title: parsed.title || relInsideKb,
      relPath: path.join('.claude', 'knowledge_base', relInsideKb),
      sectionHeadings: parsed.sectionHeadings,
    });
  }
}

async function collectShortFileTree(repoPath: string): Promise<string> {
  const files = await listFilesMatching(
    repoPath,
    (rel, isDir) => {
      const parts = rel.split('/');
      if (parts.some((p) => IGNORE_DIRS.has(p))) return false;
      if (isDir) return false;
      return true;
    },
    4,
  );
  const capped = files.slice(0, 100);
  const tree = capped.join('\n');
  return capped.length < files.length
    ? tree + `\n[...truncated, ${files.length - capped.length} more files]`
    : tree;
}

/* ------------------------------------------------------------------ */
/* LLM prompt                                                          */
/* ------------------------------------------------------------------ */

function buildPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as KnowledgeQaPrepDetect;
  const fileTree = detected.__fileTree ?? '(no file tree available)';
  const kbList =
    detected.kbFiles.length > 0
      ? detected.kbFiles.map((f) => `- ${f.relPath} — ${f.title}`).join('\n')
      : '(no knowledge base files yet)';

  return [
    'You are a senior software engineer auditing a codebase for parts that are AMBIGUOUS or UNCLEAR.',
    'Your goal: identify code or behaviors that you cannot confidently understand from the source alone,',
    'so that you can ask the user (the project owner) targeted questions whose answers will be added',
    'to the knowledge base for every future task to inherit.',
    '',
    '## Project context',
    `Framework: ${detected.framework ?? 'unknown'}`,
    `Language: ${detected.language ?? 'unknown'}`,
    '',
    '## Existing knowledge base files',
    kbList,
    '',
    '## Repository overview (partial file tree)',
    '```',
    fileTree,
    '```',
    '',
    '## Instructions',
    '',
    'Use your file-reading tools to deeply explore this repository. For each ambiguous area:',
    '1. Read the relevant code thoroughly.',
    '2. Check whether the existing KB files above already explain it. If yes, skip — do not re-ask.',
    '3. If neither code nor KB makes the answer obvious, formulate ONE targeted question.',
    '',
    `Cap: at most ${MAX_AGENT_QUESTIONS} questions. Quality over quantity.`,
    '',
    'Examples of GOOD questions:',
    '- "How does the order state transition when only one of N items in the order is delivered?"',
    '- "What records (and which attributes) are filtered out from the products table by the default scope?"',
    '- "When `retryWithBackoff` exhausts attempts, is the original error re-thrown or wrapped?"',
    '',
    'Examples of BAD questions (do NOT ask these):',
    '- "What does this function do?" (read the code)',
    '- "Is this safe?" (form an opinion from the code)',
    '- "What is React?" (general knowledge)',
    '',
    '## Output format',
    '',
    'Emit exactly ONE JSON object inside a ```json fenced code block:',
    '```',
    '{',
    '  "agentQuestions": [',
    '    {',
    '      "id": "kebab-case-slug",',
    '      "topic": "Short title (1-6 words)",',
    '      "question": "Full question sentence ending with ?",',
    '      "context": "1-3 sentences citing file paths and what you read that triggered the question.",',
    '      "suggestedKbFile": ".claude/knowledge_base/BUSINESS_LOGIC.md"',
    '    }',
    '  ],',
    '  "explicitNoQuestions": false',
    '}',
    '```',
    '',
    'Field rules:',
    '- id: kebab-case, unique within this output.',
    '- topic: a short label the user will see as a textarea heading.',
    '- question: a single concrete question.',
    '- context: cite the file paths you read; explain why the answer was unclear.',
    '- suggestedKbFile: optional. If you have a strong opinion which existing KB file the answer',
    '  belongs in, list it (relative path from repo root). Otherwise omit.',
    '',
    '## "No questions" is a valid outcome — but it MUST be explicit',
    '',
    'If after careful exploration you have NO ambiguity left, you MUST emit:',
    '```',
    '{ "agentQuestions": [], "explicitNoQuestions": true }',
    '```',
    '',
    'An empty array WITHOUT `"explicitNoQuestions": true` will be treated as a parse failure',
    `and the step will be marked failed for the user to retry. So is more than ${MAX_AGENT_QUESTIONS} questions.`,
    'Do not emit any prose outside the fenced JSON block.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* LLM output parsing                                                  */
/* ------------------------------------------------------------------ */

export class QaPrepParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaPrepParseError';
  }
}

function isAgentQuestion(val: unknown): val is AgentQuestion {
  if (!val || typeof val !== 'object') return false;
  const v = val as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.topic !== 'string' || v.topic.length === 0) return false;
  if (typeof v.question !== 'string' || v.question.length === 0) return false;
  if (typeof v.context !== 'string') return false;
  if (v.suggestedKbFile !== undefined && typeof v.suggestedKbFile !== 'string') return false;
  return true;
}

export function parseQaPrepOutput(raw: unknown): KnowledgeQaPrepApply {
  let source: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'result' in (raw as Record<string, unknown>)) {
    source = (raw as Record<string, unknown>).result;
  }
  let text: string;
  if (typeof source === 'string') {
    text = source;
  } else if (typeof source === 'object' && source !== null) {
    return validateParsed(source);
  } else {
    throw new QaPrepParseError('LLM output is empty or not parseable');
  }

  const fenceRe = /```json\s*([\s\S]*?)```/;
  const match = fenceRe.exec(text);
  if (!match || !match[1]) {
    throw new QaPrepParseError('No ```json fenced block found in LLM output');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new QaPrepParseError(
      `JSON parse error in LLM output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateParsed(parsed);
}

function validateParsed(parsed: unknown): KnowledgeQaPrepApply {
  if (!parsed || typeof parsed !== 'object') {
    throw new QaPrepParseError('LLM output is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.agentQuestions)) {
    throw new QaPrepParseError('"agentQuestions" must be an array');
  }
  if (typeof obj.explicitNoQuestions !== 'boolean') {
    throw new QaPrepParseError('"explicitNoQuestions" must be a boolean');
  }
  const list = obj.agentQuestions as unknown[];
  if (list.length > MAX_AGENT_QUESTIONS) {
    throw new QaPrepParseError(
      `LLM emitted ${list.length} questions, cap is ${MAX_AGENT_QUESTIONS}`,
    );
  }
  const seenIds = new Set<string>();
  const validated: AgentQuestion[] = [];
  for (const item of list) {
    if (!isAgentQuestion(item)) {
      throw new QaPrepParseError('Agent question entry has invalid shape');
    }
    if (seenIds.has(item.id)) {
      throw new QaPrepParseError(`Duplicate agent question id "${item.id}"`);
    }
    seenIds.add(item.id);
    validated.push(item);
  }
  if (validated.length === 0 && obj.explicitNoQuestions !== true) {
    throw new QaPrepParseError(
      'Empty agentQuestions array without explicitNoQuestions=true is not allowed',
    );
  }
  return { agentQuestions: validated, explicitNoQuestions: obj.explicitNoQuestions };
}

/* ------------------------------------------------------------------ */
/* Step definition                                                     */
/* ------------------------------------------------------------------ */

export const knowledgeQaPrepStep: StepDefinition<KnowledgeQaPrepDetect, KnowledgeQaPrepApply> = {
  metadata: {
    id: '09-qa',
    workflowType: 'onboarding',
    index: 10,
    title: 'Knowledge base Q&A — agent question generation',
    description:
      'LLM scans the repository and the existing knowledge base, then emits a list of targeted questions about ambiguous or undocumented code. The user answers them in the next step.',
    requiresCli: true,
  },

  async detect(ctx: StepContext): Promise<KnowledgeQaPrepDetect> {
    await ctx.emitProgress('Loading project metadata...');
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | { project?: { framework?: string; primaryLanguage?: string } }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;

    await ctx.emitProgress('Listing existing knowledge base...');
    const kbFiles = await listKbFiles(ctx.repoPath);

    await ctx.emitProgress('Collecting file tree for LLM orientation...');
    const fileTree = await collectShortFileTree(ctx.repoPath);

    await ctx.emitProgress(
      `Project context gathered (${kbFiles.length} KB files, ${fileTree.split('\n').length} source files). Waiting for AI question generation...`,
    );

    ctx.logger.info(
      { framework, language, kbFileCount: kbFiles.length },
      'qa-prep detect complete',
    );
    return { framework, language, kbFiles, __fileTree: fileTree };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    buildPrompt,
    timeoutMs: 60 * 60 * 1000,
  },

  async apply(ctx, args): Promise<KnowledgeQaPrepApply> {
    const result = parseQaPrepOutput(args.llmOutput);
    ctx.logger.info(
      {
        questionCount: result.agentQuestions.length,
        explicitNoQuestions: result.explicitNoQuestions,
      },
      'qa-prep apply complete',
    );
    return result;
  },
};
