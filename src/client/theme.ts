/**
 * Design System: Bay State Pet & Garden Supply ("The General Store")
 * Digital extension of the Taunton, MA general store.
 */

export const colors = {
  uniformGreen: '#14532D',      // Store aprons & exterior signage
  shadowPine: '#0B3D22',        // Button hover & active nav states
  seedlingGreen: '#16844D',     // Category tags & success states
  signetBurgundy: '#760C19',    // Secondary buttons & featured badges
  burgundyDark: '#4E0710',      // Burgundy hover state
  cornerCalloutGold: '#F6DB12', // Sale badges & promo callouts
  mutedGold: '#E9B520',         // Pre-order badges & borders
  feedBagCream: '#FAF9F2',      // Soft page sections & button text
  whiteSurface: '#FFFFFF',      // Primary card & input surface
  ledgerCharcoal: '#211414',   // Main body text (warm near-black)
  cardBorder: '#E8E6D9',       // Card borders
  mulchBrown: '#6B3A18',       // Footer detail text
} as const;

export const fonts = {
  display: "'Arvo', Georgia, serif",
  body: "'Inter', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
} as const;

export const rounded = {
  none: '0',
  xs: '0.125rem', // 2px
  sm: '0.25rem',  // 4px
  md: '0.375rem', // 6px
  lg: '0.5rem',   // 8px
  xl: '0.75rem',  // 12px
  full: '9999px',
} as const;

export const themeStyles = {
  card: {
    backgroundColor: colors.whiteSurface,
    color: colors.ledgerCharcoal,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.lg,
    boxShadow: '0 1px 3px 0 rgba(33, 20, 20, 0.06)',
    padding: '24px',
  },
  cardHeader: {
    backgroundColor: colors.uniformGreen,
    color: colors.feedBagCream,
    padding: '0.75rem 1rem',
    borderTopLeftRadius: rounded.lg,
    borderTopRightRadius: rounded.lg,
  },
  buttonPrimary: {
    backgroundColor: colors.uniformGreen,
    color: colors.feedBagCream,
    border: `1px solid ${colors.shadowPine}`,
    borderRadius: rounded.sm,
    fontFamily: fonts.body,
    fontWeight: 600,
    fontSize: '0.75rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    cursor: 'pointer',
  },
  buttonSecondary: {
    backgroundColor: colors.signetBurgundy,
    color: colors.feedBagCream,
    border: `1px solid ${colors.burgundyDark}`,
    borderRadius: rounded.sm,
    fontFamily: fonts.body,
    fontWeight: 600,
    fontSize: '0.75rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    cursor: 'pointer',
  },
  badge: {
    backgroundColor: colors.uniformGreen,
    color: colors.feedBagCream,
    borderRadius: rounded.md,
    fontFamily: fonts.body,
    fontWeight: 600,
    fontSize: '0.75rem',
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    padding: '0.125rem 0.5rem',
  },
  badgeSale: {
    backgroundColor: colors.cornerCalloutGold,
    color: colors.ledgerCharcoal,
    borderRadius: rounded.md,
    fontFamily: fonts.body,
    fontWeight: 600,
    fontSize: '0.75rem',
    padding: '0.125rem 0.5rem',
  },
  badgeFeatured: {
    backgroundColor: colors.signetBurgundy,
    color: colors.feedBagCream,
    borderRadius: rounded.md,
    fontFamily: fonts.body,
    fontWeight: 600,
    fontSize: '0.75rem',
    padding: '0.125rem 0.5rem',
  },
} as const;
