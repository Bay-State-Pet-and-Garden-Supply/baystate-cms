# Master Session Handoff & Architecture Log: Baystate CMS Data Pipeline & Taxonomy System

## Executive Summary
This document provides a comprehensive, end-to-end handoff summarizing the entire session history and architecture built for **Baystate CMS**.

The session progressed through seven major engineering phases:
1. **Training Corpus Scraper Subsystem** (`src/crawler/`)
2. **WAF Analysis & Anti-Bot Detection Safeguards**
3. **$0 Open Data Acquisition Ladder (Open Pet Food Facts & GreenCore/Icecat)**
4. **Local Store Catalog Ingestion (21,802 items / 20,418 GTINs)**
5. **Bright Data Cloud Scraper API Integration (`POST /datasets/v3/trigger`)**
6. **Store Taxonomy System & Crosswalk Registry (`src/classification/taxonomy/`)**
7. **Bronze → Silver → Gold Dataset Consolidation Pipeline (`storage/datasets/silver/`)**

---

## Complete Session History & Milestones

### Phase 1: Training Corpus Crawling Infrastructure
- **Objective**: Build a separate, high-volume e-commerce corpus crawling pipeline to gather training data from notable retail sites (*Chewy*, *Tractor Supply*, *Burpee*, *Scotts*, *Bonide*, *Ace Hardware*) without mixing with the single-item onboarding extractor.
- **Key Modules Created**:
  - `src/crawler/corpus-schema.ts`: Defined `ScrapedProductEvidenceSchema` (Zod schema for title, brand, GTIN, raw breadcrumb array, specifications object, image URLs).
  - `src/crawler/base-crawler.ts`: Built `TrainingCorpusCrawler` wrapping Crawlee (`CheerioCrawler` and `PlaywrightCrawler` with Camoufox anti-detect Firefox). Implemented explicit `crawler.teardown()` on `maxItems` target hit, `crawler.addRequests()`, and Crawlee `ProxyConfiguration` support (`process.env.PROXY_URL`).
  - `src/crawler/dataset-exporter.ts`: Exports arrays into `storage/training-corpus/<domain>/` as `.jsonl` files and calculates dataset quality statistics (UPC rate, Brand coverage, Breadcrumb depth, Specs rate).
  - Domain parsers in `src/crawler/sites/`: Built Chewy (`/dp/`), Tractor Supply (`/tsc/product/`), Burpee, Ace Hardware (`/p/`), Scotts, and Bonide parsers with strict product URL validation guards to prevent category page pollution.

---

### Phase 2: Live Crawl Execution & WAF Diagnostics
- **Executed Live Crawls**:
  - `bonide.com`: 36 requests, 30 items collected, 100% taxonomy breadcrumbs extracted cleanly. Saved to `storage/training-corpus/bonide.com/`.
  - `scotts.com`: 5 items collected successfully. Saved to `storage/training-corpus/scotts.com/`.
- **WAF Diagnostics**:
  - Identified Akamai Edge WAF blocks (`HTTP 403 / 429`) on enterprise retail sites (*Chewy.com*, *TractorSupply.com*) prior to JS execution due to IP reputation.

---

### Phase 3: $0 Acquisition Ladder & Open Barcode Importers
To avoid paying dataset vendors before exhausting open resources, implemented a $0 open data acquisition strategy:
- **Open Pet Food Facts Importer** ([src/crawler/importers/open-pet-food-facts.ts](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/src/crawler/importers/open-pet-food-facts.ts)):
  - Queries Open Pet Food Facts (ODbL open database) by GTIN/UPC barcode with multi-format fallback checks (UPC-12, EAN-13).
  - Returns official titles, brand names, ingredient lists, targeted species, package sizes, and claims.
- **Open Icecat Importer** ([src/crawler/importers/icecat.ts](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/src/crawler/importers/icecat.ts)):
  - Installed `icecat@1.4.5` (`GreenCore/icecat`).
  - Fetches structured product content sheets from Icecat via GTIN/EAN/UPC.

---

