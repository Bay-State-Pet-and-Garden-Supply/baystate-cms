import React, { useState, useEffect } from 'react';
import { getClassificationConfig } from '../../onboarding-api';
import type { AttributeMappingConfig } from '../../../shared/schemas/classification';

export function TypesAttributesView() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getClassificationConfig()
      .then(res => { if (!cancelled) setConfig(res.config); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading classification configuration...</div>;
  }
  if (!config) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
        <p>Classification configuration not available.</p>
        <p style={{ fontSize: 12 }}>Sync products from ShopSite to enable this view.</p>
      </div>
    );
  }

  const { productTypes = [], attributes = [], attributeProfiles = [], attributeMappings = [] } = config;

  const attrNames = new Map(attributes.map((a: any) => [a.id, a.name]));
  const mappingCache = new Map(attributeMappings.map((m: any) => [m.attributeId, m]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {productTypes.length > 0 && (
        <section>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px', color: '#0f172a' }}>
            Product Types ({productTypes.length})
          </h3>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
            Product Types define which attributes are relevant for products of that type.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {productTypes.map((pt: any) => {
              const profile = attributeProfiles.find((ap: any) => ap.id === pt.attributeProfileId);
              return (
                <div key={pt.id} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong style={{ fontSize: 14, color: '#0f172a' }}>{pt.name}</strong>
                      <code style={{ marginLeft: 8, fontSize: 11, color: '#64748b' }}>{pt.id}</code>
                    </div>
                    {profile && <span style={{ fontSize: 11, color: '#059669' }}>{profile.attributes.length} attributes</span>}
                  </div>
                  {pt.description && <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>{pt.description}</p>}
                  {profile && profile.attributes.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                      {profile.attributes.map((pa: any) => (
                        <span key={pa.attributeId} style={{ fontSize: 11, background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: 4 }}>
                          {attrNames.get(pa.attributeId) ?? pa.attributeId}
                          {pa.required && <span style={{ marginLeft: 2, color: '#dc2626' }}>*</span>}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Product Attributes */}
      <section>
        <h3 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px', color: '#0f172a' }}>
          Product Attributes ({attributes.length})
        </h3>
        <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
          Product Attributes are merchandising concepts (e.g. flavor, size, material).
          They are distinct from Catalog Fields (ShopSite XML destinations).
        </p>
        {attributes.length === 0 ? (
          <p style={{ fontSize: 13, color: '#9ca3af' }}>No attributes configured.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={th}>Attribute</th>
                  <th style={th}>ID</th>
                  <th style={th}>Value Mode</th>
                  <th style={th}>Allowed Values</th>
                  <th style={th}>Mapped Catalog Field</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {attributes.map((attr: any) => {
                  const mapping = mappingCache.get(attr.id) as AttributeMappingConfig | undefined;
                  return (
                    <tr key={attr.id}>
                      <td style={td}>
                        <strong>{attr.name}</strong>
                        {attr.isClaim && <span style={{ marginLeft: 4, fontSize: 10, color: '#dc2626' }}>claim</span>}
                      </td>
                      <td style={td}><code style={{ fontSize: 11 }}>{attr.id}</code></td>
                      <td style={td}><ModeBadge mode={attr.valueMode} /></td>
                      <td style={td}>
                        {attr.allowedValues?.length > 0
                          ? <span style={{ fontSize: 11, color: '#475569' }}>{attr.allowedValues.slice(0, 5).join(', ')}{attr.allowedValues.length > 5 ? '…' : ''}</span>
                          : <span style={{ fontSize: 11, color: '#9ca3af' }}>free text</span>}
                      </td>
                      <td style={td}>
                        {mapping ? (
                          <div>
                            <code style={{ fontSize: 11, color: '#059669' }}>{mapping.catalogField}</code>
                            {mapping.isStale && <span style={{ marginLeft: 4, fontSize: 10, color: '#dc2626' }}>stale</span>}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>— unmapped</span>
                        )}
                      </td>
                      <td style={td}>
                        {mapping?.isStale ? (
                          <span style={{ color: '#dc2626', fontSize: 11 }}>stale</span>
                        ) : mapping ? (
                          <span style={{ color: '#059669', fontSize: 11 }}>mapped</span>
                        ) : (
                          <span style={{ color: '#d97706', fontSize: 11 }}>unmapped</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p style={{ fontSize: 12, color: '#9ca3af', borderTop: '1px solid #e5e7eb', paddingTop: 16, margin: 0 }}>
        Editing Product Types, Attributes, and Mappings is available in Onboarding Settings.
      </p>
    </div>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    controlled: { bg: '#dcfce7', fg: '#166534' },
    freeText: { bg: '#fef3c7', fg: '#92400e' },
    measured: { bg: '#e0e7ff', fg: '#3730a3' },
  };
  const c = colors[mode] ?? { bg: '#f1f5f9', fg: '#6b7280' };
  return <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{mode}</span>;
}

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', borderBottom: '2px solid #e5e7eb', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' };
