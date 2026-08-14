import React, { useEffect, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerPreferencesContent, StoreManagerPreferenceRevision } from '../../store-manager-api';
import { formatPreferenceRevision } from '../../store-manager-command-logic';

interface PreferencesPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Explicit operational preferences (Settings-only). Preferences are versioned
 * workspace configuration — the model has no tool to write them and chat text
 * is never parsed into them. Saving creates a NEW immutable revision.
 */
export function PreferencesPanel({ open, onClose }: PreferencesPanelProps) {
  const [labelsJson, setLabelsJson] = useState('{}');
  const [vendorConvention, setVendorConvention] = useState('unknown');
  const [healthExclusions, setHealthExclusions] = useState('');
  const [reviewScopesJson, setReviewScopesJson] = useState('{}');
  const [active, setActive] = useState<StoreManagerPreferenceRevision | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setNotice(null);
    import('../../store-manager-api')
      .then(({ fetchStoreManagerPreferences }) => fetchStoreManagerPreferences())
      .then((data) => {
        if (cancelled) return;
        setActive(data.active);
        if (data.active) {
          const c = data.active.content;
          setLabelsJson(JSON.stringify(c.product_field_labels ?? {}, null, 2));
          setVendorConvention(c.vendor_identifier_convention ?? 'unknown');
          setHealthExclusions((c.health_exclusions ?? []).join('\n'));
          setReviewScopesJson(JSON.stringify(c.review_scope_defaults ?? {}, null, 2));
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load preferences.');
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const parseJsonObject = (text: string, fallback: Record<string, unknown>): Record<string, unknown> | null => {
    const trimmed = text.trim();
    if (!trimmed) return fallback;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return null;
    } catch {
      return null;
    }
  };

  const save = async () => {
    setError(null);
    setNotice(null);
    const labels = parseJsonObject(labelsJson, {});
    const reviewScopes = parseJsonObject(reviewScopesJson, {});
    if (labels === null) {
      setError('product_field_labels must be a JSON object, e.g. { "ProductField24": "Brand" }.');
      return;
    }
    if (reviewScopes === null) {
      setError('review_scope_defaults must be a JSON object of named scopes.');
      return;
    }
    const content: StoreManagerPreferencesContent = {};
    if (Object.keys(labels as Record<string, unknown>).length > 0) {
      content.product_field_labels = labels as Record<string, string>;
    }
    if (vendorConvention !== 'unknown') content.vendor_identifier_convention = vendorConvention;
    const exclusions = healthExclusions
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (exclusions.length > 0) content.health_exclusions = exclusions;
    if (Object.keys(reviewScopes).length > 0) content.review_scope_defaults = reviewScopes as Record<string, never>;

    setSaving(true);
    try {
      const { saveStoreManagerPreferences } = await import('../../store-manager-api');
      const result = await saveStoreManagerPreferences(content);
      setActive(result.revision);
      setNotice(
        `Saved as revision v${result.revision.version}.` +
          (result.unknownSkus.length > 0 ? ` Unknown SKUs: ${result.unknownSkus.slice(0, 5).join(', ')}.` : ''),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preference save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Store Manager operational preferences"
      style={{
        position: 'absolute',
        right: 24,
        top: 64,
        zIndex: 50,
        width: 420,
        maxHeight: '70vh',
        overflowY: 'auto',
        padding: 16,
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.md,
        boxShadow: '0 12px 32px rgba(0,0,0,0.16)',
        fontFamily: fonts.body,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: colors.ledgerCharcoal }}>Operational preferences</div>
          <div style={{ fontSize: 11, color: colors.mulchBrown }}>{formatPreferenceRevision(active)}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close preferences" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 10px' }}>
          Close
        </button>
      </div>

      <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 10 }}>
        Explicit, versioned workspace configuration. Saved revisions are immutable; edits create a new version. The
        assistant never writes or infers preferences from chat.
      </div>

      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 8 }}>
        ProductField labels
        <textarea
          value={labelsJson}
          onChange={(e) => setLabelsJson(e.target.value)}
          rows={3}
          spellCheck={false}
          style={{ width: '100%', marginTop: 4, padding: 8, fontSize: 12, fontFamily: fonts.mono, borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
        />
      </label>

      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 8 }}>
        Vendor identifier convention
        <select
          value={vendorConvention}
          onChange={(e) => setVendorConvention(e.target.value)}
          style={{ width: '100%', marginTop: 4, padding: 6, fontSize: 12, borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
        >
          <option value="unknown">(none)</option>
          <option value="upc_a">UPC-A</option>
          <option value="upc_e">UPC-E</option>
          <option value="ean_13">EAN-13</option>
          <option value="sku">SKU</option>
        </select>
      </label>

      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 8 }}>
        Health exclusions (one SKU per line)
        <textarea
          value={healthExclusions}
          onChange={(e) => setHealthExclusions(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="SKU-100&#10;SKU-200"
          style={{ width: '100%', marginTop: 4, padding: 8, fontSize: 12, fontFamily: fonts.mono, borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
        />
      </label>

      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 8 }}>
        Review-scope defaults (JSON)
        <textarea
          value={reviewScopesJson}
          onChange={(e) => setReviewScopesJson(e.target.value)}
          rows={3}
          spellCheck={false}
          style={{ width: '100%', marginTop: 4, padding: 8, fontSize: 12, fontFamily: fonts.mono, borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` }}
        />
      </label>

      {error && <div style={{ color: colors.signetBurgundy, fontSize: 12, marginTop: 8 }}>{error}</div>}
      {notice && <div style={{ color: colors.seedlingGreen, fontSize: 12, marginTop: 8 }}>{notice}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={save} disabled={saving} className="btn btn-primary" style={{ fontSize: 12, padding: '6px 16px' }}>
          {saving ? 'Saving…' : 'Save new revision'}
        </button>
      </div>
    </div>
  );
}
