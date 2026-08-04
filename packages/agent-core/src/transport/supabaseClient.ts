import { createClient, AuthApiError, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseConfig, markSupabaseConfigInUse } from './config';
import { logger } from '../platform/logger';

/**
 * Storage backend Supabase persists the auth session into. Matches the subset of
 * the Web Storage / Supabase storage interface the auth client uses.
 *
 * Every host must register an implementation via `setSupabaseStorageAdapter`
 * before the Supabase client is first used — e.g. `registerZoteroSupabaseStorage()`
 * for the Zotero plugin, or a non-Zotero host's own implementation (web
 * `localStorage`, Office settings, …).
 */
export interface SupabaseStorageAdapter {
    getItem: (key: string) => Promise<string | null> | string | null;
    setItem: (key: string, value: string) => Promise<void> | void;
    removeItem: (key: string) => Promise<void> | void;
}

// Host-supplied storage adapter. The Supabase client is created lazily on the
// first property access of the exported `supabase` proxy, so a host has until
// that point to register — but registration is required before it, and
// `createSupabaseClient` throws otherwise.
let injectedStorageAdapter: SupabaseStorageAdapter | null = null;

/**
 * Register the storage adapter for the Supabase auth session. Must be called
 * before the Supabase client is first used (see `createSupabaseClient`) — the
 * client is created lazily, so registering at host bundle init is sufficient.
 */
export function setSupabaseStorageAdapter(adapter: SupabaseStorageAdapter): void {
    if (supabaseInstance) {
        throw new Error('Supabase storage adapter must be set before the Supabase client is first used');
    }
    injectedStorageAdapter = adapter;
}

/** Stops a Supabase client: marks it disposed and stops its auto-refresh ticker. */
export type SupabaseDisposer = () => Promise<void>;

/**
 * Host access to the Supabase state that has to outlive a bundle reload: the
 * previous instance's disposer, and the auth lock.
 *
 * Reloading the bundle creates a second module instance while the first one's
 * auto-refresh ticker is still running. Two tickers refreshing the same session
 * race for a single-use refresh token, so the new instance stops the old one
 * through `previousDisposer()`. The auth lock is shared for the mirror-image
 * reason: an operation already waiting behind an in-flight refresh must still be
 * released by the old holder once the new instance takes over.
 *
 * The host decides how far that state reaches — the Zotero plugin scopes it to
 * the window that loaded the bundle, so reloading one window never touches
 * another window's live client.
 *
 * A host that neither reloads its bundle nor needs to stop the client from
 * outside this bundle can skip registration entirely: there is then no previous
 * instance to stop and no lock to inherit. Code in the same bundle can always
 * call `disposeSupabaseClient` directly; `publishDisposer` exists for the
 * reload and cross-bundle cases, where the caller cannot import it.
 */
export interface SupabaseReloadBridge {
    /**
     * Returns the disposer published by the previous instance, if any, without
     * consuming it. Stopping a client is idempotent, and leaving the disposer
     * reachable is what lets the host's shutdown path retry a stop that failed.
     */
    previousDisposer(): SupabaseDisposer | undefined;
    /**
     * Publishes this instance's disposer, replacing the previous instance's,
     * for the next instance's `previousDisposer()` and for the host's own
     * shutdown path.
     */
    publishDisposer(dispose: SupabaseDisposer): void;
    /**
     * Returns the auth lock shared with previous instances, adopting `fallback`
     * as the shared lock when there is none yet.
     */
    shareAuthLock(fallback: AuthLockState): AuthLockState;
}

let reloadBridge: SupabaseReloadBridge | null = null;

/**
 * Register the bridge to reload-persistent Supabase state. Call once at bundle
 * init (e.g. `registerZoteroSupabaseReloadBridge()` from `react/index.tsx`),
 * before the Supabase client is first used.
 *
 * Registering adopts the shared auth lock and stops any previous instance's
 * auto-refresh ticker; this instance's disposer is published later, when its
 * client is created.
 *
 * Throws once a client exists, because every effect of registering is wrong at
 * that point: the disposer taken off the host would be this client's own, so
 * stopping it would kill a live auto-refresh ticker, and swapping the auth lock
 * would strand any operation already queued on the old one.
 */
