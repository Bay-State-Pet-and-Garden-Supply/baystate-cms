/**
 * Product Intelligence shared wire types (PI-7).
 *
 * Row shapes shared between the API server (`src/db/repositories/
 * product-intelligence-repo.ts`) and the Agent Lab client
 * (`src/client/product-intelligence-api.ts`). JSON columns stay strings on
 * the wire; each consumer decodes them with its own parse helpers.
 */
export interface PiConflictRow {
  id: string;
  runId: string;
  field: string;
  severity: 'low' | 'medium' | 'high';
  status: 'open' | 'resolved' | 'dismissed';
  competingValuesJson: string;
  evidenceIdsJson: string;
  resolutionJson: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}
