/**
 * export-pi-archive.ts — Phase 0 (PR 0.1) archival dump for the Agent Lab
 * decommission (docs/plans/agent-lab-decommission-plan.md).
 *
 * Dumps every Product-Intellectual-exclusive table to newline-delimited JSON
 * under archive/pi-decommission-YYYYMMDD/ (gitignored — DB dumps never enter
 * git), writes a SHA-256 checksum manifest, and prints a census summary.
 *
 * Read-only: opens the workspace DB with `readonly: true`. Credential-shaped
 * fields are redacted before write (security mandate: log/data redaction).
 *
 * Usage: bun scripts/export-pi-archive.ts [dbPath]
 *   dbPath defaults to storage/catalog/.shopsite-cms/app.db
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

const DEFAULT_DB = resolve("storage/catalog/.shopsite-cms/app.db");
const dbPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DB;

if (!existsSync(dbPath)) {
  console.error(`[pi-archive] DB not found: ${dbPath}`);
  process.exit(1);
}

// PI-exclusive tables (product_intelligence_* + pi_* + agent_* family).
// benchmark_* tables are SHARED with the classification program (#14) and are
// deliberately NOT dumped here — they are only counted as a tamper check.
const PI_TABLES = [
  "product_intelligence_runs",
  "product_intelligence_events",
  "product_intelligence_steps",
  "product_intelligence_tool_calls",
  "product_intelligence_sources",
  "product_intelligence_evidence",
  "product_intelligence_conflicts",
  "product_intelligence_results",
  "product_intelligence_comparisons",
  "product_intelligence_policy_decisions",
  "product_intelligence_assets",
  "product_intelligence_imports",
  "pi_approved_policies",
  "pi_budget_policies",
  "pi_evaluation_runs",
  "pi_image_candidates",
  "pi_page_artifacts",
  "pi_retention_policies",
  "pi_reuse_policies",
  "pi_review_decisions",
  "pi_source_authorities",
  "agent_corrections",
  "agent_evaluation_cases",
  "agent_evaluation_snapshots",
  "agent_teaching_events",
  "agent_version_snapshots",
  "agent_version_states",
] as const;

const BENCHMARK_TABLES = [
  "benchmark_datasets",
  "benchmark_eval_runs",
  "benchmark_examples",
  "benchmark_prediction_bundles",
  "benchmark_qualification_receipts",
] as const;

/** Redact credential-shaped values before any bytes hit disk. */
function redact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      typeof v === "string" &&
      /password|secret|token|credential|api[_-]?key|authorization/i.test(k)
        ? "[REDACTED]"
        : v;
  }
  return out;
}

const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const outDir = resolve("archive", `pi-decommission-${dateTag}`);
mkdirSync(outDir, { recursive: true });

const db = new Database(dbPath, { readonly: true });
const manifest: string[] = [];
const census: Array<{ table: string; rows: number; file?: string }> = [];

for (const table of PI_TABLES) {
  const exists = db.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table);
  if (!exists) {
    census.push({ table, rows: 0 });
    continue;
  }
  const rows = db
    .query(`SELECT * FROM ${table}`)
    .all()
    .map((r) => redact(r as Record<string, unknown>));
  const fileName = `${table}.ndjson`;
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const payload = body.length > 0 ? body + "\n" : "";
  writeFileSync(join(outDir, fileName), payload);
  manifest.push(`${createHash("sha256").update(payload).digest("hex")}  ${fileName}`);
  census.push({ table, rows: rows.length, file: fileName });
}

console.log(`[pi-archive] wrote ${PI_TABLES.length} tables → ${outDir}`);

// Tamper-check counts for shared benchmark tables (no dump).
console.log("\n[pi-archive] benchmark_* tamper-check counts (shared w/ #14):");
for (const t of BENCHMARK_TABLES) {
  const row = db.query(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number } | null;
  const n = row?.c ?? 0;
  console.log(`  ${t} = ${n}`);
}

writeFileSync(join(outDir, "SHA256SUMS.txt"), manifest.join("\n") + "\n");

console.log("\n[pi-archive] census:");
for (const c of census) {
  console.log(`  ${c.table.padEnd(42)} ${String(c.rows).padStart(6)}${c.rows === 1 && !c.file ? "" : ""}${c.file ? `  → ${c.file}` : ""}`);
}

db.close();
