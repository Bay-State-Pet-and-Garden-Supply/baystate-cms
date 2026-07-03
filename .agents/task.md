# Scoring Refinement and Automation Tasks

- [x] Modify `src/onboarding/source-discovery.ts`
  - [x] Implement subdomain filtering (penalizing non-store subdomains by `-0.4`)
  - [x] Rebalance scoring weights (domain to `+0.2`, brand to `+0.15`)
  - [x] Add variant keyword dictionary and separate base/variant overlap scoring
  - [x] Implement bidirectional substring checks for word-matching logic
- [x] Modify `src/onboarding/job-queue.ts`
  - [x] Automatically set status to `source_confirmed` if the top source has confidence >= `0.95`
- [x] Update unit tests in `src/tests/unit/source-discovery.test.ts`
  - [x] Add test for subdomain filtering (penalizing help/support subdomains)
  - [x] Add test for base name matching (variant keyword exclusion)
  - [x] Add test for variant keyword tie-breaker matching
  - [x] Add test for bidirectional substring matching
- [x] Run automated tests
  - [x] Ensure all tests pass
- [x] Verify fix against active database
  - [x] Run verification script to inspect final rankings for `WOOF FORAGER FLYBALLYELLOW` and others
- [x] Document final walkthrough
