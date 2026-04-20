import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth.js';

const trimmedOptional = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .optional();

export const accountUpdateSchema = z.object({
  name: trimmedOptional(80),
  phone: trimmedOptional(32),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(255),
  newPassword: passwordSchema,
});

export const gitIdentityUpdateSchema = z.object({
  gitName: trimmedOptional(100),
  gitEmail: z
    .union([z.literal(''), emailSchema])
    .transform((v) => v.trim())
    .optional(),
});

export type AccountUpdate = z.infer<typeof accountUpdateSchema>;
export type PasswordChange = z.infer<typeof passwordChangeSchema>;
export type GitIdentityUpdate = z.infer<typeof gitIdentityUpdateSchema>;

export const accountResponseSchema = z.object({
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: emailSchema,
});

export const gitIdentityResponseSchema = z.object({
  gitName: z.string().nullable(),
  gitEmail: z.string().nullable(),
});

export type AccountResponse = z.infer<typeof accountResponseSchema>;
export type GitIdentityResponse = z.infer<typeof gitIdentityResponseSchema>;
