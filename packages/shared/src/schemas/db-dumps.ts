import { z } from 'zod';

/** Supported DB dump formats, by file extension. A dump is imported into the
 *  task's ephemeral DB before migrations run, then deleted immediately. */
export const dbDumpFormatSchema = z.enum(['sql', 'sql.gz', 'dump']);
export type DbDumpFormat = z.infer<typeof dbDumpFormatSchema>;

/** Chunked-upload session lifecycle for a DB dump. Mirrors the repo upload
 *  session; `consumed` is set once the import step has loaded + deleted it. */
export const dbUploadStatusSchema = z.enum(['uploading', 'complete', 'cancelled', 'consumed']);

export const initDbUploadRequestSchema = z.object({
  filename: z.string().min(1).max(512),
  totalSize: z.number().int().positive(),
  chunkSize: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
});

export type InitDbUploadRequest = z.infer<typeof initDbUploadRequestSchema>;

export const dbUploadSessionSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  dumpFormat: dbDumpFormatSchema,
  totalSize: z.number().int(),
  bytesReceived: z.number().int(),
  chunkSize: z.number().int(),
  status: dbUploadStatusSchema,
});

export type DbUploadSession = z.infer<typeof dbUploadSessionSchema>;
