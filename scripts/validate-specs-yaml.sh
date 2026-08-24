#!/usr/bin/env bash
# validate-specs-yaml.sh — referenced by docs/plans/family-title-category-page-requirements-plan.md §13.
#
# Validates every specs/**/*.yaml file:
#   1. parses as YAML
#   2. uses only allowed status values
#   3. epic.yaml story refs (spec:/tasks:) point at existing files
# Read-only; exits non-zero on first class of failure (all failures reported).
set -u

root="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

# Historical epics (e03-e05) also use "todo"; it remains a legal value.
ALLOWED_STATUSES='planned|todo|failing|passing|done|in_progress|blocked|cancelled'

while IFS= read -r f; do
  rel="${f#"$root"/}"

  # 1. Parse check
  if ! node -e "require('js-yaml').load(require('fs').readFileSync(process.argv[1],'utf8'))" "$f" >/dev/null 2>&1; then
    echo "FAIL parse: $rel"
    fail=1
    continue
  fi

  # 2. Status vocabulary check (indented or top-level "status:" keys)
  bad=$(node -e '
    const y = require("js-yaml"), fs = require("fs");
    const doc = y.load(fs.readFileSync(process.argv[1], "utf8"));
    const allowed = new Set(String(process.argv[2]).split("|"));
    const bad = [];
    const walk = (node, path) => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach((v, i) => walk(v, path + "[" + i + "]")); return; }
      for (const [k, v] of Object.entries(node)) {
        if (k === "status" && typeof v === "string" && !allowed.has(v)) {
          bad.push(path + ".status=" + v);
        }
        walk(v, path ? path + "." + k : k);
      }
    };
    walk(doc, "");
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
  ' "$f" "$ALLOWED_STATUSES" 2>&1)
  if [ -n "$bad" ]; then
    echo "FAIL status: $rel"
    echo "$bad" | sed 's/^/    /'
    fail=1
  fi

  # 3. Epic story spec/tasks file references exist
  missing=$(node -e '
    const y = require("js-yaml"), fs = require("fs"), path = require("path");
    const doc = y.load(fs.readFileSync(process.argv[1], "utf8"));
    const dir = path.dirname(process.argv[1]);
    const missing = [];
    for (const s of doc.stories ?? []) {
      for (const key of ["spec", "tasks"]) {
        if (typeof s[key] === "string" && !fs.existsSync(path.join(dir, s[key]))) {
          missing.push(s.id + "." + key + "=" + s[key]);
        }
      }
    }
    if (missing.length) { console.error(missing.join("\n")); process.exit(1); }
  ' "$f" 2>&1)
  if [ -n "$missing" ]; then
    echo "FAIL refs: $rel"
    echo "$missing" | sed 's/^/    /'
    fail=1
  fi
done < <(find "$root/specs" -name '*.yaml' -not -path "$root/specs/archive/*" | sort)

if [ "$fail" -eq 0 ]; then
  echo "OK: all specs YAML valid ($(find "$root/specs" -name '*.yaml' -not -path "$root/specs/archive/*" | wc -l | tr -d ' ') files)"
fi
exit "$fail"
