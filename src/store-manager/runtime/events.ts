/**
 * Store Manager runtime event emission (epic #42, #40).
 *
 * Event types live in `contracts.ts`; this module provides the versioned
 * event sink plumbing used by the registry/executor. Persistence is handled
 * by the session repository; `createEventSink` buffers events for a turn and
 * flushes them once (so a terminal path always persists the complete ordered
 * sequence even when a later call fails).
 */

import type { StoreManagerRuntimeEvent } from './contracts';

export type { StoreManagerRuntimeEvent } from './contracts';

export interface StoreManagerEventSink {
  /** Record one event. Order is preserved. */
  record(event: StoreManagerRuntimeEvent): void;
  /** All events recorded so far (ordered). */
  snapshot(): readonly StoreManagerRuntimeEvent[];
  /** Durable flush to the session repository (idempotent). */
  flush(workspaceId: string): void;
  /** Whether the sink was already flushed. */
  get flushed(): boolean;
}

export interface StoreManagerEventPersister {
  persistEvents(workspaceId: string, events: readonly StoreManagerRuntimeEvent[]): void;
}

export function createEventSink(persister: StoreManagerEventPersister): StoreManagerEventSink {
  const events: StoreManagerRuntimeEvent[] = [];
  let didFlush = false;
  return {
    record(event) {
      events.push(event);
    },
    snapshot() {
      return events;
    },
    flush(workspaceId) {
      if (didFlush) return;
      didFlush = true;
      if (events.length > 0) persister.persistEvents(workspaceId, events);
    },
    get flushed() {
      return didFlush;
    },
  };
}
