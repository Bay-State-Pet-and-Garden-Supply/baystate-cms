import React from 'react';
import type { OnboardingItem, OnboardingSource, BrandSite } from '../../../shared/schemas/onboarding';
import { SearchableBrandSelector } from '../SearchableBrandSelector';

interface DiscoveryStagePanelProps {
  reviewItem: OnboardingItem;
  reviewSources: OnboardingSource[];
  drawerBrandName: string;
  drawerBrandDomain: string;
  setDrawerBrandName: (val: string) => void;
  setDrawerBrandDomain: (val: string) => void;
  cachedBrandSites: BrandSite[];
  catalogBrands?: string[];
  onRefreshBrandSites?: () => void;
  onSelectSource: (sourceId: string, url: string) => Promise<void>;
  manualUrlInput: string;
  setManualUrlInput: (val: string) => void;
  onSetManualUrl: (url: string) => Promise<void>;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  saveError: string | null;
  setSaveStatus: (status: 'idle' | 'saving' | 'saved' | 'error') => void;
  setSaveError: (err: string | null) => void;
  onUpdateReviewItem: () => Promise<void>;
}

export function DiscoveryStagePanel({
  reviewItem,
  reviewSources,
  drawerBrandName,
  drawerBrandDomain,
  setDrawerBrandName,
  setDrawerBrandDomain,
  cachedBrandSites,
  catalogBrands,
  onRefreshBrandSites,
  onSelectSource,
  manualUrlInput,
  setManualUrlInput,
  onSetManualUrl,
  saveStatus,
  saveError,
  setSaveStatus,
  setSaveError,
  onUpdateReviewItem,
}: DiscoveryStagePanelProps) {
  const methodLabel = (method: string): { short: string; long: string; bg: string; text: string } => {
    if (method === 'shopify_variant') {
      return { short: 'Variant', long: 'Variant resolution', bg: '#fef3c7', text: '#92400e' };
    }
    if (method === 'serper_name') {
      return {
        short: 'Name Search',
        long: `Name search ("${reviewItem.expectedName || reviewItem.name}")`,
        bg: '#ede9fe',
        text: '#5b21b6',
      };
    }
    if (method === 'serper_upc') {
      return {
        short: 'UPC Search',
        long: `UPC search ("${reviewItem.upc}")`,
        bg: '#dbeafe',
        text: '#1e40af',
      };
    }
    return { short: 'Other', long: 'Other search', bg: '#f3f4f6', text: '#374151' };
  };

  type SourceGroup = { method: string; items: OnboardingSource[] };
  const groupOrder = ['shopify_variant', 'serper_upc', 'serper_name'];
  const groups: SourceGroup[] = [];
  for (const method of groupOrder) {
    const items = reviewSources.filter((s) => s.sourceMethod === method);
    if (items.length > 0) groups.push({ method, items });
  }
  const knownMethods = new Set(groupOrder);
  const leftovers = reviewSources.filter((s) => !knownMethods.has(s.sourceMethod));
  if (leftovers.length > 0) {
    groups.push({ method: 'other', items: leftovers });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Brand Configuration Editor */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          background: '#f9fafb',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 12,
          flexShrink: 0,
        }}
      >
        <h3 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 10px 0', color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
          🏷️ Brand Configuration
        </h3>
        <SearchableBrandSelector
          brandName={drawerBrandName}
          brandDomain={drawerBrandDomain}
          onSelect={(brand, domain) => {
            setDrawerBrandName(brand);
            if (domain) setDrawerBrandDomain(domain);
          }}
          onDomainChange={(domain) => setDrawerBrandDomain(domain)}
          cachedBrandSites={cachedBrandSites}
          catalogBrands={catalogBrands || []}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={async () => {
              setSaveStatus('saving');
              try {
                const res = await fetch(`/api/onboarding/batches/${reviewItem.batchId}/bulk-brand`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    itemIds: [reviewItem.id],
                    brandHint: drawerBrandName.trim(),
                    brandDomain: drawerBrandDomain.trim(),
                  }),
                });
                if (!res.ok) {
                  const errBody = await res.json().catch(() => ({}));
                  throw new Error(errBody.error || `HTTP ${res.status}`);
                }
                if (onRefreshBrandSites) onRefreshBrandSites();
                await onUpdateReviewItem();
                setSaveStatus('saved');
                setTimeout(() => setSaveStatus('idle'), 2000);
              } catch (err) {
                setSaveStatus('error');
                setSaveError(err instanceof Error ? err.message : String(err));
              }
            }}
            disabled={saveStatus === 'saving'}
            style={{
              padding: '6px 14px',
              minHeight: 36,
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: saveStatus === 'saving' ? 'not-allowed' : 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? '✓ Saved!' : 'Save Brand'}
          </button>
        </div>
        {saveStatus === 'error' && saveError && (
          <div style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>
            Failed to save: {saveError}
          </div>
        )}
      </div>

      {/* Expected Search Query Banner */}
      {reviewItem.expectedName && (
        <div
          style={{
            background: '#f0f9ff',
            border: '1px solid #bae6fd',
            borderRadius: 8,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: '#0369a1' }}>🔍 Searching for:</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#0c4a6e' }}>{reviewItem.expectedName}</span>
          {reviewItem.expectedName !== reviewItem.name && (
            <span style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>
              (consolidated from raw &ldquo;{reviewItem.name}&rdquo;)
            </span>
          )}
        </div>
      )}

      {/* Source Candidates List */}
      {reviewSources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 12, color: '#6b7280', margin: 0, fontWeight: 500 }}>
            Search results — click any candidate to select the official product page URL:
          </p>
          {groups.map((group) => {
            const label = methodLabel(group.method);
            return (
              <div
                key={group.method}
                style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  background: '#fff',
                  overflow: 'hidden',
                }}
              >
                {/* Group Header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: '#f3f4f6',
                    borderBottom: '1px solid #e5e7eb',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: label.bg,
                        color: label.text,
                      }}
                    >
                      {label.short}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                      {label.long}
                    </span>
                  </div>
                  <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>
                    {group.items.length} result{group.items.length === 1 ? '' : 's'}
                  </span>
                </div>

                {/* Group Items */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: '#f9fafb' }}>
                  {group.items.map((src) => {
                    const srcLabel = methodLabel(src.sourceMethod);
                    let isResolved = false;
                    let variantTitle = '';
                    let matchedSignals: string[] = [];
                    if (src.metadataJson) {
                      try {
                        const meta = JSON.parse(src.metadataJson);
                        isResolved = meta.variantResolution?.status === 'resolved';
                        variantTitle = meta.variantResolution?.variantTitle || '';
                        matchedSignals = meta.variantResolution?.matchedSignals || [];
                      } catch {}
                    }

                    return (
                      <div
                        key={src.id}
                        onClick={() => onSelectSource(src.id, src.url)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectSource(src.id, src.url);
                          }
                        }}
                        style={{
                          border: '1px solid',
                          borderRadius: 8,
                          padding: 12,
                          background: src.isSelected ? '#f0fdf4' : '#fff',
                          borderColor: src.isSelected ? '#16a34a' : '#e5e7eb',
                          cursor: 'pointer',
                          textAlign: 'left',
                          boxShadow: src.isSelected ? '0 1px 3px rgba(22, 163, 74, 0.1)' : '0 1px 2px rgba(0,0,0,0.05)',
                          transition: 'all 0.15s ease-in-out',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                          <strong style={{ fontSize: 13, color: src.isSelected ? '#166534' : '#111827' }}>
                            {src.title || src.domain}
                          </strong>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {isResolved && (
                              <span style={{ fontSize: 11, fontWeight: 700, background: '#fef3c7', color: '#92400e', padding: '2px 6px', borderRadius: 4 }}>
                                Variant Resolved
                              </span>
                            )}
                            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '2px 6px', borderRadius: 4, background: srcLabel.bg, color: srcLabel.text }}>
                              {srcLabel.short}
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: src.isSelected ? '#166534' : '#15803d' }}>
                              {src.isSelected ? '✓ Selected' : `${(src.confidence * 100).toFixed(0)}%`}
                            </span>
                          </div>
                        </div>
                        <p style={{ margin: '0 0 6px', fontSize: 12, color: '#6b7280', wordBreak: 'break-all' }}>
                          {src.url}
                        </p>
                        {variantTitle && (
                          <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 600, color: '#4b5563' }}>
                            Variant: <span style={{ color: '#1e3a8a' }}>{variantTitle}</span>
                          </p>
                        )}
                        {matchedSignals.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                            {matchedSignals.map((sig) => (
                              <span key={sig} style={{ fontSize: 11, background: '#e2e8f0', color: '#334155', padding: '2px 6px', borderRadius: 4, fontWeight: 500 }}>
                                {sig}
                              </span>
                            ))}
                          </div>
                        )}
                        {src.snippet && (
                          <p style={{ margin: 0, fontSize: 12, color: '#4b5563', fontStyle: 'italic', lineHeight: 1.4 }}>
                            &ldquo;{src.snippet.slice(0, 180)}{src.snippet.length > 180 ? '...' : ''}&rdquo;
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Manual URL Input Block */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Manual Product Page URL</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={manualUrlInput}
            onChange={(e) => setManualUrlInput(e.target.value)}
            placeholder="Paste product page URL manually (e.g. https://brand.com/product)"
            style={{ flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, minHeight: 36 }}
          />
          <button
            type="button"
            onClick={() => {
              if (manualUrlInput.trim()) onSetManualUrl(manualUrlInput.trim());
            }}
            style={{ padding: '8px 16px', minHeight: 36, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
          >
            Set URL
          </button>
        </div>
      </div>
    </div>
  );
}
