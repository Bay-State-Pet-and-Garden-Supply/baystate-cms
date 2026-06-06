import { z } from 'zod';

export const ChangeSetSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(1, 'Title is required'),
  description: z.string().nullable().default(null),
  status: z.enum(['draft', 'reviewing', 'approved', 'pushed', 'discarded']).default('draft'),
  baseCommit: z.string(),
  approvedCommit: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  approvedAt: z.string().nullable().default(null),
});

export const ChangeSetItemSchema = z.object({
  id: z.string(),
  changeSetId: z.string(),
  sku: z.string().min(1, 'SKU is required'),
  operation: z.enum(['create', 'update', 'archive']),
  draftJson: z.string(),
  baseJson: z.string().nullable().default(null),
  draftHash: z.string(),
  validationStatus: z.enum(['unknown', 'valid', 'blocked', 'warning']).default('unknown'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ChangeSet = z.infer<typeof ChangeSetSchema>;
export type ChangeSetItem = z.infer<typeof ChangeSetItemSchema>;
