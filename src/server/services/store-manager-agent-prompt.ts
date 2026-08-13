/**
 * Store Manager system prompt (epic #42, #41).
 *
 * The prompt is now a versioned operating contract built by
 * `store-manager-prompt-builder.ts` from reviewed code and the #34 tool
 * policy metadata registry. This module re-exports the builder surface for
 * importers that referenced the historical prompt module path.
 *
 * The system prompt must stay byte-for-byte independent of request/user/
 * product data (see #33) — never concatenate runtime content here.
 */

export {
  buildStoreManagerSystemPrompt,
  buildToolGuidelines,
  renderStateVocabulary,
  STORE_MANAGER_AGENT_SYSTEM_PROMPT,
  STORE_MANAGER_PROMPT_VERSION,
  STORE_MANAGER_STATE_VOCABULARY,
  MAX_STORE_MANAGER_PROMPT_BYTES,
} from './store-manager-prompt-builder';
