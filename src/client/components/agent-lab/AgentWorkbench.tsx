/**
 * Agent Lab: Agent Workbench.
 *
 * Interactive playground for testing agent versions, inspecting real-time
 * structured research proposals, and initiating the correction & teaching loop.
 */
import React, { useState } from 'react';
import {
  createPiRun,
  type AgentVersionSummary,
  type ProductIntelligenceFlags,
} from '../../product-intelligence-api';
import { AgentRunInspector } from './AgentRunInspector';
import { TeachModal } from './TeachModal';

export interface AgentWorkbenchProps {
  activeVersion: AgentVersionSummary | null;
  candidateVersion: AgentVersionSummary | null;
  flags: ProductIntelligenceFlags;
  onVersionUpdated: (version: AgentVersionSummary) => void;
}

export function AgentWorkbench({
  activeVersion,
  candidateVersion,
  flags: _flags,
  onVersionUpdated,
}: AgentWorkbenchProps) {
  const [sku, setSku] = useState('BLUE-076280014028');
  const [name, setName] = useState('BLUE BUFF CAN DOG 12.5OZ');
  const [brandHint, setBrandHint] = useState('Blue Buffalo');
  const [departmentHint, setDepartmentHint] = useState('Dog Food');
  const [price, setPrice] = useState('3.49');
  const [quantity, setQuantity] = useState('1');

  const [selectedVersionId, setSelectedVersionId] = useState<string>(
    candidateVersion?.snapshot.id ?? activeVersion?.snapshot.id ?? '',
  );

  const [isRunning, setIsRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTeachModalOpen, setIsTeachModalOpen] = useState(false);

  // Sync default selection if candidate version changes
  React.useEffect(() => {
    if (candidateVersion && !selectedVersionId) {
      setSelectedVersionId(candidateVersion.snapshot.id);
    } else if (activeVersion && !selectedVersionId) {
      setSelectedVersionId(activeVersion.snapshot.id);
    }
  }, [candidateVersion, activeVersion, selectedVersionId]);

  async function handleLaunchRun(e: React.FormEvent) {
    e.preventDefault();
    if (!sku.trim() || !name.trim() || !price.trim()) {
      setError('Please provide SKU, product name, and price');
      return;
    }

    setIsRunning(true);
    setError(null);
    setActiveRunId(null);

    try {
      const res = await createPiRun({
        sku: sku.trim(),
        name: name.trim(),
        brandHint: brandHint.trim() || undefined,
        departmentHint: departmentHint.trim() || undefined,
        price: price.trim() || undefined,
        quantity: quantity ? Number(quantity) : undefined,
        mode: 'interactive',
        agentVersionSnapshotId: selectedVersionId || undefined,
      });

      setActiveRunId(res.runId);
    } catch (err: any) {
      setError(err.message || 'Failed to start research run');
    } finally {
      setIsRunning(false);
    }
  }

  const isCandidateSelected =
    candidateVersion && selectedVersionId === candidateVersion.snapshot.id;

  const styles: Record<string, React.CSSProperties> = {
    container: { display: 'flex', flexDirection: 'column', gap: 20 },
    topCard: {
      background: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      padding: 20,
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    },
    formGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: 12,
      marginBottom: 16,
    },
    label: { fontSize: 11, fontWeight: 600, color: '#4b5563', textTransform: 'uppercase', marginBottom: 4, display: 'block' },
    input: {
      width: '100%',
      padding: '8px 10px',
      borderRadius: 6,
      border: '1px solid #d1d5db',
      fontSize: 13,
      boxSizing: 'border-box',
    },
    select: {
      width: '100%',
      padding: '8px 10px',
      borderRadius: 6,
      border: '1px solid #d1d5db',
      fontSize: 13,
      background: '#fff',
      boxSizing: 'border-box',
    },
    actionRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, borderTop: '1px solid #f3f4f6' },
    versionBadge: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 600,
      background: isCandidateSelected ? '#eff6ff' : '#f0fdf4',
      color: isCandidateSelected ? '#1d4ed8' : '#15803d',
      border: `1px solid ${isCandidateSelected ? '#bfdbfe' : '#bbf7d0'}`,
    },
    btnRun: {
      background: '#2563eb',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '8px 20px',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    inspectorContainer: {
      background: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      overflow: 'hidden',
    },
    emptyState: {
      padding: '60px 20px',
      textAlign: 'center',
      color: '#6b7280',
      background: '#fafafa',
      borderRadius: 10,
      border: '1px dashed #d1d5db',
    },
  };

  return (
    <div style={styles.container}>
      <div style={styles.topCard}>
        <form onSubmit={handleLaunchRun}>
          <div style={styles.formGrid}>
            <div>
              <label style={styles.label}>Supplier SKU *</label>
              <input
                style={styles.input}
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="e.g. BLUE-076280014028"
              />
            </div>
            <div>
              <label style={styles.label}>Product Name *</label>
              <input
                style={styles.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. BLUE BUFF CAN DOG 12.5OZ"
              />
            </div>
            <div>
              <label style={styles.label}>Brand Hint</label>
              <input
                style={styles.input}
                value={brandHint}
                onChange={(e) => setBrandHint(e.target.value)}
                placeholder="e.g. Blue Buffalo"
              />
            </div>
            <div>
              <label style={styles.label}>Department</label>
              <input
                style={styles.input}
                value={departmentHint}
                onChange={(e) => setDepartmentHint(e.target.value)}
                placeholder="e.g. Dog Food"
              />
            </div>
            <div>
              <label style={styles.label}>Price ($)</label>
              <input
                style={styles.input}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="e.g. 3.49"
              />
            </div>
            <div>
              <label style={styles.label}>Quantity</label>
              <input
                style={styles.input}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="e.g. 1"
              />
            </div>
            <div>
              <label style={styles.label}>Target Agent Version</label>
              <select
                style={styles.select}
                value={selectedVersionId}
                onChange={(e) => setSelectedVersionId(e.target.value)}
              >
                {activeVersion && (
                  <option value={activeVersion.snapshot.id}>
                    v{activeVersion.snapshot.versionNumber}.{activeVersion.snapshot.revisionNumber} (Active Baseline)
                  </option>
                )}
                {candidateVersion && (
                  <option value={candidateVersion.snapshot.id}>
                    v{candidateVersion.snapshot.versionNumber}.{candidateVersion.snapshot.revisionNumber} (Candidate {candidateVersion.state.lifecycleStatus})
                  </option>
                )}
              </select>
            </div>
          </div>

          {error && (
            <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={styles.actionRow}>
            <div style={styles.versionBadge}>
              <span>{isCandidateSelected ? '🧪 Candidate Sandbox' : '🛡️ Active Production Agent'}</span>
              <span>•</span>
              <span>{isCandidateSelected ? 'Import blocked' : 'Import eligible'}</span>
            </div>

            <button type="submit" style={styles.btnRun} disabled={isRunning}>
              {isRunning ? 'Running Research…' : '⚡ Run Workbench Research'}
            </button>
          </div>
        </form>
      </div>

      {activeRunId ? (
        <div style={styles.inspectorContainer}>
          <div style={{ padding: '12px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>
              🔬 Live Workbench Inspector — Run {activeRunId.slice(0, 8)}
            </span>
            <button
              onClick={() => setIsTeachModalOpen(true)}
              style={{
                background: '#4f46e5',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span>🎓</span> Correct & Teach
            </button>
          </div>
          <AgentRunInspector runId={activeRunId} onBack={() => setActiveRunId(null)} />
        </div>
      ) : (
        <div style={styles.emptyState}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔬</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
            Ready to test product research
          </div>
          <div style={{ fontSize: 13, maxWidth: 440, margin: '0 auto' }}>
            Enter a supplier SKU, product name, and price above and click <strong>Run Workbench Research</strong> to execute a live research session. GTIN/UPC is discovered evidence.
          </div>
        </div>
      )}

      {activeRunId && (
        <TeachModal
          isOpen={isTeachModalOpen}
          onClose={() => setIsTeachModalOpen(false)}
          onSuccess={(v) => {
            onVersionUpdated(v);
            setSelectedVersionId(v.snapshot.id);
          }}
          runId={activeRunId}
          versionId={selectedVersionId}
          originalResultHash="mock-hash"
          initialGtin={sku}
          initialRegisterName={name}
          initialBrand={brandHint}
        />
      )}
    </div>
  );
}
