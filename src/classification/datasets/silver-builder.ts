/**
 * Silver dataset builder.
 *
 * Milestone 8 rebuild:
 * - weak labels resolve against the ACTIVE canonical configuration
 * - every Bronze observation is preserved in a normalized Bronze artifact
 * - only deterministic representatives are selected for Silver v2
 * - no guessed Pages and no Product Type → ProductField24/25 mapping
 * - `silver-v1.jsonl` is never modified; a legacy audit accounts for every
 *   one of its rows as accepted, rejected, or duplicate
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex, canonicalJsonStringify } from '../../shared/stable-id.js';
import {
  type ScrapedProductEvidence,
  ScrapedProductEvidenceSchema,
  computePayloadHash,
} from '../../crawler/corpus-schema.js';
import {
  validateCorpusLine,
  computeEntityId,
  type CorpusValidationResult,
} from '../../crawler/corpus-validator.js';
import {
  buildCorpusManifest,
  writeCorpusManifestAtomic,
  computeManifestDigest,
  hashFileBytes,
} from '../../crawler/corpus-manifest.js';
import { WeakLabelRules, type WeakLabelConfig, type WeakLabelProductType, type WeakLabelAttribute } from './weak-label-rules.js';

export interface SilverDatasetItem {
  id: string;
  schemaVersion: 2;
  entityId: string;
  observationId: string;
  source: string;
  sourceUrl: string;
  sourceHash: string;
  provenance: {
    acquisitionMode: string;
    parserVersion: string;
    licenseStatus: string;
    weakRuleVersion: string;
  };
  input: {
    title: string;
    brand?: string;
    description?: string;
    specifications?: Record<string, string>;
    gtin?: string;
    images?: string[];
  };
  silverPredictions: {
    candidateProductType?: {
      id: string;
      name: string;
      confidence: number;
    };
    extractedAttributes: {
      species?: string[];
      lifeStage?: string[];
      foodForm?: string[];
    };
    /** Always empty: Pages are never guessed without verified identity. */
    proposedCategoryPages: [];
    /** Always empty: Product Type is never mapped to ProductField24/25. */
    shopsiteFields: Record<string, never>;
    abstentions: string[];
  };
}

export interface CorpusDisposition {
  disposition: 'accepted' | 'rejected' | 'duplicate';
  entityId?: string;
  rejectionCode?: string;
  rejectionReason?: string;
}

export interface LegacyRowAuditEntry {
  index: number;
  legacyId: string;
  source: string;
  sourceUrl: string;
  title?: string;
  disposition: 'accepted' | 'rejected' | 'duplicate';
  rejectionCode?: string;
  rejectionReason?: string;
}

export interface RebuildSummary {
  bronzeTotal: number;
  bronzeAccepted: number;
  bronzeRejected: number;
  bronzeDuplicates: number;
  silverRecords: number;
  legacyRowsAudited: number;
  bronzeFile: string;
  silverFile: string;
  auditFile: string;
  bronzeManifestDigest: string;
  silverManifestDigest: string;
}

interface BronzeObservation {
  lineIndex: number;
  raw: string;
  record: ScrapedProductEvidence;
  validation: CorpusValidationResult;
}

export class SilverDatasetBuilder {
  private weakRules: WeakLabelRules;

  constructor(weakRules: WeakLabelRules) {
    this.weakRules = weakRules;
  }

