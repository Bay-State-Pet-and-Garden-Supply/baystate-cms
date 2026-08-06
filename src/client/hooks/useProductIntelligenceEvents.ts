/**
 * useProductIntelligenceEvents — live SSE event stream hook (PI-7).
 *
 * Opens an EventSource on /api/product-intelligence/runs/:id/events/stream,
 * appends incoming PiLiveEvents (deduped by sequence), reconnects with
 * exponential backoff on error, and auto-closes when a terminal event is
 * received or the runId changes.
 */

import { useEffect, useRef, useState } from 'react';
import type { PiLiveEvent } from '../product-intelligence-api';
import { mergeEventStream, isTerminalEvent } from '../agent-lab/logic';

export type EventStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface UseEventsResult {
  events: PiLiveEvent[];
  status: EventStreamStatus;
  stop: () => void;
}

const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000];

export function useProductIntelligenceEvents(
  runId: string | null,
  opts?: { pollMs?: number },
): UseEventsResult {
  const [events, setEvents] = useState<PiLiveEvent[]>([]);
  const [status, setStatus] = useState<EventStreamStatus>('closed');
  const runIdRef = useRef<string | null>(null);
  const stoppedRef = useRef(false);
  const terminalRef = useRef(false);
  const cursorRef = useRef(-1);
  const backoffIdxRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useRef(() => {
    stoppedRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setStatus('closed');
  }).current;

  useEffect(() => {
    stoppedRef.current = false;
    terminalRef.current = false;
    cursorRef.current = -1;
    backoffIdxRef.current = 0;
    setEvents([]);
    runIdRef.current = runId;

    if (!runId) {
      setStatus('closed');
      return;
    }

    const WIRE_EVENT_TYPES = [
      'run.started', 'step.started', 'step.completed',
      'tool.started', 'tool.completed', 'result.updated',
      'run.completed', 'run.failed', 'run.cancelled',
      'source.added', 'evidence.added', 'conflict.detected',
      'asset.added', 'run.needs_review',
    ];

    const connect = () => {
      if (stoppedRef.current || terminalRef.current) return;
      if (runIdRef.current !== runId) return;

      const after = cursorRef.current;
      const pollMs = opts?.pollMs ?? 500;
      const url = `/api/product-intelligence/runs/${encodeURIComponent(runId)}/events/stream?after=${after}&pollMs=${pollMs}`;
      const es = new EventSource(url);
      esRef.current = es;
      setStatus('connecting');

      es.onopen = () => {
        if (stoppedRef.current) return;
        setStatus('live');
        backoffIdxRef.current = 0;
      };

      const handleMessage = (e: MessageEvent) => {
        if (stoppedRef.current) return;
        if (runIdRef.current !== runId) return;
        try {
          const event = JSON.parse(e.data) as PiLiveEvent;
          if (event.sequence > cursorRef.current) {
            cursorRef.current = event.sequence;
          }
          setEvents((prev) => mergeEventStream(prev, [event]));
          if (isTerminalEvent(event.type)) {
            terminalRef.current = true;
            es.close();
            esRef.current = null;
            setStatus('closed');
          }
        } catch {
          // ignore unparseable frames
        }
      };

      for (const type of WIRE_EVENT_TYPES) {
        es.addEventListener(type, handleMessage);
      }

      es.onerror = () => {
        if (stoppedRef.current || terminalRef.current) {
          es.close();
          esRef.current = null;
          return;
        }
        es.close();
        esRef.current = null;
        setStatus('reconnecting');
        const delay = BACKOFF_SCHEDULE[Math.min(backoffIdxRef.current, BACKOFF_SCHEDULE.length - 1)];
        backoffIdxRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      stoppedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
    // runId is the only dependency; opts is read once per connection.
  }, [runId]);

  return { events, status, stop };
}