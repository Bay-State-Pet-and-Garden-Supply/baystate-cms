# Design System: Bay State Pet & Garden Supply

<!-- impeccable:design-schema 1 -->

## 1. Overview

**Creative North Star: "The General Store"**

This is a digital general store — warm, practical, and built for legibility and utility. The website is an extension of the physical store at 429 Winthrop Street, not a separate brand experiment.

The system is **business-first and accessible**: clean typography, clear contrast on cream stock, and soft, natural shadows that create depth and visual hierarchy without being overwhelming. It's confident and reliable. Decisions that grab attention do so for reasons a store manager would recognize — a sale badge, a pickup-only label, a department sign.

**Key Characteristics:**
- Clean and soft — rounded corners (`sm`, `md`), subtle shadows (`sm`, `md`) for elevation
- Physical not digital — the palette evokes aprons, signage, paper bags
- Readable and clear — normal font weights for body, sensible headers, avoiding excessive caps
- Semantic not decorative — accent colors signal meaning (sale, pre-order, pickup), not mood
- Store-first — every design choice answers "would this make sense for our customers?"

## 2. Colors

The palette follows the physical store — green uniforms and signage dominate, burgundy and gold are heritage accents from the logo, cream and white hold the background. The hierarchy is: **Green owns the room, burgundy remembers, gold whispers.**

### Primary
- **Uniform Green** (`#14532D`): Headers, primary buttons, navigation, footer, sidebar backgrounds. The color of the store aprons and exterior signage. Dark enough for white text at AA contrast.
- **Shadow Pine** (`#0B3D22`): Button hover states, footer bottom band, active nav states.
- **Seedling Green** (`#16844D`): Garden category tags, success states, icons for completed/published status. Brighter and lighter than Uniform Green.

### Secondary
- **Signet Burgundy** (`#760C19`): Secondary buttons, featured badges, sale banners, "special" highlights. The logo's deep red — used sparingly but with impact.
- **Burgundy Dark** (`#4E0710`): Hover state for burgundy elements, footer accent details.

### Tertiary
- **Corner Callout Gold** (`#F6DB12`): Sale badges, rating stars, promo strips, active nav underlines.
- **Muted Gold** (`#E9B520`): Borders, icons, subtle highlights, pre-order badges.

### Neutral
- **White Surface** (`#FFFFFF`): Primary wall color. Page background, product cards, form fields. Clean and bright.
- **Feed Bag Cream** (`#FAF9F2`): Softer page sections and accents. Toned down, cleaner cream.
- **Ledger Charcoal** (`#211414`): Main body text. Warm near-black.
- **Card Border** (`#E8E6D9`): Card borders on cream backgrounds. Subtle and less yellow.
- **Mulch Brown** (`#6B3A18`): Footer detail text, rustic accents.

### Named Rules

**The Architecture Rule.** White holds 70% of the surface (walls). Uniform Green (`#14532D`) carries 20% (furniture/registers). Signet Burgundy (`#760C19`) defines 10% of structural lines (doorframes/borders). Gold is an occasional spark.

**The Accent Is Earned Rule.** Corner Callout Gold and Signet Burgundy are never decorative. They appear only when there's a semantic reason.

## 3. Typography

- **Display Font:** `Arvo`, Georgia, serif
- **Body Font:** `Inter`, system-ui, sans-serif
- **Monospace Font:** `JetBrains Mono`, ui-monospace, monospace (SKUs, hashes, code)

### Hierarchy
- **Display** (`Arvo`, 700, `clamp(2rem, 5vw, 3.5rem)`): Hero headlines, department names.
- **Headline** (`Arvo`, 600-700, `1.5rem–2.5rem`): Section headings.
- **Title** (`Inter`, 600, `1.25rem–1.5rem`): Product card names, card titles.
- **Body** (`Inter`, 400, `0.875rem–1rem`): Product descriptions, footer text.
- **Label** (`Inter`, 600, `0.75rem–0.875rem`, uppercase): Badges, category tags, status indicators, button text.
- **Price** (`Inter`, 700, `1.25rem`): Product prices.

## 4. Elevation

This system uses **soft ambient elevation.** Surfaces are flat at rest, with subtle borders. Depth is conveyed through standard drop shadows with soft blur to create a realistic sense of layering.

### Shadow Vocabulary
- **Sm** (`shadow-sm`): Badges, inputs, standard cards.
- **Md** (`shadow-md`): Dialogs, popovers, navigation dropdowns.
- **None** (`shadow-none`): Flat surfaces.

## 5. Components

### Buttons
- **Shape:** Rounded (`rounded-sm` or `rounded-md`).
- **Primary:** Uniform Green (`#14532D`) background, Feed Bag Cream (`#FAF9F2`) text. Normal or semibold font weight.
- **Hover:** Background shifts to Shadow Pine (`#0B3D22`).
- **Secondary:** Signet Burgundy (`#760C19`) background, Feed Bag Cream (`#FAF9F2`) text. Hover shifts to Burgundy Dark (`#4E0710`).

### Cards
- **Corner Style:** Rounded (`rounded-lg`).
- **Background:** White (`#FFFFFF`) on storefront.
- **Shadow Strategy:** `shadow-sm` at rest. `shadow-md` on hover if interactive.
- **Border:** `1px solid` in Card Border (`#E8E6D9`).

### Inputs
- **Style:** Rounded (`rounded-sm`), full-width. Border `1px solid`.
- **Focus:** Border shifts to Uniform Green, soft ring.
