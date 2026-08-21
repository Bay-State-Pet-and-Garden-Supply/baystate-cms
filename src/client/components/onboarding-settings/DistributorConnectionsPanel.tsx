import { useEffect, useState } from 'react';
import {
  getDistributorConnections,
  createDistributorConnection,
  updateDistributorConnection,
  getDistributors,
  type DistributorConnectionView,
} from '../../onboarding-api';

const styles: Record<string, React.CSSProperties> = {
  section: { marginBottom: 16 },
  card: {
    border: '1px solid #dee2e6',
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
    background: '#fff',
  },
  row: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
  input: {
    padding: '6px 10px',
    border: '1px solid #ced4da',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'inherit',
    flex: 1,
    minWidth: 140,
  },
  label: { fontSize: 12, color: '#495057', fontWeight: 600, minWidth: 110 },
  button: {
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    background: '#007bff',
    color: '#fff',
    fontSize: 13,
    cursor: 'pointer',
  },
  dangerButton: {
    padding: '6px 14px',
    borderRadius: 6,
    border: '1px solid #dc3545',
    background: '#fff',
    color: '#dc3545',
    fontSize: 13,
    cursor: 'pointer',
  },
  badge: { fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600 },
  banner: {
    background: '#fff3cd',
    border: '1px solid #ffc107',
    color: '#664d03',
    borderRadius: 6,
    padding: '10px 14px',
    fontSize: 13,
    marginBottom: 16,
  },
  hint: { fontSize: 12, color: '#6c757d', marginTop: 4 },
};

const CONNECTOR_TYPES = ['api', 'ftp_catalog', 'csv', 'html_scraper', 'legacy_adapter'] as const;

const HTML_SCRAPER_FIXED_CONFIG_NOTE =
  'Distributor Scrapers use code-fixed storefront URL, origins, selectors, login flow, and proxy policy — no base-URL override is offered.';

interface Props {
  engineEnabled: boolean;
  configurationReason?: string | null;
  initiallyOpen?: boolean;
  initialConnections?: DistributorConnectionView[];
  initiallyConfirmingId?: string | null;
}

/**
 * Distributor connections infrastructure panel (ADR 0014).
 * Advisory brand routing has been moved to the Brands & Sourcing Strategy Hub
 * (e08s03 parity-gated cleanup) — this surface now shows only connection
 * CRUD + health/enable + secretConfigured. Brand routing moved to Settings → Brands.
 */
