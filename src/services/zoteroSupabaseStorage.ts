/**
 * Zotero adapters for the Supabase client: the auth-session storage, and the
 * bridge to state that has to survive a plugin reload.
 *
 * Both are kept out of `supabaseClient.ts` so the L1 transport layer doesn't
 * statically import Zotero-specific implementations — encrypted storage here,
 * and the window the reload-persistent state is stashed on.
 */

import { EncryptedStorage } from './EncryptedStorage';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    SupabaseStorageAdapter,
    setSupabaseStorageAdapter,
    setSupabaseReloadBridge,
} from '@beaver/agent-core/transport/supabaseClient';

/**
 * The window that loaded this bundle, which is where the reload-persistent
 * Supabase state lives. Deliberately not `Zotero.getMainWindow()`: that would
 * let a second main window stop the first window's live auto-refresh ticker
 * and hijack its auth lock.
 */
// eslint-disable-next-line no-restricted-globals -- per-window scoping is the point; getMainWindow() would reach across windows
const currentWindow: Window | undefined = typeof window !== 'undefined' ? window : undefined;

/**
 * The Zotero plugin's storage adapter: an AES-encrypted, profile-bound store
 * (see EncryptedStorage).
 *
 * The store is constructed here, during registration at bundle init, so
 * `EncryptedStorage` must not touch the `Zotero` global from its constructor
 * or field initializers — a throw there would abort the whole bundle before
 * any UI mounts. Its per-key work is already async and happens on first use.
 */
function createEncryptedStorageAdapter(): SupabaseStorageAdapter {
    // Create encrypted storage instance
    const encryptedStorage = new EncryptedStorage();

    // Adapter to make EncryptedStorage compatible with Supabase's expected storage interface
    return {
    getItem: async (key: string) => {
        try {
            const data = await encryptedStorage.getItem(key);
            if (!data) {
                logger(`zoteroStorage: getItem("${key}") returned null (no stored session)`);
                return null;
            }

            // Migrate double-encoded tokens from old format
            // Old format: JSON.stringify('{"access_token":"..."}') → "\"{\\"access_token\\"...\""
            // New format: '{"access_token":"..."}'
            if (data.startsWith('"') && data.endsWith('"')) {
                try {
                    const migrated = JSON.parse(data);
                    await encryptedStorage.setItem(key, migrated);
                    return migrated;
                } catch {
                    // If parse fails, it's not double-encoded, return as-is
                }
            }

            return data;
        } catch (error) {
            logger(`zoteroStorage: Error getting auth from encrypted storage: ${error}`, 2);
            return null;
        }
    },
    setItem: async (key: string, value: string) => {
        // Retry once on failure — if the new token isn't persisted, the old
        // (now server-invalidated) refresh token will cause a logout on restart.
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await encryptedStorage.setItem(key, value);
                return;
            } catch (error) {
                logger(`zoteroStorage: Failed to persist auth token (attempt ${attempt + 1}/2): ${error}`, 2);
            }
        }
        logger('zoteroStorage: Auth token could NOT be persisted after 2 attempts. '
            + 'Session will work in memory but a restart will require re-login.', 2);
    },
    removeItem: async (key: string) => {
        logger(`zoteroStorage: removeItem("${key}") called — session being cleared`, new Error().stack);
        try {
            await encryptedStorage.removeItem(key);
        } catch (error) {
            logger(`zoteroStorage: Error removing auth from encrypted storage: ${error}`, 2);
        }
    }
    };
}

/**
 * Register the Zotero encrypted-storage adapter the Supabase auth session
 * persists into. Required, not a fallback: the client throws when nothing is
 * registered. Call once at webpack bundle init (from `react/index.tsx`),
 * before the Supabase client is first used — the client is created lazily on
 * first access to the exported `supabase` proxy, so this only needs to land
 * before that point, not before module load.
 */
export function registerZoteroSupabaseStorage(): void {
    setSupabaseStorageAdapter(createEncryptedStorageAdapter());
}

/**
 * Register the bridge to Supabase state that outlives a plugin reload, stashed
 * on this bundle's window.
 *
 * `__beaverDisposeSupabase` is also the cross-bundle channel the esbuild
 * bundle's shutdown path calls to stop the client (the webpack bundle owns the
 * client, the esbuild bundle owns shutdown), so the property name is a
 * contract, not an implementation detail.
 *
 * Call once at webpack bundle init (from `react/index.tsx`), before the
 * Supabase client is first used: registration is what stops a previous
 * instance's auto-refresh ticker and adopts its auth lock.
 */
export function registerZoteroSupabaseReloadBridge(): void {
    setSupabaseReloadBridge({
        takePreviousDisposer: () => {
            const previous = currentWindow?.__beaverDisposeSupabase;
            if (currentWindow) {
                currentWindow.__beaverDisposeSupabase = undefined;
            }
            return previous;
        },
        publishDisposer: (dispose) => {
            if (currentWindow) {
                currentWindow.__beaverDisposeSupabase = dispose;
            }
        },
        shareAuthLock: (fallback) => {
            if (!currentWindow) return fallback;
            const shared = currentWindow.__beaverAuthLock ?? fallback;
            currentWindow.__beaverAuthLock = shared;
            return shared;
        },
    });
}
