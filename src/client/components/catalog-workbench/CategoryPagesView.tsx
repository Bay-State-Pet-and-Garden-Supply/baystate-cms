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
      <p style={{ fontSize: 13, color: '#525252', marginBottom: 16 }}>
        Product Pages structure customer-facing store navigation. Products linked to pages without a recorded ShopSite ID are marked as <strong>Name Match Only</strong> until synced.
      </p>

      {tree.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#737373', background: '#fff', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 8 }}>No product pages found. Sync from ShopSite first.</div>
      ) : (
        <div style={{ background: 'var(--color-white-surface, #fff)', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 'var(--rounded-lg, 8px)', padding: 16, boxShadow: 'var(--shadow-sm)' }}>
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
          background: 'var(--color-feed-bag-cream, #FAF9F2)',
          border: '1px solid var(--color-card-border, #E8E6D9)',
          marginBottom: 6,
        }}
        onClick={() => hasChildren && setExpanded(!expanded)}
        tabIndex={0}
        role="button"
        onKeyDown={e => e.key === 'Enter' && hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          <span style={{ fontSize: 10, color: 'var(--color-uniform-green, #14532D)', width: 16 }}>{expanded ? '▼' : '▶'}</span>
        ) : (
          <span style={{ width: 16 }} />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 14, color: 'var(--color-uniform-green, #14532D)' }}>{node.name}</strong>
            {isNameOnly && <span style={{ fontSize: 10, background: 'var(--color-warning-bg, #fef3c7)', color: 'var(--color-warning-text, #78350f)', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>Name Match Only</span>}
          </div>
          <div style={{ fontSize: 11, color: '#666666', marginTop: 2 }}>
            {node.fileName && <span>📄 {node.fileName} · </span>}
            <span>ID: <code style={{ fontSize: 10, color: 'var(--color-seedling-green, #16844D)' }}>{node.id}</code></span>
            {node.lastSyncedAt && <span> · synced {new Date(node.lastSyncedAt).toLocaleDateString()}</span>}
          </div>
        </div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-uniform-green, #14532D)', background: 'rgba(20, 83, 45, 0.08)', padding: '3px 10px', borderRadius: 12 }}>
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
