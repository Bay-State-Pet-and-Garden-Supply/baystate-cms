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
}

export function ValuePreviewGrid({ samples, candidates, values, fieldLabel }: ValuePreviewGridProps) {
  if (candidates.length === 0 || samples.length === 0) return null;

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
      <p className="mt-1 text-xs opacity-60">instant preview — not evidence</p>
    </div>
  );
}

export default ValuePreviewGrid;
