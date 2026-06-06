import { z } from 'zod';

export const SyncJobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  changeSetId: z.string().nullable().default(null),
  kind: z.enum(['bootstrap', 'pull_drift', 'push_publish', 'upload_only', 'export_package', 'full_reconcile']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).default('queued'),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  productCount: z.number().int().default(0),
  artifactPath: z.string().nullable().default(null),
  errorSummary: z.string().nullable().default(null),
  metadataJson: z.string().nullable().default(null),
});

export const SyncJobEventSchema = z.object({
  id: z.string(),
  syncJobId: z.string(),
  level: z.enum(['debug', 'info', 'warning', 'error']),
  message: z.string(),
  detailsJson: z.string().nullable().default(null),
  createdAt: z.string(),
});

export type SyncJob = z.infer<typeof SyncJobSchema>;
export type SyncJobEvent = z.infer<typeof SyncJobEventSchema>;
