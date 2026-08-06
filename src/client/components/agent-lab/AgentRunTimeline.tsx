/**
 * AgentRunTimeline — live vertical timeline of events (PI-7).
 * Auto-scrolls to bottom; click a tool item to open step details.
 */

import React, { useEffect, useRef } from 'react';
import type { PiLiveEvent } from '../../product-intelligence-api';
import { toTimelineItems, isTerminalEvent, type EventTone } from '../../agent-lab/logic';

interface Props {
  events: PiLiveEvent[];
  onToolSelect?: (sequence: number) => void;
}

const TONE_COLORS: Record<EventTone, { background: string; color: string; border: string }> = {
  info: { background: '#eff6ff', color: '#2563eb', border: '#bfdbfe' },
  ok: { background: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
  warn: { background: '#fef3c7', color: '#92400e', border: '#fcd34d' },
  error: { background: '#fef2f2', color: '#dc2626', border: '#fecaca' },
};

export function AgentRunTimeline({ events, onToolSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = toTimelineItems(events);
  const hasTerminal = events.some((e) => isTerminalEvent(e.type));

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length]);

  const styles: Record<string, React.CSSProperties> = {
    container: { overflowY: 'auto' as const, flex: 1, minHeight: 200 },
    item: { display: 'flex', gap: 8, padding: '4px 0', cursor: 'default' },
    icon: { fontSize: 14, flexShrink: 0, marginTop: 2 },
    content: { flex: 1 },
    label: { fontSize: 13, fontWeight: 600 },
    detail: { fontSize: 12, color: '#6b7280', marginTop: 2 },
    timestamp: { fontSize: 11, color: '#9ca3af' },
    terminalBanner: { padding: 12, borderRadius: 8, background: '#f3f4f6', color: '#4b5563', fontSize: 13, fontWeight: 600, textAlign: 'center' as const, marginTop: 8 },
  };

  return (
    <div ref={scrollRef} style={styles.container}>
      {items.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
          No events yet. Waiting for run to start…
        </div>
      )}
      {items.map((item) => {
        const colors = TONE_COLORS[item.tone];
        const isTool = item.type === 'tool.started' || item.type === 'tool.completed';
        return (
          <div
            key={item.key}
            style={{
              ...styles.item,
              cursor: isTool && onToolSelect ? 'pointer' : 'default',
            }}
            onClick={isTool && onToolSelect ? () => onToolSelect(item.sequence) : undefined}
          >
            <span style={styles.icon}>{item.icon}</span>
            <div style={styles.content}>
              <span style={{ ...styles.label, color: colors.color }}>{item.label}</span>
              <span style={{ ...styles.timestamp, marginLeft: 8 }}>
                {new Date(item.timestamp).toLocaleTimeString()}
              </span>
              {item.detail && (
                <div style={{ ...styles.detail, color: colors.color, opacity: 0.8 }}>
                  {item.detail}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {hasTerminal && (
        <div style={styles.terminalBanner}>Run finished — event stream closed.</div>
      )}
    </div>
  );
}