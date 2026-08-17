/**
 * Parse page names from a preserved ProductOnPages XML fragment.
 * Handles both raw XML and the unknownElements string representation.
 */
export function parseProductOnPages(
  preserved: { unknownElements: Record<string, unknown> } | undefined,
): string[] {
  if (!preserved?.unknownElements) return [];
  const raw = preserved.unknownElements['ProductOnPages'];
  if (!raw) return [];

  // Extract all <Name>...</Name> content
  const rawStr = typeof raw === 'string' ? raw : String(raw);
  const matches = rawStr.matchAll(/<Name>([^<]*)<\/Name>/g);
  const names: string[] = [];
  for (const match of matches) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * Build a ProductOnPages XML fragment from a list of page names.
 * Deduplicates and returns the raw XML string suitable for unknownElements.
 */
export function buildProductOnPagesFragment(pageNames: string[]): string {
  const unique = [...new Set(pageNames)].filter(Boolean);
  if (unique.length === 0) return '';
  return '\n    ' + unique.map(n => `<Name>${escapeXml(n)}</Name>`).join('\n    ') + '\n  ';
}

/**
 * Merge new pages into existing ProductOnPages, preserving all existing assignments.
 * Returns the updated XML fragment. Never removes pages.
 */
export function mergeProductOnPages(
  preserved: { unknownElements: Record<string, unknown> } | undefined,
  additionalPages: string[],
): string {
  const existing = parseProductOnPages(preserved);
  const merged = [...existing, ...additionalPages];
  return buildProductOnPagesFragment(merged);
}

function escapeXml(str: unknown): string {
  if (str == null) return '';
  return String(str)
    .replace(/&(?!#(?:[0-9]+|x[0-9a-fA-F]+);|[a-zA-Z0-9]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
