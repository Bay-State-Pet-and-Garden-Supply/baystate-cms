#!/usr/bin/env bun
/**
 * Release Authoring CLI (P2) — declarative change-set → validated candidate
 * release under src/classification/releases/.
 *
 * Fail-closed (plan B.P2.3):
 *  - refuses id deletion/renaming by construction (no such operation exists);
 *  - refuses when the candidate has ANY error-severity validation finding;
 *  - refuses to overwrite an existing release directory;
 *  - NEVER touches storage/catalog and NEVER writes workspace pins —
 *    activation is exclusively the sanctioned release-routes channel.
 *
 * Usage:
 *   bun scripts/classification-author-release.ts --source bay-state-v4 \
 *     --changeset ./my-changeset.json [--releases-root <dir>]
 *
 * Change-set JSON shape: see `ReleaseChangeSet` in
 * src/classification/release-authoring.ts. Prints the structured result as
 * JSON; exits non-zero on refusal.
 */
import fs from 'fs';
import { authorCandidateRelease, type ReleaseChangeSet } from '../src/classification/release-authoring';

function fail(message: string): never {
  console.error(`classification-author-release: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined) fail(`--${key} requires a value.`);
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const source = args.source;
const changesetPath = args.changeset;
if (!source) fail('--source <releaseId|dir> is required.');
if (!changesetPath) fail('--changeset <path-to-json> is required.');
if (!fs.existsSync(changesetPath)) fail(`changeset file does not exist: ${changesetPath}`);

let changeSet: ReleaseChangeSet;
try {
  changeSet = JSON.parse(fs.readFileSync(changesetPath, 'utf8')) as ReleaseChangeSet;
} catch (err) {
  fail(`changeset is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
}

const result = authorCandidateRelease(source, changeSet, {
  releasesRootOverride: args['releases-root'],
});

console.log(JSON.stringify({
  ok: result.ok,
  ...(result.ok ? { candidateDir: result.candidateDir } : { reason: result.reason }),
  report: result.report
    ? {
        ok: result.report.ok,
        errorFindings: result.report.findings.filter(f => f.severity === 'error'),
        warningFindings: result.report.findings.filter(f => f.severity === 'warning'),
      }
    : null,
}, null, 2));

if (!result.ok) process.exit(1);