### Phase 4: Local Store Catalog Ingestion (21,802 Items)
- **Local Catalog Discovery**:
  - Located the local pulled ShopSite catalog workspace at `storage/catalog/products/`.
  - Discovered **21,802 pulled product JSON files** containing **20,418 valid GTIN barcodes**.
- **Domain Filtering (`scripts/import-pet-food-only.ts`)**:
  - Filtered the 21,802 store products down to **2,841 targeted Dog & Cat Food SKUs** (isolating pet food items like *Nutro LID Lite*, *Triumph Beef*, *Instinct Raw Boost*, *Blue Freedom Grillers*).
  - Performed barcode lookups against Open Pet Food Facts, successfully matching items with ingredient lists, species tags, and package images.

---

### Phase 5: Bright Data Cloud Scraper API Integration
- **Client Implementation** ([src/crawler/importers/brightdata-scraper.ts](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/src/crawler/importers/brightdata-scraper.ts)):
  - Built client for Bright Data's **Crawl / Scraper API** (`POST /datasets/v3/trigger` and `GET /datasets/v3/snapshot/{snapshot_id}`).
  - Authenticates via `BRIGHT_DATA_API_KEY` stored in git-ignored `.env`.
- **Live Scrape Execution (`scripts/run-brightdata-crawl.ts`)**:
  - Triggered cloud scrape for Chewy product URLs (`snapshot_id: sd_msa4ew1janjggfbjq`).
  - Retrieved 5 cloud-rendered records, normalized them into `ScrapedProductEvidence`, and exported dataset to `storage/training-corpus/chewy.com/`.

---

### Phase 6: Store Taxonomy System & Bronze → Silver → Gold Pipeline
Established the 5 core taxonomy concepts and 3-tiered data consolidation pipeline:

1. **Store Taxonomy System** (`src/classification/taxonomy/`):
   - **Product Types** ([product-types.json](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/src/classification/taxonomy/product-types.json)): Immutable internal Product Types (`dog_food_dry`, `cat_food_wet`, `dog_treat`, `flea_tick_control`, `grass_seed`, `lawn_fertilizer`, `weed_control`, `potting_soil`, `hand_garden_tool`, etc.).
   - **Product Attributes** ([attributes.json](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/src/classification/taxonomy/attributes.json)): Reusable facts (`species`, `life_stage`, `food_form`, `flavor_protein`, `package_weight`, `organic_status`).
   - **ShopSite Field Mappings** ([shopsite-field-mappings.json](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/src/classification/taxonomy/shopsite-field-mappings.json)): Maps Product Types & Attributes directly to ShopSite publishing fields (`ProductField16` Brand, `ProductField24` Type Tag) and Category Page placements (`Dog Food Dry`, `Grass Seed`).
   - **Taxonomy Registry** ([taxonomy-registry.ts](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/src/classification/taxonomy/taxonomy-registry.ts)): Registry loader & candidate text-matching engine.

