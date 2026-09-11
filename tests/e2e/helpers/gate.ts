import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

/**
 * A task parked at a gate, which is the product's central interaction.
 *
 * A step in `waiting_form` carrying a `form_schema` is what the task page renders through
 * FormRenderer, and submitting it is how every decision in the workflow is made. The submit route
 * refuses anything that is not in that status — `No step awaiting form submission` — so the
 * status and the schema have to be seeded together or the fixture tests nothing.
 *
 * The task's title deliberately shares no words with the form's: role-name matching is a
 * case-insensitive substring, so a task called "e2e gate x" and a form called "E2E gate" are two
 * headings the same query matches.
 *
 * The schema below is a real one in miniature: a required text field, a checkbox, and a select.
 * Those three cover the renderer's three input shapes and the validation rule that actually bites
 * — `required` rejects an ABSENT value, which is the trap `validateFormValues` documents.
 */

export interface GateFixture {
  taskId: string;
  stepRowId: string;
  stepId: string;
  fields: { text: string; checkbox: string; select: string };
}

/** Kept in one place so the spec and the assertions cannot disagree about a field id. */
const FIELDS = { text: 'summary', checkbox: 'proceed', select: 'mode' } as const;

export function gateFormSchema() {
  return {
    title: 'E2E gate',
    description: 'Seeded by the end-to-end suite.',
    fields: [
      { id: FIELDS.text, label: 'Summary', type: 'text', required: true },
      { id: FIELDS.checkbox, label: 'Proceed', type: 'checkbox', default: false },
      {
        id: FIELDS.select,
        label: 'Mode',
        type: 'select',
        default: 'careful',
        options: [
          { value: 'careful', label: 'Careful' },
          { value: 'fast', label: 'Fast' },
        ],
      },
    ],
    submitLabel: 'Submit gate',
  };
}

/**
 * Seed a task whose current step is parked on that form.
 *
 * The task is `waiting_user` rather than `running`: that is the status the product gives a task
 * sitting at a gate, and the page keys several of its affordances on it.
 */
export async function seedGate(
  sql: postgres.Sql,
  userId: string,
  suffix: string,
): Promise<GateFixture> {
  const taskId = randomUUID();
  const stepRowId = randomUUID();
  const stepId = '06-gate-1-spec-approval';
  const now = new Date();

  await sql`
    insert into tasks (
      id, user_id, type, title, status,
      current_step_id, current_step_index, created_at, updated_at
    ) values (
      ${taskId}, ${userId}, 'workflow', ${`e2e parked task ${suffix}`}, 'waiting_user',
      ${stepId}, 0, ${now}, ${now}
    )
  `;

  await sql`
    insert into task_steps (
      id, task_id, step_id, step_index, title, status,
      form_schema, waiting_started_at, started_at, created_at, updated_at
    ) values (
      ${stepRowId}, ${taskId}, ${stepId}, 0, 'Gate 1: spec approval', 'waiting_form',
      ${sql.json(gateFormSchema())}, ${now}, ${now}, ${now}, ${now}
    )
  `;

  return { taskId, stepRowId, stepId, fields: { ...FIELDS } };
}

export async function readFormValues(
  sql: postgres.Sql,
  stepRowId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await sql<{ form_values: Record<string, unknown> | null }[]>`
    select form_values from task_steps where id = ${stepRowId}
  `;
  return rows[0]?.form_values ?? null;
}
