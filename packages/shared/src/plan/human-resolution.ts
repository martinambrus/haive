import type { FormSchema } from '../schemas/form.js';
import type { PlanNodeKind, PlanNodeStatus } from '../schemas/plan.js';
import { fenceOpener, scanFences } from '../markdown-fences.js';

/** Pure browser-safe policy shared by the panel, cards and resolution endpoint. */
export function humanPlanAction(node: {
  kind: PlanNodeKind;
  taskable: boolean;
}): 'decision' | 'outcome' | null {
  if (node.kind === 'external') return 'outcome';
  if (node.kind === 'decision' && !node.taskable) return 'decision';
  return null;
}

/** Keep the question and prior answers verbatim. Close a trailing top-level fence
 * before appending so the answer remains a section rather than quoted code. */
export function appendPlanAnswer(
  body: string | null,
  action: 'decision' | 'outcome',
  answer: string,
): string {
  let original = body ?? '';
  const lines = original.split('\n');
  const unclosed = scanFences(lines).find((f) => f.close === null);
  if (unclosed) original += `\n${fenceOpener(lines[unclosed.open]!)!.run}`;
  return `${original}${original ? '\n\n' : ''}## ${action === 'decision' ? 'Decision' : 'Outcome'}\n\n${answer.trim()}`;
}

export function planResolutionForm(node: {
  title: string;
  kind: PlanNodeKind;
  taskable: boolean;
  body: string | null;
  status: PlanNodeStatus;
}): FormSchema {
  const action = humanPlanAction(node);
  if (!action) throw new Error('This plan item does not need a human resolution');
  return {
    title: action === 'decision' ? 'Record decision' : 'Record outcome',
    description:
      action === 'decision'
        ? 'Answer the question below. Your answer stays with the plan so later work can use it.'
        : 'Record what happened outside Haive and what remains outstanding. Only choose Resolved when the requirements below are satisfied.',
    submitLabel: 'Save answer and status',
    fields: [
      { type: 'note', id: 'question', label: node.title, body: node.body ?? 'No description yet.' },
      {
        type: 'textarea',
        id: 'answer',
        required: true,
        label: action === 'decision' ? 'What did you decide?' : 'What is the outcome?',
        description:
          action === 'decision'
            ? 'Include the choices and details the question asks for. If something remains undecided, say what is missing.'
            : 'Include the provider, target, confirmation or other details this item asks for, and any remaining action.',
        rows: 6,
      },
      {
        type: 'radio',
        id: 'status',
        label: 'Where does this leave the item?',
        required: true,
        default:
          node.status === 'done' || node.status === 'not_applicable'
            ? node.status
            : 'blocked_human',
        options: [
          {
            value: 'done',
            label: 'Resolved',
            description:
              'The question is answered or the outside action is complete. Dependent work can proceed.',
          },
          {
            value: 'blocked_human',
            label: 'Still waiting',
            description:
              'More information or action from a person is needed. Dependent work stays blocked.',
          },
          {
            value: 'not_applicable',
            label: 'Not applicable',
            description: 'This is no longer required. Record why in your answer.',
          },
        ],
      },
    ],
  };
}
