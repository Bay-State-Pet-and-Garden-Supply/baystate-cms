/**
 * Converts a weight string into lbs, returning only the number rounded to the nearest hundredth.
 * e.g., "12 oz" -> "0.75"
 *       "15 lbs" -> "15"
 *       "1.5 kg" -> "3.31"
 *       "500 g" -> "1.1"
 *       "30" -> "30"
 */
export function convertToLbs(weightStr: string | null | undefined): string | null {
  if (!weightStr) return null;
  const trimmed = weightStr.trim();
  if (!trimmed) return null;

  // Regex to extract a number and unit.
  // Support integers or decimals: e.g. "12", "1.5", "0.75"
  const match = /^\s*(\d+(?:\.\d+)?)\s*(lbs?|kg|g|grams?|oz|ounces?|pounds?)?\s*$/i.exec(trimmed);
  if (!match) {
    // If it doesn't match the strict regex (e.g. it has other text or multiple units),
    // let's do a search for the first number and unit combination.
    const searchMatch = /(\d+(?:\.\d+)?)\s*(lbs?|kg|g|grams?|oz|ounces?|pounds?)\b/i.exec(trimmed);
    if (!searchMatch) {
      // If still no unit found, but there's a number, assume it's already in lbs.
      const numMatch = /(\d+(?:\.\d+)?)/.exec(trimmed);
      if (numMatch) {
        const num = parseFloat(numMatch[1]);
        return String(Math.round(num * 100) / 100);
      }
      return null;
    }
    return performConversion(parseFloat(searchMatch[1]), searchMatch[2]);
  }

  const num = parseFloat(match[1]);
  const unit = match[2];

  if (!unit) {
    // No unit: assume already in lbs
    return String(Math.round(num * 100) / 100);
  }

  return performConversion(num, unit);
}

function performConversion(num: number, unit: string): string {
  const u = unit.toLowerCase();
  let lbs = 0;

  if (u.startsWith('lb') || u.startsWith('pound')) {
    lbs = num;
  } else if (u === 'oz' || u.startsWith('ounce')) {
    lbs = num / 16;
  } else if (u === 'kg') {
    lbs = num * 2.2046226218;
  } else if (u === 'g' || u.startsWith('gram')) {
    lbs = num * 0.0022046226218;
  } else {
    // Fallback: assume lbs if matched by regex but not handled
    lbs = num;
  }

  return String(Math.round(lbs * 100) / 100);
}
