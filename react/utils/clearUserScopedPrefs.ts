import { clearPref } from '../../src/utils/prefs';

/**
 * Reset prefs that belong to a Beaver account, called when a different user
 * authenticates on this Zotero install.
 *
 * Scope: only clears prefs that (a) identify the previous account, (b) hold
 * sensitive credentials, (c) mirror backend per-user state that would corrupt
 * the new account's sync, or (d) are cheap to regenerate. User-authored
 * content that lives only on the device (custom instructions, custom
 * prompts, custom actions, custom model configs, deferred tool preferences)
 * is preserved, since the backend has no copy and the same human is almost
 * always the one switching accounts.
 *
 * Intentionally left in place: install-level upgrade flags, UI/citation/agent
 * preferences, onboarding tour completion, local-only customizations, and DB
 * tables (threads/messages/sync_logs are user_id-scoped on the backend;
 * embeddings and document cache entries are library-scoped).
 */
export function clearUserScopedPrefs(): void {
    // Identity (callers may immediately re-set userId/userEmail to the new
    // authenticated user — see useProfileSync.ts)
    clearPref('userId');
    clearPref('userEmail');
    clearPref('currentPlanId');

    // BYO API keys — cleared as a security default since BYOK credentials
    // are typically scoped to a billing account.
    clearPref('googleGenerativeAiApiKey');
    clearPref('openAiApiKey');
    clearPref('anthropicApiKey');

    // Last-selected model — the previous account's choice may not be
    // available to the new account's plan, so clear and let first use repopulate.
    clearPref('lastUsedModel');

    // Per-account sync state — mirrors backend per-user_id state. Carrying
    // these over would mis-attribute pending sync work to the new account.
    clearPref('skippedItems');
    clearPref('deletionJobs');

    // Per-account caches — regenerated on demand.
    clearPref('librarySuggestions');
    clearPref('librarySuggestionsGeneratedAt');
}
