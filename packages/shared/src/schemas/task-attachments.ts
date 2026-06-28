import { z } from 'zod';

/** A user-supplied file attached to a task, as returned to clients. Stored on the
 *  haive_repos volume and read by the AI CLI agent from the task workspace. */
export const taskAttachmentSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  filename: z.string(),
  sizeBytes: z.number().int(),
  contentType: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string(),
});

export type TaskAttachment = z.infer<typeof taskAttachmentSchema>;

/** Query params for the attachment upload endpoint. The file bytes are the raw
 *  request body; metadata travels in the query string. */
export const uploadTaskAttachmentQuerySchema = z.object({
  filename: z.string().min(1).max(512),
  description: z.string().max(2000).optional(),
});

export type UploadTaskAttachmentQuery = z.infer<typeof uploadTaskAttachmentQuerySchema>;
