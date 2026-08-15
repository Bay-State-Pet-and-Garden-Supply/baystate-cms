/**
 * SQLite Repository for Provider Connections and Workload Routes.
 */

import { getDb } from '../connection';
import type {
  ProviderConnection,
  AiRoutingConfig,
  WorkloadRoute,
  ModelTarget,
  AiTrustZone,
  AiTransport,
  DataSharingPolicy,
  TerminalBehavior,
} from '../../ai/provider-connections';
import {
  DEFAULT_BUILTIN_CONNECTIONS,
  buildEffectiveRoutingConfig,
} from '../../ai/provider-connections';

interface DbProviderConnection {
  id: string;
  label: string;
  transport: string;
  base_url: string;
  credential: string | null;
  trust_zone: string;
  approved_host: string;
  approved_port: number | null;
  enabled: number;
  connect_timeout_ms: number;
  inference_timeout_ms: number;
  created_at: string;
  updated_at: string;
}

interface DbWorkloadRoute {
  workload: string;
  primary_connection_id: string;
  primary_model_id: string;
  fallback_connection_id: string | null;
  fallback_model_id: string | null;
  text_data_sharing: string | null;
  image_data_sharing: string | null;
  terminal_behavior: string;
  created_at: string;
  updated_at: string;
}

export function upsertProviderConnection(conn: ProviderConnection): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO provider_connections (
      id, label, transport, base_url, credential, trust_zone,
      approved_host, approved_port, enabled, connect_timeout_ms,
      inference_timeout_ms, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      transport = excluded.transport,
      base_url = excluded.base_url,
      credential = excluded.credential,
      trust_zone = excluded.trust_zone,
      approved_host = excluded.approved_host,
      approved_port = excluded.approved_port,
      enabled = excluded.enabled,
      connect_timeout_ms = excluded.connect_timeout_ms,
      inference_timeout_ms = excluded.inference_timeout_ms,
      updated_at = excluded.updated_at
  `).run(
    conn.id,
    conn.label,
    conn.transport,
    conn.baseUrl,
    conn.credential ?? null,
    conn.trustZone,
    conn.approvedHost || (new URL(conn.baseUrl).hostname),
    conn.approvedPort ?? (new URL(conn.baseUrl).port ? parseInt(new URL(conn.baseUrl).port, 10) : null),
    conn.enabled ? 1 : 0,
    conn.connectTimeoutMs ?? 2000,
    conn.inferenceTimeoutMs ?? 60000,
    now,
    now,
  );
}

export function getProviderConnection(id: string): ProviderConnection | null {
  const db = getDb();
  const row = db.query('SELECT * FROM provider_connections WHERE id = ?').get(id) as DbProviderConnection | undefined;
  if (!row) return null;

  return {
    id: row.id,
    label: row.label,
    transport: row.transport as AiTransport,
    baseUrl: row.base_url,
    credential: row.credential,
    trustZone: row.trust_zone as AiTrustZone,
    approvedHost: row.approved_host,
    approvedPort: row.approved_port ?? undefined,
    enabled: Boolean(row.enabled),
    connectTimeoutMs: row.connect_timeout_ms,
    inferenceTimeoutMs: row.inference_timeout_ms,
  };
}

export function listProviderConnections(): ProviderConnection[] {
  const db = getDb();
  try {
    const rows = db.query('SELECT * FROM provider_connections ORDER BY id').all() as DbProviderConnection[];
    if (rows.length === 0) {
      return Object.values(DEFAULT_BUILTIN_CONNECTIONS);
    }
    return rows.map(row => ({
      id: row.id,
      label: row.label,
      transport: row.transport as AiTransport,
      baseUrl: row.base_url,
      credential: row.credential,
      trustZone: row.trust_zone as AiTrustZone,
      approvedHost: row.approved_host,
      approvedPort: row.approved_port ?? undefined,
      enabled: Boolean(row.enabled),
      connectTimeoutMs: row.connect_timeout_ms,
      inferenceTimeoutMs: row.inference_timeout_ms,
    }));
  } catch {
    return Object.values(DEFAULT_BUILTIN_CONNECTIONS);
  }
}

export function deleteProviderConnection(id: string): boolean {
  const db = getDb();
  const res = db.query('DELETE FROM provider_connections WHERE id = ?').run(id);
  return res.changes > 0;
}

export function upsertWorkloadRoute(workload: string, route: WorkloadRoute): void {
  const db = getDb();
  const now = new Date().toISOString();

  const primaryConnId = typeof route.primary === 'string' ? route.primary : route.primary.connectionId;
  const primaryModelId = typeof route.primary === 'string' ? 'inherit' : route.primary.modelId;

  let fallbackConnId: string | null = null;
  let fallbackModelId: string | null = null;

  if (route.fallback === 'inherit') {
    fallbackConnId = 'inherit';
    fallbackModelId = 'inherit';
  } else if (route.fallback) {
    fallbackConnId = route.fallback.connectionId;
    fallbackModelId = route.fallback.modelId;
  }

  db.query(`
    INSERT INTO ai_workload_routes (
      workload, primary_connection_id, primary_model_id,
      fallback_connection_id, fallback_model_id,
      text_data_sharing, image_data_sharing, terminal_behavior,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workload) DO UPDATE SET
      primary_connection_id = excluded.primary_connection_id,
      primary_model_id = excluded.primary_model_id,
      fallback_connection_id = excluded.fallback_connection_id,
      fallback_model_id = excluded.fallback_model_id,
      text_data_sharing = excluded.text_data_sharing,
      image_data_sharing = excluded.image_data_sharing,
      terminal_behavior = excluded.terminal_behavior,
      updated_at = excluded.updated_at
  `).run(
    workload,
    primaryConnId,
    primaryModelId,
    fallbackConnId,
    fallbackModelId,
    route.textDataSharing ?? null,
    route.imageDataSharing ?? null,
    route.terminalBehavior,
    now,
    now,
  );
}

export function getWorkloadRoute(workload: string): WorkloadRoute | null {
  const db = getDb();
  try {
    const row = db.query('SELECT * FROM ai_workload_routes WHERE workload = ?').get(workload) as DbWorkloadRoute | undefined;
    if (!row) return null;

    const primary: ModelTarget | 'inherit' = row.primary_connection_id === 'inherit'
      ? 'inherit'
      : { connectionId: row.primary_connection_id, modelId: row.primary_model_id };

    let fallback: ModelTarget | 'inherit' | null = null;
    if (row.fallback_connection_id === 'inherit') {
      fallback = 'inherit';
    } else if (row.fallback_connection_id && row.fallback_model_id) {
      fallback = { connectionId: row.fallback_connection_id, modelId: row.fallback_model_id };
    }

    return {
      primary,
      fallback,
      textDataSharing: (row.text_data_sharing as DataSharingPolicy) ?? undefined,
      imageDataSharing: (row.image_data_sharing as DataSharingPolicy) ?? undefined,
      terminalBehavior: row.terminal_behavior as TerminalBehavior,
    };
  } catch {
    return null;
  }
}

export function getFullAiRoutingConfig(): AiRoutingConfig {
  const connectionsList = listProviderConnections();
  const connections: Record<string, ProviderConnection> = {};
  for (const c of connectionsList) {
    connections[c.id] = c;
  }

  const effective = buildEffectiveRoutingConfig();

  const discovery = getWorkloadRoute('discovery') ?? effective.workloads.discovery;
  const curation = getWorkloadRoute('curation') ?? effective.workloads.curation;
  const visionOcr = getWorkloadRoute('visionOcr') ?? effective.workloads.visionOcr;
  const profileBuilder = getWorkloadRoute('profileBuilder') ?? effective.workloads.profileBuilder;
  const storeManager = getWorkloadRoute('storeManager') ?? effective.workloads.storeManager;

  return {
    connections,
    defaults: effective.defaults,
    workloads: {
      discovery,
      curation,
      visionOcr,
      profileBuilder,
      storeManager,
    },
  };
}
