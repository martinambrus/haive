import { z } from 'zod';

export const inputFrameSchema = z.object({
  type: z.literal('input'),
  data: z.string().max(8192),
});

export const resizeFrameSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export const pingFrameSchema = z.object({
  type: z.literal('ping'),
});

export const setControlPassthroughFrameSchema = z.object({
  type: z.literal('set_control_passthrough'),
  allow: z.boolean(),
});

export const terminalClientFrameSchema = z.discriminatedUnion('type', [
  inputFrameSchema,
  resizeFrameSchema,
  pingFrameSchema,
  setControlPassthroughFrameSchema,
]);

export type TerminalClientFrameInput = z.infer<typeof terminalClientFrameSchema>;
