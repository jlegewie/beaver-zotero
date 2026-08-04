import { beforeEach, describe, expect, it, vi } from 'vitest';

const { capturedLocks, mockCreateClient, mockLogger } = vi.hoisted(() => ({
    capturedLocks: [] as Array<(name: string, acquireTimeout: number, fn: () => Promise<unknown>) => Promise<unknown>>,
    mockCreateClient: vi.fn((_url: string, _key: string, options: {
        auth: {
            lock: (name: string, acquireTimeout: number, fn: () => Promise<unknown>) => Promise<unknown>;
            storage: unknown;
        };
    }) => {
        capturedLocks.push(options.auth.lock);
        return {
            auth: {
                initialize: vi.fn().mockResolvedValue(undefined),
                startAutoRefresh: vi.fn().mockResolvedValue(undefined),
                stopAutoRefresh: vi.fn().mockResolvedValue(undefined),
            },
        };
    }),
    mockLogger: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => {
    class MockAuthApiError extends Error {}

    return {
        AuthApiError: MockAuthApiError,
        createClient: mockCreateClient,
    };
});

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: mockLogger,
}));

function createMockStorageAdapter() {
    return {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    };
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

/**
 * Register the Zotero reload bridge for the freshly loaded module generation.
 * The bridge is what stashes the disposer and the auth lock on the window, so
 * a test that exercises reload behavior has to register it per generation.
 */
async function registerReloadBridge(): Promise<void> {
    const { registerZoteroSupabaseReloadBridge } = await import('../../../src/services/zoteroSupabaseStorage');
    registerZoteroSupabaseReloadBridge();
}

/** Let the disposer's promise chain settle. */
async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    capturedLocks.length = 0;
    mockCreateClient.mockClear();
    mockLogger.mockClear();
    vi.resetModules();

    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';

    vi.stubGlobal('window', {});
});

