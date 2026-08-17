import React, { useEffect, useState } from 'react';
import { getAiConfig } from '../../onboarding-api';
import {
  resolveWorkloadRoute,
  type AiRoutingConfig,
  type ModelTarget,
  type ResolvedWorkloadRoute,
} from '../../../ai/provider-connections';
import type { ConnectionHealthReport } from '../../../ai/connection-health-monitor';
import { colors, rounded } from '../../theme';

interface AiSummaryData {
  config: AiRoutingConfig;
  health: Record<string, ConnectionHealthReport>;
}

export interface AiRouteSummaryRow {
  label: string;
  route: ResolvedWorkloadRoute;
  inheritsPrimary: boolean;
  inheritsFallback: boolean;
}

const labelStyle: React.CSSProperties = { fontSize: '0.75rem', fontWeight: 600, color: '#8f8c81' };
const valueStyle: React.CSSProperties = { fontSize: '0.8125rem', color: colors.ledgerCharcoal };
const WORKLOAD_KEYS: Array<keyof AiRoutingConfig['workloads']> = [
  'discovery',
  'curation',
  'profileBuilder',
  'visionOcr',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isModelTarget(value: unknown): value is ModelTarget {
  return isRecord(value) && typeof value.connectionId === 'string' && typeof value.modelId === 'string';
}

function isRouteTarget(value: unknown): value is ModelTarget | 'inherit' {
  return value === 'inherit' || isModelTarget(value);
}

function isOptionalRouteTarget(value: unknown): boolean {
  return value === undefined || value === null || isRouteTarget(value);
}

function isValidAiConfig(value: unknown): value is AiRoutingConfig {
  if (!isRecord(value) || !isRecord(value.connections) || !isRecord(value.defaults) || !isRecord(value.workloads)) {
    return false;
  }
  if (!isModelTarget(value.defaults.catalogTarget) || !isOptionalRouteTarget(value.defaults.catalogFallback)) return false;
  const workloads = value.workloads;
  return WORKLOAD_KEYS.every((key) => {
    const route = workloads[key];
    return isRecord(route)
      && isRouteTarget(route.primary)
      && isOptionalRouteTarget(route.fallback)
      && 'terminalBehavior' in route;
  });
}

function targetLabel(config: AiRoutingConfig, target: ModelTarget): string {
  const conn = config.connections[target.connectionId];
  if (!conn) return `${target.connectionId} · ${target.modelId}`;
  return target.modelId ? `${conn.label} · ${target.modelId}` : conn.label;
}

/**
 * Derive the effective routes shown to onboarding operators. Keep workload
 * rows separate even when they happen to resolve to the same target: their
 * fallback, policy, and terminal behavior can still differ.
 */
export function deriveAiRouteSummaryRows(config: AiRoutingConfig): AiRouteSummaryRow[] {
  if (!isValidAiConfig(config)) throw new Error('AI routing configuration is incomplete.');

  const catalogFallback = config.defaults.catalogFallback ?? null;
  const rows: AiRouteSummaryRow[] = [{
    label: 'Catalog default',
    route: {
      primary: config.defaults.catalogTarget,
      fallback: catalogFallback,
      textDataSharing: config.defaults.textDataSharing,
      imageDataSharing: config.defaults.imageDataSharing,
      terminalBehavior: 'fail_closed',
    },
    inheritsPrimary: false,
    inheritsFallback: false,
  }];

  const labels: Record<keyof AiRoutingConfig['workloads'], string> = {
    discovery: 'Discovery',
    curation: 'Curation',
    profileBuilder: 'Profile Builder',
    visionOcr: 'Vision / OCR',
    storeManager: 'Store Manager',
  };

  for (const workload of WORKLOAD_KEYS) {
    const configured = config.workloads[workload];
    const route = resolveWorkloadRoute(workload, config);
    rows.push({
      label: labels[workload],
      route,
      inheritsPrimary: configured.primary === 'inherit',
      inheritsFallback: configured.fallback === 'inherit',
    });
  }
  return rows;
}

function HealthChip({ report }: { report?: ConnectionHealthReport }): React.ReactElement | null {
  if (!report) return null;
  const palette: Record<string, { color: string; label: string }> = {
    online: { color: colors.seedlingGreen, label: 'online' },
    unreachable: { color: colors.signetBurgundy, label: 'unreachable' },
    misconfigured: { color: colors.mutedGold, label: 'misconfigured' },
  };
  const meta = palette[report.status];
  if (!meta) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.6875rem', color: '#6B3A18' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color, display: 'inline-block' }} />
      {meta.label}
    </span>
  );
}

function RouteRow({ row, config, health }: {
  row: AiRouteSummaryRow;
  config: AiRoutingConfig;
  health: Record<string, ConnectionHealthReport>;
}): React.ReactElement {
  const fallback = row.route.fallback;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <span style={labelStyle}>{row.label}</span>
      <span style={valueStyle}>{targetLabel(config, row.route.primary)}</span>
      <HealthChip report={health[row.route.primary.connectionId]} />
      {row.inheritsPrimary && <span style={{ fontSize: '0.6875rem', color: '#8f8c81' }}>· inherits Catalog default</span>}
      {fallback && (
        <span style={{ ...valueStyle, fontSize: '0.75rem', color: '#6B3A18' }}>
          Fallback: {targetLabel(config, fallback)}
          <HealthChip report={health[fallback.connectionId]} />
          {row.inheritsFallback && ' · inherited'}
        </span>
      )}
    </div>
  );
}

/**
 * Read-only summary of the effective AI routes used by onboarding workloads.
 * Configuration lives in Settings → AI Compute; this component never mutates it
 * and fails soft if the config endpoint or response is unavailable.
 */
export function AiRouteSummary(): React.ReactElement {
  const [data, setData] = useState<AiSummaryData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAiConfig()
      .then((res) => {
        if (!isValidAiConfig(res?.config)) throw new Error('Invalid AI routing configuration.');
        if (!isRecord(res.health)) throw new Error('Invalid AI health response.');
        if (!cancelled) setData({ config: res.config, health: res.health as Record<string, ConnectionHealthReport> });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const manageLink = (
    <a
      href="/?view=settings&tab=ai"
      style={{ color: colors.signetBurgundy, fontSize: '0.8125rem', fontWeight: 600, textDecoration: 'none' }}
    >
      Manage AI Compute →
    </a>
  );

  let body: React.ReactNode;
  if (failed) {
    body = <span style={{ ...valueStyle, color: '#8f8c81', fontSize: '0.75rem' }}>Route summary unavailable.</span>;
  } else if (!data) {
    body = <span style={{ ...valueStyle, color: '#8f8c81', fontSize: '0.75rem' }}>Loading route summary…</span>;
  } else {
    const rows = (() => {
      try {
        return deriveAiRouteSummaryRows(data.config);
      } catch {
        return null;
      }
    })();
    body = rows ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((row) => <RouteRow key={row.label} row={row} config={data.config} health={data.health ?? {}} />)}
      </div>
    ) : (
      <span style={{ ...valueStyle, color: '#8f8c81', fontSize: '0.75rem' }}>Route summary unavailable.</span>
    );
  }

  return (
    <div
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: '0.75rem 1rem',
        marginBottom: '1rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8f8c81' }}>
          AI Compute Routes
        </span>
        {manageLink}
      </div>
      {body}
    </div>
  );
}
