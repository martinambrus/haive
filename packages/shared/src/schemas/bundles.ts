import { z } from 'zod';
import { archiveFormatSchema } from './repos.js';

export const customBundleSourceTypeSchema = z.enum(['zip', 'git']);
export const customBundleStatusSchema = z.enum(['active', 'syncing', 'failed']);
export const customBundleItemKindSchema = z.enum(['agent', 'skill']);
export const customBundleItemSourceFormatSchema = z.enum(['claude-md', 'codex-toml', 'gemini-md']);

/** Body for POST /api/bundles. Git-source only — ZIP-source bundles are
 *  created by the upload-complete endpoint after a chunked upload finishes. */
export const createGitBundleRequestSchema = z.object({
  repositoryId: z.string().uuid(),
  name: z.string().min(1).max(255),
  enabledKinds: z.array(customBundleItemKindSchema).min(1).default(['agent', 'skill']),
  gitUrl: z.string().url(),
  gitBranch: z.string().min(1).max(255).optional(),
  gitCredentialsId: z.string().uuid().optional(),
});

export type CreateGitBundleRequest = z.infer<typeof createGitBundleRequestSchema>;

/** Init body for POST /api/bundles/uploads/init. Carries the bundle metadata
 *  alongside file metadata so the complete endpoint can create the
 *  `custom_bundles` row without an extra round-trip. */
export const initBundleUploadRequestSchema = z.object({
  repositoryId: z.string().uuid(),
  name: z.string().min(1).max(255),
  enabledKinds: z.array(customBundleItemKindSchema).min(1).default(['agent', 'skill']),
  filename: z.string().min(1).max(512),
  totalSize: z.number().int().positive(),
  chunkSize: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
});

export type InitBundleUploadRequest = z.infer<typeof initBundleUploadRequestSchema>;

export const bundleUploadStatusSchema = z.enum(['uploading', 'complete', 'cancelled']);

export const bundleUploadSessionSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().uuid(),
  name: z.string(),
  enabledKinds: z.array(customBundleItemKindSchema),
  filename: z.string(),
  archiveFormat: archiveFormatSchema,
  totalSize: z.number().int(),
  bytesReceived: z.number().int(),
  chunkSize: z.number().int(),
  status: bundleUploadStatusSchema,
});

export type BundleUploadSession = z.infer<typeof bundleUploadSessionSchema>;

/** Public-facing bundle record returned by GET /api/bundles. Does not embed
 *  items — fetch the detail endpoint for those. */
export const bundleSummarySchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().uuid(),
  name: z.string(),
  sourceType: customBundleSourceTypeSchema,
  enabledKinds: z.array(customBundleItemKindSchema),
  status: customBundleStatusSchema,
  archiveFilename: z.string().nullable(),
  archiveFormat: archiveFormatSchema.nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  gitCredentialsId: z.string().uuid().nullable(),
  lastSyncAt: z.string().nullable(),
  lastSyncCommit: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  itemCounts: z.object({
    agent: z.number().int().nonnegative(),
    skill: z.number().int().nonnegative(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BundleSummary = z.infer<typeof bundleSummarySchema>;
