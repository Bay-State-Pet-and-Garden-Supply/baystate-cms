// fallow-ignore-file unused-exports

import React, { useState, useEffect, useRef } from 'react';
import type { BrandSite } from '../../shared/schemas/onboarding';

interface SearchableBrandSelectorProps {
  brandName: string;
  brandDomain: string;
  onSelect: (brand: string, domain: string) => void;
  onDomainChange: (domain: string) => void;
  cachedBrandSites: BrandSite[];
  catalogBrands: string[];
}

export function SearchableBrandSelector({
  brandName,
  brandDomain,
  onSelect,
  onDomainChange,
  cachedBrandSites,
  catalogBrands,
}: SearchableBrandSelectorProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const suggestionsMap = new Map<string, { brandName: string; domain: string }>();

  if (catalogBrands) {
    catalogBrands.forEach((brand) => {
      if (brand && brand.trim()) {
        suggestionsMap.set(brand.toUpperCase().trim(), { brandName: brand.trim(), domain: '' });
      }
    });
  }

  if (cachedBrandSites) {
    cachedBrandSites.forEach((site) => {
      if (site.brandName && site.brandName.trim()) {
        suggestionsMap.set(site.brandName.toUpperCase().trim(), {
          brandName: site.brandName.trim(),
          domain: site.domain || '',
        });
      }
    });
  }

  const mergedSuggestions = Array.from(suggestionsMap.values());

  const filteredSuggestions = mergedSuggestions.filter((item) =>
    item.brandName.toLowerCase().includes(query.toLowerCase().trim()),
  );

  const exactMatch = mergedSuggestions.find(
    (item) => item.brandName.toLowerCase() === query.toLowerCase().trim(),
  );

  const displayValue = brandName;

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <div style={{ marginBottom: 8 }}>
        <label
          style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 500,
            color: '#4b5563',
            marginBottom: 4,
            textAlign: 'left',
          }}
        >
          Brand Name
        </label>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder="Search or type brand..."
            value={isOpen ? query : displayValue}
            onFocus={() => {
              setQuery(brandName);
              setIsOpen(true);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            style={{
              width: '100%',
              padding: '6px 8px',
              fontSize: 13,
              border: '1px solid #d1d5db',
              borderRadius: 6,
              boxSizing: 'border-box',
            }}
          />
          {isOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: '#fff',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                maxHeight: 180,
                overflowY: 'auto',
                zIndex: 110,
                boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
              }}
            >
              {query.trim() && !exactMatch && (
                <div
                  onClick={() => {
                    onSelect(query.trim(), '');
                    setIsOpen(false);
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#eff6ff')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  style={{
                    padding: '8px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    fontWeight: 600,
                    color: '#2563eb',
                    borderBottom: '1px solid #e5e7eb',
                    textAlign: 'left',
                  }}
                >
                  ✨ Create Brand &quot;{query.trim()}&quot;
                </div>
              )}
              {filteredSuggestions.length === 0 && !query.trim() && (
                <div
                  style={{
                    padding: '8px 10px',
                    fontSize: 12,
                    color: '#9ca3af',
                    fontStyle: 'italic',
                    textAlign: 'left',
                  }}
                >
                  No brands found. Type to create.
                </div>
              )}
              {filteredSuggestions.map((item, idx) => (
                <div
                  key={`${item.brandName}-${idx}`}
                  onClick={() => {
                    onSelect(item.brandName, item.domain);
                    setIsOpen(false);
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#eff6ff')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    transition: 'background-color 0.15s',
                    textAlign: 'left',
                  }}
                >
                  <strong>{item.brandName}</strong> {item.domain ? `(${item.domain})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label
          style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 500,
            color: '#4b5563',
            marginBottom: 4,
            textAlign: 'left',
          }}
        >
          Official Domain
        </label>
        <input
          type="text"
          placeholder="e.g. brandname.com"
          value={brandDomain}
          onChange={(e) => onDomainChange(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 8px',
            fontSize: 13,
            border: '1px solid #d1d5db',
            borderRadius: 6,
            boxSizing: 'border-box',
          }}
        />
      </div>
    </div>
  );
}
