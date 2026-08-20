// story: e06s01 — history shell (empty-state now, immutable versions populated in e06s04)
export function HistoryShell({ versions = [] }: { versions?: Array<{ id: string }> }): React.ReactElement {
  if (versions.length === 0) {
    return (
      <section aria-label="History">
        <h3>History</h3>
        <div style={{ fontSize: 13, color: '#6b7280' }}>No versions yet — first activation will create an immutable entry with actor/model/config, diffs, activation/rollback events.</div>
      </section>
    );
  }
  return (
    <section aria-label="History">
      <h3>History</h3>
      <ul>
        {versions.map((v) => (
          <li key={v.id}>{v.id}</li>
        ))}
      </ul>
    </section>
  );
}