  /**
   * Transforms a validated Bronze observation into a deterministic Silver v2
   * candidate record. Abstains (no candidateProductType, no values) whenever
   * the weak rules find insufficient positive evidence.
   */
  buildSilverRecord(bronze: ScrapedProductEvidence, validated?: CorpusValidationResult): SilverDatasetItem {
    const entityId = bronze.entityId || (validated?.entityId) || computeEntityId(bronze.sourceUrl);
    const payloadHash = bronze.payloadHash || computePayloadHash(bronze as Record<string, unknown>);
    const observationId = bronze.observationId || (validated?.observationId) || sha256Hex(`observation:${entityId}:${payloadHash}`);

    const title = (bronze.title || '').trim();
    const brand = bronze.brand?.trim();

    const typeMatch = this.weakRules.resolveProductType({
      title,
      description: bronze.description,
      specifications: bronze.specifications,
    });

    const attributes = this.weakRules.resolveAttributes({
      title,
      description: bronze.description,
      specifications: bronze.specifications,
    });

    const abstentions: string[] = [];
    if (!typeMatch) abstentions.push('product_type');
    if (!attributes.species) abstentions.push('species');
    if (!attributes.lifeStage) abstentions.push('life_stage');
    if (!attributes.foodForm) abstentions.push('food_form');

    return {
      id: `silver-${entityId.slice(0, 16)}`,
      schemaVersion: 2,
      entityId,
      observationId,
      source: bronze.retailer,
      sourceUrl: bronze.sourceUrl,
      sourceHash: payloadHash,
      provenance: {
        acquisitionMode: bronze.acquisitionMode ?? 'import_file',
        parserVersion: bronze.parserVersion ?? '1.0',
        licenseStatus: bronze.licenseStatus ?? 'unknown',
        weakRuleVersion: this.weakRules.version,
      },
      input: {
        title,
        ...(brand ? { brand } : {}),
        ...(bronze.description?.trim() ? { description: bronze.description.trim() } : {}),
        specifications: bronze.specifications || {},
        ...(bronze.gtin || bronze.upc ? { gtin: bronze.gtin || bronze.upc } : {}),
        images: bronze.images || [],
      },
      silverPredictions: {
        ...(typeMatch ? { candidateProductType: typeMatch } : {}),
        extractedAttributes: {
          ...(attributes.species ? { species: attributes.species } : {}),
          ...(attributes.lifeStage ? { lifeStage: attributes.lifeStage } : {}),
          ...(attributes.foodForm ? { foodForm: attributes.foodForm } : {}),
        },
        proposedCategoryPages: [],
        shopsiteFields: {},
        abstentions,
      },
    };
  }
}

/**
 * Offline corpus rebuild. Pure filesystem operation over `storage/training-corpus`
 * (and the legacy `silver-v1.jsonl`); never contacts the network.
 *
 * Guarantees:
 * - every Bronze observation is preserved in the normalized Bronze artifact
 * - only deterministic representatives reach Silver v2
 * - the 73 legacy silver-v1 rows are each audited as accepted/rejected/duplicate
 * - identical inputs produce byte-identical outputs
 */
