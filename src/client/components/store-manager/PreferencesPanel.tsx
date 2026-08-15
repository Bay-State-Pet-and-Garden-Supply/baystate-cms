import React, { useEffect, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { StoreManagerPreferencesContent, StoreManagerPreferenceRevision } from '../../store-manager-api';
import { formatPreferenceRevision } from '../../store-manager-command-logic';

interface PreferencesPanelProps {
  open: boolean;
  onClose: () => void;
  variant?: 'modal' | 'inline';
}

/**
 * Explicit operational preferences (Settings-only). Preferences are versioned
 * workspace configuration — the model has no tool to write them and chat text
 * is never parsed into them. Saving creates a NEW immutable revision.
 */
export function PreferencesPanel({ open, onClose, variant = 'inline' }: PreferencesPanelProps) {
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

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

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

  const isInline = variant === 'inline';

  const cardContent = (
    <div
      role={isInline ? 'region' : 'dialog'}
      aria-modal={isInline ? undefined : true}
      aria-label="Store Manager operational preferences"
      onClick={(e) => e.stopPropagation()}
      style={{
        width: '100%',
        maxWidth: isInline ? 800 : 480,
        maxHeight: isInline ? undefined : '85vh',
        overflowY: 'auto',
        padding: 24,
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        boxShadow: isInline ? '0 1px 3px rgba(33,20,20,0.04)' : '0 20px 25px -5px rgba(0, 0, 0, 0.15)',
        fontFamily: fonts.body,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal }}>Operational preferences</div>
          <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 2 }}>{formatPreferenceRevision(active)}</div>
        </div>
        {isInline ? null : (
          <button type="button" onClick={onClose} aria-label="Close preferences" className="btn btn-outline" style={{ fontSize: 12, padding: '4px 12px' }}>
            ✕ Close
          </button>
        )}
      </div>

      <div style={{ fontSize: 12, color: colors.mulchBrown, marginBottom: 12 }}>
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
          style={{ width: '100%', marginTop: 4, padding: 8, fontSize: 12, fontFamily: fonts.mono, borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, boxSizing: 'border-box' }}
        />
      </label>

      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 12 }}>
        Vendor identifier convention
        <select
          value={vendorConvention}
          onChange={(e) => setVendorConvention(e.target.value)}
          style={{ width: '100%', marginTop: 4, padding: 6, fontSize: 12, borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, boxSizing: 'border-box' }}
        >
          <option value="unknown">(none)</option>
          <option value="upc_a">UPC-A</option>
          <option value="upc_e">UPC-E</option>
          <option value="ean_13">EAN-13</option>
          <option value="sku">SKU</option>
        </select>
      </label>

      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 12 }}>
        Health exclusions (one SKU per line)
        <textarea
          value={healthExclusions}
          onChange={(e) => setHealthExclusions(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="SKU-100&#10;SKU-200"
          style={{ width: '100%', marginTop: 4, padding: 8, fontSize: 12, fontFamily: fonts.mono, borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, boxSizing: 'border-box' }}
        />
      </label>

      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 12 }}>
        Review-scope defaults (JSON)
        <textarea
          value={reviewScopesJson}
          onChange={(e) => setReviewScopesJson(e.target.value)}
          rows={3}
          spellCheck={false}
          style={{ width: '100%', marginTop: 4, padding: 8, fontSize: 12, fontFamily: fonts.mono, borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}`, boxSizing: 'border-box' }}
        />
      </label>

      {error && <div style={{ color: colors.signetBurgundy, fontSize: 12, marginTop: 10 }}>{error}</div>}
      {notice && <div style={{ color: colors.seedlingGreen, fontSize: 12, marginTop: 10 }}>{notice}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button type="button" onClick={save} disabled={saving} className="btn btn-primary" style={{ fontSize: 12, padding: '8px 18px' }}>
          {saving ? 'Saving…' : 'Save new revision'}
        </button>
      </div>
    </div>
  );

  if (isInline) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', background: colors.feedBagCream }}>
        {cardContent}
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(33, 20, 20, 0.45)',
        backdropFilter: 'blur(2px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      {cardContent}
    </div>
  );
}
