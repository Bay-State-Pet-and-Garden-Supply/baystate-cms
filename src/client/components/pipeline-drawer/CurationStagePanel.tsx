import React from 'react';
import type { ClassificationProposal, CurationTargetConfig } from '../../../shared/schemas/classification';
import type { BrandSite } from '../../../shared/schemas/onboarding';
import { pageNameFromPageValue } from '../../../shared/proposal-display';
import { SearchableBrandSelector } from '../SearchableBrandSelector';

interface CurationStagePanelProps {
  curatedTitle: string;
  titleSource?: string | null;
  curatedAt?: string | null;
  curationMethod?: string | null;
  curatedWeight: string;
  brandName?: string | null;
  onUpdateBrand?: (brandName: string) => void;
  cachedBrandSites?: BrandSite[];
  catalogBrands?: string[];
  suggestedProductType?: string | null;
  classificationProposals: ClassificationProposal[];
  proposalControlsDisabled: boolean;
  storePages: string[];
  suggestedPages: string[];
  pageSearchQuery: string;
  setPageSearchQuery: (query: string) => void;
  onUpdateTitle: (title: string) => void;
  onUpdateWeight: (weight: string) => void;
  onTogglePage: (pageName: string, isAssigned: boolean) => void;
  onRemovePage: (pageName: string) => void;
  fieldTargetForProposal: (proposal: ClassificationProposal) => { target: CurationTargetConfig | null; values: string[]; label: string };
  productTypeOptions: () => { label: string; value: string }[];
  getEffectiveProposalValue: (proposal: ClassificationProposal) => any;
  getEffectiveProposalTargetId: (proposal: ClassificationProposal) => string | null;
  getEffectiveProductTypeId: (proposal: ClassificationProposal) => string | null;
  withReviewedProposalValue: (proposal: ClassificationProposal, reviewedValue: unknown) => ClassificationProposal;
  withReviewedProductTypeId: (proposal: ClassificationProposal, reviewedProductTypeId: string | null) => ClassificationProposal;
  updateProposal: (id: string, updates: Partial<ClassificationProposal>) => void;
}

