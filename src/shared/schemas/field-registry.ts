import { z } from 'zod';

export const FieldRegistryEntrySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  xmlField: z.string(),
  label: z.string(),
  kind: z.string(),
  dataType: z.enum(['string', 'number', 'boolean', 'html', 'image', 'list', 'raw_xml']),
  editable: z.boolean().default(true),
  required: z.boolean().default(false),
  uiGroup: z.string().nullable().default(null),
  sampleValuesJson: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const FieldRegistrySchema = z.object({
  entries: z.array(FieldRegistryEntrySchema),
  schemaVersion: z.literal(1).default(1),
});

export type FieldRegistryEntry = z.infer<typeof FieldRegistryEntrySchema>;
export type FieldRegistry = z.infer<typeof FieldRegistrySchema>;
