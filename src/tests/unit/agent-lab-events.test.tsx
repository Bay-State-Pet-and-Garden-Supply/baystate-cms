// @vitest-environment jsdom
/**
 * Agent Lab SSE hook tests (PI-7) — reconnect behavior with a stubbed
 * EventSource: cursor-based replay after reconnect, backoff cap, terminal
 * stop, stale-runId guard, and cross-sequence dedupe.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useProductIntelligenceEvents } from '../../client/hooks/useProductIntelligenceEvents';
import type { PiLiveEvent } from '../../client/product-intelligence-api';

/** Minimal EventSource stand-in recording instances and dispatching frames. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(e: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: { data: string }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    const cbs = this.listeners.get(type);
    if (cbs) for (const cb of cbs) cb({ data: JSON.stringify(data) });
  }

  fail() {
    if (this.onerror) this.onerror();
  }
}

function fakeEvent(sequence: number, type: string, payload: unknown = {}): PiLiveEvent {
  return { runId: 'run-1', sequence, type, payload, createdAt: '2026-01-01T00:00:00Z' };
}

/** Harness component exposing the hook's state through a ref. */
function Harness({ runId, pollMs, onState }: { runId: string | null; pollMs?: number; onState: (s: { events: PiLiveEvent[]; status: string }) => void }) {
  const { events, status } = useProductIntelligenceEvents(runId, pollMs !== undefined ? { pollMs } : undefined);
  useEffect(() => {
    onState({ events, status });
  }, [events, status, onState]);
  return null;
}

function mountHarness(runId: string | null, pollMs?: number) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let latest = { events: [] as PiLiveEvent[], status: 'closed' };
  const onState = (s: { events: PiLiveEvent[]; status: string }) => {
    latest = s;
  };
  act(() => {
    root.render(<Harness runId={runId} pollMs={pollMs} onState={onState} />);
  });
  return {
    latest: () => latest,
    root,
    container,
    rerender: (newRunId: string | null) => {
      act(() => {
        root.render(<Harness runId={newRunId} pollMs={pollMs} onState={onState} />);
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  FakeEventSource.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useProductIntelligenceEvents', () => {
  it('connects with after=-1 and flips to live on open', () => {
    const h = mountHarness('run-1');
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain('/runs/run-1/events/stream?after=-1&pollMs=500');
    act(() => {
      FakeEventSource.instances[0].onopen?.();
    });
    expect(h.latest().status).toBe('live');
    h.unmount();
  });

  it('appends events, advances the cursor, and dedupes by sequence', () => {
    const h = mountHarness('run-1');
    const es = FakeEventSource.instances[0];
    act(() => {
      es.emit('run.started', fakeEvent(0, 'run.started'));
      es.emit('tool.started', fakeEvent(1, 'tool.started'));
      es.emit('tool.started', fakeEvent(1, 'tool.started')); // duplicate
    });
    expect(h.latest().events).toHaveLength(2);
    expect(h.latest().events.map((e) => e.sequence)).toEqual([0, 1]);
    h.unmount();
  });

  it('reconnects after an error using the advanced cursor (replay safety)', () => {
    vi.useFakeTimers();
    const h = mountHarness('run-1');
    const es0 = FakeEventSource.instances[0];
    act(() => {
      es0.emit('run.started', fakeEvent(0, 'run.started'));
      es0.emit('evidence.added', fakeEvent(3, 'evidence.added', { field: 'title' }));
    });
    act(() => {
      es0.fail();
    });
    expect(h.latest().status).toBe('reconnecting');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain('after=3');
    h.unmount();
  });

  it('caps the reconnect backoff at 8s', () => {
    vi.useFakeTimers();
    const h = mountHarness('run-1');
    let es = FakeEventSource.instances[0];
    for (let i = 0; i < 6; i++) {
      act(() => {
        es.fail();
      });
      act(() => {
        vi.advanceTimersByTime(8000);
      });
      es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    }
    // 1 initial + 6 reconnects, all capped at 8s so the schedule never grows unbounded
    expect(FakeEventSource.instances.length).toBe(7);
    h.unmount();
  });

  it('stops reconnecting after a terminal event and never resurrects', () => {
    vi.useFakeTimers();
    const h = mountHarness('run-1');
    const es0 = FakeEventSource.instances[0];
    act(() => {
      es0.emit('run.completed', fakeEvent(5, 'run.completed', { outcome: 'submitted' }));
    });
    expect(h.latest().status).toBe('closed');
    expect(es0.closed).toBe(true);
    // A late error must not schedule a reconnect.
    act(() => {
      es0.fail();
      vi.advanceTimersByTime(16000);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    h.unmount();
  });

  it('ignores frames from a stale run connection after runId changes', () => {
    const h = mountHarness('run-1');
    const oldEs = FakeEventSource.instances[0];
    h.rerender('run-2');
    expect(oldEs.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => {
      oldEs.emit('run.started', fakeEvent(0, 'run.started'));
    });
    expect(h.latest().events).toHaveLength(0);
    h.unmount();
  });

  it('returns closed status for a null runId', () => {
    const h = mountHarness(null);
    expect(h.latest().status).toBe('closed');
    expect(FakeEventSource.instances).toHaveLength(0);
    h.unmount();
  });
});
