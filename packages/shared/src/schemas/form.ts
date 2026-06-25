import { z } from 'zod';

/** Optional auxiliary content the renderer can show next to a field/option.
 *  Currently the only `kind` is `'diff'`, used by the upgrade form so each
 *  artifact selection can disclose a baseline-vs-current diff. `editable` is a
 *  forward-looking flag — the renderer ignores it today (read-only diff only),
 *  but workflow tasks will use `editable: true` to let users hand-edit the
 *  proposed content before apply. */
export const diffDetailsSchema = z.object({
  kind: z.literal('diff'),
  baseline: z.string().nullable(),
  current: z.string(),
  editable: z.boolean().optional(),
});

export type DiffDetails = z.infer<typeof diffDetailsSchema>;

const baseField = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  details: diffDetailsSchema.optional(),
  /** Conditionally hide this field based on another field's CURRENT value in the
   *  same form. When the predicate fails the field is not rendered. Use for inputs
   *  that only apply to a particular choice (e.g. console/network checks that are
   *  irrelevant once browser testing is skipped). */
  visibleWhen: z
    .object({
      field: z.string().min(1),
      equals: z.string().optional(),
      notEquals: z.string().optional(),
    })
    .optional(),
});

export const textFieldSchema = baseField.extend({
  type: z.literal('text'),
  default: z.string().optional(),
  placeholder: z.string().optional(),
});

export const textareaFieldSchema = baseField.extend({
  type: z.literal('textarea'),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  rows: z.number().int().positive().optional(),
});

export const optionSchema = z.object({
  value: z.string(),
  label: z.string(),
  /** Optional short badge text rendered next to the label (e.g. "AI-suggested"). */
  badge: z.string().optional(),
  /** Badge color variant. Defaults to 'default' (neutral). */
  badgeColor: z.enum(['default', 'amber', 'indigo', 'green']).optional(),
  /** Optional gray sub-text rendered under the option label (radio fields), e.g. a
   *  one-line explanation of what the option does. */
  description: z.string().optional(),
  /** Optional hover-tooltip content shown via an info icon after the option label
   *  (radio fields). Rendered as a styled HTML tooltip, not the native title. */
  info: z.string().optional(),
  /** Optional pretty group label. When set on one or more options in a
   *  multi-select, the renderer clusters options by group and shows a
   *  "Select all in <group>" button per distinct group. */
  group: z.string().optional(),
  /** Per-option diff disclosure (e.g. the upgrade form attaches a baseline-vs-
   *  current diff to each artifact option). Field-level `details` is also
   *  supported on baseField for non-multi-select fields like radios. */
  details: diffDetailsSchema.optional(),
});

export const selectFieldSchema = baseField.extend({
  type: z.literal('select'),
  options: z.array(optionSchema),
  default: z.string().optional(),
});

export const multiSelectFieldSchema = baseField.extend({
  type: z.literal('multi-select'),
  options: z.array(optionSchema),
  defaults: z.array(z.string()).optional(),
});

export const checkboxFieldSchema = baseField.extend({
  type: z.literal('checkbox'),
  default: z.boolean().optional(),
});

export const radioFieldSchema = baseField.extend({
  type: z.literal('radio'),
  options: z.array(optionSchema),
  default: z.string().optional(),
});

export const selectWithTextFieldSchema = baseField.extend({
  type: z.literal('select-with-text'),
  predefined: z.array(optionSchema),
  default: z.string().optional(),
  placeholder: z.string().optional(),
});

export const radioWithTextareaFieldSchema = baseField.extend({
  type: z.literal('radio-with-textarea'),
  predefined: z.array(optionSchema),
  customLabel: z.string().optional(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  rows: z.number().int().positive().optional(),
});

export const directoryPickerFieldSchema = baseField.extend({
  type: z.literal('directory-picker'),
  rootPath: z.string().optional(),
  mustContainGit: z.boolean().optional(),
});

export const fileUploadFieldSchema = baseField.extend({
  type: z.literal('file-upload'),
  accept: z.string().optional(),
  maxSizeBytes: z.number().int().positive().optional(),
});

export const numberFieldSchema = baseField.extend({
  type: z.literal('number'),
  default: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
});

/** Read-only note rendered inline among the fields (no input value). `body` is
 *  shown as markdown when it looks like markdown (links open in a new tab),
 *  else as plain text. Use for a short contextual line — e.g. a link to a
 *  related settings page — positioned by its place in the fields array. */
export const noteFieldSchema = baseField.extend({
  type: z.literal('note'),
  body: z.string(),
  /** Visual emphasis. 'warning' renders an amber callout — use for an action the
   *  user should take before continuing (e.g. fill in a hands-free config). Omitted
   *  or 'info' renders the plain neutral line. */
  variant: z.enum(['info', 'warning']).optional(),
});

export const treeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    label: z.string(),
    fileCount: z.number().int().nonnegative().optional(),
    badge: z.string().optional(),
    badgeColor: z.enum(['default', 'amber', 'indigo', 'green']).optional(),
    children: z.array(treeNodeSchema).optional(),
  }),
);

