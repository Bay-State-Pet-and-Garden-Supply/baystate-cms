import React, { useState, useEffect } from 'react';
import { listProducts, getConnection, bulkImportProducts, getProductFacets, type ProductIndexItem } from '../../api';

const STYLE_RULES = `
  .catalog-layout {
    display: flex;
    gap: 28px;
    align-items: flex-start;
    margin-top: 24px;
  }
  .catalog-sidebar {
    width: 280px;
    flex-shrink: 0;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
    position: sticky;
    top: 24px;
  }
  .catalog-main {
    flex-grow: 1;
    min-width: 0;
  }
  .filter-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .filter-title {
    font-size: 11px;
    font-weight: 700;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0;
  }
  .price-range-inputs {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .price-input {
    width: 100%;
    padding: 8px 10px;
    font-size: 13px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    outline: none;
    transition: all 0.15s ease;
  }
  .price-input:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
  }
  .active-filters-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 20px;
    align-items: center;
    background: #f8fafc;
    padding: 10px 14px;
    border-radius: 10px;
    border: 1px solid #e2e8f0;
  }
  .filter-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #eff6ff;
    color: #1d4ed8;
    border: 1px solid #bfdbfe;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .filter-badge:hover {
    background: #dbeafe;
    border-color: #93c5fd;
  }
  .filter-badge-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: rgba(29, 78, 216, 0.1);
    color: #1d4ed8;
    font-size: 10px;
    font-weight: 700;
  }
  .filter-badge:hover .filter-badge-close {
    background: rgba(29, 78, 216, 0.2);
  }
  .clear-all-btn {
    background: none;
    border: none;
    color: #ef4444;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    transition: background 0.15s;
  }
  .clear-all-btn:hover {
    background: #fef2f2;
  }
  .sidebar-input {
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    outline: none;
    transition: all 0.15s ease;
  }
  .sidebar-input:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
  }
  .sidebar-select {
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    outline: none;
    background-color: #ffffff;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .sidebar-select:focus {
    border-color: #2563eb;
  }
  .catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 24px;
    margin-top: 24px;
  }
  .product-card {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    cursor: pointer;
    position: relative;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  .product-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 12px 20px -8px rgba(0, 0, 0, 0.12), 0 4px 6px -2px rgba(0, 0, 0, 0.04);
    border-color: #cbd5e1;
  }
  .card-image-container {
    height: 180px;
    background: #f8fafc;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-bottom: 1px solid #f1f5f9;
  }
  .card-image {
    max-width: 90%;
    max-height: 90%;
    object-fit: contain;
    transition: transform 0.3s ease;
  }
  .product-card:hover .card-image {
    transform: scale(1.05);
  }
  .card-image-fallback {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #94a3b8;
    padding: 16px;
    text-align: center;
  }
  .card-content {
    padding: 16px;
    display: flex;
    flex-direction: column;
    flex-grow: 1;
  }
  .card-sku {
    font-family: monospace;
    font-size: 11px;
    color: #64748b;
    margin-bottom: 4px;
    letter-spacing: 0.5px;
  }
  .card-title {
    font-size: 14px;
    font-weight: 600;
    color: #1e293b;
    line-height: 1.4;
    margin: 0 0 12px 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    height: 38px;
  }
  .card-footer {
    margin-top: auto;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 12px;
    border-top: 1px dashed #f1f5f9;
  }
  .card-price {
    font-size: 16px;
    font-weight: 700;
    color: #0f172a;
  }
  .card-badge-container {
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 10;
  }
  .card-badge-right-container {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 10;
  }
  .card-badge {
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 10px;
    font-weight: 600;
    color: #ffffff;
    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
  }
  .view-toggle-container {
    display: flex;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    overflow: hidden;
    background: #f1f5f9;
    padding: 2px;
  }
  .view-toggle-btn {
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #64748b;
    display: flex;
    align-items: center;
    gap: 6px;
    border-radius: 6px;
    transition: all 0.15s ease;
  }
  .view-toggle-btn.active {
    background: #ffffff;
    color: #2563eb;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  .settings-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    width: 260px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
    padding: 12px;
    z-index: 50;
  }
  .media-url-input {
    flex-grow: 1;
    padding: 8px 12px;
    font-size: 13px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    outline: none;
    transition: all 0.15s ease;
  }
  .media-url-input:focus {
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
  }
  .cog-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    background: #ffffff;
    color: #475569;
    cursor: pointer;
    transition: all 0.15s;
  }
  .cog-btn:hover {
    background: #f8fafc;
    border-color: #94a3b8;
    color: #0f172a;
  }
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(15, 23, 42, 0.6);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal-container {
    background: #ffffff;
    border-radius: 16px;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    width: 90%;
    max-width: 650px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: modalAppear 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes modalAppear {
    from { transform: scale(0.95); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }
  .modal-header {
    padding: 20px 24px;
    border-bottom: 1px solid #f1f5f9;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .modal-header h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: #0f172a;
  }
  .modal-close-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: #64748b;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: 6px;
    transition: background 0.15s;
  }
  .modal-close-btn:hover {
    background: #f1f5f9;
    color: #0f172a;
  }
  .modal-body {
    padding: 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .modal-footer {
    padding: 16px 24px;
    border-top: 1px solid #f1f5f9;
    background: #f8fafc;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }
  .textarea-import {
    width: 100%;
    height: 120px;
    padding: 12px;
    font-family: monospace;
    font-size: 13px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    resize: vertical;
    outline: none;
    transition: border-color 0.15s;
  }
  .textarea-import:focus {
    border-color: #2563eb;
  }
  .preview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-top: 8px;
  }
  .preview-table th {
    background: #f8fafc;
    color: #64748b;
    font-weight: 600;
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid #e2e8f0;
  }
  .preview-table td {
    padding: 8px 12px;
    border-bottom: 1px solid #f1f5f9;
    color: #334155;
  }
  .preview-container {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    max-height: 200px;
    overflow-y: auto;
  }
  .import-file-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: #f8fafc;
    border: 1px dashed #cbd5e1;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    color: #475569;
    transition: all 0.15s;
  }
  .import-file-label:hover {
    background: #f1f5f9;
    border-color: #94a3b8;
  }
`;