export function rebuildOfflineCorpus(options: {
  bronzeDir: string;
  outputDir: string;
  weakRules: WeakLabelRules;
  allowedRegistrableDomains?: ReadonlySet<string>;
  legacySilverFile?: string;
}): RebuildSummary {
  const { bronzeDir, outputDir, weakRules } = options;
  const silverDir = path.join(outputDir, 'silver');
  const bronzeOutDir = path.join(outputDir, 'bronze');

  // 1. Collect and sort all bronze lines deterministically.
  const bronzeFiles: string[] = [];
  if (fs.existsSync(bronzeDir)) {
    for (const domain of fs.readdirSync(bronzeDir).sort()) {
      const domainDir = path.join(bronzeDir, domain);
      if (!fs.statSync(domainDir).isDirectory()) continue;
      for (const file of fs.readdirSync(domainDir).sort()) {
        if (file.endsWith('.jsonl')) bronzeFiles.push(path.join(domainDir, file));
      }
    }
  }

  const observations: BronzeObservation[] = [];
  let lineIndex = 0;
  for (const filePath of bronzeFiles) {
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const raw of lines) {
      observations.push({ lineIndex, raw, record: {} as ScrapedProductEvidence, validation: { ok: false } });
      lineIndex++;
    }
  }

  // 2. Validate every line; assign collision-resistant IDs.
  const seenEntityIds = new Set<string>();
  const validated: Array<BronzeObservation & { record: ScrapedProductEvidence }> = [];

  for (const obs of observations) {
    let record: ScrapedProductEvidence;
    try {
      record = ScrapedProductEvidenceSchema.parse(JSON.parse(obs.raw));
    } catch {
      validated.push({ ...obs, record: {} as ScrapedProductEvidence, validation: { ok: false, rejectionCode: 'invalid_json', rejectionReason: 'Unparseable JSON or schema-invalid record.' } });
      continue;
    }
    const validation = validateCorpusLine(obs.raw, {
      allowedRegistrableDomains: options.allowedRegistrableDomains,
      seenEntityIds,
    });
    if (validation.ok && validation.entityId) seenEntityIds.add(validation.entityId);
    validated.push({ ...obs, record, validation });
  }

  // 3. Normalized Bronze: preserve EVERY observation with its state.
  fs.mkdirSync(bronzeOutDir, { recursive: true });
  const bronzeNormalizedPath = path.join(bronzeOutDir, 'bronze-normalized.jsonl');
  const bronzeLines: string[] = validated
    .map((obs) => {
      const record = { ...obs.record } as ScrapedProductEvidence;
      if (obs.validation.ok) {
        record.entityId = obs.validation.entityId;
        record.observationId = obs.validation.observationId;
        record.validationState = 'valid';
      } else {
        record.validationState = 'rejected';
      }
      record.qualityFlags = [
        ...(record.qualityFlags || []),
        ...(obs.validation.ok ? [] : [`rejected:${obs.validation.rejectionCode}`]),
      ];
      return canonicalJsonStringify(record);
    })
    .sort();
  writeLinesAtomic(bronzeNormalizedPath, bronzeLines);

  // 4. Silver v2: deterministic representatives of accepted entities only.
  const builder = new SilverDatasetBuilder(weakRules);
  const acceptedByEntity = new Map<string, BronzeObservation & { record: ScrapedProductEvidence }>();
  for (const obs of validated) {
    if (!obs.validation.ok) continue;
    if (!obs.validation.entityId) continue;
    const existing = acceptedByEntity.get(obs.validation.entityId);
    if (!existing || bronzeSortKey(obs.record) < bronzeSortKey(existing.record)) {
      acceptedByEntity.set(obs.validation.entityId, obs);
    }
  }

  const silverRecords = Array.from(acceptedByEntity.values())
    .map((obs) => builder.buildSilverRecord(obs.record, obs.validation))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));

  fs.mkdirSync(silverDir, { recursive: true });
  const silverContent = silverRecords.map((r) => canonicalJsonStringify(r)).join('\n') + '\n';
  const silverDigest = sha256Hex(silverContent);
  const silverV2Path = path.join(silverDir, `silver-v2-${silverDigest}.jsonl`);
  fs.writeFileSync(silverV2Path, silverContent, 'utf-8');

  // 5. Legacy silver-v1 audit: account for every legacy row.
  //    Per sourceUrl, an entity is accepted if any observation validated;
  //    otherwise duplicate if it was a duplicate locator, else rejected.
  //    The first legacy row of an accepted URL is 'accepted'; later rows
  //    with the same URL are 'duplicate'.
  const urlDisposition = new Map<string, { disposition: 'accepted' | 'duplicate' | 'rejected'; rejectionCode?: string; rejectionReason?: string }>();
  for (const obs of validated) {
    const url = obs.record.sourceUrl || obs.record.rawUrl;
    if (!url) continue;
    const current = urlDisposition.get(url);
    if (obs.validation.ok) {
      urlDisposition.set(url, { disposition: 'accepted' });
    } else if (!current) {
      urlDisposition.set(url, {
        disposition: obs.validation.rejectionCode === 'duplicate_locator' ? 'duplicate' : 'rejected',
        rejectionCode: obs.validation.rejectionCode,
        rejectionReason: obs.validation.rejectionReason,
      });
    } else if (current.disposition === 'accepted' || obs.validation.rejectionCode !== 'duplicate_locator') {
      // keep accepted; or a non-duplicate rejection supersedes nothing (first rejection kept)
    }
  }

  const auditEntries: LegacyRowAuditEntry[] = [];
  const legacyFile = options.legacySilverFile ?? path.join(silverDir, 'silver-v1.jsonl');
  if (fs.existsSync(legacyFile)) {
    const legacyLines = fs.readFileSync(legacyFile, 'utf-8').split(/\r?\n/).filter(Boolean);
    const urlOccurrence = new Map<string, number>();
    legacyLines.forEach((line, index) => {
      let legacy: { id?: string; source?: string; sourceUrl?: string; input?: { title?: string } };
      try {
        legacy = JSON.parse(line);
      } catch {
        auditEntries.push({
          index,
          legacyId: 'unparseable',
          source: '',
          sourceUrl: '',
          disposition: 'rejected',
          rejectionCode: 'invalid_json',
          rejectionReason: 'Legacy row is not valid JSON.',
        });
        return;
      }
      const url = legacy.sourceUrl || '';
      const entity = urlDisposition.get(url);
      if (!entity) {
        auditEntries.push({
          index,
          legacyId: legacy.id || '',
          source: legacy.source || '',
          sourceUrl: url,
          ...(legacy.input?.title ? { title: legacy.input.title } : {}),
          disposition: 'rejected',
          rejectionCode: 'missing_bronze_match',
          rejectionReason: 'No matching Bronze observation found for legacy row.',
        });
        return;
      }
      let disposition = entity.disposition;
      if (disposition === 'accepted') {
        const occurrence = (urlOccurrence.get(url) || 0) + 1;
        urlOccurrence.set(url, occurrence);
        if (occurrence > 1) disposition = 'duplicate';
      }
      auditEntries.push({
        index,
        legacyId: legacy.id || '',
        source: legacy.source || '',
        sourceUrl: url,
        ...(legacy.input?.title ? { title: legacy.input.title } : {}),
        disposition,
        ...(entity.rejectionCode ? { rejectionCode: entity.rejectionCode } : {}),
        ...(entity.rejectionReason ? { rejectionReason: entity.rejectionReason } : {}),
      });
    });
  }
  const auditPath = path.join(silverDir, 'silver-v1-audit.jsonl');
  writeLinesAtomic(auditPath, auditEntries.map((entry) => canonicalJsonStringify(entry)));

  // 6. Content-addressed manifests for both output directories.
  const bronzeManifest = buildCorpusManifest({
    'bronze-normalized.jsonl': hashFileBytes(bronzeNormalizedPath),
  });
  writeCorpusManifestAtomic(bronzeOutDir, bronzeManifest);

  const silverFiles: Record<string, string> = {
    [`silver-v2-${silverDigest}.jsonl`]: hashFileBytes(silverV2Path),
    'silver-v1-audit.jsonl': hashFileBytes(auditPath),
  };
  if (fs.existsSync(path.join(silverDir, 'silver-v1.jsonl'))) {
    silverFiles['silver-v1.jsonl'] = hashFileBytes(path.join(silverDir, 'silver-v1.jsonl'));
  }
  const silverManifest = buildCorpusManifest(silverFiles);
  writeCorpusManifestAtomic(silverDir, silverManifest);

  const acceptedCount = validated.filter((obs) => obs.validation.ok).length;
  const duplicateCount = validated.filter((obs) => obs.validation.rejectionCode === 'duplicate_locator').length;
  const rejectedCount = validated.length - acceptedCount - duplicateCount;

  return {
    bronzeTotal: validated.length,
    bronzeAccepted: acceptedCount,
    bronzeRejected: rejectedCount,
    bronzeDuplicates: duplicateCount,
    silverRecords: silverRecords.length,
    legacyRowsAudited: auditEntries.length,
    bronzeFile: bronzeNormalizedPath,
    silverFile: silverV2Path,
    auditFile: auditPath,
    bronzeManifestDigest: computeManifestDigest(bronzeManifest),
    silverManifestDigest: computeManifestDigest(silverManifest),
  };
}

/** Deterministic representative sort key (sourceUrl, then scrapedAt). */
function bronzeSortKey(record: ScrapedProductEvidence): string {
  return `${record.sourceUrl}|${record.scrapedAt || ''}`;
}

/** Atomic write of sorted lines (temp + rename). */
function writeLinesAtomic(targetPath: string, lines: string[]): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}`);
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, targetPath);
}

/** Convenience: build weak rules from an active config bundle shape. */
export function weakRulesFromBundle(bundle: {
  productTypes?: WeakLabelProductType[];
  attributes?: WeakLabelAttribute[];
}): WeakLabelRules {
  const config: WeakLabelConfig = {
    productTypes: bundle.productTypes || [],
    attributes: bundle.attributes || [],
    speciesAttributeId: 'species',
    foodFormAttributeId: 'food-form',
    lifeStageAttributeId: 'life-stage',
  };
  return new WeakLabelRules(config);
}
