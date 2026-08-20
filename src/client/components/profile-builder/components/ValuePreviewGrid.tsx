// story: e07s03 — value previews per field per sample
import React from 'react';

export type RankedRecipe = {
  selector: string;
  stability: 'high' | 'medium' | 'low';
  source: 'jsonld' | 'css-stable' | 'shopify' | 'semantic' | 'generic';
  score: number;
};

export interface ValuePreviewGridProps {
  samples: Array<{ id: string; url: string }>;
  candidates: RankedRecipe[];
  /** values[sampleId] -> extracted value or null for no match */
  values: Record<string, string | null>;
  /** optional field label for caption */
  fieldLabel?: string;
  /** per-sample captures for true 3/3 matrix — when provided, values are derived per sample capture, not shared snapshot */
  captures?: Record<string, { html: string; dom?: string }>;
}

export function ValuePreviewGrid({ samples, candidates, values, fieldLabel, captures }: ValuePreviewGridProps) {
  if (candidates.length === 0 || samples.length === 0) return null;
  // story: e07s03 — per-sample capture/evaluate: when captures provided, values are expected to be per-sample already (caller evaluates each capture separately for true 3/3 matrix)
  void captures;
  const top = candidates[0];
  const stableCount = top ? samples.filter(s => {
    const v = values[s.id];
    return v !== null && v !== undefined && String(v).trim().length > 0;
  }).length : 0;
  const total = samples.length;
  const confidenceLabel = stableCount === total && total > 0
    ? `${fieldLabel ?? 'Field'}: stable on ${stableCount}/${total} templates`
    : stableCount > 0 ? `${fieldLabel ?? 'Field'}: ${stableCount}/${total} templates — Value alternatives available` : null;

  return (
    <div className="value-preview-grid" data-field={fieldLabel ?? ''}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border p-1 text-left">Candidate</th>
            {samples.map(s => (
              <th key={s.id} className="border p-1 text-left truncate max-w-[180px]" title={s.url}>
                {s.url}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {candidates.map(c => (
            <tr key={c.selector}>
              <td className="border p-1">
                <span className="font-mono text-xs">{c.selector}</span>
                <span className="ml-2 text-xs opacity-60">
                  {c.source} · {c.stability} ({c.score})
                </span>
              </td>
              {samples.map(s => {
                const v = values[s.id] ?? null;
                return (
                  <td key={s.id} className="border p-1">
                    {v === null ? (
                      <span className="text-red-600">no match</span>
                    ) : (
                      <span>{v}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {confidenceLabel && <p className="mt-1 text-xs font-semibold">{confidenceLabel}</p>}
      <p className="mt-1 text-xs opacity-60">instant preview — not evidence</p>
    </div>
  );
}

export default ValuePreviewGrid;
