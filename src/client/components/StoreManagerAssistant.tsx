import React, { useState, useEffect, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import {
  fetchStoreManagerModels,
  formatModelPricing,
  type StoreManagerModelDescriptor,
} from '../store-manager-api';
import {
  approvalCardCopy,
  deniedOutcomeText,
  approvedAwaitingExecutionText,
} from '../store-manager-logic';
import { colors, fonts, rounded, themeStyles } from '../theme';
import { ViewHeader } from './common/ViewHeader';

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

/** Server-enforced attachment limit (mirrors MAX_ATTACHED_SKUS in store-manager-context.ts). */
const MAX_ATTACHED_PRODUCTS = 10;

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
  const [attachmentLimitReached, setAttachmentLimitReached] = useState(false);
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

  const { messages, sendMessage, status, error, setMessages, addToolApprovalResponse } = useChat({
    transport: transport.current,
    // #34: when the assistant message has complete tool-approval responses,
    // resubmit automatically so the server validates the HMAC signature and
    // executes the approved tool.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  // Session cost is derived exclusively from server-attached message metadata
  // (epic #42, #37): the durable model-call row id, resolved provider/model,
  // aggregate tokens, and honest cost basis. Client-supplied `usage` is never
  // accepted.
  const totalThreadCost = messages.reduce((sum: number, msg: any) => {
    const meta = msg?.metadata;
    if (meta && typeof meta.estimatedCostUsd === 'number') {
      return sum + meta.estimatedCostUsd;
    }
    return sum;
  }, 0);
  const formattedCost = totalThreadCost > 0 ? `$${totalThreadCost.toFixed(5)}` : '$0.00';

  // #34: per-approval decision state (blocks duplicate clicks while a decision
  // is being submitted).
  const [approvalDecisions, setApprovalDecisions] = useState<Record<string, 'approving' | 'denying'>>({});

  const handleApprovalDecision = async (approvalId: string, approved: boolean) => {
    if (status === 'submitted' || status === 'streaming') return;
    if (approvalDecisions[approvalId]) return;
    setApprovalDecisions(prev => ({ ...prev, [approvalId]: approved ? 'approving' : 'denying' }));
    try {
      await addToolApprovalResponse({
        id: approvalId,
        approved,
        reason: approved ? undefined : 'Denied by operator.',
      });
    } catch (err) {
      console.error('Failed to submit approval response:', err);
    } finally {
      setApprovalDecisions(prev => {
        const next = { ...prev };
        delete next[approvalId];
        return next;
      });
    }
  };

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
    setAttachmentLimitReached(false);
  };

  // Attach/Toggle a product context (dedupe by SKU; enforce the attachment cap)
  const toggleProductContext = (product: SelectedProduct) => {
    if (selectedProducts.some(p => p.sku === product.sku)) {
      setSelectedProducts(selectedProducts.filter(p => p.sku !== product.sku));
    } else if (selectedProducts.length >= MAX_ATTACHED_PRODUCTS) {
      setAttachmentLimitReached(true);
    } else {
      setSelectedProducts([...selectedProducts, product]);
    }
  };

  // Remove an attached product context
  const removeProductContext = (sku: string) => {
    setSelectedProducts(selectedProducts.filter(p => p.sku !== sku));
    setAttachmentLimitReached(false);
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
  const parseInlineMarkdown = (text: string, isUser = false) => {
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
        parts.push(<strong key={key++} style={{ fontWeight: 700, color: isUser ? '#FFFFFF' : 'inherit' }}>{content}</strong>);
      } else {
        parts.push(
          <code
            key={key++}
            style={{
              background: isUser ? 'rgba(255, 255, 255, 0.2)' : colors.feedBagCream,
              padding: '2px 6px',
              borderRadius: rounded.xs,
              fontFamily: fonts.mono,
              fontSize: '13px',
              color: isUser ? '#FFFFFF' : colors.signetBurgundy,
              border: isUser ? '1px solid rgba(255, 255, 255, 0.3)' : `1px solid ${colors.cardBorder}`,
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

  // Helper renderer for Markdown in assistant/user messages
  const renderMarkdownLine = (line: string, idx: number, isUser = false) => {
    const trimmed = line.trim();
    const textColor = isUser ? '#FFFFFF' : colors.ledgerCharcoal;
    const headColor = isUser ? '#FFFFFF' : colors.ledgerCharcoal;

    if (trimmed.startsWith('# ')) {
      return (
        <h1
          key={idx}
          style={{
            fontFamily: fonts.display,
            fontSize: '20px',
            fontWeight: 700,
            color: headColor,
            margin: '18px 0 8px',
            borderBottom: isUser ? '1px solid rgba(255,255,255,0.2)' : `1px solid ${colors.cardBorder}`,
            paddingBottom: '4px',
          }}
        >
          {parseInlineMarkdown(trimmed.substring(2), isUser)}
        </h1>
      );
    }
    if (trimmed.startsWith('## ')) {
      return (
        <h2 key={idx} style={{ fontFamily: fonts.display, fontSize: '16px', fontWeight: 700, color: headColor, margin: '14px 0 6px' }}>
          {parseInlineMarkdown(trimmed.substring(3), isUser)}
        </h2>
      );
    }
    if (trimmed.startsWith('### ')) {
      return (
        <h3 key={idx} style={{ fontFamily: fonts.display, fontSize: '14px', fontWeight: 700, color: isUser ? '#FFFFFF' : colors.mulchBrown, margin: '12px 0 4px' }}>
          {parseInlineMarkdown(trimmed.substring(4), isUser)}
        </h3>
      );
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      return (
        <li
          key={idx}
          style={{
            margin: '6px 0 6px 24px',
            paddingLeft: '4px',
            listStyleType: 'disc',
            listStylePosition: 'outside',
            fontSize: '14px',
            color: textColor,
            lineHeight: '1.6',
          }}
        >
          {parseInlineMarkdown(trimmed.substring(2), isUser)}
        </li>
      );
    }
    if (/^\d+\.\s/.test(trimmed)) {
      const content = trimmed.replace(/^\d+\.\s/, '');
      return (
        <li
          key={idx}
          style={{
            margin: '6px 0 6px 24px',
            paddingLeft: '4px',
            listStyleType: 'decimal',
            listStylePosition: 'outside',
            fontSize: '14px',
            color: textColor,
            lineHeight: '1.6',
          }}
        >
          {parseInlineMarkdown(content, isUser)}
        </li>
      );
    }
    if (trimmed === '') {
      return <div key={idx} style={{ height: '8px' }} />;
    }
    return (
      <p key={idx} style={{ margin: '8px 0', fontSize: '14px', color: textColor, lineHeight: '1.6' }}>
        {parseInlineMarkdown(line, isUser)}
      </p>
    );
  };

  const renderMessageContent = (text: string, isUser = false) => {
    if (!text) return null;
    return text.split('\n').map((line, idx) => renderMarkdownLine(line, idx, isUser));
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
            <div key={sku} style={{ display: 'inline-flex', gap: 4, background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.xs, padding: '2px 6px', alignItems: 'center' }}>
              <button
                onClick={() => onSelectProduct?.(sku)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '11px',
                  fontFamily: fonts.mono,
                  color: colors.uniformGreen,
                  fontWeight: 700,
                  cursor: 'pointer',
                  padding: 0,
                }}
                title="Click to open product detail"
              >
                {sku}
              </button>
              <button
                onClick={() => toggleProductContext({ sku, title: productTitle })}
                style={{
                  background: 'none',
                  border: 'none',
                  color: selectedProducts.some(p => p.sku === sku) ? colors.signetBurgundy : colors.seedlingGreen,
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '0 2px',
                  fontWeight: 'bold',
                }}
                title={selectedProducts.some(p => p.sku === sku) ? 'Remove Context' : 'Attach Context'}
              >
                {selectedProducts.some(p => p.sku === sku) ? '✕' : '+'}
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
          background: colors.feedBagCream,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.md,
          boxShadow: '0 1px 2px rgba(33,20,20,0.03)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>
            Tool Execution: <code style={{ color: colors.uniformGreen, fontFamily: fonts.mono }}>{toolName}</code>
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: rounded.xs,
              background: isLoading ? colors.cornerCalloutGold : state === 'output-error' ? '#fee2e2' : colors.seedlingGreen,
              color: isLoading ? colors.ledgerCharcoal : state === 'output-error' ? colors.signetBurgundy : colors.feedBagCream,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {isLoading ? 'Running...' : state === 'output-error' ? 'Error' : 'Complete'}
          </span>
        </div>

        {input && Object.keys(input).length > 0 && (
          <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 6, fontFamily: fonts.mono }}>
            Arguments: <code>{JSON.stringify(input).slice(0, 2000)}</code>
          </div>
        )}

        {state === 'output-available' && output && (
          <div style={{ fontSize: 13, borderTop: `1px solid ${colors.cardBorder}`, paddingTop: 8, marginTop: 4 }}>
            {toolName === 'getDashboardStats' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 8 }}>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.mulchBrown, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Total Products</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colors.ledgerCharcoal }}>{output.metrics?.totalProducts}</div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.seedlingGreen, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Synced Products</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colors.seedlingGreen }}>
                      {output.metrics?.syncedProducts}
                    </div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.signetBurgundy, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Drifted Products</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colors.signetBurgundy }}>
                      {output.metrics?.driftedProducts}
                    </div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.signetBurgundy, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>With Warnings</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: colors.signetBurgundy }}>
                      {output.metrics?.productsWithWarnings}
                    </div>
                  </div>
                </div>
                {output.recentSyncJobs && output.recentSyncJobs.length > 0 && (
                  <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 6, fontFamily: fonts.mono }}>
                    <strong>Last Sync Status:</strong> {output.recentSyncJobs[0].status} ({output.recentSyncJobs[0].productCount} items)
                  </div>
                )}
              </div>
            )}

            {toolName === 'getCatalogHealthReport' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ color: colors.seedlingGreen, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Healthy</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: colors.seedlingGreen }}>
                    {output.healthyProducts}/{output.totalProducts}
                  </div>
                </div>
                <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ color: colors.signetBurgundy, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Blockers</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: colors.signetBurgundy }}>{output.totalErrors}</div>
                </div>
                <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                  <div style={{ color: colors.mulchBrown, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Warnings</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: colors.mulchBrown }}>{output.totalWarnings}</div>
                </div>
              </div>
            )}

            {toolName === 'listCatalogHealthIssues' && Array.isArray(output) && (
              <div>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${colors.cardBorder}`, textAlign: 'left', color: colors.mulchBrown }}>
                      <th style={{ padding: '6px 0' }}>Product</th>
                      <th style={{ padding: '6px 0' }}>Severity</th>
                      <th style={{ padding: '6px 0' }}>Code / Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {output.map((issue: any, index: number) => (
                      <tr key={index} style={{ borderBottom: `1px solid ${colors.cardBorder}` }}>
                        <td style={{ padding: '6px 0' }}>
                          <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <button
                              onClick={() => onSelectProduct?.(issue.sku)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: colors.uniformGreen,
                                fontFamily: fonts.mono,
                                cursor: 'pointer',
                                fontWeight: 700,
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
                                color: selectedProducts.some(p => p.sku === issue.sku) ? colors.signetBurgundy : colors.seedlingGreen,
                                cursor: 'pointer',
                                fontSize: '11px',
                                fontWeight: 'bold',
                                padding: 0,
                              }}
                              title={selectedProducts.some(p => p.sku === issue.sku) ? 'Remove Context' : 'Attach Context'}
                            >
                              {selectedProducts.some(p => p.sku === issue.sku) ? '✕' : '+'}
                            </button>
                          </div>
                        </td>
                        <td style={{ padding: '6px 0' }}>
                          <span
                            style={{
                              color: issue.severity === 'blocker' ? colors.signetBurgundy : colors.mulchBrown,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              fontSize: 10,
                            }}
                          >
                            {issue.severity}
                          </span>
                        </td>
                        <td style={{ padding: '6px 0', color: colors.ledgerCharcoal }}>
                          <code style={{ fontFamily: fonts.mono, fontSize: 11 }}>{issue.code}</code>: {issue.message}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {toolName === 'searchProducts' && Array.isArray(output) && (
              <div>
                <div style={{ fontWeight: 600, color: colors.mulchBrown, fontSize: 11, marginBottom: 6 }}>
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
                        background: colors.whiteSurface,
                        padding: '8px 12px',
                        borderRadius: rounded.xs,
                        border: `1px solid ${colors.cardBorder}`,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>
                        <button
                          onClick={() => onSelectProduct?.(prod.sku)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: colors.uniformGreen,
                            fontFamily: fonts.mono,
                            fontWeight: 700,
                            cursor: 'pointer',
                            padding: 0,
                            fontSize: 12,
                          }}
                        >
                          {prod.sku}
                        </button>
                        <button
                          onClick={() => toggleProductContext({ sku: prod.sku, title: prod.title })}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: selectedProducts.some(p => p.sku === prod.sku) ? colors.signetBurgundy : colors.seedlingGreen,
                            cursor: 'pointer',
                            padding: '0 4px',
                            fontSize: '11px',
                            fontWeight: 'bold',
                          }}
                          title={selectedProducts.some(p => p.sku === prod.sku) ? 'Remove Context' : 'Attach Context'}
                        >
                          {selectedProducts.some(p => p.sku === prod.sku) ? '✕' : '+'}
                        </button>{' '}
                        - {prod.title}
                      </span>
                      <span style={{ fontSize: 11, color: colors.mulchBrown, fontFamily: fonts.mono }}>${prod.price || '0.00'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {toolName === 'getProductFieldAudit' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.mulchBrown, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Scanned</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>{output.totalProductsScanned}</div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.signetBurgundy, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Missing/Empty</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: colors.signetBurgundy }}>{output.missingCount}</div>
                  </div>
                  <div style={{ background: colors.whiteSurface, padding: 8, borderRadius: rounded.xs, border: `1px solid ${colors.cardBorder}` }}>
                    <div style={{ color: colors.uniformGreen, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Unique Values</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: colors.uniformGreen }}>{output.uniqueValueCount}</div>
                  </div>
                </div>

                {output.duplicateGroups && output.duplicateGroups.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 700, color: colors.signetBurgundy, fontSize: 12 }}>
                      Duplicate Groups Detected ({output.duplicateGroups.length})
                    </div>
                    <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 4 }}>
                      {output.duplicateGroups.map((g: any, i: number) => (
                        <div
                          key={i}
                          style={{
                            fontSize: 11,
                            padding: '6px 8px',
                            background: colors.whiteSurface,
                            border: `1px solid ${colors.cardBorder}`,
                            borderRadius: rounded.xs,
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
                <div style={{ fontWeight: 700, color: colors.uniformGreen, fontSize: 12, marginBottom: 4 }}>
                  {output.proposalCount} Proposals Generated
                </div>
                <div style={{ fontSize: 11, color: colors.mulchBrown, marginBottom: 8 }}>
                  Affects {output.affectedProductCount} products. Proposed mapping:
                </div>
                <div style={{ maxHeight: 150, overflowY: 'auto' }}>
                  {output.proposals.map((prop: any) => (
                    <div
                      key={prop.id}
                      style={{
                        padding: 8,
                        background: colors.whiteSurface,
                        border: `1px solid ${colors.cardBorder}`,
                        borderRadius: rounded.xs,
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
                            padding: '1px 5px',
                            borderRadius: rounded.xs,
                            background: prop.safeAutoApply ? colors.feedBagCream : '#fee2e2',
                            color: prop.safeAutoApply ? colors.seedlingGreen : colors.signetBurgundy,
                            border: `1px solid ${prop.safeAutoApply ? colors.seedlingGreen : colors.signetBurgundy}`,
                          }}
                        >
                          {prop.safeAutoApply ? 'Safe Auto-Apply' : 'Requires Approval'}
                        </span>
                      </div>
                      <div style={{ color: colors.mulchBrown, fontSize: 11, marginTop: 4 }}>
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
                <div style={{ fontWeight: 700, color: colors.ledgerCharcoal, fontSize: 12, marginBottom: 4 }}>
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
                  {JSON.stringify(output, null, 2).slice(0, 8000)}
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

  // -- Tool approval UI (epic #42, #34) ---------------------------------------

  /** Extract the stable tool name from an AI SDK v7 tool part. */
  const toolNameFromPart = (part: any): string => {
    if (part.type === 'dynamic-tool') return part.toolName || 'unknown-tool';
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) return part.type.slice('tool-'.length);
    return part.toolName || 'unknown-tool';
  };

  /** Adapt a v7 tool part into the shape the existing renderer expects. */
  const adaptToolPart = (part: any) => ({
    toolName: toolNameFromPart(part),
    state: part.state,
    output: part.output,
    errorText: part.errorText,
    input: part.input,
    toolCallId: part.toolCallId,
  });

  /** Blocking approval card. The operator sees the exact action, risk, scope,
   *  and state transition before Approve/Deny. No optimistic success claims. */
  const renderApprovalRequest = (part: any, key: number) => {
    const toolName = toolNameFromPart(part);
    const approvalId: string = part.approval?.id;
    const hasServerSignature = Boolean(part.approval?.signature);
    // #40 change 11: unknown/stale tool parts (legacy history, unknown tool
    // version, unsigned parts) render a read-only safe fallback — never an
    // executable Approve/Deny control.
    if (!hasServerSignature || !approvalId) {
      return (
        <div
          key={key}
          style={{
            margin: '12px 0',
            padding: '12px 16px',
            background: '#f5f5f4',
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            fontSize: 12,
            color: colors.mulchBrown,
          }}
        >
          <strong>Stale or unrecognized approval request</strong> — re-run the action to receive a
          fresh, signed approval. Tool: <code style={{ fontFamily: fonts.mono }}>{toolName}</code>
        </div>
      );
    }
    const copy = approvalCardCopy(toolName, part.input || {});
    const decisionBusy = approvalDecisions[approvalId];
    const isBusy = Boolean(decisionBusy) || status === 'submitted' || status === 'streaming';
    return (
      <div
        key={key}
        style={{
          margin: '12px 0',
          padding: '14px 16px',
          background: '#fef9e7',
          border: `1px solid ${colors.mutedGold}`,
          borderRadius: rounded.md,
          boxShadow: '0 1px 3px rgba(33,20,20,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 16 }}>🔒</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>
            Action requires approval
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: rounded.xs,
              background: colors.mutedGold,
              color: colors.ledgerCharcoal,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {copy.risk}
          </span>
        </div>
        <div style={{ fontSize: 13, color: colors.ledgerCharcoal }}>
          <strong>{copy.title}</strong>
        </div>
        <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 6 }}>
          <div><strong>Scope:</strong> <code style={{ fontFamily: fonts.mono }}>{copy.scope}</code></div>
          <div style={{ marginTop: 2 }}><strong>State transition:</strong> {copy.transition}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button
            className="btn"
            disabled={isBusy}
            onClick={() => handleApprovalDecision(approvalId, true)}
            style={{
              background: colors.seedlingGreen,
              color: colors.feedBagCream,
              border: 'none',
              padding: '6px 18px',
              borderRadius: rounded.sm,
              fontSize: 12,
              fontWeight: 700,
              cursor: isBusy ? 'not-allowed' : 'pointer',
              opacity: isBusy ? 0.6 : 1,
            }}
          >
            {decisionBusy === 'approving' ? 'Approving…' : 'Approve'}
          </button>
          <button
            className="btn"
            disabled={isBusy}
            onClick={() => handleApprovalDecision(approvalId, false)}
            style={{
              background: colors.whiteSurface,
              color: colors.signetBurgundy,
              border: `1px solid ${colors.signetBurgundy}`,
              padding: '6px 18px',
              borderRadius: rounded.sm,
              fontSize: 12,
              fontWeight: 700,
              cursor: isBusy ? 'not-allowed' : 'pointer',
              opacity: isBusy ? 0.6 : 1,
            }}
          >
            Deny
          </button>
        </div>
      </div>
    );
  };

  /** Approval result banner: approved (awaiting execution) or denied (not executed). */
  const renderApprovalResponded = (part: any, key: number) => {
    const toolName = toolNameFromPart(part);
    const approved = part.approval?.approved === true;
    return (
      <div
        key={key}
        style={{
          margin: '12px 0',
          padding: '12px 16px',
          background: approved ? '#ecfdf5' : '#fef2f2',
          border: `1px solid ${approved ? colors.seedlingGreen : colors.signetBurgundy}`,
          borderRadius: rounded.md,
          fontSize: 13,
          fontWeight: 600,
          color: approved ? colors.shadowPine : colors.signetBurgundy,
        }}
      >
        {approved ? approvedAwaitingExecutionText(toolName) : deniedOutcomeText(toolName)}
      </div>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        height: 'calc(100vh - 54px)',
        maxHeight: 'calc(100vh - 54px)',
        background: colors.feedBagCream,
        color: colors.ledgerCharcoal,
        fontFamily: fonts.body,
      }}
    >
      {/* Left Sidebar - Chat History */}
      <aside
        style={{
          width: '260px',
          minWidth: '260px',
          flexShrink: 0,
          background: colors.feedBagCream,
          borderRight: `1px solid ${colors.cardBorder}`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <button
          onClick={startNewChat}
          className="btn btn-primary"
          style={{
            margin: '16px',
            padding: '10px 16px',
            fontFamily: fonts.display,
            fontSize: '0.8rem',
            textAlign: 'center',
          }}
        >
          + New Chat Thread
        </button>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.05em' }}>
            Conversations (Last 7 Days)
          </div>
          
          {threads.length === 0 ? (
            <div style={{ fontSize: '12px', color: colors.mulchBrown, fontStyle: 'italic', textAlign: 'center', marginTop: 16 }}>
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
                    padding: '10px 12px',
                    marginBottom: '6px',
                    borderRadius: rounded.md,
                    background: isActive ? colors.whiteSurface : 'transparent',
                    border: isActive ? `1px solid ${colors.uniformGreen}` : '1px solid transparent',
                    boxShadow: isActive ? '0 1px 3px rgba(33,20,20,0.06)' : 'none',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? colors.ledgerCharcoal : colors.mulchBrown,
                    transition: 'all 0.15s',
                  }}
                  onMouseOver={e => {
                    if (!isActive) e.currentTarget.style.background = colors.whiteSurface;
                  }}
                  onMouseOut={e => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px', flex: 1 }}>
                    {thread.title}
                  </span>
                  <button
                    onClick={e => deleteThread(e, thread.id)}
                    style={{
                      border: 'none',
                      background: 'none',
                      padding: 0,
                      color: colors.mulchBrown,
                      cursor: 'pointer',
                      fontSize: '14px',
                    }}
                    onMouseOver={e => (e.currentTarget.style.color = colors.signetBurgundy)}
                    onMouseOut={e => (e.currentTarget.style.color = colors.mulchBrown)}
                    title="Delete conversation"
                  >
                    ✕
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
            background: colors.whiteSurface,
            borderBottom: `1px solid ${colors.cardBorder}`,
          }}
        >
        <ViewHeader
          title="Store Manager AI Assistant"
          description={currentThreadTitle ? `Current thread: "${currentThreadTitle}"` : 'Interactive catalog auditing and refactoring advisor.'}
          style={{ marginBottom: 0 }}
          badge={
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: rounded.full,
                background: status === 'streaming' ? colors.uniformGreen : status === 'submitted' ? colors.signetBurgundy : colors.seedlingGreen,
                color: colors.feedBagCream,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {status === 'streaming' ? 'Streaming...' : status === 'submitted' ? 'Submitting...' : 'Ready'}
            </span>
          }
        />

          {/* Model selection dropdown — server-driven model list with clear pricing */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: '12px', fontWeight: 700, color: colors.ledgerCharcoal }}>AI Model:</label>
              <div style={{ position: 'relative' }}>
                <select
                  value={selectedModel ?? ''}
                  onChange={e => setSelectedModel(e.target.value || null)}
                  disabled={status === 'streaming' || status === 'submitted' || modelsLoading || modelOptions.length === 0}
                  style={{
                    background: colors.whiteSurface,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    padding: '6px 28px 6px 12px',
                    fontSize: '13px',
                    color: colors.ledgerCharcoal,
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
                    color: colors.mulchBrown,
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
                  color: colors.signetBurgundy,
                  background: '#fee2e2',
                  border: `1px solid ${colors.signetBurgundy}`,
                  borderRadius: rounded.md,
                  padding: '4px 8px',
                  maxWidth: 320,
                  textAlign: 'right',
                }}
              >
                {modelSetupMessage}
              </div>
            )}
            <div style={{ fontSize: '11px', fontWeight: 700, color: colors.uniformGreen, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>Session Cost:</span>
              <span style={{ fontFamily: fonts.mono, fontSize: '12px' }}>{formattedCost}</span>
            </div>
          </div>
        </header>

        {/* Main Chat Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {messages.length === 0 ? (
            <div style={{ margin: 'auto', maxWidth: 640, textAlign: 'center', padding: '40px 24px', backgroundColor: colors.whiteSurface, borderRadius: rounded.lg, border: `1px solid ${colors.cardBorder}`, boxShadow: '0 1px 3px rgba(33,20,20,0.04)' }}>
              <h3 style={{ fontSize: '20px', fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal, margin: '0 0 8px' }}>
                How can I help manage your store catalog?
              </h3>
              <p style={{ color: colors.mulchBrown, fontSize: '14px', margin: '0 0 24px', lineHeight: 1.6 }}>
                Attach specific products as context or click a starter prompt below to audit fields, check health, and inspect drift.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {[
                  { title: 'Summarize Catalog Health', prompt: 'Summarize catalog health.' },
                  { title: 'Show Products with Blockers', prompt: 'Show products with blockers.' },
                  { title: 'Audit ProductField24', prompt: 'Audit ProductField24.' },
                  { title: 'Find Duplicate Brands', prompt: 'Find duplicate Brand values.' },
                  { title: 'Find Products Missing Images', prompt: 'Which products are missing images?' },
                  { title: 'Show Unsynced Products', prompt: 'Show unsynced or drifted products.' },
                ].map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleStarterPrompt(item.prompt)}
                    style={{
                      background: colors.whiteSurface,
                      border: `1px solid ${colors.cardBorder}`,
                      borderRadius: rounded.md,
                      padding: '12px 16px',
                      color: colors.ledgerCharcoal,
                      fontSize: '13px',
                      fontWeight: 600,
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                    onMouseOver={e => {
                      e.currentTarget.style.borderColor = colors.uniformGreen;
                      e.currentTarget.style.background = colors.feedBagCream;
                    }}
                    onMouseOut={e => {
                      e.currentTarget.style.borderColor = colors.cardBorder;
                      e.currentTarget.style.background = colors.whiteSurface;
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
                    margin: '8px 0',
                    animation: 'fadeIn 0.2s ease-out',
                  }}
                >
                  <div
                    style={{
                      maxWidth: '82%',
                      padding: '20px 24px',
                      borderRadius: rounded.lg,
                      background: isUser ? colors.uniformGreen : colors.whiteSurface,
                      border: isUser ? `1px solid ${colors.shadowPine}` : `1px solid ${colors.cardBorder}`,
                      color: isUser ? '#FFFFFF' : colors.ledgerCharcoal,
                      boxShadow: '0 2px 4px rgba(33,20,20,0.06)',
                    }}
                  >
                    <div style={{ fontSize: '11px', color: isUser ? colors.cornerCalloutGold : colors.uniformGreen, fontWeight: 700, marginBottom: 10, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                      {isUser ? 'YOU' : 'ASSISTANT'}
                    </div>

                    <div className="message-text">
                      {message.parts && message.parts.length > 0 ? (
                        message.parts.map((part, partIdx) => {
                          if (part.type === 'text') {
                            return <div key={partIdx}>{renderMessageContent(part.text, isUser)}</div>;
                          }
                          if (part.type === 'reasoning') {
                            return (
                              <details
                                key={partIdx}
                                style={{
                                  marginTop: 6,
                                  marginBottom: 6,
                                  background: colors.feedBagCream,
                                  padding: 10,
                                  borderRadius: rounded.md,
                                  border: `1px solid ${colors.cardBorder}`,
                                }}
                              >
                                <summary style={{ fontSize: 11, color: colors.mulchBrown, cursor: 'pointer', outline: 'none', fontWeight: 600 }}>
                                  Thinking Process
                                </summary>
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: colors.mulchBrown,
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
                          if (part.type === 'dynamic-tool' || (typeof part.type === 'string' && part.type.startsWith('tool-') && part.type !== 'tool-invocation')) {
                            // AI SDK v7 tool parts: approval request/response and execution states.
                            const toolPart = part as any;
                            if (toolPart.state === 'approval-requested') {
                              return renderApprovalRequest(toolPart, partIdx);
                            }
                            if (toolPart.state === 'approval-responded') {
                              return renderApprovalResponded(toolPart, partIdx);
                            }
                            return renderToolInvocation(adaptToolPart(toolPart), partIdx);
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
                  borderRadius: rounded.md,
                  background: colors.whiteSurface,
                  border: `1px solid ${colors.cardBorder}`,
                  color: colors.mulchBrown,
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  boxShadow: '0 1px 3px rgba(33,20,20,0.05)',
                }}
              >
                <div className="spinner-ring" style={{ width: 14, height: 14, borderWidth: 2, borderTopColor: colors.uniformGreen }} />
                Assistant is thinking...
              </div>
            </div>
          )}

          {error && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div
                style={{
                  background: '#fee2e2',
                  border: `1px solid ${colors.signetBurgundy}`,
                  borderRadius: rounded.md,
                  padding: '12px 16px',
                  color: colors.signetBurgundy,
                  fontSize: '13px',
                  fontWeight: 600,
                  maxWidth: 600,
                }}
              >
                Error: {error.message || 'An error occurred during response streaming.'}
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
              backgroundColor: 'rgba(33, 20, 20, 0.4)',
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
                backgroundColor: colors.whiteSurface,
                borderRadius: rounded.lg,
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.15)',
                overflow: 'hidden',
                animation: 'fadeIn 0.2s ease-out',
                border: `1px solid ${colors.cardBorder}`,
              }}
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: '18px 24px',
                  borderBottom: `1px solid ${colors.cardBorder}`,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  backgroundColor: colors.whiteSurface,
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal }}>
                    Attach Product Context
                  </h3>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: colors.mulchBrown }}>
                    Search and select products to inject as conversational context for the Store Manager.
                  </p>
                </div>
                <button
                  onClick={() => setShowAttachModal(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '20px',
                    color: colors.mulchBrown,
                    cursor: 'pointer',
                    padding: '4px',
                  }}
                  onMouseOver={e => e.currentTarget.style.color = colors.signetBurgundy}
                  onMouseOut={e => e.currentTarget.style.color = colors.mulchBrown}
                >
                  ✕
                </button>
              </div>

              {/* Modal Search Bar */}
              <div
                style={{
                  padding: '16px 24px',
                  borderBottom: `1px solid ${colors.cardBorder}`,
                  backgroundColor: colors.feedBagCream,
                }}
              >
                <input
                  type="text"
                  value={modalSearchQuery}
                  onChange={e => setModalSearchQuery(e.target.value)}
                  placeholder="Type SKU or product name to filter..."
                  style={{
                    width: '100%',
                    background: colors.whiteSurface,
                    border: `1px solid ${colors.cardBorder}`,
                    borderRadius: rounded.md,
                    padding: '10px 16px',
                    fontSize: '14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                    color: colors.ledgerCharcoal,
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
                  background: colors.feedBagCream,
                }}
              >
                {modalLoading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <div className="spinner-ring" style={{ width: 32, height: 32, borderTopColor: colors.uniformGreen, marginBottom: 12 }} />
                    <span style={{ fontSize: '13px', color: colors.mulchBrown }}>Searching catalog...</span>
                  </div>
                ) : modalProducts.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: colors.mulchBrown }}>
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
                            border: `1px solid ${isSelected ? colors.uniformGreen : colors.cardBorder}`,
                            borderRadius: rounded.md,
                            padding: '12px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            textAlign: 'center',
                            background: colors.whiteSurface,
                            height: '180px',
                            boxShadow: isSelected ? '0 4px 6px -1px rgba(20,83,45,0.1)' : '0 1px 2px rgba(33,20,20,0.03)',
                            transition: 'all 0.15s',
                          }}
                        >
                          {/* Product Image */}
                          <div
                            style={{
                              width: '60px',
                              height: '60px',
                              borderRadius: rounded.sm,
                              background: colors.feedBagCream,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              marginBottom: '8px',
                              overflow: 'hidden',
                              border: `1px solid ${colors.cardBorder}`,
                            }}
                          >
                            {imageUrl ? (
                              <img
                                src={imageUrl}
                                alt={prod.title}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <span style={{ fontSize: '11px', color: colors.mulchBrown, fontWeight: 600 }}>NO IMAGE</span>
                            )}
                          </div>

                          {/* Product Text */}
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <div
                              style={{
                                fontSize: '12px',
                                fontWeight: 700,
                                color: colors.ledgerCharcoal,
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
                            <div style={{ fontSize: '10px', color: colors.mulchBrown, fontFamily: fonts.mono }}>
                              {prod.sku}
                            </div>
                          </div>

                          {/* Add Context Button */}
                          <button
                            onClick={() => toggleProductContext(prod)}
                            style={{
                              width: '100%',
                              padding: '6px 0',
                              borderRadius: rounded.sm,
                              fontSize: '11px',
                              fontWeight: 600,
                              cursor: 'pointer',
                              border: '1px solid',
                              background: isSelected ? colors.feedBagCream : colors.whiteSurface,
                              color: isSelected ? colors.uniformGreen : colors.ledgerCharcoal,
                              borderColor: isSelected ? colors.uniformGreen : colors.cardBorder,
                              transition: 'all 0.15s',
                            }}
                          >
                            {isSelected ? '✓ Attached' : '+ Attach'}
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
                  borderTop: `1px solid ${colors.cardBorder}`,
                  display: 'flex',
                  justifyContent: 'flex-end',
                  backgroundColor: colors.whiteSurface,
                }}
              >
                <button
                  onClick={() => setShowAttachModal(false)}
                  className="btn btn-primary"
                  style={{ padding: '8px 20px', fontSize: '0.8rem' }}
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
              background: colors.feedBagCream,
              borderTop: `1px solid ${colors.cardBorder}`,
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: '10px', fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Context ({selectedProducts.length}/{MAX_ATTACHED_PRODUCTS}):
            </span>
            {attachmentLimitReached && (
              <span style={{ fontSize: '10px', fontWeight: 700, color: colors.signetBurgundy }}>
                ⚠ Attachment limit reached ({MAX_ATTACHED_PRODUCTS} max). Remove one before attaching more.
              </span>
            )}
            {selectedProducts.map(p => (
              <span
                key={p.sku}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: colors.whiteSurface,
                  border: `1px solid ${colors.uniformGreen}`,
                  borderRadius: rounded.sm,
                  padding: '3px 8px',
                  fontSize: '12px',
                  color: colors.uniformGreen,
                  fontWeight: 600,
                  boxShadow: '0 1px 2px rgba(33,20,20,0.02)',
                }}
              >
                <strong>{p.sku}</strong> - {p.title.substring(0, 20)}{p.title.length > 20 ? '...' : ''}
                <button
                  type="button"
                  onClick={() => removeProductContext(p.sku)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: colors.mulchBrown,
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    padding: 0,
                    fontSize: '12px',
                    marginLeft: 2,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  onMouseOver={e => (e.currentTarget.style.color = colors.signetBurgundy)}
                  onMouseOut={e => (e.currentTarget.style.color = colors.mulchBrown)}
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
            background: colors.whiteSurface,
            borderTop: `1px solid ${colors.cardBorder}`,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            onClick={() => setShowAttachModal(true)}
            className="btn btn-outline"
            style={{
              height: '2.5rem',
              fontSize: '0.75rem',
              padding: '0 16px',
            }}
            title="Attach product context"
          >
            + Attach Context
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
              background: colors.feedBagCream,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.md,
              padding: '12px 16px',
              color: colors.ledgerCharcoal,
              fontSize: '14px',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = colors.uniformGreen)}
            onBlur={e => (e.currentTarget.style.borderColor = colors.cardBorder)}
          />
          <button
            type="submit"
            disabled={!input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel}
            className="btn btn-primary"
            style={{
              height: '2.5rem',
              fontSize: '0.8rem',
              padding: '0 24px',
              opacity: !input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel ? 0.6 : 1,
              cursor: !input.trim() || status === 'submitted' || status === 'streaming' || !selectedModel ? 'not-allowed' : 'pointer',
            }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
