// story: e06s02 — guided upstream panel showing candidate vs confirmed + waiver
import { useEffect, useState } from 'react';

type Inventory = { candidateCount: number; confirmedCount: number; freshness: string | null };
type SuiteResp = { suite: string[]; inventory: Inventory };

export function SuitePanel({ domain }: { domain: string }) {
  const [data, setData] = useState<SuiteResp | null>(null);
  const [waiverReason, setWaiverReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domain) return;
    fetch(`/api/domains/${encodeURIComponent(domain)}/representative-suite`)
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [domain]);

  if (!domain) return null;
  if (error) return <div className="text-sm text-red-600">{error}</div>;
  if (!data) return <div className="text-sm text-stone-500">Loading inventory…</div>;

  const needWaiver = data.inventory.candidateCount < 3 && data.suite.length < 3;

  return (
    <div className="rounded border p-3 bg-white">
      <h3 className="font-semibold text-sm mb-2">Upstream — Sitemap inventory</h3>
      <div className="text-xs text-stone-600 mb-2">
        Candidate: {data.inventory.candidateCount} · Confirmed: {data.suite.length} · Freshness: {data.inventory.freshness ?? 'unknown'}
      </div>
      {needWaiver && (
        <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs">
          <p className="font-medium">Waiver required (&lt;3 product URLs)</p>
          <input
            className="mt-1 w-full border rounded px-2 py-1"
            placeholder="Reason for waiver"
            value={waiverReason}
            onChange={(e) => setWaiverReason(e.target.value)}
          />
          <button
            className="mt-1 px-2 py-1 bg-stone-800 text-white rounded text-xs"
            onClick={async () => {
              const res = await fetch(`/api/domains/${encodeURIComponent(domain)}/waiver`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: waiverReason, actor: 'operator' }),
              });
              if (!res.ok) setError(await res.text());
              else location.reload();
            }}
          >
            Create waiver
          </button>
        </div>
      )}
      <ul className="mt-2 text-xs list-disc pl-4">
        {data.suite.map((u) => (
          <li key={u} className="truncate">{u}</li>
        ))}
      </ul>
    </div>
  );
}
