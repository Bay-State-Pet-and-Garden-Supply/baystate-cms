#!/usr/bin/env bun
/**
 * M6 live-smoke CLI entry (thin wrapper).
 *
 * All logic (gates, secret resolution, connector invocation, report) lives
 * in `src/onboarding/sourcing/html-scraper/live-smoke.ts` so it is
 * importable by the vitest/bun suites; this file only wires argv/env to it.
 * The actual live command is a manual rollout action (M8) — it never runs
 * in tests or CI and performs no network when the gate is absent.
 */
import { main } from '../src/onboarding/sourcing/html-scraper/live-smoke.ts';

if (import.meta.main === true) {
  main(process.argv.slice(2), process.env);
}