export interface TreeNode {
  path: string;
  label: string;
  fileCount?: number;
  badge?: string;
  badgeColor?: 'default' | 'amber' | 'indigo' | 'green';
  children?: TreeNode[];
}

export const directoryTreeFieldSchema = baseField.extend({
  type: z.literal('directory-tree'),
  tree: z.array(treeNodeSchema),
  defaults: z.array(z.string()).optional(),
});

/** Pre-existing bundle row surfaced by the form so the composer can render
 *  edit/remove controls. `itemCount` is the live count from
 *  `custom_bundle_items` so the user sees what's already ingested without
 *  having to click into the row. */
export const bundleComposerInitialSchema = z.object({
  id: z.string(),
  name: z.string(),
  sourceType: z.enum(['zip', 'git']),
  gitUrl: z.string().optional(),
  gitBranch: z.string().optional(),
  archiveFilename: z.string().optional(),
  enabledKinds: z.array(z.enum(['agent', 'skill'])),
  itemCount: z.number().int().nonnegative(),
  status: z.enum(['active', 'syncing', 'failed']),
  lastSyncError: z.string().nullable().optional(),
});

export type BundleComposerInitial = z.infer<typeof bundleComposerInitialSchema>;

export const bundleComposerCredentialOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export type BundleComposerCredentialOption = z.infer<typeof bundleComposerCredentialOptionSchema>;

export const bundleComposerFieldSchema = baseField.extend({
  type: z.literal('bundle-composer'),
  initialBundles: z.array(bundleComposerInitialSchema),
  allowAddZip: z.boolean(),
  allowAddGit: z.boolean(),
  credentialOptions: z.array(bundleComposerCredentialOptionSchema),
});

/** Display-only panel: the renderer live-validates the instance-level global KB
 *  (enabled / DB / Ollama) and shows status + an Add/Fix action button. Carries
 *  the task's repo + CLI so the "Add a house rule" link can pre-fill them. */
export const globalKbStatusFieldSchema = baseField.extend({
  type: z.literal('global-kb-status'),
  repositoryId: z.string().nullable().optional(),
  cliProviderId: z.string().nullable().optional(),
});

export const leafFormFieldSchema = z.discriminatedUnion('type', [
  textFieldSchema,
  textareaFieldSchema,
  selectFieldSchema,
  multiSelectFieldSchema,
  checkboxFieldSchema,
  radioFieldSchema,
  selectWithTextFieldSchema,
  radioWithTextareaFieldSchema,
  directoryPickerFieldSchema,
  fileUploadFieldSchema,
  numberFieldSchema,
  noteFieldSchema,
  directoryTreeFieldSchema,
  bundleComposerFieldSchema,
  globalKbStatusFieldSchema,
]);

export type LeafFormField = z.infer<typeof leafFormFieldSchema>;

export const accordionItemSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(leafFormFieldSchema),
});

export type AccordionItem = z.infer<typeof accordionItemSchema>;

export const accordionFieldSchema = baseField.extend({
  type: z.literal('accordion'),
  items: z.array(accordionItemSchema),
});

export const formFieldSchema = z.discriminatedUnion('type', [
  textFieldSchema,
  textareaFieldSchema,
  selectFieldSchema,
  multiSelectFieldSchema,
  checkboxFieldSchema,
  radioFieldSchema,
  selectWithTextFieldSchema,
  radioWithTextareaFieldSchema,
  directoryPickerFieldSchema,
  fileUploadFieldSchema,
  numberFieldSchema,
  noteFieldSchema,
  directoryTreeFieldSchema,
  accordionFieldSchema,
  bundleComposerFieldSchema,
  globalKbStatusFieldSchema,
]);

