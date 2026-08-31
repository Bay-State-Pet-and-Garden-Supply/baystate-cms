import React, { useState } from 'react';

export interface VariantCandidateCard {
  variantKey: string;
  title: string;
  sku?: string | null;
  gtin?: string | null;
  price?: string | null;
  available: boolean;
  image?: string | null;
  options?: Array<{ axis: string; value: string }>;
}

export interface ChooseVariantPanelProps {
  resolutionId: string;
  identityMatrixHash: string;
  candidates: VariantCandidateCard[];
  onSelect: (variantKey: string) => Promise<void>;
  onCancel?: () => void;
}

export function ChooseVariantPanel({ resolutionId, identityMatrixHash, candidates, onSelect, onCancel }: ChooseVariantPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await onSelect(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="dialog" aria-label="Choose product variant" data-testid="choose-variant-panel">
      <h3>Choose product variant</h3>
      <p data-testid="resolution-meta">{resolutionId.slice(0, 8)} · {identityMatrixHash.slice(0, 8)}</p>
      <div role="radiogroup" aria-label="Variant options">
        {candidates.map((c) => (
          <label key={c.variantKey} style={{ display: 'block', border: '1px solid #ccc', margin: 8, padding: 8, opacity: c.available ? 1 : 0.5 }}>
            <input
              type="radio"
              name="variant"
              value={c.variantKey}
              checked={selected === c.variantKey}
              onChange={() => setSelected(c.variantKey)}
              disabled={!c.available}
              aria-label={c.title}
            />
            {c.image && <img src={c.image} alt={c.title} width={48} height={48} />}
            <span>{c.title}</span>
            {c.sku && <span> SKU: {c.sku}</span>}
            {c.gtin && <span> GTIN: {c.gtin}</span>}
            {c.price && <span> ${c.price}</span>}
            {!c.available && <span> (unavailable)</span>}
          </label>
        ))}
      </div>
      {error && <div role="alert">{error}</div>}
      <button onClick={submit} disabled={!selected || saving} aria-label="Confirm variant selection">
        {saving ? 'Saving…' : 'Confirm'}
      </button>
      {onCancel && <button onClick={onCancel}>Cancel</button>}
    </div>
  );
}
export default ChooseVariantPanel;
