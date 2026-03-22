import { createClient, AuthApiError } from '@supabase/supabase-js';
import { EncryptedStorage } from './EncryptedStorage';
import { logger } from '../utils/logger';

// Stop any previous Supabase client's auto-refresh timer that may have survived
// a plugin reload.  Use `window` (the current script's window) rather than
// Zotero.getMainWindow() so that opening a second main window doesn't
// accidentally stop the first window's active auto-refresh timer.
// eslint-disable-next-line no-restricted-globals -- intentionally using `window` (this script's window), not getMainWindow()
const currentWindow: Window | undefined = typeof window !== 'undefined' ? window : undefined;
if (currentWindow?.__beaverDisposeSupabase) {
    currentWindow.__beaverDisposeSupabase();
    logger('Stopped previous Supabase client auto-refresh timer');
}

// Create encrypted storage instance
const encryptedStorage = new EncryptedStorage();

// Adapter to make EncryptedStorage compatible with Supabase's expected storage interface
const zoteroStorage = {
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

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase URL or Anon Key');
}

// =============================================================================
// Auth Lock Implementation
// =============================================================================
// Supabase uses a lock mechanism to prevent concurrent token refresh operations.
// Without proper locking, multiple concurrent refresh attempts can cause
// "Invalid Refresh Token: Already Used" errors because refresh tokens are single-use.
//
// This mutex-based implementation ensures only one auth operation runs at a time.
// Subsequent operations wait in a queue with configurable timeout.
// =============================================================================

interface LockQueueEntry {
    resolve: (token: number) => void;
    timeoutId: ReturnType<typeof setTimeout> | null;
}

interface AuthLockState {
    locked: boolean;
    queue: LockQueueEntry[];
    lockName: string | null;
    lockToken: number | null;  // Unique token to verify lock ownership
}

const authLock: AuthLockState = {
    locked: false,
    queue: [],
    lockName: null,
    lockToken: null
};

// Counter for generating unique lock tokens
let lockTokenCounter = 0;

/**
 * Error thrown when lock acquisition times out
 * Supabase auth-js checks for isAcquireTimeout to skip work when lock is held
 */
class LockAcquireTimeoutError extends Error {
    isAcquireTimeout = true;
    
    constructor(name: string, timeout: number) {
        super(`Lock acquisition timeout for "${name}" after ${timeout}ms`);
        this.name = 'LockAcquireTimeoutError';
    }
}

/**
 * Mutex-based lock for Supabase auth operations
 * Prevents concurrent token refresh which causes "Invalid Refresh Token: Already Used" errors
 */
async function acquireAuthLock<T>(
    name: string,
    acquireTimeout: number,
    fn: () => Promise<T>
): Promise<T> {
    const startTime = Date.now();

    // Try to acquire the lock - returns a unique token if successful, null if not
    const lockToken = await tryAcquireLock(name, acquireTimeout);

    if (lockToken === null) {
        // Lock acquisition failed (timeout or immediate failure with acquireTimeout=0)
        // Throw an error with isAcquireTimeout so Supabase auth-js can handle it properly
        // (e.g., auto-refresh ticker will skip work when lock is held by another operation)
        logger(`Auth lock: Failed to acquire "${name}" (timeout: ${acquireTimeout}ms, held by: "${authLock.lockName}")`);
        throw new LockAcquireTimeoutError(name, acquireTimeout);
    }

    const waitTime = Date.now() - startTime;
    if (waitTime > 100) {
        logger(`Auth lock: Acquired "${name}" after waiting ${waitTime}ms`);
    }

    try {
        const result = await fn();
        // Log when auto-refresh operations complete — helps diagnose silent token failures
        if (name.includes('refresh') || name.includes('initialize')) {
            logger(`Auth lock: "${name}" completed successfully`);
        }
        return result;
    } catch (error) {
        handleAuthError(error, name);
        throw error;
    } finally {
        releaseLock(lockToken);
    }
}

/**
 * Attempt to acquire the lock, waiting up to acquireTimeout milliseconds
 * Returns a unique lock token on success, null on failure/timeout
 * 
 * Supabase auth-js timeout semantics:
 * - acquireTimeout < 0: wait indefinitely (no timeout)
 * - acquireTimeout === 0: fail immediately if lock is held
 * - acquireTimeout > 0: wait up to that many milliseconds
 */
