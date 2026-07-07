import React, { useState, useEffect } from 'react';
import { listAttributeMappings } from '../../api';
import type { AttributeMappingView } from './types';

export function MappingsView() {
  const [mappings, setMappings] = useState<AttributeMappingView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    listAttributeMappings()
      .then(res => { if (!cancelled) setMappings(res.mappings); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading attribute mappings...</div>;
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
        Attribute Mappings link <strong>Product Attributes</strong> (merchandising concepts) to <strong>Catalog Fields</strong> (ShopSite XML destinations).
        Each mapping includes a serialization format and tracks which Product Types use the attribute.
      </p>

      {mappings.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          <p>No attribute mappings configured.</p>
          <p style={{ fontSize: 12 }}>Configure Product Attributes and Catalog Field mappings in Onboarding Settings.</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={th}>Product Attribute</th>
                <th style={th}>Attribute ID</th>
                <th style={th}>Catalog Field</th>
                <th style={th}>Serialization</th>
                <th style={th}>Used By Product Types</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map(m => (
                <tr key={m.id}>
                  <td style={td}><strong>{m.attributeName}</strong></td>
                  <td style={td}><code style={{ fontSize: 11 }}>{m.attributeId}</code></td>
                  <td style={td}>
                    <code style={{ fontSize: 11, color: '#059669' }}>{m.catalogField}</code>
                  </td>
                  <td style={td}>
                    <code style={{ fontSize: 11 }}>
                      {m.serialization?.format ?? 'direct'}
                      {m.serialization?.separator && ` [sep: ${m.serialization.separator}]`}
                    </code>
                  </td>
                  <td style={td}>
                    {m.usedByProductTypes.length > 0 ? (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {m.usedByProductTypes.map(pt => (
                          <span key={pt} style={{ fontSize: 11, background: '#f1f5f9', padding: '1px 6px', borderRadius: 4, color: '#475569' }}>{pt}</span>
                        ))}
                      </div>
                    ) : (
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    {m.isStale ? (
                      <span style={{ color: '#dc2626', fontSize: 11, fontWeight: 600 }}>stale</span>
                    ) : (
                      <span style={{ color: '#059669', fontSize: 11, fontWeight: 600 }}>active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', borderBottom: '2px solid #e5e7eb', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' };
