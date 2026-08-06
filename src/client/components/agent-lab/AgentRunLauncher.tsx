/**
 * AgentRunLauncher — form to create a new PI run (PI-7).
 */

import React, { useState } from 'react';
import { createPiRun } from '../../product-intelligence-api';
import { validateRunLaunch, buildRunLaunchPayload } from '../../agent-lab/logic';

interface Props {
  onCreated: (runId: string) => void;
  onCancel: () => void;
}

export function AgentRunLauncher({ onCreated, onCancel }: Props) {
  const [gtin, setGtin] = useState('');
  const [registerName, setRegisterName] = useState('');
  const [brandHint, setBrandHint] = useState('');
  const [departmentHint, setDepartmentHint] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  const handleSubmit = async () => {
    setServerError(null);
    const qtyNum = quantity.trim() === '' ? undefined : Number(quantity);
    const result = validateRunLaunch({
      gtin,
      registerName,
      price: price.trim() === '' ? undefined : price,
      quantity: qtyNum,
    });
    if (!result.valid) {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    setSubmitting(true);
    try {
      const payload = buildRunLaunchPayload({
        gtin,
        registerName,
        brandHint: brandHint.trim() || undefined,
        departmentHint: departmentHint.trim() || undefined,
        price: price.trim() || undefined,
        quantity: qtyNum,
      });
      const res = await createPiRun(payload);
      onCreated(res.runId);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 20 },
    title: { fontSize: 18, fontWeight: 600, margin: 0, marginBottom: 20, color: '#111827' },
    field: { marginBottom: 16 },
    label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 },
    input: { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const },
    hint: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
    btnRow: { display: 'flex', gap: 10, marginTop: 16 },
    primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    secondaryBtn: { background: '#fff', border: '1px solid #d1d5db', color: '#4b5563', borderRadius: 6, padding: '8px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    error: { color: '#dc2626', fontSize: 13, marginTop: 8 },
    issue: { color: '#dc2626', fontSize: 13, marginTop: 2 },
    issueList: { marginBottom: 12 },
    note: { fontSize: 12, color: '#6b7280', marginTop: 12, fontStyle: 'italic' },
  };

  return (
    <div style={styles.card}>
      <h2 style={styles.title}>New Product Research Run</h2>

      {issues.length > 0 && (
        <div style={styles.issueList}>
          {issues.map((issue, i) => (
            <p key={i} style={styles.issue}>⚠ {issue}</p>
          ))}
        </div>
      )}

      {serverError && <p style={styles.error}>Server error: {serverError}</p>}

      <div style={styles.field}>
        <label style={styles.label}>UPC / GTIN *</label>
        <input style={styles.input} value={gtin} onChange={(e) => setGtin(e.target.value)} placeholder="e.g. 039978004012" />
        <div style={styles.hint}>8-14 digit UPC/GTIN as printed on the package.</div>
      </div>
      <div style={styles.field}>
        <label style={styles.label}>Register name *</label>
        <input style={styles.input} value={registerName} onChange={(e) => setRegisterName(e.target.value)} placeholder="e.g. STELLA CHKN BROTH 16OZ" />
      </div>
      <div style={styles.field}>
        <label style={styles.label}>Brand hint</label>
        <input style={styles.input} value={brandHint} onChange={(e) => setBrandHint(e.target.value)} placeholder="Optional" />
      </div>
      <div style={styles.field}>
        <label style={styles.label}>Department hint</label>
        <input style={styles.input} value={departmentHint} onChange={(e) => setDepartmentHint(e.target.value)} placeholder="Optional" />
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label}>Price</label>
          <input style={styles.input} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 3.99" />
        </div>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label}>Quantity</label>
          <input style={styles.input} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 12" />
        </div>
      </div>

      <div style={styles.btnRow}>
        <button style={styles.primaryBtn} disabled={submitting} onClick={handleSubmit}>
          {submitting ? 'Starting…' : 'Start run'}
        </button>
        <button style={styles.secondaryBtn} onClick={onCancel} disabled={submitting}>Cancel</button>
      </div>
      <p style={styles.note}>One product at a time in this release.</p>
    </div>
  );
}