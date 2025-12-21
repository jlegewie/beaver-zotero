import { createStore } from 'jotai';

/**
 * Get or create the shared Jotai store.
 * The store is stored on the Zotero object to ensure it's shared across all windows.
 * This is necessary because each window loads its own instance of the React bundle.
 */
function getOrCreateStore() {
    // Check if we're in a Zotero environment
    if (typeof Zotero !== 'undefined') {
        // Use existing store if available, otherwise create and store it
        if (!Zotero.__beaverJotaiStore) {
            Zotero.__beaverJotaiStore = createStore();
        }
        return Zotero.__beaverJotaiStore;
    }
    // Fallback for non-Zotero environments (shouldn't happen in practice)
    return createStore();
}

export const store = getOrCreateStore();
