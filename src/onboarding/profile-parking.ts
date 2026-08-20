// story: e06s04

export interface ParkingResult {
  parked: boolean;
  status: string | null;
}

const parkedCounts = new Map<string, number>();

export function evaluateParking(input: { domain: string; sourceType: string; hasActiveVersion: boolean }): ParkingResult {
  const key = input.domain.toLowerCase().replace(/^www\./, '').trim();
  if (input.sourceType === 'distributor_record') {
    return { parked: false, status: null };
  }
  if (input.sourceType === 'official_page' && !input.hasActiveVersion) {
    const cur = parkedCounts.get(key) ?? 0;
    parkedCounts.set(key, cur + 1);
    return { parked: true, status: 'setup_required_profile' };
  }
  return { parked: false, status: null };
}

export function getParkedCount(domain: string): number {
  return parkedCounts.get(domain.toLowerCase().replace(/^www\./, '').trim()) ?? 0;
}

export function releaseParked(domain: string): number {
  const key = domain.toLowerCase().replace(/^www\./, '').trim();
  const count = parkedCounts.get(key) ?? 0;
  parkedCounts.set(key, 0);
  return count;
}

export function getDomainTask(domain: string): string | null {
  const key = domain.toLowerCase().replace(/^www\./, '').trim();
  const n = parkedCounts.get(key) ?? 0;
  if (n === 0) return null;
  return `Build profile for ${domain} — unblocks ${n} products`;
}

export function resetParkingForTest(): void {
  parkedCounts.clear();
}
