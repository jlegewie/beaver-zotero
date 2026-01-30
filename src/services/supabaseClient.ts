import { createClient, AuthApiError } from '@supabase/supabase-js';
import { EncryptedStorage } from './EncryptedStorage';
import { logger } from '../utils/logger';

// Create encrypted storage instance
const encryptedStorage = new EncryptedStorage();

// Adapter to make EncryptedStorage compatible with Supabase's expected storage interface
const zoteroStorage = {
    getItem: async (key: string) => {
        try {
            const data = await encryptedStorage.getItem(key);
            if (!data) return null;

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
            console.error('Error getting auth from encrypted storage:', error);
            return null;
        }
    },
    setItem: async (key: string, value: string) => {
        try {
            await encryptedStorage.setItem(key, value);
        } catch (error) {
            console.error('Error setting auth in encrypted storage:', error);
        }
    },
    removeItem: async (key: string) => {
        try {
            await encryptedStorage.removeItem(key);
        } catch (error) {
            console.error('Error removing auth from encrypted storage:', error);
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
    lockAcquiredAt: number | null;
}

const authLock: AuthLockState = {
    locked: false,
    queue: [],
    lockName: null,
    lockToken: null,
    lockAcquiredAt: null
};

// Counter for generating unique lock tokens
let lockTokenCounter = 0;

// Maximum time a lock can be held before being considered stale (30 seconds)
const MAX_LOCK_HOLD_TIME = 30000;

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

    // Check for stale lock (lock held too long, possibly due to error)
    if (authLock.locked && authLock.lockAcquiredAt) {
        const lockHeldTime = Date.now() - authLock.lockAcquiredAt;
        if (lockHeldTime > MAX_LOCK_HOLD_TIME) {
            logger(`Auth lock: Releasing stale lock held for ${lockHeldTime}ms by "${authLock.lockName}"`, 2);
            forceReleaseLock();
        }
    }

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
        return await fn();
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
        authLock.lockAcquiredAt = Date.now();
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
                authLock.lockAcquiredAt = Date.now();
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
        authLock.lockAcquiredAt = null;
    }
}

/**
 * Force release the lock (used for stale lock recovery)
 * Grants lock to the first waiter with a new token, invalidating the old holder's token.
 * Remaining waiters stay in queue and will be resolved when lock is released normally.
 */
function forceReleaseLock(): void {
    // Clear timeout only for the first waiter (who will get the lock)
    // Other waiters keep their timeouts active

    // If there are waiters, grant lock to the first one with a new token
    if (authLock.queue.length > 0) {
        const firstWaiter = authLock.queue.shift()!;
        if (firstWaiter.timeoutId) {
            clearTimeout(firstWaiter.timeoutId);
        }
        // Generate new token - this invalidates the old holder's token
        const newToken = ++lockTokenCounter;
        authLock.lockToken = newToken;
        authLock.lockAcquiredAt = Date.now();
        // Resolve the first waiter (they get the lock with the new token)
        firstWaiter.resolve(newToken);
        // Remaining waiters stay in queue and will be resolved when lock is released normally
    } else {
        // No waiters - fully release lock
        authLock.locked = false;
        authLock.lockName = null;
        authLock.lockToken = null;
        authLock.lockAcquiredAt = null;
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
