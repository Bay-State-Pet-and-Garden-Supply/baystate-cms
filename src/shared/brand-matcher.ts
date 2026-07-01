/**
 * Matches the first word(s) of a product name against a list of existing brand names.
 * Ensures case-insensitivity and checks for alphanumeric word boundaries.
 * Longest brands are checked first to ensure "Stella & Chewy's" matches instead of just "Stella".
 */
export function matchExistingBrand(productName: string, existingBrands: string[]): string | null {
  if (!productName) return null;
  const cleanName = productName.trim().toLowerCase();

  // Sort brands by length descending so we match the longest brand name first
  const sortedBrands = [...existingBrands].sort((a, b) => b.length - a.length);

  for (const brand of sortedBrands) {
    const cleanBrand = brand.trim().toLowerCase();
    if (!cleanBrand) continue;

    if (cleanName.startsWith(cleanBrand)) {
      const nextChar = cleanName.charAt(cleanBrand.length);
      // Alphanumeric word boundary check: next character must be empty, space, or non-alphanumeric punctuation
      if (!nextChar || !/[a-zA-Z0-9]/.test(nextChar)) {
        return brand;
      }
    }
  }
  return null;
}
