import { z } from 'zod';

const baseField = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
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
