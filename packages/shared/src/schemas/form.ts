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
  directoryTreeFieldSchema,
  bundleComposerFieldSchema,
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
  directoryTreeFieldSchema,
  accordionFieldSchema,
  bundleComposerFieldSchema,
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

export const formSchemaSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  /** Optional disclosures rendered between description and fields. */
  infoSections: z.array(infoSectionSchema).optional(),
  fields: z.array(formFieldSchema),
  submitLabel: z.string().optional(),
});

export type FormSchema = z.infer<typeof formSchemaSchema>;

export const formSubmissionSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export type FormSubmission = z.infer<typeof formSubmissionSchema>;
