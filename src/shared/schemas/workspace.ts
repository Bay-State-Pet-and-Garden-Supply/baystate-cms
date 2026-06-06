import { z } from 'zod';

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Workspace name is required'),
  workspacePath: z.string(),
  gitPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  bootstrapStatus: z.enum(['not_started', 'running', 'complete', 'failed']).default('not_started'),
  baselineCommit: z.string().nullable().default(null),
});

export const ShopSiteConnectionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cgiBaseUrl: z.string().url('Must be a valid URL'),
  authStrategy: z.enum(['basic']).default('basic'),
  merchantId: z.string().min(1, 'Merchant ID is required'),
  passwordSecretRef: z.string().nullable().default(null),
  lastTestedAt: z.string().nullable().default(null),
  lastTestStatus: z.string().nullable().default(null),
  lastTestError: z.string().nullable().default(null),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
export type ShopSiteConnection = z.infer<typeof ShopSiteConnectionSchema>;
