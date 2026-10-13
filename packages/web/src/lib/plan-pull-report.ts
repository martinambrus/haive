import type { PlanPullOutcome } from '@/lib/api-client';
import { inlineCode } from '@/lib/project-state-conflicts';

const SHOWN = 8;

const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: 'title',
  body: 'text',
  kind: 'kind',
  status: 'status',
  taskable: 'task flag',
  parentId: 'parent',
  ordinal: 'position',
};

function subjectLabel(subject: string, titleOf: (id: string) => string | null): string {
  if (subject.startsWith('edge:')) return 'a link between two nodes';
  if (subject.startsWith('code-link:')) return 'a code link';
  const title = titleOf(subject);
  return title !== null ? inlineCode(title) : `a node (${inlineCode(subject.slice(0, 8))})`;
}

function listed(items: string[]): string {
  const head = items.slice(0, SHOWN).join(', ');
  return items.length > SHOWN ? `${head} and ${items.length - SHOWN} more` : head;
}

/** What a Pull decided without asking, and what it left to a person, as markdown sentences. */
export function pullReportLines(
  report: Pick<PlanPullOutcome, 'nodesDeleted' | 'conflicts' | 'reported'>,
  titleOf: (id: string) => string | null,
): string[] {
  const lines: string[] = [];
  const deleted = report.nodesDeleted ?? [];
  if (deleted.length > 0) {
    lines.push(
      `${deleted.length} node(s) were deleted here because the other side deleted them and nobody here had changed them: ${listed(deleted.map((id) => inlineCode(id.slice(0, 8))))}.`,
    );
  }
  const asked = report.conflicts ?? [];
  if (asked.length > 0) {
    lines.push(
      `${asked.length} change(s) were made differently on both sides and wait for your answer: ${listed(
        asked.map((c) => `${subjectLabel(c.nodeId, titleOf)} ${FIELD_LABELS[c.field] ?? c.field}`),
      )}.`,
    );
  }
  const reported = (report.reported ?? []).map((r) => {
    const what = subjectLabel(r.subject, titleOf);
    if (r.kind === 'kept-modified') {
      const [deleter, editor] =
        r.deletedBy === 'local'
          ? ['this install', 'the other side']
          : ['the other side', 'this install'];
      return `${what} was kept: ${deleter} deleted it, but ${editor} had changed it.`;
    }
    if (r.kind === 'kept-ancestor') {
      return `${what} was kept because a node under it that was changed is kept.`;
    }
    const field = r.field ? (FIELD_LABELS[r.field] ?? r.field) : 'details';
    return `The ${field} of ${what} was changed on both sides; this install's was kept.`;
  });
  lines.push(...reported.slice(0, SHOWN));
  if (reported.length > SHOWN)
    lines.push(`${reported.length - SHOWN} more decisions are not listed.`);
  return lines;
}
