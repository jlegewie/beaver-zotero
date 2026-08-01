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

vi.mock('../../../src/utils/logger', () => ({
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

describe('supabaseClient auth lock reload handling', () => {
    beforeEach(() => {
        capturedLocks.length = 0;
        mockCreateClient.mockClear();
        mockLogger.mockClear();
        vi.resetModules();

        process.env.SUPABASE_URL = 'https://example.supabase.co';
        process.env.SUPABASE_ANON_KEY = 'anon-key';

        vi.stubGlobal('window', {});
    });

    it('does not create the client until the exported client is first used', async () => {
        const module = await import('../../../src/services/supabaseClient');
        module.setSupabaseStorageAdapter(createMockStorageAdapter());

        expect(mockCreateClient).not.toHaveBeenCalled();

        module.supabase.auth;

        expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it('uses the registered storage adapter when the exported client is first used', async () => {
        const registeredStorage = createMockStorageAdapter();
        const module = await import('../../../src/services/supabaseClient');

        module.setSupabaseStorageAdapter(registeredStorage);
        module.supabase.auth;

        expect(mockCreateClient).toHaveBeenCalledTimes(1);
        expect(mockCreateClient.mock.calls[0][2].auth.storage).toBe(registeredStorage);
    });

    it('throws when the exported client is used without a registered storage adapter', async () => {
        const module = await import('../../../src/services/supabaseClient');

        expect(() => module.supabase.auth).toThrow(
            'No Supabase storage adapter registered.'
        );
        expect(mockCreateClient).not.toHaveBeenCalled();
    });

    it('rejects storage registration after the exported client has been used', async () => {
        const module = await import('../../../src/services/supabaseClient');
        module.setSupabaseStorageAdapter(createMockStorageAdapter());

        module.supabase.auth;

        expect(() => module.setSupabaseStorageAdapter(createMockStorageAdapter()))
            .toThrow('Supabase storage adapter must be set before the Supabase client is first used');
    });

    it('keeps inherited waiters queued across module reloads', async () => {
        const firstModule = await import('../../../src/services/supabaseClient');
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
        const secondModule = await import('../../../src/services/supabaseClient');
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
        const firstModule = await import('../../../src/services/supabaseClient');
        firstModule.setSupabaseStorageAdapter(createMockStorageAdapter());
        firstModule.supabase.auth;
        const firstWindowLock = (window as any).__beaverAuthLock;

        delete (window as any).__beaverAuthLock;

        vi.resetModules();
        const secondModule = await import('../../../src/services/supabaseClient');
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
