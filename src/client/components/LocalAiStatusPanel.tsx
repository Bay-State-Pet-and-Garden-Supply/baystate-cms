/**
 * LocalAiStatusPanel.tsx — Local AI Runtime status panel.
 *
 * Displays Ollama connection status, active/queued request counts,
 * resident model state, context window, and vision capabilities.
 */

import React, { useEffect, useState } from 'react';
import { getLocalRuntimeStatusApi, type LocalRuntimeStatusResponse } from '../onboarding-api';

import { getModelCapabilities, getModelProfile } from '../../ai/model-registry';

export function LocalAiStatusPanel(): React.ReactElement {
  const [status, setStatus] = useState<LocalRuntimeStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  const loadStatus = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getLocalRuntimeStatusApi();
      setStatus(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 15000);
    return () => clearInterval(timer);
  }, []);

  const firstRunningModel = status?.runningModels[0]?.name;
  const runningProfile = firstRunningModel ? getModelProfile(firstRunningModel) : null;
  const runningCaps = firstRunningModel ? getModelCapabilities(firstRunningModel) : null;

  const contextDisplay = runningProfile?.recommendedContext
    ? `${Math.round(runningProfile.recommendedContext / 1024)}K (32K Recommended)`
    : status?.connected
    ? '32K Recommended'
    : '—';

  const capabilitiesDisplay = runningCaps
    ? `${runningCaps.modalities.includes('image') ? 'Vision ' : ''}${runningCaps.toolCalling !== 'none' ? 'Tools' : ''}`.trim() || 'Text'
    : status?.connected
    ? 'Available'
    : '—';

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: 16,
        background: '#f9fafb',
        marginBottom: 20,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>
            Local AI Runtime (Ollama)
          </h3>
          {status ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 12,
                background: status.connected ? '#dcfce7' : '#fee2e2',
                color: status.connected ? '#166534' : '#991b1b',
              }}
            >
              {status.connected ? '✓ Connected' : '✕ Offline'}
            </span>
          ) : loading ? (
            <span style={{ fontSize: 12, color: '#9ca3af' }}>checking status…</span>
          ) : (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: '#fee2e2', color: '#991b1b' }}>
              ✕ Unreachable
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={loadStatus}
          disabled={loading}
          style={{
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '…' : 'Refresh Status'}
        </button>
      </div>

      {error && (
        <p style={{ color: '#dc2626', fontSize: 12, background: '#fef2f2', padding: 8, borderRadius: 4, margin: '0 0 10px' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        <div style={{ background: '#fff', padding: 10, borderRadius: 6, border: '1px solid #e5e7eb' }}>
          <span style={{ display: 'block', fontSize: 11, color: '#6b7280' }}>Active Requests</span>
          <strong style={{ fontSize: 14, color: '#111827' }}>
            {status ? `${status.activeRequests} / ${status.maxConcurrency}` : '—'}
          </strong>
        </div>

        <div style={{ background: '#fff', padding: 10, borderRadius: 6, border: '1px solid #e5e7eb' }}>
          <span style={{ display: 'block', fontSize: 11, color: '#6b7280' }}>Queued Requests</span>
          <strong style={{ fontSize: 14, color: '#111827' }}>
            {status ? status.queuedRequests : '—'}
          </strong>
        </div>

        <div style={{ background: '#fff', padding: 10, borderRadius: 6, border: '1px solid #e5e7eb' }}>
          <span style={{ display: 'block', fontSize: 11, color: '#6b7280' }}>Context Window</span>
          <strong style={{ fontSize: 14, color: '#111827' }}>{contextDisplay}</strong>
        </div>

        <div style={{ background: '#fff', padding: 10, borderRadius: 6, border: '1px solid #e5e7eb' }}>
          <span style={{ display: 'block', fontSize: 11, color: '#6b7280' }}>Capabilities</span>
          <strong style={{ fontSize: 14, color: '#111827' }}>{capabilitiesDisplay}</strong>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#4b5563' }}>
        <strong>Loaded Models: </strong>
        {status && status.runningModels.length > 0 ? (
          status.runningModels.map((m) => m.name).join(', ')
        ) : (
          <span style={{ color: '#9ca3af' }}>No model currently resident in GPU/memory</span>
        )}
      </div>
    </div>
  );
}
