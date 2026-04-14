import { z } from 'zod';

export const emailSchema = z.string().email().max(255);
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(255);

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(255),
});

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const userResponseSchema = z.object({
  id: z.string().uuid(),
  email: emailSchema,
  role: z.enum(['admin', 'user']),
  status: z.enum(['active', 'deactivated']),
  createdAt: z.string(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;
