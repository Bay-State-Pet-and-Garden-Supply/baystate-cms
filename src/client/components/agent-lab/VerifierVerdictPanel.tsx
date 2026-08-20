/** Verifier verdict and structured retry controls (story: e02s02). */
import React from 'react';
import type { PiRunProjection } from '../../product-intelligence-api';

interface Report {
  verdict?: string;
  identityStatus?: string;
  identityScore?: number;
  productDataDecision?: string;
  checks?: Array<{ checkName?: string; passed?: boolean; field?: string | null; details?: string }>;
  retryRequest?: { targetSpecialist?: string; reason?: string; suggestedAction?: string } | null;
}

function readReport(projection: PiRunProjection): Report | null {
  if (!projection.result) return null;
  try { return JSON.parse(projection.result.resultJson) as Report; } catch { return null; }
}

export function VerifierVerdictPanel({ projection }: { projection: PiRunProjection }) {
  const report = readReport(projection);
  if (!report) return null;
  const blocked = report.identityStatus !== 'verified' || (report.identityScore ?? 0) < 0.8;
  const citations = (report.checks ?? []).filter((check) => check.field || check.details);
  return <section aria-label="Verifier verdict" style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginTop: 12 }}>
    <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>Verification</h3>
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
      <span>Identity: <strong>{report.identityStatus ?? 'unknown'}</strong></span>
      <span>Product data: <strong>{report.productDataDecision ?? 'unknown'}</strong></span>
      <span>Overall: <strong>{blocked ? 'blocked' : (report.verdict ?? 'unknown')}</strong></span>
    </div>
    {blocked && <p style={{ color: '#b91c1c', fontSize: 12 }}>Low-confidence or unresolved identity blocks verification.</p>}
    {citations.length > 0 && <ul style={{ fontSize: 12 }}>{citations.map((check, index) => <li key={`${check.field ?? 'check'}-${index}`}>{check.field ?? check.checkName}: {check.details ?? (check.passed ? 'passed' : 'failed')}</li>)}</ul>}
    {report.retryRequest && <p style={{ background: '#fffbeb', padding: 8, fontSize: 12 }}>Retry requested: <strong>{report.retryRequest.targetSpecialist}</strong> — {report.retryRequest.reason}. {report.retryRequest.suggestedAction}</p>}
  </section>;
}
