// story: e06s01
import type { ReadinessState } from '../../../onboarding/profile-readiness';

export function ReadinessRail({ state }: { state: ReadinessState }): React.ReactElement {
  return (
    <nav aria-label="Readiness">
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{state.overall}</div>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {state.steps.map((s) => (
          <li key={s.id} style={{ padding: '6px 0', opacity: s.status === 'pending' ? 0.6 : 1 }}>
            <span style={{ fontWeight: s.status === 'active' ? 700 : 400 }}>{s.label}</span>
            <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>— {s.status}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
