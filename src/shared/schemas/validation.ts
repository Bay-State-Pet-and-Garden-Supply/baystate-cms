import { z } from 'zod';

export const ValidationResultSchema = z.object({
  id: z.string(),
  scopeType: z.enum(['product', 'change_set', 'sync_job', 'drift']),
  scopeId: z.string(),
  severity: z.enum(['blocker', 'warning', 'info']),
  code: z.string(),
  message: z.string(),
  fieldPath: z.string().nullable().default(null),
  createdAt: z.string(),
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;
