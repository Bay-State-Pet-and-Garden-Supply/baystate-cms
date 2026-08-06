/**
 * AgentStepDetails — selected tool call details (PI-7).
 */

import React from 'react';
import type { PiToolCallRow } from '../../product-intelligence-api';

interface Props {
  toolCalls: PiToolCallRow[];
  sequence: number | null;
}

export function AgentStepDetails({ toolCalls, sequence }: Props) {
  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    row: { fontSize: 13, color: '#4b5563', marginBottom: 4 },
    label: { fontWeight: 600, color: '#374151' },
    error: { fontSize: 13, color: '#dc2626', background: '#fef2f2', padding: 8, borderRadius: 6, marginTop: 8, whiteSpace: 'pre-wrap' as const },
    empty: { fontSize: 13, color: '#9ca3af' },
  };

  if (sequence === null) {
    return (
      <div style={styles.card}>
        <p style={styles.empty}>Select a tool call from the timeline to inspect it.</p>
      </div>
    );
  }

  const call = toolCalls.find((t) => t.sequence === sequence);
  if (!call) {
    return (
      <div style={styles.card}>
        <p style={styles.empty}>No tool call found for this event.</p>
      </div>
    );
  }

  const latency = call.latencyMs != null ? `${call.latencyMs}ms` : '-';
  const hasError = call.errorJson != null && call.errorJson !== '';
  let formattedError: string | null = null;
  if (hasError && call.errorJson) {
    try {
      formattedError = JSON.stringify(JSON.parse(call.errorJson), null, 2);
    } catch {
      formattedError = call.errorJson;
    }
  }

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>🔧 {call.toolName}</h3>
      <div style={styles.row}><span style={styles.label}>Started:</span> {call.startedAt ? new Date(call.startedAt).toLocaleTimeString() : '-'}</div>
      <div style={styles.row}><span style={styles.label}>Completed:</span> {call.completedAt ? new Date(call.completedAt).toLocaleTimeString() : '-'}</div>
      <div style={styles.row}><span style={styles.label}>Latency:</span> {latency}</div>
      <div style={styles.row}><span style={styles.label}>Policy:</span> {call.policyOutcome}</div>
      {call.costUsd != null && (
        <div style={styles.row}><span style={styles.label}>Cost:</span> ${call.costUsd.toFixed(6)}</div>
      )}
      {hasError && formattedError && (
        <pre style={styles.error}>{formattedError}</pre>
      )}
    </div>
  );
}