export function DistributorConnectionsPanel({
  engineEnabled,
  configurationReason = null,
  initiallyOpen = false,
  initialConnections = [],
  initiallyConfirmingId = null,
}: Props) {
  const [connections, setConnections] = useState<DistributorConnectionView[]>(initialConnections);
  const [distributors, setDistributors] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showForm, setShowForm] = useState(initiallyOpen);
  const [distributorId, setDistributorId] = useState('');
  const [connectorType, setConnectorType] = useState<string>('api');
  const [secretRef, setSecretRef] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [configJson, setConfigJson] = useState('');
  const [authorityJson, setAuthorityJson] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editConfigJson, setEditConfigJson] = useState('');
  const [editAuthorityJson, setEditAuthorityJson] = useState('');
  const [confirmingEnableId, setConfirmingEnableId] = useState<string | null>(initiallyConfirmingId);

  async function refresh() {
    try {
      const [conns, dists] = await Promise.all([getDistributorConnections(), getDistributors()]);
      setConnections(conns.connections);
      setDistributors(dists.distributors);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load distributor settings');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const configuration: Record<string, unknown> = {};
      if (baseUrl.trim()) configuration.baseUrl = baseUrl.trim();
      if (configJson.trim()) Object.assign(configuration, JSON.parse(configJson) as Record<string, unknown>);
      let authorityPolicy: Record<string, unknown> | undefined;
      if (authorityJson.trim()) authorityPolicy = JSON.parse(authorityJson) as Record<string, unknown>;
      await createDistributorConnection({
        distributorId,
        connectorType: connectorType as DistributorConnectionView['connectorType'],
        secretRef: secretRef.trim() || null,
        configuration,
        authorityPolicy,
      });
      setShowForm(false);
      setSecretRef('');
      setBaseUrl('');
      setConfigJson('');
      setAuthorityJson('');
      setNotice('Connection created (disabled). Enable it after verifying fixture, credential, and health checks.');
      await refresh();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'Failed to create connection');
    }
  }

  async function handleSaveEdit(connection: DistributorConnectionView) {
    setError('');
    try {
      const patch: { configuration?: Record<string, unknown>; authorityPolicy?: Record<string, unknown> } = {};
      if (editConfigJson.trim()) patch.configuration = JSON.parse(editConfigJson) as Record<string, unknown>;
      if (editAuthorityJson.trim()) patch.authorityPolicy = JSON.parse(editAuthorityJson) as Record<string, unknown>;
      await updateDistributorConnection(connection.id, patch);
      setEditingId(null);
      setNotice('Connection updated.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update connection');
    }
  }

  function startEdit(connection: DistributorConnectionView) {
    setEditingId(connection.id);
    setEditConfigJson(JSON.stringify(connection.configuration ?? {}, null, 2));
    setEditAuthorityJson(JSON.stringify(connection.authorityPolicy ?? {}, null, 2));
  }

  async function handleDisable(connection: DistributorConnectionView) {
    try {
      await updateDistributorConnection(connection.id, { enabled: false });
      setConfirmingEnableId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update connection');
    }
  }

  async function handleConfirmEnable(connection: DistributorConnectionView) {
    try {
      await updateDistributorConnection(connection.id, { enabled: true });
      setConfirmingEnableId(null);
      setNotice('Connection enabled.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update connection');
    }
  }

  return (
    <div>
      {!engineEnabled && (
        <div style={styles.banner}>
          ⚠ Sourcing engine is <strong>disabled</strong> —{' '}
          {configurationReason ? `${configurationReason}. ` : 'distributor lookups do not run. '}
          Connections can still be configured here (the capability flag <code>BAYSTATE_CMS_SOURCING_ENABLED</code> must be
          enabled for the worker to use them).
        </div>
      )}

      {error && <div style={{ ...styles.banner, background: '#f8d7da', borderColor: '#f5c6cb', color: '#721c24' }}>{error}</div>}
      {notice && <div style={{ ...styles.banner, background: '#d1e7dd', borderColor: '#badbcc', color: '#0f5132' }}>{notice}</div>}

      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Distributor Connections</h3>
          <button style={styles.button} onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : '+ Add connection'}
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleCreate} style={styles.card}>
            <div style={styles.row}>
              <span style={styles.label}>Distributor</span>
              <input
                style={styles.input}
                list="distributor-options"
                placeholder="phillips | bci | orgill | ..."
                value={distributorId}
                onChange={(e) => setDistributorId(e.target.value)}
              />
              <datalist id="distributor-options">
                {distributors.map((d) => (
                  <option key={d.id} value={d.id} />
                ))}
              </datalist>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Connector type</span>
              <select style={styles.input} value={connectorType} onChange={(e) => setConnectorType(e.target.value)}>
                {CONNECTOR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            {connectorType === 'html_scraper' && (
              <div style={styles.row}>
                <span style={{ fontSize: 12, color: '#6c757d' }}>{HTML_SCRAPER_FIXED_CONFIG_NOTE}</span>
              </div>
            )}
            <div style={styles.row}>
              <span style={styles.label}>Secret ref</span>
              <input
                style={styles.input}
                placeholder="ENV_VAR_NAME or api_keys service name (never the key itself)"
                value={secretRef}
                onChange={(e) => setSecretRef(e.target.value)}
              />
            </div>
            {connectorType !== 'html_scraper' && (
              <div style={styles.row}>
                <span style={styles.label}>Base URL (optional)</span>
                <input
                  style={styles.input}
                  placeholder="https://api.provider.com/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
            )}
            <div style={styles.row}>
              <span style={styles.label}>Config JSON</span>
              <textarea
                style={{ ...styles.input, minHeight: 48, fontFamily: 'monospace', fontSize: 12 }}
                placeholder='{"pageSize": 100, "maxPages": 5}'
                value={configJson}
                onChange={(e) => setConfigJson(e.target.value)}
              />
            </div>
            <div style={styles.row}>
              <span style={styles.label}>Authority JSON</span>
              <textarea
                style={{ ...styles.input, minHeight: 48, fontFamily: 'monospace', fontSize: 12 }}
                placeholder='{"skuAuthority": true, "identityFieldOverrides": []}'
                value={authorityJson}
                onChange={(e) => setAuthorityJson(e.target.value)}
              />
            </div>
            <div style={styles.hint}>Raw credentials are never stored — only a reference is saved and resolved server-side.</div>
            <div style={styles.hint}>
              Connections are created <strong>disabled</strong> and activated only after fixture, credential, and health checks pass.
            </div>
            <div style={{ marginTop: 10 }}>
              <button type="submit" style={styles.button}>
                Create connection
              </button>
            </div>
          </form>
        )}

        {connections.length === 0 && !showForm && (
          <div style={{ color: '#6c757d', fontSize: 13 }}>No distributor connections configured.</div>
        )}

        {connections.map((conn) => (
          <div key={conn.id} style={styles.card}>
            <div style={styles.row}>
              <strong style={{ fontSize: 14 }}>{conn.distributorName || conn.distributorId}</strong>
              <span style={{ fontSize: 12, color: '#6c757d' }}>{conn.connectorType}</span>
              <span
                style={{
                  ...styles.badge,
                  background: conn.enabled ? '#d1e7dd' : '#e9ecef',
                  color: conn.enabled ? '#0f5132' : '#495057',
                }}
              >
                {conn.enabled ? 'enabled' : 'disabled'}
              </span>
              <span
                style={{
                  ...styles.badge,
                  background: conn.secretRequired ? (conn.secretConfigured ? '#d1e7dd' : '#f8d7da') : '#e9ecef',
                  color: conn.secretRequired ? (conn.secretConfigured ? '#0f5132' : '#721c24') : '#495057',
                }}
              >
                {conn.secretRequired ? (conn.secretConfigured ? 'secret configured' : 'secret missing') : 'no secret required'}
              </span>
            </div>
            <div style={styles.hint}>
              Base URL: {typeof conn.configuration?.baseUrl === 'string' ? conn.configuration.baseUrl : '(default)'} · Created{' '}
              {new Date(conn.createdAt).toLocaleString()}
            </div>
            {editingId === conn.id && (
              <div style={{ marginTop: 8 }}>
                <div style={styles.row}>
                  <span style={styles.label}>Config JSON</span>
                  <textarea
                    style={{ ...styles.input, minHeight: 48, fontFamily: 'monospace', fontSize: 12 }}
                    value={editConfigJson}
                    onChange={(e) => setEditConfigJson(e.target.value)}
                  />
                </div>
                <div style={styles.row}>
                  <span style={styles.label}>Authority JSON</span>
                  <textarea
                    style={{ ...styles.input, minHeight: 48, fontFamily: 'monospace', fontSize: 12 }}
                    value={editAuthorityJson}
                    onChange={(e) => setEditAuthorityJson(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={styles.button} onClick={() => handleSaveEdit(conn)}>
                    Save
                  </button>
                  <button style={styles.dangerButton} onClick={() => setEditingId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {conn.enabled ? (
                <button style={{ ...styles.button, background: '#6c757d' }} onClick={() => handleDisable(conn)}>
                  Disable
                </button>
              ) : (
                <button style={{ ...styles.button, background: '#6c757d' }} onClick={() => setConfirmingEnableId(conn.id)}>
                  Enable
                </button>
              )}
              <button style={{ ...styles.button, background: '#6c757d' }} onClick={() => startEdit(conn)}>
                Edit config
              </button>
            </div>
            {!conn.enabled && confirmingEnableId === conn.id && (
              <div
                style={{
                  marginTop: 8,
                  padding: '10px 12px',
                  borderRadius: 6,
                  background: '#fff3cd',
                  border: '1px solid #ffc107',
                  fontSize: 12,
                  color: '#664d03',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>⚠ Enable this connection for distributor lookups?</div>
                Verify fixture, credential, and health checks completed before activating.
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button style={styles.button} onClick={() => handleConfirmEnable(conn)}>
                    Confirm enable
                  </button>
                  <button style={styles.dangerButton} onClick={() => setConfirmingEnableId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        <div style={{ ...styles.hint, marginTop: 12, fontStyle: 'italic' }}>
          Brand routing moved to <strong>Settings → Brands</strong> (Brands & Sourcing Strategy Hub).
        </div>
      </div>
    </div>
  );
}
