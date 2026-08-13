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

export const typography = {
  viewTitle: {
    fontFamily: fonts.display,
    fontSize: '1.625rem',
    fontWeight: 700,
    color: colors.ledgerCharcoal,
    lineHeight: 1.25,
    margin: 0,
    letterSpacing: '-0.015em',
  },
  viewSubtitle: {
    fontFamily: fonts.body,
    fontSize: '0.8125rem',
    color: colors.mulchBrown,
    margin: '0.25rem 0 0 0',
    lineHeight: 1.4,
  },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: '1.25rem',
    fontWeight: 700,
    color: colors.ledgerCharcoal,
    lineHeight: 1.3,
    margin: '0 0 0.75rem 0',
  },
  sectionSubtitle: {
    fontFamily: fonts.body,
    fontSize: '0.8125rem',
    color: colors.mulchBrown,
    margin: '-0.5rem 0 0.75rem 0',
  },
  cardTitle: {
    fontFamily: fonts.body,
    fontSize: '1rem',
    fontWeight: 600,
    color: colors.ledgerCharcoal,
    lineHeight: 1.3,
    margin: '0 0 0.5rem 0',
  },
  subsectionTitle: {
    fontFamily: fonts.body,
    fontSize: '0.875rem',
    fontWeight: 600,
    color: colors.ledgerCharcoal,
    lineHeight: 1.35,
    margin: '0 0 0.375rem 0',
  },
  microTitle: {
    fontFamily: fonts.body,
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    color: colors.mulchBrown,
    margin: '0 0 0.25rem 0',
  },
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
