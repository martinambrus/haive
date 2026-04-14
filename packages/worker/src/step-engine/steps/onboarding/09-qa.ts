import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormField, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from './_helpers.js';

export interface KbFileSummary {
  id: string;
  title: string;
  filePath: string;
  relPath: string;
  sectionHeadings: string[];
  hasStubMarker: boolean;
}

export interface KnowledgeQaDetect {
  files: KbFileSummary[];
}

export interface KnowledgeQaApply {
  updated: { id: string; relPath: string }[];
  unchanged: string[];
}

const STUB_MARKERS = [
  'LLM synthesis was skipped',
  'Fill in human-written',
  'Add notes here once the project has content',
];

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
    if (h2 && h2[1]) {
      sectionHeadings.push(h2[1].trim());
    }
  }
  return { title, sectionHeadings };
}

function hasStubMarker(text: string): boolean {
  return STUB_MARKERS.some((marker) => text.includes(marker));
}

async function listKbFiles(repo: string): Promise<KbFileSummary[]> {
  const kbDir = path.join(repo, '.claude', 'knowledge_base');
  if (!(await pathExists(kbDir))) return [];
  let entries;
  try {
    entries = await readdir(kbDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: KbFileSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const id = entry.name.replace(/\.md$/, '');
    const filePath = path.join(kbDir, entry.name);
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseKbFile(text);
    out.push({
      id,
      title: parsed.title || id,
      filePath,
      relPath: path.join('.claude', 'knowledge_base', entry.name),
      sectionHeadings: parsed.sectionHeadings,
      hasStubMarker: hasStubMarker(text),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function formatClarificationBlock(notes: string, nowIso: string): string {
  const stamp = nowIso.slice(0, 10);
  return ['', `## Clarifications (added ${stamp})`, '', notes.trim(), ''].join('\n');
}

export const knowledgeQaStep: StepDefinition<KnowledgeQaDetect, KnowledgeQaApply> = {
  metadata: {
    id: '09-qa',
    workflowType: 'onboarding',
    index: 10,
    title: 'Knowledge base Q&A',
    description:
      'Walks the generated knowledge base entries. For each file the user can mark it as needing clarification and supply written notes that are appended as a new clarification section.',
    requiresCli: false,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const files = await listKbFiles(ctx.repoPath);
    return files.length > 0;
  },

  async detect(ctx: StepContext): Promise<KnowledgeQaDetect> {
    const files = await listKbFiles(ctx.repoPath);
    ctx.logger.info(
      {
        fileCount: files.length,
        stubCount: files.filter((f) => f.hasStubMarker).length,
      },
      'knowledge-qa detect complete',
    );
    return { files };
  },

  form(_ctx, detected): FormSchema | null {
    if (detected.files.length === 0) return null;
    const fields: FormField[] = [];
    for (const file of detected.files) {
      const sectionList =
        file.sectionHeadings.length > 0
          ? file.sectionHeadings.map((h) => `- ${h}`).join('\n')
          : '- (no sections detected)';
      fields.push({
        type: 'checkbox',
        id: `clarify__${file.id}`,
        label: `${file.title} needs clarification`,
        description: `${file.relPath}${file.hasStubMarker ? ' (stub)' : ''}\n${sectionList}`,
        default: file.hasStubMarker,
      });
      fields.push({
        type: 'textarea',
        id: `notes__${file.id}`,
        label: `${file.title} clarification notes`,
        description:
          'Only applied if the checkbox above is ticked. Content is appended as a new "Clarifications" section.',
        rows: 4,
      });
    }
    return {
      title: 'Knowledge base clarification',
      description:
        'Review each knowledge base file. Tick the checkbox and fill the textarea for any entry that needs a written clarification. Untouched files are left exactly as-is.',
      fields,
      submitLabel: 'Save clarifications',
    };
  },

  async apply(ctx, args): Promise<KnowledgeQaApply> {
    const detected = args.detected as KnowledgeQaDetect;
    const values = args.formValues as Record<string, unknown>;
    const updated: { id: string; relPath: string }[] = [];
    const unchanged: string[] = [];
    const nowIso = new Date().toISOString();

    for (const file of detected.files) {
      const flag = values[`clarify__${file.id}`];
      const notesRaw = values[`notes__${file.id}`];
      const shouldClarify = flag === true;
      const notes = typeof notesRaw === 'string' ? notesRaw.trim() : '';
      if (!shouldClarify || notes.length === 0) {
        unchanged.push(file.id);
        continue;
      }
      let text: string;
      try {
        text = await readFile(file.filePath, 'utf8');
      } catch (err) {
        ctx.logger.warn(
          { err, file: file.relPath },
          'knowledge-qa failed to read KB file; skipping',
        );
        unchanged.push(file.id);
        continue;
      }
      const trimmed = text.endsWith('\n') ? text : `${text}\n`;
      const next = `${trimmed}${formatClarificationBlock(notes, nowIso)}`;
      await writeFile(file.filePath, next, 'utf8');
      updated.push({ id: file.id, relPath: file.relPath });
    }

    ctx.logger.info(
      { updated: updated.length, unchanged: unchanged.length },
      'knowledge-qa apply complete',
    );
    return { updated, unchanged };
  },
};
