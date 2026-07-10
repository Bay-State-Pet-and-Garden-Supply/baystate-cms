import React, { useState, useEffect } from 'react';
import { getCategoryPageTree, listPages } from '../../api';
import type { CategoryPageNode } from './types';

export function CategoryPagesView() {
  const [tree, setTree] = useState<CategoryPageNode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getCategoryPageTree();
        if (!cancelled) setTree(res.pages);
      } catch {
        // Fallback to flat list
        try {
          const res = await listPages();
          if (!cancelled) {
            const flat: CategoryPageNode[] = res.pages.map(p => ({
              id: p.id,
              name: p.name,
              fileName: p.fileName,
              parentId: p.parentId,
              productCount: 0,
              lastSyncedAt: p.lastSyncedAt,
              children: [],
            }));
            setTree(buildTree(flat));
          }
        } catch {
          if (!cancelled) setTree([]);
        }
      }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading product pages...</div>;
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
        Product Pages are customer-facing store pages. Assignments validated by page ID (per ADR 0005).
        Pages without a stable <code>page_id</code> are flagged as name-only assignments.
      </p>

      {tree.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No product pages found. Sync from ShopSite first.</div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
          {tree.map(node => (
            <PageNode key={node.id} node={node} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}

function PageNode({ node, depth }: { node: CategoryPageNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children && node.children.length > 0;
  const isNameOnly = node.id.startsWith('nameonly-');

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          marginLeft: depth * 24,
          borderRadius: 6,
          cursor: 'pointer',
          background: '#f8fafc',
          border: '1px solid #f1f5f9',
          marginBottom: 4,
        }}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          <span style={{ fontSize: 10, color: '#64748b', width: 16 }}>{expanded ? '▼' : '▶'}</span>
        ) : (
          <span style={{ width: 16 }} />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 14, color: '#0f172a' }}>{node.name}</strong>
            {isNameOnly && <span style={{ fontSize: 10, background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 4 }}>name-only</span>}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
            {node.fileName && <span>📄 {node.fileName} · </span>}
            <span>ID: <code style={{ fontSize: 10 }}>{node.id}</code></span>
            {node.lastSyncedAt && <span> · synced {new Date(node.lastSyncedAt).toLocaleDateString()}</span>}
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#64748b', background: '#f1f5f9', padding: '2px 10px', borderRadius: 12 }}>
          {node.productCount} products
        </div>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map(child => (
            <PageNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function buildTree(pages: CategoryPageNode[]): CategoryPageNode[] {
  const map = new Map<string, CategoryPageNode>();
  const roots: CategoryPageNode[] = [];
  for (const p of pages) map.set(p.id, { ...p, children: [] });
  for (const p of pages) {
    if (p.parentId && map.has(p.parentId)) {
      map.get(p.parentId)!.children.push(map.get(p.id)!);
    } else {
      roots.push(map.get(p.id)!);
    }
  }
  return roots;
}