function tryAcquireLock(name: string, acquireTimeout: number): Promise<number | null> {
    // Lock is free - acquire immediately with a unique token
    if (!authLock.locked) {
        const token = ++lockTokenCounter;
        authLock.locked = true;
        authLock.lockName = name;
        authLock.lockToken = token;
        return Promise.resolve(token);
    }

    // Lock is held - check timeout semantics
    // acquireTimeout === 0 means fail immediately
    if (acquireTimeout === 0) {
        logger(`Auth lock: Cannot acquire "${name}" immediately (held by "${authLock.lockName}")`);
        return Promise.resolve(null);
    }

    // acquireTimeout < 0 means wait indefinitely, > 0 means wait with timeout
    return new Promise<number | null>((resolve) => {
        const entry: LockQueueEntry = {
            resolve: (token: number) => {
                authLock.lockName = name;
                authLock.lockToken = token;
                resolve(token);
            },
            timeoutId: null
        };

        // Only set timeout if acquireTimeout > 0 (negative means wait indefinitely)
        if (acquireTimeout > 0) {
            entry.timeoutId = setTimeout(() => {
                const index = authLock.queue.indexOf(entry);
                if (index >= 0) {
                    authLock.queue.splice(index, 1);
                }
                resolve(null);
            }, acquireTimeout);
        }

        authLock.queue.push(entry);
    });
}

/**
 * Release the lock and wake up the next waiter if any
 * Verifies lock ownership via token to prevent stale holders from releasing
 * a lock that was force-transferred to another operation
 */
function releaseLock(token: number): void {
    // Verify ownership: if the token doesn't match, this caller no longer owns
    // the lock (e.g., it was force-released due to staleness)
    if (authLock.lockToken !== token) {
        logger(`Auth lock: Ignoring release from stale owner (token ${token}, current: ${authLock.lockToken})`);
        return;
    }

    if (authLock.queue.length > 0) {
        // Pass lock to next waiter with a new token
        const next = authLock.queue.shift()!;
        if (next.timeoutId) {
            clearTimeout(next.timeoutId);
        }
        const newToken = ++lockTokenCounter;
        next.resolve(newToken);
    } else {
        // No waiters - release lock
        authLock.locked = false;
        authLock.lockName = null;
        authLock.lockToken = null;
    }
}

/**
 * Handle auth errors with appropriate logging
 * Note: We no longer automatically clear the session on "Already Used" errors
 * because with proper locking, this error indicates a more serious issue
 * (e.g., token used on another device) that requires user re-authentication
 */
function handleAuthError(error: unknown, lockName: string): void {
    if (error instanceof AuthApiError) {
        if (error.message.includes('Invalid Refresh Token')) {
            // This error with proper locking means the token was used elsewhere
            // (another device, or server-side invalidation)
            logger(`Auth lock: Invalid refresh token in "${lockName}" - user may need to re-authenticate`, 2);
            // Don't clear session here - let the error propagate so the UI can handle it
        } else {
            logger(`Auth lock: AuthApiError in "${lockName}": ${error.message}`, 2);
        }
    } else if (error instanceof Error) {
        logger(`Auth lock: Error in "${lockName}": ${error.message}`, 2);
    }
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: zoteroStorage,
        // Mutex-based lock to prevent concurrent token refresh operations
        lock: acquireAuthLock
    }
});

// Force-start auto-refresh and remove the visibility-change listener.
//
// The Supabase SDK registers a `visibilitychange` listener during
// _initialize() (inside _handleVisibilityChange, in the `finally` block).
// That listener stops the auto-refresh ticker when the document becomes
// "hidden" and calls _recoverAndRefresh() when it becomes "visible" again.
// In Zotero this is harmful: if the window is briefly obscured the ticker
// stops, the access token can expire, and _recoverAndRefresh may hit a
// stale refresh token → "Invalid Refresh Token" → unexpected logout.
//
// startAutoRefresh() removes the visibility listener and runs the ticker
// unconditionally.  We must call it AFTER initialize() resolves, because
// _initialize()'s finally block re-registers the listener.  Calling it
// before (as was done previously) is a no-op — the listener doesn't exist
// yet and gets registered right after.
// Guard: if the client is disposed (plugin reload / shutdown) before
// initialize() resolves, skip startAutoRefresh() so we don't resurrect
// the old client's ticker alongside the new one.
let disposed = false;

async function stopDisposedSupabaseClient(): Promise<void> {
    // initialize() always re-runs _handleVisibilityChange() in its finally
    // block, so a disposed client must stop auto-refresh again after
    // initialize() settles to remove any re-registered SDK listener.
    await supabase.auth.stopAutoRefresh();
}

supabase.auth.initialize().then(async () => {
    if (disposed) {
        await stopDisposedSupabaseClient();
        return;
    }
    await supabase.auth.startAutoRefresh();
}).catch(async (e) => {
    if (disposed) {
        await stopDisposedSupabaseClient();
        return;
    }
    logger(`Failed to initialize/start Supabase auto-refresh: ${e}`, 2);
});

// Register cleanup function on the current window so that:
// 1. Module-level reload cleanup (above) can stop this client's timer
// 2. hooks.ts (esbuild bundle) can call win.__beaverDisposeSupabase during shutdown
// Using `window` scopes the function to the window that loaded this bundle,
// so multi-window scenarios don't interfere with each other.
if (currentWindow) {
    currentWindow.__beaverDisposeSupabase = async () => {
        disposed = true;
        await stopDisposedSupabaseClient();
    };
}
