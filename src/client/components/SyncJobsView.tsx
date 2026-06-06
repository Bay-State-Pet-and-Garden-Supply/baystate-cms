import React, { useState, useEffect } from 'react';
import { listSyncJobs, getSyncJobDetail, type SyncJob, type SyncJobDetail } from '../api';

export function SyncJobsView() {
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<SyncJobDetail | null>(null);
  const [error, setError] = useState('');

  const fetch = async () => {
    try {
      const res = await listSyncJobs();
      setJobs(res.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { fetch(); }, []);

  const handleSelect = async (id: string) => {
    try {
      const res = await getSyncJobDetail(id);
      setSelectedJob(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const statusStyle = (s: string): React.CSSProperties => ({
    padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, color: '#fff',
    background: s === 'succeeded' ? '#16a34a' : s === 'failed' ? '#dc2626' : s === 'running' ? '#f59e0b' : '#6b7280',
  });

  const kindLabel = (k: string): string => {
    const labels: Record<string, string> = {
      push_publish: 'Push & Publish',
      upload_only: 'Upload Only',
      pull_drift: 'Drift Check',
      full_reconcile: 'Full Reconcile',
      bootstrap: 'Bootstrap',
    };
    return labels[k] ?? k;
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 16 },
    row: { display: 'flex', gap: 24 },
    col: { flex: 1 },
    list: { border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
    listItem: { padding: '12px 16px', borderBottom: '1px solid #e5e7eb', cursor: 'pointer', fontSize: 14 },
    activeItem: { padding: '12px 16px', borderBottom: '1px solid #e5e7eb', cursor: 'pointer', fontSize: 14, background: '#eff6ff' },
    detailCard: { border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    error: { color: '#dc2626', padding: 8, background: '#fef2f2', borderRadius: 4, margin: '8px 0', fontSize: 13 },
    eventItem: { padding: '6px 0', borderBottom: '1px dashed #f3f4f6', fontSize: 13 },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Sync Jobs</h1>
      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.row}>
        <div style={styles.col}>
          <div style={styles.list}>
            {jobs.length === 0 && <p style={{ padding: 16, color: '#9ca3af' }}>No sync jobs yet.</p>}
            {jobs.map(job => (
              <div
                key={job.id}
                style={selectedJob?.job?.id === job.id ? styles.activeItem : styles.listItem}
                onClick={() => handleSelect(job.id)}
              >
                <div>
                  <strong>{kindLabel(job.kind)}</strong>
                  <span style={{ marginLeft: 8 }}><span style={statusStyle(job.status)}>{job.status}</span></span>
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  {job.startedAt?.slice(0, 19) ?? '—'} | {job.productCount} product(s)
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: 2 }}>
          {selectedJob && (
            <div style={styles.detailCard}>
              <h3 style={{ margin: '0 0 12px' }}>
                {kindLabel(selectedJob.job.kind)}
                <span style={{ marginLeft: 8 }}><span style={statusStyle(selectedJob.job.status)}>{selectedJob.job.status}</span></span>
              </h3>
              <div style={{ fontSize: 13, marginBottom: 16 }}>
                <div>Started: {selectedJob.job.startedAt?.slice(0, 19) ?? '—'}</div>
                <div>Completed: {selectedJob.job.completedAt?.slice(0, 19) ?? '—'}</div>
                <div>Products: {selectedJob.job.productCount}</div>
                {selectedJob.job.errorSummary && (
                  <div style={{ color: '#dc2626', marginTop: 4 }}>Error: {selectedJob.job.errorSummary}</div>
                )}
              </div>

              <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Events</h4>
              {selectedJob.events.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13 }}>No events recorded.</p>}
              {selectedJob.events.map(evt => (
                <div key={evt.id} style={styles.eventItem}>
                  <span style={{
                    display: 'inline-block', width: 60, fontSize: 11, color: '#6b7280',
                  }}>{evt.createdAt.slice(11, 19)}</span>
                  <span style={{
                    display: 'inline-block', width: 60, fontSize: 11,
                    color: evt.level === 'error' ? '#dc2626' : evt.level === 'warning' ? '#f59e0b' : '#16a34a',
                  }}>{evt.level}</span>
                  <span>{evt.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