export type FormField = z.infer<typeof formFieldSchema>;

/** Read-only expandable info card shown above the form fields. Use for
 *  context the renderer should preview compactly (preview line) but make
 *  available in full when the user opts in (body). Body is auto-rendered
 *  as markdown (HTML) when it contains headings or fenced blocks; otherwise
 *  it falls back to a pre-wrapped text block. */
export const infoSectionSchema = z.object({
  /** Heading shown next to the disclosure triangle. */
  title: z.string().min(1),
  /** Optional one-line preview shown next to the title (e.g. counts, sizes). */
  preview: z.string().optional(),
  /** Full content shown when expanded. */
  body: z.string(),
  /** When true, the disclosure renders open on first paint. Use for the
   *  primary section users should see immediately (e.g. spec summary on
   *  the gate-1 form). Defaults to closed so secondary context stays out
   *  of the way. */
  defaultOpen: z.boolean().optional(),
});

export type InfoSection = z.infer<typeof infoSectionSchema>;

/** One row of a form's status summary — a clean two-column "item | status" grid
 *  with a coloured pill, rendered above the fields. Use for an at-a-glance pass/fail
 *  roll-up (e.g. gate-2's verification results) instead of a plain-text prelude.
 *  Producers should OMIT rows that don't apply (e.g. a skipped check) rather than
 *  emit a misleading status. */
export const statusSummaryItemSchema = z.object({
  /** Left-column label, e.g. "Tests", "Code review". */
  label: z.string().min(1),
  /** Pill colour: pass=green, fail=red, warn=amber, info=neutral. */
  status: z.enum(['pass', 'fail', 'warn', 'info']),
  /** Pill text. Defaults to the uppercased status (PASS/FAIL/WARN/INFO) when
   *  omitted; set it to surface a domain word (VALID, BLOCKING, ADVISORY, …). */
  statusLabel: z.string().optional(),
  /** Optional muted sub-line shown next to the label (e.g. "peer REQUEST_CHANGES"). */
  detail: z.string().optional(),
  /** Optional expandable content for this row (markdown, same rendering as an
   *  infoSection body). When present the row becomes a disclosure: the label/pill
   *  stay visible and the body reveals on click — co-locating each result with its
   *  evidence instead of a separate section list. */
  body: z.string().optional(),
  /** When true (and `body` is set) the row's disclosure renders open on first paint
   *  (use for failures the user must see). Defaults to closed. */
  defaultOpen: z.boolean().optional(),
});

export type StatusSummaryItem = z.infer<typeof statusSummaryItemSchema>;

export const formSchemaSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  /** Optional coloured status table rendered between the description and the
   *  infoSections. Omit non-applicable rows; an empty/absent array renders nothing. */
  statusSummary: z.array(statusSummaryItemSchema).optional(),
  /** Optional disclosures rendered between description and fields. */
  infoSections: z.array(infoSectionSchema).optional(),
  fields: z.array(formFieldSchema),
  submitLabel: z.string().optional(),
  /** How the form's primary CTA should behave when clicked:
   *   - 'submit' (default): submit the form values to the step (POST form).
   *   - 'retry': trigger a step retry instead — the renderer skips the form
   *     entirely and shows a single Retry button. Use when `detect` finds
   *     a precondition unmet (e.g. no git repo) and the only useful next
   *     action is for the user to fix the precondition and re-run detect.
   *   - 'clarify': POST the answer to the step's /clarify route — a mid-step
   *     clarification (e.g. the merge-resolver asking how to resolve a conflict)
   *     whose answer must NOT overwrite the step's form values. */
  submitAction: z.enum(['submit', 'retry', 'clarify']).optional(),
  /** Auto-submit this form (posting its field defaults / `{}`) WITHOUT pausing for
   *  the user, even when the task's auto-continue is off. Use for an info-only form
   *  that has nothing to decide (e.g. 06b's single-agent decision) — its
   *  infoSections still render on the done card for review. Forms with a real
   *  decision leave this unset so they gate. */
  autoSubmit: z.boolean().optional(),
});

export type FormSchema = z.infer<typeof formSchemaSchema>;

export const formSubmissionSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export type FormSubmission = z.infer<typeof formSubmissionSchema>;