describe('supabaseClient auth lock reload handling', () => {
    it('does not create the client until the exported client is first used', async () => {
        const module = await import('@beaver/agent-core/transport/supabaseClient');
        module.setSupabaseStorageAdapter(createMockStorageAdapter());

        expect(mockCreateClient).not.toHaveBeenCalled();

        module.supabase.auth;

        expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it('uses the registered storage adapter when the exported client is first used', async () => {
        const registeredStorage = createMockStorageAdapter();
        const module = await import('@beaver/agent-core/transport/supabaseClient');

        module.setSupabaseStorageAdapter(registeredStorage);
        module.supabase.auth;

        expect(mockCreateClient).toHaveBeenCalledTimes(1);
        expect(mockCreateClient.mock.calls[0][2].auth.storage).toBe(registeredStorage);
    });

    it('throws when the exported client is used without a registered storage adapter', async () => {
        const module = await import('@beaver/agent-core/transport/supabaseClient');

        expect(() => module.supabase.auth).toThrow(
            'No Supabase storage adapter registered.'
        );
        expect(mockCreateClient).not.toHaveBeenCalled();
    });

    it('rejects storage registration after the exported client has been used', async () => {
        const module = await import('@beaver/agent-core/transport/supabaseClient');
        module.setSupabaseStorageAdapter(createMockStorageAdapter());

        module.supabase.auth;

        expect(() => module.setSupabaseStorageAdapter(createMockStorageAdapter()))
            .toThrow('Supabase storage adapter must be set before the Supabase client is first used');
    });

    it('keeps inherited waiters queued across module reloads', async () => {
        const firstModule = await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        firstModule.setSupabaseStorageAdapter(createMockStorageAdapter());
        firstModule.supabase.auth;
        const firstGenerationLock = capturedLocks.at(-1)!;
        const initialWindowLock = (window as any).__beaverAuthLock;

        expect(initialWindowLock).toBeDefined();

        const holderRelease = createDeferred<void>();
        const events: string[] = [];

        const holder = firstGenerationLock('refresh-session', -1, async () => {
            events.push('holder:start');
            await holderRelease.promise;
            events.push('holder:end');
            return 'holder';
        });

        const inheritedWaiter = firstGenerationLock('get-session', -1, async () => {
            events.push('inherited');
            return 'inherited';
        });

        await Promise.resolve();
        expect(events).toEqual(['holder:start']);

        vi.resetModules();
        const secondModule = await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        secondModule.setSupabaseStorageAdapter(createMockStorageAdapter());
        secondModule.supabase.auth;
        const reloadedLock = capturedLocks.at(-1)!;
        expect((window as any).__beaverAuthLock).toBe(initialWindowLock);

        const reloadedWaiter = reloadedLock('refresh-after-reload', -1, async () => {
            events.push('reloaded');
            return 'reloaded';
        });

        await Promise.resolve();
        expect(events).toEqual(['holder:start']);

        holderRelease.resolve();

        await expect(holder).resolves.toBe('holder');
        await expect(inheritedWaiter).resolves.toBe('inherited');
        await expect(reloadedWaiter).resolves.toBe('reloaded');
        expect(events).toEqual([
            'holder:start',
            'holder:end',
            'inherited',
            'reloaded',
        ]);
    });

    it('starts with a fresh auth lock after shutdown cleanup removes the persisted state', async () => {
        const firstModule = await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        firstModule.setSupabaseStorageAdapter(createMockStorageAdapter());
        firstModule.supabase.auth;
        const firstWindowLock = (window as any).__beaverAuthLock;

        // Mirrors the host shutdown path, which disposes the client and clears
        // both pieces of reload-persistent state off the window.
        delete (window as any).__beaverAuthLock;
        (window as any).__beaverDisposeSupabase = undefined;

        vi.resetModules();
        const secondModule = await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        secondModule.setSupabaseStorageAdapter(createMockStorageAdapter());
        secondModule.supabase.auth;

        expect((window as any).__beaverAuthLock).toBeDefined();
        expect((window as any).__beaverAuthLock).not.toBe(firstWindowLock);
        expect((window as any).__beaverAuthLock).toMatchObject({
            locked: false,
            queue: [],
            lockName: null,
            lockToken: null,
            tokenCounter: 0,
        });
    });
});

describe('supabaseClient reload bridge', () => {
    it('creates a working client and touches no host state when no bridge is registered', async () => {
        const module = await import('@beaver/agent-core/transport/supabaseClient');
        module.setSupabaseStorageAdapter(createMockStorageAdapter());

        module.supabase.auth;

        expect(mockCreateClient).toHaveBeenCalledTimes(1);
        expect((window as any).__beaverDisposeSupabase).toBeUndefined();
        expect((window as any).__beaverAuthLock).toBeUndefined();
    });

    it('disposes without a client and without a bridge', async () => {
        const module = await import('@beaver/agent-core/transport/supabaseClient');

        await expect(module.disposeSupabaseClient()).resolves.toBeUndefined();

        expect(mockCreateClient).not.toHaveBeenCalled();
    });

    // Registering late would hand this generation its own disposer back and
    // swap the lock out from under any queued waiter, both silently.
    it('rejects bridge registration after the exported client has been used', async () => {
        const module = await import('@beaver/agent-core/transport/supabaseClient');
        module.setSupabaseStorageAdapter(createMockStorageAdapter());

        module.supabase.auth;

        await expect(registerReloadBridge()).rejects.toThrow(
            'Supabase reload bridge must be set before the Supabase client is first used'
        );
    });

    it('publishes the disposer only once a client exists', async () => {
        const module = await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        module.setSupabaseStorageAdapter(createMockStorageAdapter());

        expect((window as any).__beaverDisposeSupabase).toBeUndefined();

        module.supabase.auth;

        expect((window as any).__beaverDisposeSupabase).toBeTypeOf('function');
    });

    // Two auto-refresh tickers on one session race for the single-use refresh
    // token, so the reloaded instance has to stop the previous one.
    it('stops the previous instance when the next one registers the bridge', async () => {
        const firstModule = await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        firstModule.setSupabaseStorageAdapter(createMockStorageAdapter());
        firstModule.supabase.auth;

        const firstClient = mockCreateClient.mock.results[0].value as {
            auth: { stopAutoRefresh: ReturnType<typeof vi.fn> };
        };
        expect(firstClient.auth.stopAutoRefresh).not.toHaveBeenCalled();

        vi.resetModules();
        const secondModule = await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        await flushAsync();

        expect(firstClient.auth.stopAutoRefresh).toHaveBeenCalled();
        // Left in place until this instance publishes its own, so a stop that
        // failed can still be retried from the host's shutdown path.
        expect((window as any).__beaverDisposeSupabase).toBeTypeOf('function');

        secondModule.setSupabaseStorageAdapter(createMockStorageAdapter());
        secondModule.supabase.auth;

        expect((window as any).__beaverDisposeSupabase).toBeTypeOf('function');
        expect((window as any).__beaverDisposeSupabase).toBe(secondModule.disposeSupabaseClient);
    });

    // A stop that fails leaves the old ticker running, so the disposer has to
    // stay reachable for the host to retry rather than being consumed by the
    // attempt that failed.
    it('keeps the previous disposer reachable when stopping it fails', async () => {
        const firstModule = await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        firstModule.setSupabaseStorageAdapter(createMockStorageAdapter());
        firstModule.supabase.auth;

        const firstClient = mockCreateClient.mock.results[0].value as {
            auth: { stopAutoRefresh: ReturnType<typeof vi.fn> };
        };
        firstClient.auth.stopAutoRefresh.mockRejectedValueOnce(new Error('stop failed'));

        vi.resetModules();
        await import('@beaver/agent-core/transport/supabaseClient');
        await registerReloadBridge();
        await flushAsync();

        expect(firstClient.auth.stopAutoRefresh).toHaveBeenCalledTimes(1);

        const disposer = (window as any).__beaverDisposeSupabase;
        expect(disposer).toBeTypeOf('function');

        await disposer();
        expect(firstClient.auth.stopAutoRefresh).toHaveBeenCalledTimes(2);
    });
});
