// story: e07s02 — conservative template clustering (path + tag+class shingle, prefix guard)
import { findUrlsByDomain } from '../db/repositories/brand-url-index-repo';
import { normalizeDomain } from '../db/repositories/brand-url-index-repo';

export type Cluster = {
  key: string;
  prefix: string;
  count: number;
  fingerprint: string;
  suggestedUrl: string;
  urls: string[];
  hasVariant: boolean;
};

export function templateAwarePrefix(url: string): string {
  try {
    const p = new URL(url).pathname;
    const segs = p.split('/').filter(Boolean);
    if (segs.length === 0) return '/';
    if (segs[0] === 'products' && segs.length >= 1) return '/products';
    if (segs[0] === 'product' && segs.length >= 1) return '/product';
    if (segs[0] === 'p' && segs.length >= 1) return '/p';
    if (segs[0] === 'collections' && segs[1] === 'all' && segs[2] === 'products') return '/collections/all/products';
    return `/${segs[0]}`;
  } catch {
    return '/';
  }
}

export function domFingerprint(html: string): Set<string> {
  const set = new Set<string>();
  const tagRe = /<([a-z][a-z0-9-]*)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    set.add(tag);
    const classAttr = m[0].match(/class\s*=\s*["']([^"']+)["']/i);
    if (classAttr) {
      const classes = classAttr[1].split(/\s+/).filter(Boolean);
      for (const cls of classes) set.add(`${tag}.${cls.toLowerCase()}`);
    }
  }
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 0 : inter / uni;
}

type InputUrl = { url: string; html: string };
type AnyUrl = string | InputUrl;

export function clusterUrls(urls: AnyUrl[], _opts?: unknown): Cluster[] {
  const inputs: InputUrl[] = urls.map((u) => (typeof u === 'string' ? { url: u, html: '' } : u));
  const clusters: { prefix: string; count: number; suggestedUrl: string; fp: Set<string>; html: string; urls: string[] }[] = [];
  for (const { url, html } of inputs) {
    const prefix = templateAwarePrefix(url);
    const fp = domFingerprint(html);
    const fStr = [...fp].sort().join(',').slice(0, 80) || 'empty';
    let merged = false;
    for (const c of clusters) {
      if (c.prefix !== prefix) continue;
      const j = jaccard(c.fp, fp);
      if (j >= 0.8) {
        c.count += 1;
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ prefix, count: 1, suggestedUrl: url, fp, html, urls: [url] });
    } else {
      const target = clusters.find((c) => c.prefix === prefix && jaccard(c.fp, fp) >= 0.8);
      if (target) target.urls.push(url);
    }
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters.map((c) => ({ key: c.prefix, prefix: c.prefix, count: c.count, fingerprint: [...c.fp].sort().join(',').slice(0, 80) || 'empty', suggestedUrl: c.suggestedUrl, urls: c.urls, hasVariant: c.urls.some((u) => u.includes('variant') || u.includes('?')) }));
}

export function clusterInventoryUrls(domain: string): { clusters: Cluster[]; suggested: string[]; filtered: { count: number; reason: string } } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSuiteSuggestion } = require('./suite-suggestion-service') as typeof import('./suite-suggestion-service');
    const s = getSuiteSuggestion(domain);
    const reason = Object.entries(s.filteredReasons).map(([k, v]) => `${k}:${v}`).join(', ');
    return { clusters: s.clusters as unknown as Cluster[], suggested: s.suggested, filtered: { count: s.filteredCount, reason } };
  } catch {
    return { clusters: [], suggested: [], filtered: { count: 0, reason: '' } };
  }
}
