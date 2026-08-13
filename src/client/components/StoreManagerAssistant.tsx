import React, { useState, useEffect, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  fetchStoreManagerModels,
  formatModelPricing,
  type StoreManagerModelDescriptor,
} from '../store-manager-api';

interface StoreManagerAssistantProps {
  onSelectProduct?: (sku: string) => void;
}

interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
}

interface SelectedProduct {
  sku: string;
  title: string;
  primaryImage?: string | null;
}

const generateUuid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2) + Date.now().toString(36);

export function StoreManagerAssistant({ onSelectProduct }: StoreManagerAssistantProps) {
  const [currentThreadId, setCurrentThreadId] = useState<string>(generateUuid());
  const [currentThreadTitle, setCurrentThreadTitle] = useState<string>('');
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [input, setInput] = useState('');
  
  // Model selection state — populated from the server-owned descriptor
  // endpoint; there is no hard-coded client model catalog.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<StoreManagerModelDescriptor[]>([]);
  const [modelSetupMessage, setModelSetupMessage] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);

  // Product context attachment states
  const [selectedProducts, setSelectedProducts] = useState<SelectedProduct[]>([]);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [modalSearchQuery, setModalSearchQuery] = useState('');
  const [modalProducts, setModalProducts] = useState<SelectedProduct[]>([]);
  const [modalLoading, setModalLoading] = useState(false);

  // ShopSite Media URL for displaying product images
  const [mediaUrl] = useState(() => localStorage.getItem('shopsite_media_url') || '');

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Track selected products and model in refs to avoid stale closures in transport constructor
  const selectedProductsRef = useRef(selectedProducts);
  useEffect(() => {
    selectedProductsRef.current = selectedProducts;
  }, [selectedProducts]);

  const selectedModelRef = useRef(selectedModel);
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  // Load the server-owned model descriptor list on mount.
  useEffect(() => {
    let cancelled = false;
    fetchStoreManagerModels()
      .then(data => {
        if (cancelled) return;
        setModelOptions(data.models);
        setModelSetupMessage(data.setupMessage ?? null);
      })
      .catch(err => {
        if (cancelled) return;
        setModelOptions([]);
        setModelSetupMessage(err instanceof Error ? err.message : 'Failed to load available models.');
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the selection valid across refresh/config changes: never keep an
  // unavailable stale value selected.
  useEffect(() => {
    setSelectedModel(prev => {
      if (prev && modelOptions.some(m => m.id === prev)) return prev;
      const preferred = modelOptions.find(m => m.isDefault) ?? modelOptions[0] ?? null;
      return preferred?.id ?? null;
    });
  }, [modelOptions]);

  const currentThreadIdRef = useRef(currentThreadId);
  useEffect(() => {
    currentThreadIdRef.current = currentThreadId;
  }, [currentThreadId]);

  // Set up the default transport pointing to our Hono chat route
  const transport = useRef(
    new DefaultChatTransport({
      api: '/api/store-manager/chat',
      body: () => ({
        selectedSkus: selectedProductsRef.current.map(p => p.sku),
        selectedModel: selectedModelRef.current,
        threadId: currentThreadIdRef.current,
      }),
    })
  );

  const { messages, sendMessage, status, error, setMessages } = useChat({
    transport: transport.current,
  });

  const totalThreadCost = messages.reduce((sum, msg: any) => {
    if (msg.usage && typeof msg.usage.cost === 'number') {
      return sum + msg.usage.cost;
    }
    return sum;
  }, 0);
  const formattedCost = totalThreadCost > 0 ? `$${totalThreadCost.toFixed(5)}` : '$0.00';

  // Autocomplete search for products in the modal
  useEffect(() => {
    if (!showAttachModal) return;

    const delayDebounce = setTimeout(() => {
      setModalLoading(true);
      fetch(`/api/products?search=${encodeURIComponent(modalSearchQuery)}&limit=24`)
        .then(res => res.json())
        .then(data => {
          setModalProducts(data.products || []);
          setModalLoading(false);
        })
        .catch(err => {
          console.error('Failed to search products for modal:', err);
          setModalLoading(false);
        });
    }, 200);

    return () => clearTimeout(delayDebounce);
  }, [modalSearchQuery, showAttachModal]);

  // Load thread list on mount
  const loadThreads = async (selectActiveId?: string) => {
    try {
      const res = await fetch('/api/store-manager/chat/threads');
      const data = await res.json();
      const loadedThreads = data.threads || [];
      setThreads(loadedThreads);

      if (loadedThreads.length > 0) {
        const targetId = selectActiveId || loadedThreads[0].id;
        const matchingThread = loadedThreads.find((t: ChatThread) => t.id === targetId);
        
        if (matchingThread) {
          setCurrentThreadId(matchingThread.id);
          setCurrentThreadTitle(matchingThread.title);
          loadThreadMessages(matchingThread.id);
        } else {
          setCurrentThreadId(loadedThreads[0].id);
          setCurrentThreadTitle(loadedThreads[0].title);
          loadThreadMessages(loadedThreads[0].id);
        }
      } else {
        startNewChat();
      }
    } catch (err) {
      console.error('Failed to load chat threads:', err);
    }
  };

  useEffect(() => {
    loadThreads();
  }, []);

  // Load messages for a specific thread
  const loadThreadMessages = async (threadId: string) => {
    try {
      const res = await fetch(`/api/store-manager/chat/${threadId}`);
      const data = await res.json();
      setMessages(data.messages || []);
    } catch (err) {
      console.error('Failed to load thread messages:', err);
    }
  };

  // Switch to a different thread
  const selectThread = (thread: ChatThread) => {
    if (status === 'streaming' || status === 'submitted') return;
    setCurrentThreadId(thread.id);
    setCurrentThreadTitle(thread.title);
    loadThreadMessages(thread.id);
    setSelectedProducts([]); // Reset context on thread switch
  };

  // Initialize a fresh new chat thread
  const startNewChat = () => {
    if (status === 'streaming' || status === 'submitted') return;
    const newId = generateUuid();
    setCurrentThreadId(newId);
    setCurrentThreadTitle('');
    setMessages([]);
    setSelectedProducts([]);
  };

  // Attach/Toggle a product context
  const toggleProductContext = (product: SelectedProduct) => {
    if (selectedProducts.some(p => p.sku === product.sku)) {
      setSelectedProducts(selectedProducts.filter(p => p.sku !== product.sku));
    } else {
      setSelectedProducts([...selectedProducts, product]);
    }
  };

  // Remove an attached product context
  const removeProductContext = (sku: string) => {
    setSelectedProducts(selectedProducts.filter(p => p.sku !== sku));
  };

  // Resolve image URL
  const getProductImageUrl = (primaryImage?: string | null) => {
    if (!primaryImage) return '';
    return mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + primaryImage : '';
  };

  // Auto-scroll to bottom of chat on new message or status change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  // Save chat history whenever messages list is updated and assistant is ready
  const lastMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    const saveChat = async () => {
      if (status === 'ready' && messages.length > 0 && messages.length !== lastMessagesLengthRef.current) {
        lastMessagesLengthRef.current = messages.length;

        let title = currentThreadTitle;
        if (!title) {
          const firstUserMsg = messages.find(m => m.role === 'user');
          if (firstUserMsg && firstUserMsg.parts) {
            const textPart = firstUserMsg.parts.find(p => p.type === 'text');
            if (textPart && textPart.type === 'text') {
              const cleaned = textPart.text.replace(/[#*`]/g, '').trim();
              title = cleaned.substring(0, 32) + (cleaned.length > 32 ? '...' : '');
            }
          }
          if (!title) {
            title = `Chat - ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          }
          setCurrentThreadTitle(title);
        }

        try {
          await fetch(`/api/store-manager/chat/${currentThreadId}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, threadTitle: title }),
          });
          await loadThreads(currentThreadId);
        } catch (err) {
          console.error('Failed to save chat history:', err);
        }
      }
    };
    saveChat();
  }, [messages, status, currentThreadId, currentThreadTitle]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || status === 'submitted' || status === 'streaming') return;
    if (!selectedModel) return; // no usable model configured
    sendMessage({ text: input.trim() });
    setInput('');
  };

  const handleStarterPrompt = (promptText: string) => {
    if (status === 'submitted' || status === 'streaming') return;
    sendMessage({ text: promptText });
  };

  const deleteThread = async (e: React.MouseEvent, threadId: string) => {
    e.stopPropagation();
    if (status === 'streaming' || status === 'submitted') return;
    if (!confirm('Are you sure you want to delete this conversation?')) return;

    try {
      await fetch(`/api/store-manager/chat/${threadId}`, { method: 'DELETE' });
      if (threadId === currentThreadId) {
        await loadThreads();
      } else {
        await loadThreads(currentThreadId);
      }
    } catch (err) {
      console.error('Failed to delete chat thread:', err);
    }
  };

  // Helper to parse bold markdown inside text
  const parseInlineMarkdown = (text: string) => {
    const parts = [];
    let key = 0;
    const regex = /(\*\*|`)(.*?)\1/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(<span key={key++}>{text.substring(lastIndex, match.index)}</span>);
      }
      const marker = match[1];
      const content = match[2];
      if (marker === '**') {
        parts.push(<strong key={key++}>{content}</strong>);
      } else {
        parts.push(
          <code
            key={key++}
            style={{
              background: '#f3f4f6',
              padding: '2px 6px',
              borderRadius: 4,
              fontFamily: 'monospace',
              fontSize: '13px',
              color: '#dc2626',
            }}
          >
            {content}
          </code>
        );
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(<span key={key++}>{text.substring(lastIndex)}</span>);
    }

    return parts.length > 0 ? parts : text;
  };

  // Helper renderer for Markdown in assistant messages
  const renderMarkdownLine = (line: string, idx: number) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return (
        <h1
          key={idx}
          style={{
            fontSize: '20px',
            fontWeight: 800,
            color: '#111827',
            margin: '18px 0 8px',
            borderBottom: '1px solid #f3f4f6',
            paddingBottom: '4px',
          }}
        >
          {parseInlineMarkdown(trimmed.substring(2))}
        </h1>
      );
    }
    if (trimmed.startsWith('## ')) {
      return (
        <h2 key={idx} style={{ fontSize: '16px', fontWeight: 700, color: '#1f2937', margin: '14px 0 6px' }}>
          {parseInlineMarkdown(trimmed.substring(3))}
        </h2>
      );
    }
    if (trimmed.startsWith('### ')) {
      return (
        <h3 key={idx} style={{ fontSize: '14px', fontWeight: 700, color: '#374151', margin: '12px 0 4px' }}>
          {parseInlineMarkdown(trimmed.substring(4))}
        </h3>
      );
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      return (
        <li
          key={idx}
          style={{
            marginLeft: '16px',
            listStyleType: 'disc',
            margin: '3px 0',
            fontSize: '14px',
            color: '#4b5563',
          }}
        >
          {parseInlineMarkdown(trimmed.substring(2))}
        </li>
      );
    }
    if (/^\d+\.\s/.test(trimmed)) {
      const content = trimmed.replace(/^\d+\.\s/, '');
      return (
        <li
          key={idx}
          style={{
            marginLeft: '16px',
            listStyleType: 'decimal',
            margin: '3px 0',
            fontSize: '14px',
            color: '#4b5563',
          }}
        >
          {parseInlineMarkdown(content)}
        </li>
      );
    }
    if (trimmed === '') {
      return <div key={idx} style={{ height: '8px' }} />;
    }
    return (
      <p key={idx} style={{ margin: '4px 0', fontSize: '14px', color: '#374151', lineHeight: '1.5' }}>
        {parseInlineMarkdown(line)}
      </p>
    );
  };

  const renderMessageContent = (text: string) => {
    if (!text) return null;
    return text.split('\n').map((line, idx) => renderMarkdownLine(line, idx));
  };

  // Render nice visual cards for tool invocation and output
  const renderToolInvocation = (part: any, key: number) => {
    const { toolName, state, output, errorText, input } = part;
    const isLoading = state === 'input-streaming' || state === 'input-available';

    const renderSkuList = (skus: string[], productTitle = 'Audit Context') => {
      if (!skus || skus.length === 0) return <em>None</em>;
      return (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {skus.map(sku => (
            <div key={sku} style={{ display: 'inline-flex', gap: 2, background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 4, padding: '2px 4px', alignItems: 'center' }}>
              <button
                onClick={() => onSelectProduct?.(sku)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '11px',
                  color: '#2563eb',
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: 0,
                }}
                title="Click to open product detail"
              >
                🔑 {sku}
              </button>
              <button
                onClick={() => toggleProductContext({ sku, title: productTitle })}
                style={{
                  background: 'none',
                  border: 'none',
                  color: selectedProducts.some(p => p.sku === sku) ? '#ef4444' : '#10b981',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '0 2px',
                  fontWeight: 'bold',
                }}
                title={selectedProducts.some(p => p.sku === sku) ? 'Remove Context' : 'Attach Context'}
              >
                {selectedProducts.some(p => p.sku === sku) ? '✕' : '📎'}
              </button>
            </div>
          ))}
        </div>
      );
    };

    return (
      <div
        key={key}
        style={{
          margin: '12px 0',
          padding: '12px 16px',
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>
            🛠️ Tool Called: <code style={{ color: '#2563eb' }}>{toolName}</code>
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: 4,
              background: isLoading ? '#fef3c7' : state === 'output-error' ? '#fee2e2' : '#dcfce7',
              color: isLoading ? '#d97706' : state === 'output-error' ? '#b91c1c' : '#15803d',
            }}
          >
            {isLoading ? 'Running...' : state === 'output-error' ? 'Error' : 'Complete'}
          </span>
        </div>

        {input && Object.keys(input).length > 0 && (
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
            Arguments: <code>{JSON.stringify(input)}</code>
          </div>
        )}

        {state === 'output-available' && output && (
          <div style={{ fontSize: 13, borderTop: '1px solid #f1f5f9', paddingTop: 8, marginTop: 4 }}>
            {toolName === 'getDashboardStats' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 8 }}>
                  <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                    <div style={{ color: '#64748b', fontSize: 10 }}>Total Products</div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{output.metrics?.totalProducts}</div>
                  </div>
                  <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                    <div style={{ color: '#16a34a', fontSize: 10 }}>Synced Products</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#16a34a' }}>
                      {output.metrics?.syncedProducts}
                    </div>
                  </div>
                  <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                    <div style={{ color: '#ea580c', fontSize: 10 }}>Drifted Products</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#ea580c' }}>
                      {output.metrics?.driftedProducts}
                    </div>
                  </div>
                  <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                    <div style={{ color: '#dc2626', fontSize: 10 }}>With Warnings</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#dc2626' }}>
                      {output.metrics?.productsWithWarnings}
                    </div>
                  </div>
                </div>
                {output.recentSyncJobs && output.recentSyncJobs.length > 0 && (
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 6 }}>
                    <strong>Last Sync Status:</strong> {output.recentSyncJobs[0].status} (
                    {output.recentSyncJobs[0].productCount} items)
                  </div>
                )}
              </div>
            )}

            {toolName === 'getCatalogHealthReport' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                  <div style={{ color: '#64748b', fontSize: 10 }}>Healthy</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#16a34a' }}>
                    {output.healthyProducts}/{output.totalProducts}
                  </div>
                </div>
                <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                  <div style={{ color: '#dc2626', fontSize: 10 }}>Blockers</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626' }}>{output.totalErrors}</div>
                </div>
                <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                  <div style={{ color: '#d97706', fontSize: 10 }}>Warnings</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#d97706' }}>{output.totalWarnings}</div>
                </div>
              </div>
            )}

            {toolName === 'listCatalogHealthIssues' && Array.isArray(output) && (
              <div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #e2e8f0', textAlign: 'left', color: '#64748b' }}>
                      <th style={{ padding: '4px 0' }}>Product</th>
                      <th style={{ padding: '4px 0' }}>Severity</th>
                      <th style={{ padding: '4px 0' }}>Code / Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {output.map((issue: any, index: number) => (
                      <tr key={index} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 0' }}>
                          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <button
                              onClick={() => onSelectProduct?.(issue.sku)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#2563eb',
                                fontWeight: 600,
                                cursor: 'pointer',
                                padding: 0,
                                fontSize: 12,
                              }}
                            >
                              {issue.sku}
                            </button>
                            <button
                              onClick={() => toggleProductContext({ sku: issue.sku, title: issue.title || 'Catalog Issue' })}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: selectedProducts.some(p => p.sku === issue.sku) ? '#ef4444' : '#10b981',
                                cursor: 'pointer',
                                fontSize: '11px',
                                fontWeight: 'bold',
                                padding: 0,
                              }}
                              title={selectedProducts.some(p => p.sku === issue.sku) ? 'Remove Context' : 'Attach Context'}
                            >
                              {selectedProducts.some(p => p.sku === issue.sku) ? '✕' : '📎'}
                            </button>
                          </div>
                        </td>
                        <td style={{ padding: '6px 0' }}>
                          <span
                            style={{
                              color: issue.severity === 'blocker' ? '#dc2626' : '#ea580c',
                              fontWeight: 600,
                            }}
                          >
                            {issue.severity}
                          </span>
                        </td>
                        <td style={{ padding: '6px 0', color: '#334155' }}>
                          <code>{issue.code}</code>: {issue.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {toolName === 'searchProducts' && Array.isArray(output) && (
              <div>
                <div style={{ fontWeight: 600, color: '#64748b', fontSize: 11, marginBottom: 4 }}>
                  Found {output.length} products:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {output.map((prod: any) => (
                    <div
                      key={prod.sku}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 12,
                        background: '#fff',
                        padding: 6,
                        borderRadius: 6,
                        border: '1px solid #f1f5f9',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>
                        <button
                          onClick={() => onSelectProduct?.(prod.sku)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#2563eb',
                            fontWeight: 600,
                            cursor: 'pointer',
                            padding: 0,
                            fontSize: 12,
                          }}
                        >
                          🔑 {prod.sku}
                        </button>
                        <button
                          onClick={() => toggleProductContext({ sku: prod.sku, title: prod.title })}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: selectedProducts.some(p => p.sku === prod.sku) ? '#ef4444' : '#10b981',
                            cursor: 'pointer',
                            padding: '0 4px',
                            fontSize: '11px',
                            fontWeight: 'bold',
                          }}
                          title={selectedProducts.some(p => p.sku === prod.sku) ? 'Remove Context' : 'Attach Context'}
                        >
                          {selectedProducts.some(p => p.sku === prod.sku) ? '✕' : '📎'}
                        </button>{' '}
                        - {prod.title}
                      </span>
                      <span style={{ fontSize: 11, color: '#64748b' }}>${prod.price || '0.00'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {toolName === 'getProductFieldAudit' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
                  <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                    <div style={{ color: '#64748b', fontSize: 10 }}>Scanned</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{output.totalProductsScanned}</div>
                  </div>
                  <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                    <div style={{ color: '#64748b', fontSize: 10 }}>Missing/Empty</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{output.missingCount}</div>
                  </div>
                  <div style={{ background: '#fff', padding: 8, borderRadius: 6, border: '1px solid #f1f5f9' }}>
                    <div style={{ color: '#64748b', fontSize: 10 }}>Unique Values</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{output.uniqueValueCount}</div>
                  </div>
                </div>

                {output.duplicateGroups && output.duplicateGroups.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 700, color: '#b91c1c', fontSize: 12 }}>
                      ⚠️ Duplicate Groups Detected ({output.duplicateGroups.length})
                    </div>
                    <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 4 }}>
                      {output.duplicateGroups.map((g: any, i: number) => (
                        <div
                          key={i}
                          style={{
                            fontSize: 11,
                            padding: '4px 6px',
                            background: '#fff',
                            border: '1px solid #f1f5f9',
                            borderRadius: 4,
                            marginBottom: 4,
                          }}
                        >
                          <strong>{g.type.toUpperCase()}:</strong> "{g.normalized}"
                          <ul style={{ paddingLeft: 12, margin: '2px 0 0 0' }}>
                            {g.values.map((v: any, j: number) => (
                              <li key={j}>
                                "{v.value}" ({v.count} products) {renderSkuList(v.skus, `Brand: ${v.value}`)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {toolName === 'proposeProductFieldNormalization' && (
              <div>
                <div style={{ fontWeight: 700, color: '#1e3a8a', fontSize: 12, marginBottom: 4 }}>
                  📋 {output.proposalCount} Proposals
                </div>
                <div style={{ fontSize: 11, color: '#4b5563', marginBottom: 8 }}>
                  Affects {output.affectedProductCount} products. Proposed mapping:
                </div>
                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  {output.proposals.map((prop: any) => (
                    <div
                      key={prop.id}
                      style={{
                        padding: 6,
                        background: '#fff',
                        border: '1px solid #f1f5f9',
                        borderRadius: 6,
                        marginBottom: 6,
                        fontSize: 12,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700 }}>
                          <code>{prop.oldValue}</code> ➔ <code>{prop.newValue}</code>
                        </span>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '1px 4px',
                            borderRadius: 4,
                            background: prop.safeAutoApply ? '#dcfce7' : '#fee2e2',
                            color: prop.safeAutoApply ? '#15803d' : '#b91c1c',
                          }}
                        >
                          {prop.safeAutoApply ? 'Safe Auto-Apply' : 'Requires Approval'}
                        </span>
                      </div>
                      <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>
                        Reason: {prop.reason} | Confidence: {Math.round(prop.confidence * 100)}%
                      </div>
                      <div style={{ marginTop: 4 }}>
                        Affected SKUs: {renderSkuList(prop.affectedSkus, `Value: ${prop.newValue}`)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {toolName === 'explainNextActions' && output.actions && (
              <div>
                <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 12, marginBottom: 4 }}>
                  🚀 Recommended Actions Checklist:
                </div>
                <ul style={{ paddingLeft: 16, margin: 0, fontSize: 13, color: '#334155' }}>
                  {output.actions.map((act: string, idx: number) => (
                    <li key={idx} style={{ margin: '4px 0' }}>
                      {act}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {toolName === 'generateNormalizationProposals' && (
              <div style={{ color: '#15803d', fontWeight: 600 }}>
                ✅ Successfully generated and stored {output.proposalCount} proposals in the database.
              </div>
            )}

            {toolName === 'applyNormalizationProposal' && (
              <div style={{ color: '#15803d', fontWeight: 600 }}>
                🎉 Successfully applied proposal! Changes staged inside Change Set: <code>{output.changeSetId}</code>
              </div>
            )}

            {toolName === 'dismissNormalizationProposal' && (
              <div style={{ color: '#64748b', fontWeight: 600 }}>
                Dismissed proposal successfully.
              </div>
            )}

            {!['getDashboardStats', 'getCatalogHealthReport', 'listCatalogHealthIssues', 'searchProducts', 'getProductFieldAudit', 'proposeProductFieldNormalization', 'generateNormalizationProposals', 'applyNormalizationProposal', 'dismissNormalizationProposal', 'explainNextActions'].includes(toolName) && (
              <details style={{ fontSize: 11, color: '#334155', cursor: 'pointer' }}>
                <summary style={{ outline: 'none', color: '#2563eb', fontWeight: 600 }}>Show Raw JSON Output</summary>
                <pre
                  style={{
                    background: '#fff',
                    padding: 8,
                    borderRadius: 4,
                    border: '1px solid #e2e8f0',
                    marginTop: 4,
                    overflowX: 'auto',
                    maxHeight: 200,
                  }}
                >
                  {JSON.stringify(output, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}

        {state === 'output-error' && errorText && (
          <div style={{ borderTop: '1px solid #fee2e2', paddingTop: 8, marginTop: 8, color: '#ef4444', fontSize: 12 }}>
            ❌ <strong>Error:</strong> {errorText}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        height: 'calc(100vh - 54px)',
        maxHeight: 'calc(100vh - 54px)',
        background: '#f9fafb',
        color: '#1f2937',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Left Sidebar - Chat History */}
      <aside
        style={{
          width: '260px',
          minWidth: '260px',
          flexShrink: 0,
          background: '#f3f4f6',
          borderRight: '1px solid #e5e7eb',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <button
          onClick={startNewChat}
          style={{
            margin: '16px',
            padding: '10px 16px',
            background: '#ffffff',
            border: '1px dashed #d1d5db',
            borderRadius: '8px',
            color: '#2563eb',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            textAlign: 'center',
            transition: 'all 0.2s',
          }}
          onMouseOver={e => {
            e.currentTarget.style.borderColor = '#2563eb';
            e.currentTarget.style.background = '#eff6ff';
          }}
          onMouseOut={e => {
            e.currentTarget.style.borderColor = '#d1d5db';
            e.currentTarget.style.background = '#ffffff';
          }}
        >
          ➕ New Chat
        </button>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.5px' }}>
            Conversations (Last 7 Days)
          </div>
          
          {threads.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#9ca3af', fontStyle: 'italic', textAlign: 'center', marginTop: 16 }}>
              No recent conversations
            </div>
          ) : (
            threads.map(thread => {
              const isActive = thread.id === currentThreadId;
              return (
                <div
                  key={thread.id}
                  onClick={() => selectThread(thread)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    width: '100%',
                    padding: '8px 12px',
                    marginBottom: '6px',
                    borderRadius: '6px',
                    background: isActive ? '#ffffff' : 'transparent',
                    border: isActive ? '1px solid #e5e7eb' : '1px solid transparent',
                    boxShadow: isActive ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? '#111827' : '#4b5563',
                    transition: 'all 0.15s',
                  }}
                  onMouseOver={e => {
                    if (!isActive) e.currentTarget.style.background = '#e5e7eb';
                  }}
                  onMouseOut={e => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px', flex: 1 }}>
                    💬 {thread.title}
                  </span>
                  <button
                    onClick={e => deleteThread(e, thread.id)}
                    style={{
                      border: 'none',
                      background: 'none',
                      padding: 0,
                      color: '#9ca3af',
                      cursor: 'pointer',
                      fontSize: '14px',
                    }}
                    onMouseOver={e => (e.currentTarget.style.color = '#ef4444')}
                    onMouseOut={e => (e.currentTarget.style.color = '#9ca3af')}
                    title="Delete conversation"
                  >
                    🗑️
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Right Area - Chat Window */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {/* Header */}
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 24px',
            background: '#ffffff',
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#2563eb', display: 'flex', alignItems: 'center', gap: 8 }}>
              🤖 Store Manager AI Assistant
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  background: status === 'streaming' ? '#2563eb' : status === 'submitted' ? '#ea580c' : '#10b981',
                  color: '#fff',
                }}
              >
                {status === 'streaming' ? 'Streaming...' : status === 'submitted' ? 'Submitting...' : 'Ready'}
              </span>
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#6b7280' }}>
              {currentThreadTitle ? `Current thread: "${currentThreadTitle}"` : 'Interactive catalog auditing and refactoring advisor.'}
            </p>
          </div>

          {/* Model selection dropdown — server-driven model list with clear pricing */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: '12px', fontWeight: 700, color: '#4b5563' }}>AI Model:</label>
              <div style={{ position: 'relative' }}>
                <select
                  value={selectedModel ?? ''}
                  onChange={e => setSelectedModel(e.target.value || null)}
                  disabled={status === 'streaming' || status === 'submitted' || modelsLoading || modelOptions.length === 0}
                  style={{
                    background: '#ffffff',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    padding: '6px 28px 6px 12px',
                    fontSize: '13px',
                    color: '#374151',
                    fontWeight: 600,
                    cursor: (status === 'streaming' || status === 'submitted' || modelOptions.length === 0) ? 'not-allowed' : 'pointer',
                    outline: 'none',
                    appearance: 'none',
                  }}
                >
                  {modelsLoading ? (
                    <option value="">Loading models…</option>
                  ) : modelOptions.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    modelOptions.map(opt => (
                      <option key={opt.id} value={opt.id} title={opt.capabilitySummary}>
                        {opt.providerLabel} · {opt.id} ({formatModelPricing(opt)})
                      </option>
                    ))
                  )}
                </select>
                <div
                  style={{
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    pointerEvents: 'none',
                    fontSize: '9px',
                    color: '#9ca3af',
                  }}
                >
                  ▼
                </div>
              </div>
            </div>
            {modelSetupMessage && !modelsLoading && modelOptions.length === 0 && (
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#b45309',
                  background: '#fef3c7',
                  border: '1px solid #fde68a',
                  borderRadius: 6,
                  padding: '4px 8px',
                  maxWidth: 320,
                  textAlign: 'right',
                }}
              >
                ⚠️ {modelSetupMessage}
              </div>
            )}
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#16a34a', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>💵 Session Cost:</span>
              <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{formattedCost}</span>
            </div>
          </div>
        </header>

        {/* Main Chat Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {messages.length === 0 ? (
            <div style={{ margin: 'auto', maxWidth: 600, textAlign: 'center', padding: '40px 0' }}>
              <div style={{ fontSize: '48px', marginBottom: 16 }}>💼</div>
              <h3 style={{ fontSize: '22px', fontWeight: 800, color: '#111827', margin: '0 0 8px' }}>
                How can I help you manage the store?
              </h3>
              <p style={{ color: '#6b7280', fontSize: '14px', margin: '0 0 32px', lineHeight: 1.6 }}>
                Attach specific products as context or ask general catalog questions.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {[
                  { title: '📊 Summarize Catalog Health', prompt: 'Summarize catalog health.' },
                  { title: '⚠️ Show Products with Blockers', prompt: 'Show products with blockers.' },
                  { title: '🔎 Audit ProductField24', prompt: 'Audit ProductField24.' },
                  { title: '🔄 Find Duplicate Brands', prompt: 'Find duplicate Brand values.' },
                  { title: '🖼️ Find Products Missing Images', prompt: 'Which products are missing images?' },
                  { title: '📡 Show Unsynced Products', prompt: 'Show unsynced or drifted products.' },
                ].map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleStarterPrompt(item.prompt)}
                    style={{
                      background: '#ffffff',
                      border: '1px solid #d1d5db',
                      borderRadius: 8,
                      padding: '12px 16px',
                      color: '#374151',
                      fontSize: '13px',
                      fontWeight: 500,
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                    onMouseOver={e => {
                      e.currentTarget.style.borderColor = '#2563eb';
                      e.currentTarget.style.background = '#eff6ff';
                    }}
                    onMouseOut={e => {
                      e.currentTarget.style.borderColor = '#d1d5db';
                      e.currentTarget.style.background = '#ffffff';
                    }}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message: UIMessage) => {
              const isUser = message.role === 'user';
              return (
                <div
                  key={message.id}
                  style={{
                    display: 'flex',
                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                    animation: 'fadeIn 0.2s ease-out',
                  }}
                >
                  <div
                    style={{
                      maxWidth: '80%',
                      padding: '16px 20px',
                      borderRadius: 12,
                      background: isUser ? '#eff6ff' : '#ffffff',
                      border: isUser ? '1px solid #bfdbfe' : '1px solid #e5e7eb',
                      color: isUser ? '#1e3a8a' : '#1f2937',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                    }}
                  >
                    <div style={{ fontSize: '11px', color: isUser ? '#2563eb' : '#4b5563', fontWeight: 700, marginBottom: 6 }}>
                      {isUser ? 'YOU' : 'ASSISTANT'}
                    </div>

                    <div className="message-text">
                      {message.parts && message.parts.length > 0 ? (
                        message.parts.map((part, partIdx) => {
                          if (part.type === 'text') {
                            return <div key={partIdx}>{renderMessageContent(part.text)}</div>;
                          }
                          if (part.type === 'reasoning') {
                            return (
                              <details
                                key={partIdx}
                                style={{
                                  marginTop: 6,
                                  marginBottom: 6,
                                  background: '#f3f4f6',
                                  padding: 8,
                                  borderRadius: 6,
                                  border: '1px solid #e5e7eb',
                                }}
                              >
                                <summary style={{ fontSize: 11, color: '#4b5563', cursor: 'pointer', outline: 'none' }}>
                                  Thinking Process
                                </summary>
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: '#6b7280',
                                    fontStyle: 'italic',
                                    marginTop: 4,
                                    whiteSpace: 'pre-wrap',
                                  }}
                                >
                                  {part.text}
                                </div>
                              </details>
                            );
                          }
                          if (part.type === 'tool-invocation') {
                            return renderToolInvocation(part, partIdx);
                          }
                          return null;
                        })
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {status === 'streaming' && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div
                style={{
                  padding: '12px 16px',
                  borderRadius: 12,
                  background: '#ffffff',
                  border: '1px solid #e5e7eb',
                  color: '#6b7280',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                }}
              >
                <div className="spinner-ring" style={{ width: 14, height: 14, borderWidth: 2, borderTopColor: '#2563eb' }} />
                Assistant is thinking...
              </div>
            </div>
          )}

          {error && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div
                style={{
                  background: '#fee2e2',
                  border: '1px solid #fca5a5',
                  borderRadius: 8,
                  padding: '12px 16px',
                  color: '#991b1b',
                  fontSize: '13px',
                  fontWeight: 600,
                  maxWidth: 600,
                }}
              >
                ⚠️ Error: {error.message || 'An error occurred during response streaming.'}
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Product Search Grid Modal */}
        {showAttachModal && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 1000,
            }}
          >
            <div
              style={{
                width: '800px',
                maxWidth: '95%',
                height: '600px',
                maxHeight: '90%',
                backgroundColor: '#ffffff',
                borderRadius: '12px',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
                overflow: 'hidden',
                animation: 'fadeIn 0.2s ease-out',
              }}
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: '18px 24px',
                  borderBottom: '1px solid #e5e7eb',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#111827' }}>
                    📎 Attach Product Context
                  </h3>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#6b7280' }}>
                    Search and select products to inject as conversational context for the Store Manager.
                  </p>
                </div>
                <button
                  onClick={() => setShowAttachModal(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '20px',
                    color: '#9ca3af',
                    cursor: 'pointer',
                    padding: '4px',
                  }}
                  onMouseOver={e => e.currentTarget.style.color = '#ef4444'}
                  onMouseOut={e => e.currentTarget.style.color = '#9ca3af'}
                >
                  ✕
                </button>
              </div>

              {/* Modal Search Bar */}
              <div
                style={{
                  padding: '16px 24px',
                  borderBottom: '1px solid #e5e7eb',
                  backgroundColor: '#f9fafb',
                }}
              >
                <input
                  type="text"
                  value={modalSearchQuery}
                  onChange={e => setModalSearchQuery(e.target.value)}
                  placeholder="🔍 Type SKU or product name to filter..."
                  style={{
                    width: '100%',
                    background: '#ffffff',
                    border: '1px solid #d1d5db',
                    borderRadius: '8px',
                    padding: '10px 16px',
                    fontSize: '14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                  autoFocus
                />
              </div>

              {/* Modal Content - Product Grid */}
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '24px',
                  background: '#f9fafb',
                }}
              >
                {modalLoading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <div className="spinner-ring" style={{ width: 32, height: 32, borderTopColor: '#2563eb', marginBottom: 12 }} />
                    <span style={{ fontSize: '13px', color: '#6b7280' }}>Searching catalog...</span>
                  </div>
                ) : modalProducts.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af' }}>
                    <div style={{ fontSize: '40px', marginBottom: 8 }}>🔍</div>
                    <span style={{ fontSize: '14px', fontStyle: 'italic' }}>No matching products found</span>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                      gap: '16px',
                    }}
                  >
                    {modalProducts.map(prod => {
                      const isSelected = selectedProducts.some(p => p.sku === prod.sku);
                      const imageUrl = getProductImageUrl(prod.primaryImage);

                      return (
                        <div
                          key={prod.sku}
                          style={{
                            border: isSelected ? '2px solid #2563eb' : '1px solid #e5e7eb',
                            borderRadius: '8px',
                            padding: '12px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            textAlign: 'center',
                            background: '#ffffff',
                            height: '180px',
                            boxShadow: isSelected ? '0 4px 6px -1px rgba(37,99,235,0.1)' : '0 1px 2px rgba(0,0,0,0.05)',
                            transition: 'all 0.15s',
                          }}
                        >
                          {/* Product Image */}
                          <div
                            style={{
                              width: '60px',
                              height: '60px',
                              borderRadius: '6px',
                              background: '#f3f4f6',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              marginBottom: '8px',
                              overflow: 'hidden',
                            }}
                          >
                            {imageUrl ? (
                              <img
                                src={imageUrl}
                                alt={prod.title}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <span style={{ fontSize: '24px' }}>📦</span>
                            )}
                          </div>

                          {/* Product Text */}
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <div
                              style={{
                                fontSize: '12px',
                                fontWeight: 700,
                                color: '#1f2937',
                                marginBottom: '2px',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                                minHeight: '32px',
                              }}
                            >
                              {prod.title}
                            </div>
                            <div style={{ fontSize: '10px', color: '#6b7280', fontFamily: 'monospace' }}>
                              {prod.sku}
                            </div>
                          </div>

                          {/* Add Context Button */}
                          <button
                            onClick={() => toggleProductContext(prod)}
                            style={{
                              width: '100%',
                              padding: '6px 0',
                              borderRadius: '6px',
                              fontSize: '12px',
                              fontWeight: 600,
                              cursor: 'pointer',
                              border: '1px solid',
                              background: isSelected ? '#dcfce7' : '#ffffff',
                              color: isSelected ? '#15803d' : '#2563eb',
                              borderColor: isSelected ? '#bbf7d0' : '#2563eb',
                              transition: 'all 0.15s',
                            }}
                            onMouseOver={e => {
                              if (!isSelected) {
                                e.currentTarget.style.background = '#eff6ff';
                              } else {
                                e.currentTarget.style.background = '#fee2e2';
                                e.currentTarget.style.color = '#b91c1c';
                                e.currentTarget.style.borderColor = '#fca5a5';
                                e.currentTarget.textContent = '✕ Remove';
                              }
                            }}
                            onMouseOut={e => {
                              if (!isSelected) {
                                e.currentTarget.style.background = '#ffffff';
                                e.currentTarget.style.color = '#2563eb';
                                e.currentTarget.style.borderColor = '#2563eb';
                              } else {
                                e.currentTarget.style.background = '#dcfce7';
                                e.currentTarget.style.color = '#15803d';
                                e.currentTarget.style.borderColor = '#bbf7d0';
                                e.currentTarget.textContent = '✓ Attached';
                              }
                            }}
                          >
                            {isSelected ? '✓ Attached' : '➕ Attach'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div
                style={{
                  padding: '14px 24px',
                  borderTop: '1px solid #e5e7eb',
                  display: 'flex',
                  justifyContent: 'flex-end',
                  backgroundColor: '#f9fafb',
                }}
              >
                <button
                  onClick={() => setShowAttachModal(false)}
                  style={{
                    background: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '10px 24px',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                  }}
                  onMouseOver={e => e.currentTarget.style.background = '#1d4ed8'}
                  onMouseOut={e => e.currentTarget.style.background = '#2563eb'}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Attached products preview */}
        {selectedProducts.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              padding: '8px 24px',
              background: '#f8fafc',
              borderTop: '1px solid #e5e7eb',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: '10px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Context ({selectedProducts.length}):
            </span>
            {selectedProducts.map(p => (
              <span
                key={p.sku}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: 6,
                  padding: '3px 8px',
                  fontSize: '12px',
                  color: '#1e40af',
                  fontWeight: 500,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
                }}
              >
                📦 <strong>{p.sku}</strong> - {p.title.substring(0, 20)}{p.title.length > 20 ? '...' : ''}
                <button
                  type="button"
                  onClick={() => removeProductContext(p.sku)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#93c5fd',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    padding: 0,
                    fontSize: '12px',
                    marginLeft: 2,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  onMouseOver={e => (e.currentTarget.style.color = '#ef4444')}
                  onMouseOut={e => (e.currentTarget.style.color = '#93c5fd')}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Input Form */}
        <form
          onSubmit={handleSend}
          style={{
            padding: '16px 24px',
            background: '#ffffff',
            borderTop: '1px solid #e5e7eb',
            display: 'flex',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            onClick={() => setShowAttachModal(true)}
            style={{
              background: '#f3f4f6',
              border: '1px solid #d1d5db',
              borderRadius: 8,
              padding: '12px 16px',
              fontSize: '14px',
              cursor: 'pointer',
              fontWeight: 600,
              color: '#4b5563',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.2s',
            }}
            onMouseOver={e => {
              e.currentTarget.style.background = '#e5e7eb';
            }}
            onMouseOut={e => {
              e.currentTarget.style.background = '#f3f4f6';
            }}
            title="Attach product context"
          >
            📎 Attach Context
          </button>

          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={
              !selectedModel
                ? 'No usable AI model configured. Check Settings → LLM Providers.'
                : selectedProducts.length > 0
                  ? "Ask a question about the attached product(s)..."
                  : "Ask about your catalog, product fields, health, or proposals..."
            }
            disabled={status === 'submitted' || status === 'streaming' || !selectedModel}
            style={{
              flex: 1,
              background: '#f9fafb',
              border: '1px solid #d1d5db',
              borderRadius: 8,
              padding: '12px 16px',
              color: '#111827',
              fontSize: '14px',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = '#2563eb')}
            onBlur={e => (e.currentTarget.style.borderColor = '#d1d5db')}
          />
          <button
            type="submit"
            disabled={!input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel}
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '12px 24px',
              fontSize: '14px',
              fontWeight: 600,
              cursor:
                !input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel ? 'not-allowed' : 'pointer',
              opacity:
                !input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel ? 0.6 : 1,
              transition: 'background 0.2s',
            }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
