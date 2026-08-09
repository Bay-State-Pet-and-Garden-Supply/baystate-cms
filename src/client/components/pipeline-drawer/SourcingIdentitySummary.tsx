import React from 'react';
import type { OnboardingItem } from '../../../shared/schemas/onboarding';

interface SourcingIdentitySummaryProps {
  reviewItem: OnboardingItem;
}

export function SourcingIdentitySummary({ reviewItem }: SourcingIdentitySummaryProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Product Barcode & Identifier Card */}
      <div
        style={{
          padding: 16,
          background: '#f9fafb',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 28,
            marginBottom: 6,
          }}
        >
          📦
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Distributor Sourcing Phase
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 4 }}>
          {reviewItem.name}
        </div>
        <div
          style={{
            marginTop: 8,
            padding: '4px 12px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 16,
            fontSize: 12,
            fontWeight: 700,
            color: '#1e40af',
            fontFamily: 'monospace',
          }}
        >
          UPC / GTIN: {reviewItem.upc}
        </div>
      </div>

      {/* Register / Import Hints */}
      <div
        style={{
          padding: 14,
          background: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
        }}
      >
        <h4 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: '#374151' }}>
          Import Hints & Manifest Metadata
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#6b7280' }}>Register Title:</span>
            <span style={{ fontWeight: 600, color: '#111827', textAlign: 'right', maxWidth: 160 }}>
              {reviewItem.name}
            </span>
          </div>

          {reviewItem.brandHint && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6b7280' }}>Brand Hint:</span>
              <span style={{ fontWeight: 600, color: '#111827' }}>{reviewItem.brandHint}</span>
            </div>
          )}

          {reviewItem.departmentHint && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6b7280' }}>Department Hint:</span>
              <span style={{ fontWeight: 600, color: '#111827' }}>{reviewItem.departmentHint}</span>
            </div>
          )}

          {reviewItem.price && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6b7280' }}>Import Price:</span>
              <span style={{ fontWeight: 600, color: '#111827' }}>${reviewItem.price}</span>
            </div>
          )}

          {reviewItem.quantity !== null && reviewItem.quantity !== undefined && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6b7280' }}>Quantity:</span>
              <span style={{ fontWeight: 600, color: '#111827' }}>{reviewItem.quantity}</span>
            </div>
          )}

          {reviewItem.existingSku && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#6b7280' }}>Existing CMS SKU:</span>
              <span style={{ fontWeight: 600, color: '#7c3aed', fontFamily: 'monospace' }}>
                {reviewItem.existingSku}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Stage Status Callout */}
      <div
        style={{
          padding: 12,
          background: '#f9fafb',
          border: '1px dashed #d1d5db',
          borderRadius: 6,
          fontSize: 12,
          color: '#4b5563',
          lineHeight: 1.4,
        }}
      >
        ℹ️ Product media images will be extracted in stage 3 (<strong>Extraction</strong>) once sourcing evidence and official brand URLs are established.
      </div>
    </div>
  );
}