export function CurationStagePanel({
  curatedTitle,
  titleSource,
  curatedAt,
  curationMethod,
  curatedWeight,
  brandName,
  onUpdateBrand,
  cachedBrandSites = [],
  catalogBrands = [],
  suggestedProductType,
  classificationProposals,
  proposalControlsDisabled,
  storePages,
  suggestedPages,
  pageSearchQuery,
  setPageSearchQuery,
  onUpdateTitle,
  onUpdateWeight,
  onTogglePage,
  onRemovePage,
  fieldTargetForProposal,
  productTypeOptions,
  getEffectiveProposalValue,
  getEffectiveProposalTargetId,
  getEffectiveProductTypeId,
  withReviewedProposalValue,
  withReviewedProductTypeId,
  updateProposal,
}: CurationStagePanelProps) {
  const isBrandMissing = !brandName || !brandName.trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Brand (ProductField16) Input */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 700, color: isBrandMissing ? '#dc2626' : '#374151', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>🏷️ Brand (ProductField16)</span>
          {isBrandMissing && (
            <span style={{ fontSize: 11, fontWeight: 600, color: '#dc2626', textTransform: 'none', background: '#fee2e2', padding: '2px 8px', borderRadius: 4 }}>
              Mandatory Field Missing
            </span>
          )}
        </label>
        {onUpdateBrand ? (
          <SearchableBrandSelector
            brandName={brandName || ''}
            brandDomain=""
            onSelect={(brand) => onUpdateBrand(brand)}
            onDomainChange={() => {}}
            cachedBrandSites={cachedBrandSites}
            catalogBrands={catalogBrands}
          />
        ) : (
          <div style={{ fontSize: 13, fontWeight: 600, color: isBrandMissing ? '#991b1b' : '#111827', padding: '8px 12px', background: isBrandMissing ? '#fef2f2' : '#f9fafb', borderRadius: 6, border: isBrandMissing ? '1px solid #fca5a5' : '1px solid #e5e7eb' }}>
            {brandName || '(No brand specified)'}
          </div>
        )}
      </div>

      {/* Curated Title Input */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          ✏ Store-Ready Title
        </label>
        <input
          type="text"
          value={curatedTitle}
          onChange={(e) => onUpdateTitle(e.target.value)}
          placeholder="Enter clean store-ready product title"
          style={{
            width: '100%',
            padding: '10px 12px',
            border: '1.5px solid #c084fc',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            background: '#faf5ff',
            boxSizing: 'border-box',
            minHeight: 40,
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: '#6b7280' }}>
          <span>Source: <strong>{titleSource || 'auto'}</strong></span>
          {curatedAt && <span>· Curated {new Date(curatedAt).toLocaleString()}</span>}
          {curationMethod && <span>· Method: {curationMethod}</span>}
        </div>
      </div>

      {/* Weight Input */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          ⚖️ Product Weight
        </label>
        <input
          type="text"
          value={curatedWeight}
          onChange={(e) => onUpdateWeight(e.target.value)}
          placeholder="e.g. 15 lbs, 500g"
          style={{
            width: '100%',
            padding: '10px 12px',
            border: '1px solid #d1d5db',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            background: '#fff',
            boxSizing: 'border-box',
            minHeight: 40,
          }}
        />
      </div>

      {/* Suggested Product Type */}
      {suggestedProductType && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#4b5563' }}>Suggested Product Type</label>
          <div style={{ display: 'inline-block', fontSize: 13, fontWeight: 600, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, padding: '4px 12px' }}>
            {suggestedProductType}
          </div>
        </div>
      )}

      {/* AI Proposals Section */}
      {classificationProposals.filter((p) => p.targetId !== 'product_draft_projection').length > 0 && (
        <div style={{ padding: 14, background: '#f5f3ff', borderRadius: 10, border: '1px solid #ddd6fe' }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 10px', color: '#7c3aed', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            🤖 AI Proposals & Classification
          </h3>
          {classificationProposals
            .filter((p) => p.targetId !== 'product_draft_projection')
            .map((p) => {
              const tl: Record<string, string> = {
                primary_product_type: 'Product Type',
                category_page: 'Page',
                field_assignment: 'Product Field',
                configuration_gap: 'Gap',
                reviewable_abstention: 'Needs Review',
              };
              const fieldMeta = fieldTargetForProposal(p);
              const typeOptions = productTypeOptions();
              const effectiveValue = getEffectiveProposalValue(p);
              const proposedValues = Array.isArray(effectiveValue)
                ? effectiveValue.map(String)
                : effectiveValue != null && typeof effectiveValue !== 'object'
                ? [String(effectiveValue)]
                : [];
              const displayTarget =
                p.proposalType === 'field_assignment'
                  ? fieldMeta.label
                  : p.proposalType === 'primary_product_type'
                  ? 'Product Type'
                  : pageNameFromPageValue(effectiveValue, getEffectiveProposalTargetId(p)) ?? '';

              return (
                <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid #ede9fe', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span>
                      <strong style={{ color: '#5b21b6', fontSize: 13 }}>{tl[p.proposalType] || p.proposalType}</strong>
                      {displayTarget && <span style={{ marginLeft: 6, fontWeight: 600, color: '#374151' }}>{displayTarget}</span>}
                    </span>
                    <span style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, background: '#fff', padding: '2px 6px', borderRadius: 4, border: '1px solid #e5e7eb' }}>
                      {Math.round(p.confidence * 100)}% confidence
                    </span>
                  </div>

                  {p.proposalType === 'field_assignment' && fieldMeta.values.length > 0 && (
                    fieldMeta.target?.selectionMode === 'multiple' ? (
                      <select
                        multiple
                        disabled={proposalControlsDisabled}
                        value={proposedValues}
                        onChange={(e) => {
                          const values = Array.from(e.currentTarget.selectedOptions).map((option) => option.value);
                          const reviewed = withReviewedProposalValue(p, values);
                          updateProposal(p.id, {
                            revisedValue: reviewed.revisedValue,
                            hasRevisedValue: reviewed.hasRevisedValue,
                            status: values.length > 0 ? 'accepted' : p.status,
                          });
                        }}
                        style={{ width: '100%', minHeight: 90, border: '1px solid #c4b5fd', borderRadius: 6, padding: 6, fontSize: 12, background: '#fff' }}
                      >
                        {fieldMeta.values.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    ) : (
                      <select
                        disabled={proposalControlsDisabled}
                        value={proposedValues[0] ?? ''}
                        onChange={(e) => {
                          const reviewed = withReviewedProposalValue(p, e.target.value);
                          updateProposal(p.id, {
                            revisedValue: reviewed.revisedValue,
                            hasRevisedValue: reviewed.hasRevisedValue,
                            status: e.target.value ? 'accepted' : p.status,
                          });
                        }}
                        style={{ width: '100%', border: '1px solid #c4b5fd', borderRadius: 6, padding: 8, fontSize: 12, background: '#fff', minHeight: 36 }}
                      >
                        <option value="">Choose a value…</option>
                        {fieldMeta.values.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    )
                  )}

                  {p.proposalType === 'primary_product_type' && typeOptions.length > 0 && (
                    <select
                      disabled={proposalControlsDisabled}
                      value={getEffectiveProductTypeId(p) ?? ''}
                      onChange={(e) => {
                        const productTypeId = e.target.value || null;
                        const reviewed = withReviewedProductTypeId(p, productTypeId);
                        updateProposal(p.id, {
                          revisedValue: reviewed.revisedValue,
                          hasRevisedValue: reviewed.hasRevisedValue,
                          revisedTargetId: reviewed.revisedTargetId,
                          hasRevisedTargetId: reviewed.hasRevisedTargetId,
                          status: productTypeId ? 'accepted' : 'deferred',
                        });
                      }}
                      style={{ width: '100%', border: '1px solid #c4b5fd', borderRadius: 6, padding: 8, fontSize: 12, background: '#fff', minHeight: 36 }}
                    >
                      <option value="">Choose a product type…</option>
                      {typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  )}

                  {p.proposalType === 'field_assignment' && fieldMeta.values.length === 0 && (
                    <input
                      type="text"
                      disabled={proposalControlsDisabled}
                      value={proposedValues.join(', ')}
                      onChange={(e) => {
                        const reviewed = withReviewedProposalValue(p, e.target.value);
                        updateProposal(p.id, {
                          revisedValue: reviewed.revisedValue,
                          hasRevisedValue: reviewed.hasRevisedValue,
                          status: e.target.value ? 'accepted' : p.status,
                        });
                      }}
                      placeholder="Enter reviewed value"
                      style={{ width: '100%', border: '1px solid #c4b5fd', borderRadius: 6, padding: 8, fontSize: 12, boxSizing: 'border-box', minHeight: 36 }}
                    />
                  )}
                </div>
              );
            })}
        </div>
      )}

      {/* Product Pages Section */}
      {storePages.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, margin: 0, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            📄 ShopSite Product Pages
          </h3>

          {/* Selected Pages Chips */}
          {suggestedPages && suggestedPages.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {suggestedPages.map((pageName) => (
                <span
                  key={pageName}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: '#f3e8ff',
                    border: '1px solid #d8b4fe',
                    color: '#6b21a8',
                    padding: '4px 10px',
                    borderRadius: 16,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {pageName}
                  <button
                    type="button"
                    onClick={() => onRemovePage(pageName)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#a855f7',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: 12,
                      fontWeight: 'bold',
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Page Search Input */}
          <input
            type="text"
            placeholder="Search pages..."
            value={pageSearchQuery}
            onChange={(e) => setPageSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: 13,
              boxSizing: 'border-box',
              minHeight: 36,
            }}
          />

          {/* Page List Checklist */}
          <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #d1d5db', borderRadius: 6, padding: 8, background: '#fff' }}>
            {storePages
              .filter((pageName) => pageName.toLowerCase().includes(pageSearchQuery.toLowerCase()))
              .map((pageName) => {
                const isAssigned = suggestedPages?.includes(pageName) ?? false;
                return (
                  <label key={pageName} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 12, cursor: 'pointer', borderRadius: 4 }}>
                    <input
                      type="checkbox"
                      checked={isAssigned}
                      onChange={(e) => onTogglePage(pageName, e.target.checked)}
                      style={{ width: 16, height: 16 }}
                    />
                    <span style={{ fontWeight: isAssigned ? 600 : 400, color: isAssigned ? '#6b21a8' : '#374151' }}>
                      {pageName}
                    </span>
                  </label>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
