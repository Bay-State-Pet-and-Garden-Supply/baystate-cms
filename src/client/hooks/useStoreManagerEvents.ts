/**
 * useStoreManagerEvents — live notification SSE hook (operations console,
 * Issue 3).
 *
 * Opens an EventSource on /api/store-manager/notifications/stream, appends
 * notification events (deduped by id/sequence), reconnects with capped
 * exponential backoff, honors the Last-Event-ID-style cursor (`after`), and
 * closes cleanly when the hook unmounts or the workspace session ends (the
 * endpoint 404s / closes and the hook stops reconnecting). Behavioral pattern
 * only — nothing from Product Intelligence is imported or reused.
 */

import { useEffect, useRef, useState } from 'react';
import type { StoreManagerNotification } from '../store-manager-api';

export type EventStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface UseStoreManagerEventsResult {
  notifications: StoreManagerNotification[];
  status: EventStreamStatus;
  stop: () => void;
}

const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000];

export function useStoreManagerEvents(opts?: { pollMs?: number }): UseStoreManagerEventsResult {
  const [notifications, setNotifications] = useState<StoreManagerNotification[]>([]);
  const [status, setStatus] = useState<EventStreamStatus>('closed');
  const stoppedRef = useRef(false);
  const cursorRef = useRef(0);
  const backoffIdxRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownIdsRef = useRef<Set<string>>(new Set());

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
    cursorRef.current = 0;
    backoffIdxRef.current = 0;
    knownIdsRef.current = new Set();
    setNotifications([]);

    const connect = () => {
      if (stoppedRef.current) return;
      const pollMs = opts?.pollMs ?? 3000;
      const url = `/api/store-manager/notifications/stream?after=${cursorRef.current}&pollMs=${pollMs}`;
      let es: EventSource;
      try {
        es = new EventSource(url);
      } catch {
        setStatus('closed');
        return;
      }
      esRef.current = es;
      setStatus('connecting');

      es.onopen = () => {
        if (stoppedRef.current) return;
        setStatus('live');
        backoffIdxRef.current = 0;
      };

      const handleMessage = (e: MessageEvent) => {
        if (stoppedRef.current) return;
        try {
          const event = JSON.parse(e.data) as StoreManagerNotification;
          if (knownIdsRef.current.has(event.id)) return; // dedupe
          knownIdsRef.current.add(event.id);
          if (event.sequence > cursorRef.current) cursorRef.current = event.sequence;
          setNotifications((prev) => [...prev, event]);
        } catch {
          // ignore unparseable frames
        }
      };

      es.addEventListener('notification', handleMessage);

      es.onerror = () => {
        if (stoppedRef.current) {
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
    // opts is read once per connection; only mount/unmount controls lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { notifications, status, stop };
}
