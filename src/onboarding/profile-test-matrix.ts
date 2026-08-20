// story: e06s04

export interface MatrixSample {
  id: string;
  url: string;
  expectedTitle: string;
}

export interface MatrixCell {
  field: string;
  extracted: string | null;
  expected: string;
  provenance: string;
  artifactHash: string;
  success: boolean;
  failureReason: string | null;
}

export interface MatrixRow {
  sampleId: string;
  sampleUrl: string;
  cells: MatrixCell[];
}

export interface MatrixResult {
  domain: string;
  draftVersion: string;
  rows: MatrixRow[];
  createdAt: string;
}

const store = new Map<string, MatrixResult>();

function keyFor(domain: string, version: string): string {
  return `${domain.toLowerCase().replace(/^www\./, '').trim()}::${version}`;
}

export async function runMatrix(input: {
  domain: string;
  draftVersion: string;
  samples: MatrixSample[];
  runner: (sample: MatrixSample) => Promise<{ extractedTitle: string | null; provenance: string; artifactHash: string; success: boolean; failureReason?: string | null }>;
}): Promise<MatrixResult> {
  const rows: MatrixRow[] = [];
  for (const s of input.samples) {
    const r = await input.runner(s);
    rows.push({
      sampleId: s.id,
      sampleUrl: s.url,
      cells: [{
        field: 'title',
        extracted: r.extractedTitle,
        expected: s.expectedTitle,
        provenance: r.provenance,
        artifactHash: r.artifactHash,
        success: r.success,
        failureReason: r.failureReason ?? null,
      }],
    });
  }
  const result: MatrixResult = { domain: input.domain, draftVersion: input.draftVersion, rows, createdAt: new Date().toISOString() };
  store.set(keyFor(input.domain, input.draftVersion), result);
  return result;
}

export function getMatrixResult(domain: string, draftVersion: string): MatrixResult | null {
  return store.get(keyFor(domain, draftVersion)) ?? null;
}

export function resetTestMatrixForTest(): void {
  store.clear();
}