function decodeHtmlEntities(text: string | null | undefined): string {
  if (!text) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = text;
  return txt.value;
}

function ProductImage({ src, alt, title }: { src: string; alt: string; title: string }) {
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
  }, [src]);

  if (error || !src) {
    return (
      <div className="card-image-fallback">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 8, color: '#94a3b8' }}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>No Image</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      title={title}
      className="card-image"
      onError={() => setError(true)}
    />
  );
}

function parseCsvOrTsv(text: string): { sku: string; name: string; price: string | null }[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length === 0) return [];
  
  const firstLine = lines[0];
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const separator = tabCount > commaCount ? '\t' : ',';
  
  const parseRow = (rowText: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < rowText.length; i++) {
      const char = rowText[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === separator && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  
  let skuIdx = headers.findIndex(h => h.includes('sku'));
  let nameIdx = headers.findIndex(h => h.includes('name') || h.includes('title') || h.includes('register') || h.includes('system'));
  let priceIdx = headers.findIndex(h => h.includes('price') || h.includes('cost') || h.includes('amount'));
  
  const startLineIdx = (skuIdx !== -1 || nameIdx !== -1) ? 1 : 0;
  if (skuIdx === -1) skuIdx = 0;
  if (nameIdx === -1) nameIdx = 1;
  if (priceIdx === -1) priceIdx = 2;

  const products: { sku: string; name: string; price: string | null }[] = [];
  
  for (let i = startLineIdx; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    if (cols.length <= Math.max(skuIdx, nameIdx)) continue;
    
    const sku = cols[skuIdx];
    const name = cols[nameIdx];
    
    let price: string | null = null;
    if (priceIdx !== -1 && cols.length > priceIdx) {
      const cleaned = cols[priceIdx].replace(/[$\s,]/g, '');
      if (cleaned && !isNaN(Number(cleaned))) {
        price = cleaned;
      }
    }
    
    if (sku && name) {
      products.push({ sku, name, price });
    }
  }
  
  return products;
}

interface ProductsViewProps {
  onSelectProduct: (sku: string) => void;
  onShowChangeSets: () => void;
}

export function ProductsView({ onSelectProduct, onShowChangeSets }: ProductsViewProps) {
  const [products, setProducts] = useState<ProductIndexItem[]>([]);
  const [search, setSearch] = useState('');
  
  // Advanced Filter States
  const [activeSearch, setActiveSearch] = useState('');
  const [status, setStatus] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [inventoryStatus, setInventoryStatus] = useState('');
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({});
  const [facets, setFacets] = useState<Record<string, { label: string; values: string[] }>>({});
  const [facetsLoading, setFacetsLoading] = useState(false);

  // Bulk import states
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<Array<{ sku: string; name: string; price: string | null }>>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any | null>(null);

  // Parse CSV/TSV data
  useEffect(() => {
    if (!importText) {
      setImportPreview([]);
      return;
    }
    try {
      const parsed = parseCsvOrTsv(importText);
      setImportPreview(parsed);
    } catch (e) {
      console.error(e);
      setImportPreview([]);
    }
  }, [importText]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        setImportText(text);
      }
    };
    reader.readAsText(file);
  };

  const handleExecuteImport = async () => {
    if (importPreview.length === 0) return;
    setImporting(true);
    setError('');
    try {
      const res = await bulkImportProducts(importPreview);
      setImportResult(res);
      fetchProducts(1, status, activeSearch, pageSize, minPrice, maxPrice, inventoryStatus, customFilters);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const resetImport = () => {
    setImportText('');
    setImportPreview([]);
    setImportResult(null);
    setShowImportModal(false);
    setError('');
  };

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // View settings
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    return (localStorage.getItem('shopsite_catalog_view_mode') as 'grid' | 'list') || 'grid';
  });
  const [mediaUrl, setMediaUrl] = useState(() => {
    return localStorage.getItem('shopsite_media_url') || '';
  });
  const [showSettings, setShowSettings] = useState(false);

  // Pagination states
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);

  // Load Facets on Mount
  useEffect(() => {
    setFacetsLoading(true);
    getProductFacets()
      .then(res => {
        setFacets(res.facets);
      })
      .catch(err => {
        console.error('Failed to load facets:', err);
      })
      .finally(() => {
        setFacetsLoading(false);
      });
  }, []);

  const fetchProducts = async (
    currentPage: number,
    currentStatus: string,
    currentSearch: string,
    limit: number,
    minP: string,
    maxP: string,
    invStatus: string,
    cFilters: Record<string, string>
  ) => {
    setLoading(true);
    setError('');
    try {
      const offset = (currentPage - 1) * limit;
      const res = await listProducts(
        currentStatus || undefined,
        currentSearch || undefined,
        limit,
        offset,
        minP || undefined,
        maxP || undefined,
        invStatus || undefined,
        cFilters
      );
      setProducts(res.products);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!localStorage.getItem('shopsite_media_url')) {
      getConnection().then(res => {
        if (res.connection && res.connection.cgiBaseUrl) {
          try {
            const url = new URL(res.connection.cgiBaseUrl);
            const derivedMediaUrl = `${url.protocol}//${url.host}/media/`;
            setMediaUrl(derivedMediaUrl);
            localStorage.setItem('shopsite_media_url', derivedMediaUrl);
          } catch (e) {
            console.error('Failed to parse cgiBaseUrl:', e);
          }
        }
      }).catch(err => {
        console.error('Failed to load connection settings:', err);
      });
    }
  }, []);

  useEffect(() => {
    fetchProducts(page, status, activeSearch, pageSize, minPrice, maxPrice, inventoryStatus, customFilters);
  }, [page, status, activeSearch, pageSize, minPrice, maxPrice, inventoryStatus, customFilters]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveSearch(search);
    setPage(1);
  };

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    setPage(1);
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  };

  const handlePrevPage = () => {
    if (page > 1) {
      setPage(p => p - 1);
    }
  };

  const handleNextPage = () => {
    if (page < Math.ceil(total / pageSize)) {
      setPage(p => p + 1);
    }
  };

  const handleViewModeChange = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    localStorage.setItem('shopsite_catalog_view_mode', mode);
  };

  const handleMediaUrlChange = (url: string) => {
    setMediaUrl(url);
    localStorage.setItem('shopsite_media_url', url);
  };

  const handleResetAll = () => {
    setSearch('');
    setActiveSearch('');
    setStatus('');
    setMinPrice('');
    setMaxPrice('');
    setInventoryStatus('');
    setCustomFilters({});
    setPage(1);
  };

  const renderActiveFilterBadges = () => {
    const badges: React.ReactNode[] = [];

    if (activeSearch) {
      badges.push(
        <div key="search" className="filter-badge" onClick={() => { setSearch(''); setActiveSearch(''); setPage(1); }}>
          Search: "{activeSearch}"
          <span className="filter-badge-close">×</span>
        </div>
      );
    }
    if (status) {
      let label = status;
      if (status === 'enabled') label = 'Enabled';
      if (status === 'disabled') label = 'Disabled';
      if (status === 'active') label = 'Active';
      if (status === 'draft') label = 'Draft';
      if (status === 'archived') label = 'Archived';
      badges.push(
        <div key="status" className="filter-badge" onClick={() => { setStatus(''); setPage(1); }}>
          Status: {label}
          <span className="filter-badge-close">×</span>
        </div>
      );
    }
    if (minPrice || maxPrice) {
      badges.push(
        <div key="price" className="filter-badge" onClick={() => { setMinPrice(''); setMaxPrice(''); setPage(1); }}>
          Price: ${minPrice || '0'} – ${maxPrice || '∞'}
          <span className="filter-badge-close">×</span>
        </div>
      );
    }
    if (inventoryStatus) {
      let label = 'All';
      if (inventoryStatus === 'in_stock') label = 'In Stock';
      if (inventoryStatus === 'out_of_stock') label = 'Out of Stock';
      if (inventoryStatus === 'low_stock') label = 'Low Stock';
      badges.push(
        <div key="inventory" className="filter-badge" onClick={() => { setInventoryStatus(''); setPage(1); }}>
          Stock: {label}
          <span className="filter-badge-close">×</span>
        </div>
      );
    }
    Object.entries(customFilters).forEach(([field, val]) => {
      const fieldLabel = facets[field]?.label || field;
      badges.push(
        <div key={field} className="filter-badge" onClick={() => {
          setCustomFilters(prev => {
            const next = { ...prev };
            delete next[field];
            return next;
          });
          setPage(1);
        }}>
          {fieldLabel}: {val}
          <span className="filter-badge-close">×</span>
        </div>
      );
    });

    if (badges.length === 0) return null;

    return (
      <div className="active-filters-bar">
        <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600, marginRight: 8 }}>Active Filters:</span>
        {badges}
        <button type="button" className="clear-all-btn" onClick={handleResetAll}>Clear All</button>
      </div>
    );
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    title: { fontSize: 24, fontWeight: 600 },
    controlsRow: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16, marginBottom: 16 },
    rightControls: { display: 'flex', gap: 12, alignItems: 'center' },
    select: { padding: '6px 12px', fontSize: 14, border: '1px solid #ccc', borderRadius: 4 },
    button: { padding: '6px 16px', fontSize: 14, cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4 },
    table: { width: '100%', borderCollapse: 'collapse' as any },
    th: { textAlign: 'left' as any, padding: '8px 12px', borderBottom: '2px solid #e5e7eb', fontSize: 13, fontWeight: 600, color: '#6b7280' },
    td: { padding: '8px 12px', borderBottom: '1px solid #e5e7eb', fontSize: 14, cursor: 'pointer' },
    row: { cursor: 'pointer' },
    badge: { padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, color: '#fff' },
    loading: { textAlign: 'center' as any, padding: 40, color: '#6b7280' },
    error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 4, marginBottom: 16 },
    empty: { textAlign: 'center' as any, padding: 40, color: '#9ca3af' },
    navBtn: { padding: '6px 16px', fontSize: 14, cursor: 'pointer', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4 },
    pagination: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb', flexWrap: 'wrap', gap: 12 },
    paginationInfo: { fontSize: 14, color: '#6b7280' },
    paginationControls: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    pageBtn: { padding: '6px 12px', fontSize: 14, background: '#fff', border: '1px solid #d1d5db', borderRadius: 4, color: '#374151', minWidth: 80, textAlign: 'center' },
    pageIndicator: { fontSize: 14, color: '#374151', margin: '0 8px' },
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={styles.container}>
      <style>{STYLE_RULES}</style>
      <div style={styles.header}>
        <h1 style={styles.title}>Products</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <button style={{ ...styles.navBtn, background: '#2563eb' }} onClick={() => setShowImportModal(true)}>Bulk Import</button>
          <button style={styles.navBtn} onClick={onShowChangeSets}>Change Sets</button>
        </div>
      </div>

      <div className="catalog-layout">
        {/* Left-hand Sidebar for Filters */}
        <aside className="catalog-sidebar">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9', paddingBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Filters</h3>
            {(activeSearch || status || minPrice || maxPrice || inventoryStatus || Object.keys(customFilters).length > 0) && (
              <button type="button" className="clear-all-btn" style={{ padding: 0 }} onClick={handleResetAll}>Clear all</button>
            )}
          </div>

          {/* Text Search */}
          <div className="filter-section">
            <label className="filter-title">Search</label>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6 }}>
              <input
                className="sidebar-input"
                placeholder="Search name, SKU, desc..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <button style={{ ...styles.button, padding: '8px 12px', borderRadius: 8 }} type="submit">Search</button>
            </form>
          </div>

          {/* Status filter */}
          <div className="filter-section">
            <label className="filter-title">Status</label>
            <select className="sidebar-select" value={status} onChange={e => handleStatusChange(e.target.value)}>
              <option value="">All Statuses</option>
              <option value="enabled">Enabled Only</option>
              <option value="disabled">Disabled Only</option>
              <option value="active">Active (Enabled)</option>
              <option value="draft">Draft (Disabled)</option>
              <option value="archived">Archived (Disabled)</option>
            </select>
          </div>

          {/* Price Range */}
          <div className="filter-section">
            <label className="filter-title">Price Range</label>
            <div className="price-range-inputs">
              <input
                type="number"
                className="price-input"
                placeholder="Min"
                value={minPrice}
                onChange={e => { setMinPrice(e.target.value); setPage(1); }}
              />
              <span style={{ color: '#94a3b8' }}>–</span>
              <input
                type="number"
                className="price-input"
                placeholder="Max"
                value={maxPrice}
                onChange={e => { setMaxPrice(e.target.value); setPage(1); }}
              />
            </div>
          </div>

          {/* Stock Status */}
          <div className="filter-section">
            <label className="filter-title">Stock Status</label>
            <select className="sidebar-select" value={inventoryStatus} onChange={e => { setInventoryStatus(e.target.value); setPage(1); }}>
              <option value="">All Inventory</option>
              <option value="in_stock">In Stock Only</option>
              <option value="out_of_stock">Out of Stock</option>
              <option value="low_stock">Low Stock (≤ 5)</option>
            </select>
          </div>

          {/* Dynamic Facets (Custom Fields) */}
          {!facetsLoading && Object.entries(facets).map(([xmlField, facet]) => (
            <div className="filter-section" key={xmlField}>
              <label className="filter-title">{facet.label}</label>
              <input
                className="sidebar-input"
                placeholder={`Search ${facet.label}...`}
                value={customFilters[xmlField] || ''}
                onChange={e => {
                  const val = e.target.value;
                  setCustomFilters(prev => {
                    const next = { ...prev };
                    if (val) {
                      next[xmlField] = val;
                    } else {
                      delete next[xmlField];
                    }
                    return next;
                  });
                  setPage(1);
                }}
              />
            </div>
          ))}
          {facetsLoading && <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>Loading fields...</div>}
        </aside>

        {/* Right-hand side main content area */}
        <main className="catalog-main">
          {/* Header Controls (Grid/List Toggle & Media Settings) */}
          <div style={styles.controlsRow}>
            <div style={styles.rightControls}>
              <div className="view-toggle-container">
                <button
                  type="button"
                  className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
                  onClick={() => handleViewModeChange('grid')}
                  title="Storefront Grid"
                  style={{ padding: '6px 10px' }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
                  onClick={() => handleViewModeChange('list')}
                  title="Table List"
                  style={{ padding: '6px 10px' }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                </button>
              </div>

              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setShowSettings(!showSettings)}
                  className="cog-btn"
                  title="Media Settings"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>

                {showSettings && (
                  <div className="settings-popover">
                    <h4 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: '#1e293b' }}>Media Settings</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 11, fontWeight: 500, color: '#64748b' }}>Media Base URL</label>
                      <input
                        className="media-url-input"
                        type="text"
                        placeholder="e.g. https://store.example.com/media/"
                        value={mediaUrl}
                        onChange={e => handleMediaUrlChange(e.target.value)}
                        style={{ fontSize: 12, padding: '6px 8px' }}
                      />
                      {!mediaUrl && (
                        <span style={{ fontSize: 10, color: '#f59e0b' }}>⚠️ Set URL to load product images</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Active Filter Badges */}
          {renderActiveFilterBadges()}

          {error && <div style={styles.error}>{error}</div>}

          {loading ? (
            <div style={styles.loading}>Loading products...</div>
          ) : products.length === 0 ? (
            <div style={styles.empty}>
              <p>No products found matching filters.</p>
            </div>
          ) : (
            <>
              {viewMode === 'grid' ? (
                <div className="catalog-grid">
                  {products.map(p => (
                    <div key={p.sku} className="product-card" onClick={() => onSelectProduct(p.sku)}>
                      <div className="card-badge-container">
                        <span className="card-badge" style={{
                          background: p.status === 'active' ? '#16a34a' : p.status === 'draft' ? '#f59e0b' : '#6b7280',
                        }}>
                          {p.status}
                        </span>
                      </div>
                      <div className="card-badge-right-container">
                        <span className="card-badge" style={{
                          background: p.syncStatus === 'synced' ? '#16a34a' : p.syncStatus === 'pending' ? '#f59e0b' : p.syncStatus === 'failed' ? '#dc2626' : '#9ca3af',
                        }}>
                          {p.syncStatus}
                        </span>
                      </div>
                      <div className="card-image-container">
                        <ProductImage
                          src={p.primaryImage ? (mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + p.primaryImage : '') : ''}
                          alt={decodeHtmlEntities(p.title)}
                          title={decodeHtmlEntities(p.title)}
                        />
                      </div>
                      <div className="card-content">
                        <div className="card-sku">{p.sku}</div>
                        <h3 className="card-title" title={decodeHtmlEntities(p.title)}>{decodeHtmlEntities(p.title)}</h3>
                        {p.customFields && Object.keys(p.customFields).length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                            {Object.entries(p.customFields)
                              .filter(([_, val]) => val && val.trim() !== '')
                              .slice(0, 2)
                              .map(([field, val]) => {
                                const fieldLabel = facets[field]?.label || field;
                                return (
                                  <span key={field} style={{ fontSize: 10, background: '#f1f5f9', color: '#475569', padding: '2px 6px', borderRadius: 4 }}>
                                    {fieldLabel}: {val}
                                  </span>
                                );
                              })}
                          </div>
                        )}
                        <div className="card-footer">
                          <span className="card-price">{p.price ? `$${p.price}` : '—'}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>SKU</th>
                      <th style={styles.th}>Name</th>
                      <th style={styles.th}>Price</th>
                      <th style={styles.th}>Status</th>
                      <th style={styles.th}>Sync</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map(p => (
                      <tr key={p.sku} style={styles.row} onClick={() => onSelectProduct(p.sku)}>
                        <td style={styles.td}><strong>{p.sku}</strong></td>
                        <td style={styles.td}>
                          <div>{decodeHtmlEntities(p.title)}</div>
                          {p.customFields && Object.keys(p.customFields).length > 0 && (
                            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                              {Object.entries(p.customFields)
                                .filter(([_, val]) => val && val.trim() !== '')
                                .map(([field, val]) => {
                                  const fieldLabel = facets[field]?.label || field;
                                  return (
                                    <span key={field} style={{ fontSize: 10, color: '#64748b' }}>
                                      <strong>{fieldLabel}:</strong> {val}
                                    </span>
                                  );
                                })}
                            </div>
                          )}
                        </td>
                        <td style={styles.td}>{p.price ? `$${p.price}` : '-'}</td>
                        <td style={styles.td}>
                          <span style={{
                            ...styles.badge,
                            background: p.status === 'active' ? '#16a34a' : p.status === 'draft' ? '#f59e0b' : '#6b7280',
                          }}>
                            {p.status}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <span style={{
                            ...styles.badge,
                            background: p.syncStatus === 'synced' ? '#16a34a' : p.syncStatus === 'pending' ? '#f59e0b' : p.syncStatus === 'failed' ? '#dc2626' : '#9ca3af',
                          }}>
                            {p.syncStatus}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div style={styles.pagination}>
                <div style={styles.paginationInfo}>
                  Showing {Math.min((page - 1) * pageSize + 1, total)} to {Math.min(page * pageSize, total)} of {total} products
                </div>
                <div style={styles.paginationControls}>
                  <button 
                    type="button"
                    style={{ ...styles.pageBtn, opacity: page === 1 ? 0.5 : 1, cursor: page === 1 ? 'not-allowed' : 'pointer' }}
                    onClick={handlePrevPage}
                    disabled={page === 1}
                  >
                    Previous
                  </button>
                  <span style={styles.pageIndicator}>Page {page} of {totalPages}</span>
                  <button 
                    type="button"
                    style={{ ...styles.pageBtn, opacity: page >= totalPages ? 0.5 : 1, cursor: page >= totalPages ? 'not-allowed' : 'pointer' }}
                    onClick={handleNextPage}
                    disabled={page >= totalPages}
                  >
                    Next
                  </button>
                  
                  <select 
                    style={styles.select} 
                    value={pageSize} 
                    onChange={e => handlePageSizeChange(Number(e.target.value))}
                  >
                    <option value={25}>25 per page</option>
                    <option value={50}>50 per page</option>
                    <option value={100}>100 per page</option>
                    <option value={200}>200 per page</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {showImportModal && (
        <div className="modal-backdrop" onClick={resetImport}>
          <div className="modal-container" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Bulk Import Products</h3>
              <button className="modal-close-btn" onClick={resetImport}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            
            <div className="modal-body">
              {!importResult ? (
                <>
                  <p style={{ margin: 0, fontSize: 13, color: '#4b5563', lineHeight: 1.5 }}>
                    Copy and paste tab-separated rows from Excel/Google Sheets, or paste comma-separated CSV rows. 
                    Columns must include <strong>SKU</strong>, <strong>Name</strong>, and optionally <strong>Price</strong>.
                  </p>
                  
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label className="import-file-label">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      Upload CSV File
                      <input 
                        type="file" 
                        accept=".csv,.txt,.tsv" 
                        onChange={handleFileUpload} 
                        style={{ display: 'none' }} 
                      />
                    </label>
                    {importPreview.length > 0 && (
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#16a34a' }}>
                        ✓ {importPreview.length} products parsed
                      </span>
                    )}
                  </div>

                  <textarea
                    className="textarea-import"
                    placeholder="SKU,Name,Price&#10;NEW-SKU-1,My Product Name,29.99&#10;NEW-SKU-2,Another Product,14.50"
                    value={importText}
                    onChange={e => setImportText(e.target.value)}
                  />

                  {importPreview.length > 0 && (
                    <div>
                      <h4 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: '#1e293b' }}>Import Preview (First 5 items)</h4>
                      <div className="preview-container">
                        <table className="preview-table">
                          <thead>
                            <tr>
                              <th>SKU</th>
                              <th>Name</th>
                              <th>Price</th>
                            </tr>
                          </thead>
                          <tbody>
                            {importPreview.slice(0, 5).map((item, idx) => (
                              <tr key={idx}>
                                <td style={{ fontFamily: 'monospace' }}>{item.sku}</td>
                                <td>{item.name}</td>
                                <td>{item.price ? `$${item.price}` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {error && <div style={{ color: '#dc2626', fontSize: 13, background: '#fef2f2', padding: 10, borderRadius: 6 }}>{error}</div>}
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#16a34a' }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Bulk Import Completed!</h3>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, background: '#f8fafc', padding: 16, borderRadius: 8 }}>
                    <div>
                      <span style={{ fontSize: 12, color: '#64748b', display: 'block' }}>Imported Successfully</span>
                      <strong style={{ fontSize: 20, color: '#16a34a' }}>{importResult.imported.length} products</strong>
                    </div>
                    <div>
                      <span style={{ fontSize: 12, color: '#64748b', display: 'block' }}>Skipped (Existing / Invalid)</span>
                      <strong style={{ fontSize: 20, color: importResult.skipped.length > 0 ? '#f59e0b' : '#64748b' }}>{importResult.skipped.length} skipped</strong>
                    </div>
                  </div>

                  {importResult.skipped.length > 0 && (
                    <div>
                      <h4 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 600, color: '#e11d48' }}>Skipped Items</h4>
                      <div className="preview-container" style={{ maxHeight: 150 }}>
                        <table className="preview-table">
                          <thead>
                            <tr>
                              <th>SKU</th>
                              <th>Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {importResult.skipped.map((skip: any, idx: number) => (
                              <tr key={idx}>
                                <td style={{ fontFamily: 'monospace', color: '#e11d48' }}>{skip.sku}</td>
                                <td style={{ color: '#64748b' }}>{skip.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <p style={{ margin: 0, fontSize: 12, color: '#64748b', lineHeight: 1.4 }}>
                    Drafts have been created in Change Set: <strong>{importResult.changeSetId.slice(0, 8)}</strong>. 
                    Remember to approve and merge this Change Set to write files, then sync/publish to upload changes to ShopSite.
                  </p>
                </div>
              )}
            </div>
            
            <div className="modal-footer">
              {!importResult ? (
                <>
                  <button style={{ ...styles.navBtn, margin: 0 }} onClick={resetImport} disabled={importing}>Cancel</button>
                  <button 
                    style={{ ...styles.button, margin: 0, opacity: importPreview.length === 0 || importing ? 0.6 : 1, cursor: importPreview.length === 0 || importing ? 'not-allowed' : 'pointer' }} 
                    onClick={handleExecuteImport}
                    disabled={importPreview.length === 0 || importing}
                  >
                    {importing ? 'Importing...' : `Import ${importPreview.length} Products`}
                  </button>
                </>
              ) : (
                <button style={{ ...styles.button, margin: 0 }} onClick={resetImport}>Done</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
