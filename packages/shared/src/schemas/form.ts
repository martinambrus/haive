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

export const leafFormFieldSchema = z.discriminatedUnion('type', [
  textFieldSchema,
  textareaFieldSchema,
  selectFieldSchema,
  multiSelectFieldSchema,
  checkboxFieldSchema,
  radioFieldSchema,
  selectWithTextFieldSchema,
  directoryPickerFieldSchema,
  fileUploadFieldSchema,
  numberFieldSchema,
  directoryTreeFieldSchema,
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
  directoryPickerFieldSchema,
  fileUploadFieldSchema,
  numberFieldSchema,
  directoryTreeFieldSchema,
  accordionFieldSchema,
]);

export type FormField = z.infer<typeof formFieldSchema>;

export const formSchemaSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(formFieldSchema),
  submitLabel: z.string().optional(),
});

export type FormSchema = z.infer<typeof formSchemaSchema>;

export const formSubmissionSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export type FormSubmission = z.infer<typeof formSubmissionSchema>;
