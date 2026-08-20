// story: e06s01 — evidence rail placeholder (shell)
export function EvidenceRail(): React.ReactElement {
  return (
    <aside aria-label="Evidence">
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, background: '#fff' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Evidence</div>
        <div style={{ fontSize: 13, color: '#6b7280' }}>Selected product preview, screenshot, JSON-LD signals — populated in e06s02+.</div>
      </div>
    </aside>
  );
}