export function setSupabaseReloadBridge(bridge: SupabaseReloadBridge): void {
    if (supabaseInstance) {
        throw new Error('Supabase reload bridge must be set before the Supabase client is first used');
    }
    reloadBridge = bridge;
    authLock = bridge.shareAuthLock(authLock);

    const previousDispose = bridge.previousDisposer();
    if (previousDispose) {
        // Not awaited: registration runs during bundle init and must not block
        // on the old client's teardown.
        logger('Stopping previous Supabase client auto-refresh timer');
        previousDispose().catch((e) => logger(`Failed to stop previous Supabase client: ${e}`, 2));
    }
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

export interface AuthLockState {
    locked: boolean;
    queue: LockQueueEntry[];
    lockName: string | null;
    lockToken: number | null;  // Unique token to verify lock ownership
    tokenCounter: number;      // Counter for generating unique lock tokens
}

function createAuthLockState(): AuthLockState {
    return {
        locked: false,
        queue: [],
        lockName: null,
        lockToken: null,
        tokenCounter: 0
    };
}

// Starts instance-local and is swapped for the reload-persistent lock when a
// host registers its bridge. Registration happens at bundle init, before any
// auth operation runs, so no lock holder or waiter can observe the swap.
let authLock: AuthLockState = createAuthLockState();

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
        const token = ++authLock.tokenCounter;
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
        const newToken = ++authLock.tokenCounter;
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

type SupabaseClientInstance = SupabaseClient<any, any, any>;

let supabaseInstance: SupabaseClientInstance | null = null;
let disposed = false;

async function stopDisposedSupabaseClient(client: SupabaseClientInstance): Promise<void> {
    // initialize() always re-runs _handleVisibilityChange() in its finally
    // block, so a disposed client must stop auto-refresh again after
    // initialize() settles to remove any re-registered SDK listener.
    await client.auth.stopAutoRefresh();
}

/**
 * Stop this instance's Supabase client: mark it disposed so the pending
 * `startAutoRefresh` chain doesn't restart the ticker, then stop the ticker.
 *
 * Published through the reload bridge so the next bundle instance and the
 * host's shutdown path can stop this client. Safe to call repeatedly and when
 * no client was ever created — the disposed flag is only set alongside a
 * client, so it can never pre-emptively disable one created later.
 */
export async function disposeSupabaseClient(): Promise<void> {
    if (!supabaseInstance) return;
    disposed = true;
    await stopDisposedSupabaseClient(supabaseInstance);
}

function createSupabaseClient(): SupabaseClientInstance {
    // Storage the auth client persists into: the host-registered adapter.
    // Falling back to an unpersisted in-memory store here would silently log
    // every user out on the next restart with no signal until they notice —
    // treat a missing registration as a wiring bug and fail loudly instead.
    if (!injectedStorageAdapter) {
        throw new Error(
            'No Supabase storage adapter registered. Call setSupabaseStorageAdapter() ' +
            '(e.g. registerZoteroSupabaseStorage() in react/index.tsx) before the Supabase client is first used.'
        );
    }
    const sessionStorage: SupabaseStorageAdapter = injectedStorageAdapter;

    // Read at creation, not at module load, so a host whose project URL is only
    // known at runtime can register it before the client is first used.
    const { url, anonKey } = getSupabaseConfig();

    const client = createClient(url, anonKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            storage: sessionStorage,
            // Mutex-based lock to prevent concurrent token refresh operations
            lock: acquireAuthLock
        }
    });

    // Pin the values only once a client actually holds them: this client keeps
    // them for the rest of its life, so a later registration that changed them
    // is rejected. A creation that threw leaves nothing pinned, so a host can
    // correct bad values and retry.
    markSupabaseConfigInUse({ url, anonKey });

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
    // earlier is a no-op — the listener doesn't exist yet and gets registered
    // right after.
    // Guard: if the client is disposed (plugin reload / shutdown) before
    // initialize() resolves, skip startAutoRefresh() so we don't resurrect
    // the old client's ticker alongside the new one.
    client.auth.initialize().then(async () => {
        if (disposed) {
            await stopDisposedSupabaseClient(client);
            return;
        }
        await client.auth.startAutoRefresh();
    }).catch(async (e) => {
        if (disposed) {
            await stopDisposedSupabaseClient(client);
            return;
        }
        logger(`Failed to initialize/start Supabase auto-refresh: ${e}`, 2);
    });

    // Publish the disposer now that there is a client to stop, so a later
    // reload and the host's shutdown path can stop this client's ticker.
    reloadBridge?.publishDisposer(disposeSupabaseClient);

    return client;
}

function getSupabaseClient(): SupabaseClientInstance {
    supabaseInstance ??= createSupabaseClient();
    return supabaseInstance;
}

export const supabase = new Proxy({} as SupabaseClientInstance, {
    get(_target, property) {
        const client = getSupabaseClient();
        const value = Reflect.get(client, property, client);
        return typeof value === 'function' ? value.bind(client) : value;
    },
    set(_target, property, value) {
        return Reflect.set(getSupabaseClient(), property, value);
    },
    has(_target, property) {
        return property in getSupabaseClient();
    },
    ownKeys() {
        return Reflect.ownKeys(getSupabaseClient());
    },
    getOwnPropertyDescriptor(_target, property) {
        return Reflect.getOwnPropertyDescriptor(getSupabaseClient(), property);
    }
});
