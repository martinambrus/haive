import { z } from 'zod';

export const repoSourceSchema = z.enum([
  'local_path',
  'git_https',
  'github_https',
  'github_oauth',
  'gitlab_https',
  'upload',
]);

export const createRepoRequestSchema = z
  .object({
    name: z.string().max(255).optional(),
    source: repoSourceSchema,
    localPath: z.string().optional(),
    remoteUrl: z.string().url().optional(),
    branch: z.string().max(255).optional(),
    credentialsId: z.string().uuid().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.source === 'local_path' && !val.localPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localPath'],
        message: 'localPath is required when source is local_path',
      });
    }
    if (
      (val.source === 'git_https' ||
        val.source === 'github_https' ||
        val.source === 'github_oauth' ||
        val.source === 'gitlab_https') &&
      !val.remoteUrl
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remoteUrl'],
        message: 'remoteUrl is required for HTTPS sources',
      });
    }
  });

export type CreateRepoRequest = z.infer<typeof createRepoRequestSchema>;

export const updateRepoExclusionsRequestSchema = z.object({
  excludedPaths: z.array(z.string().min(1).max(1024)).max(1024),
});

export type UpdateRepoExclusionsRequest = z.infer<typeof updateRepoExclusionsRequestSchema>;

export const filesystemListQuerySchema = z.object({
  path: z.string().min(1),
});

export type FilesystemListQuery = z.infer<typeof filesystemListQuerySchema>;

export const filesystemEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  hasGit: z.boolean(),
  hidden: z.boolean(),
});

export const filesystemListResponseSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(filesystemEntrySchema),
});

export type FilesystemEntry = z.infer<typeof filesystemEntrySchema>;
export type FilesystemListResponse = z.infer<typeof filesystemListResponseSchema>;