2. **Bronze → Silver Data Consolidation**:
   - **Silver Builder** ([src/classification/datasets/silver-builder.ts](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/src/classification/datasets/silver-builder.ts)): Converts Bronze raw evidence (title, brand, specs, images, description) into Silver candidate records *without relying on external retailer breadcrumbs*.
   - **Consolidation CLI** ([scripts/consolidate-datasets.ts](file:///Users/nickborrello/Desktop/Projects/shopsite-cms/scripts/consolidate-datasets.ts)): Consolidated 73 raw Bronze items across all scraped domains into `storage/datasets/silver/silver-v1.jsonl`.

---

## Complete File Directory Layout

```
shopsite-cms/
├── .env                                      # Git-ignored env (contains BRIGHT_DATA_API_KEY)
├── HANDOFF.md                                # Master handoff documentation
├── src/
│   ├── classification/
│   │   ├── taxonomy/
│   │   │   ├── product-types.json            # Immutable internal Product Types
│   │   │   ├── attributes.json               # Reusable product attributes
│   │   │   ├── shopsite-field-mappings.json  # ShopSite ProductField16/24 & ProductOnPages crosswalk
│   │   │   └── taxonomy-registry.ts          # Registry loader & text candidate matcher
│   │   └── datasets/
│   │       ├── silver-builder.ts             # Bronze -> Silver training record transformer
│   │       └── bronze-importer.ts
│   ├── crawler/
│   │   ├── base-crawler.ts                   # Crawlee wrapper with Camoufox & ProxyConfiguration
│   │   ├── dataset-exporter.ts               # Dataset exporter & metrics calculator
│   │   ├── corpus-schema.ts                  # Zod schema for ScrapedProductEvidence
│   │   ├── importers/
│   │   │   ├── open-pet-food-facts.ts        # $0 Open Pet Food Facts GTIN importer
│   │   │   ├── icecat.ts                     # $0 Open Icecat importer (GreenCore/icecat SDK)
│   │   │   └── brightdata-scraper.ts         # Bright Data Cloud Scraper API client
│   │   └── sites/                            # Site parsers (Chewy, Tractor Supply, Burpee, Bonide, Scotts, Ace)
├── storage/
│   ├── catalog/products/                     # 21,802 local ShopSite catalog JSON files (20,418 GTINs)
│   ├── training-corpus/                      # Bronze raw scraped evidence (.jsonl)
│   └── datasets/
│       ├── silver/silver-v1.jsonl            # Consolidated Silver candidate dataset (73 records)
│       └── gold/                             # Reserved for CMS Review Drawer human-approved labels
├── scripts/
│   ├── crawl-corpus.ts                       # CLI runner for domain crawling
│   ├── import-open-data.ts                   # CLI runner for GTIN barcode imports
│   ├── import-pet-food-only.ts               # Filters catalog for 2,841 Pet Food SKUs & runs Open Pet Food Facts
│   ├── run-brightdata-crawl.ts               # Triggers Bright Data Cloud Scraper jobs
│   └── consolidate-datasets.ts               # Consolidates Bronze evidence into Silver dataset
└── src/tests/unit/
    ├── crawler.test.ts                       # Unit tests for crawler parsers (6/6 pass)
    ├── importers.test.ts                     # Unit tests for Open Pet Food Facts & Icecat (3/3 pass)
    ├── brightdata-scraper.test.ts            # Unit tests for Bright Data Cloud Scraper (2/2 pass)
    └── taxonomy-registry.test.ts             # Unit tests for Taxonomy Registry & Silver Builder (3/3 pass)
```

---

## Verification & Test Suite Status

All 14 unit test cases across 4 test suites are passing cleanly:

```bash
bun test
```

Output:
```text
src/tests/unit/brightdata-scraper.test.ts (2 pass)
src/tests/unit/crawler.test.ts (6 pass)
src/tests/unit/importers.test.ts (3 pass)
src/tests/unit/taxonomy-registry.test.ts (3 pass)

14 pass, 0 fail
Ran 14 tests across 4 files. [520.00ms]
```

---

## Key CLI Commands for Reviewer

```bash
# 1. Run full unit test suite
bun test

# 2. Run Bronze -> Silver dataset consolidation
bun run scripts/consolidate-datasets.ts

# 3. Filter local catalog for 2,841 Pet Food SKUs and run Open Pet Food Facts
bun run scripts/import-pet-food-only.ts

# 4. Trigger Bright Data Cloud Scraper job for Chewy product URLs
bun run scripts/run-brightdata-crawl.ts

# 5. Crawl manufacturer domain for 30 items
bun run scripts/crawl-corpus.ts --domain=bonide.com --max-items=30
```

---

## Next Steps for Review Agent

1. **Gold Evaluation Dataset Creation**:
   - Sample 100 representative items from `storage/datasets/silver/silver-v1.jsonl`.
   - Review and approve candidate labels in the CMS Review Drawer to populate `storage/datasets/gold/gold-v1.jsonl`.
2. **Model Benchmark & Fine-Tuning Evaluation**:
   - Benchmark LLM product classification accuracy against `gold-v1.jsonl` as the ground truth evaluation baseline.
