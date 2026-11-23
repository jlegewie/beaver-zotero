import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockSetSupabaseStorageAdapter,
    mockSetSupabaseReloadBridge,
    mockEncryptedStorageConstructed,
    storageOptions,
    store,
} = vi.hoisted(() => ({
    storageOptions: [] as any[],
    mockSetSupabaseStorageAdapter: vi.fn(),
    mockSetSupabaseReloadBridge: vi.fn(),
    mockEncryptedStorageConstructed: vi.fn(),
    store: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    setSupabaseStorageAdapter: mockSetSupabaseStorageAdapter,
    setSupabaseReloadBridge: mockSetSupabaseReloadBridge,
}));

vi.mock('../../../src/services/EncryptedStorage', () => ({
    EncryptedStorage: class MockEncryptedStorage {
        constructor(options?: unknown) {
            mockEncryptedStorageConstructed();
            storageOptions.push(options);
        }

        getItem = store.getItem;
        setItem = store.setItem;
        removeItem = store.removeItem;
    },
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

import { registerZoteroSupabaseStorage } from '../../../src/services/zoteroSupabaseStorage';
import { getAuthDiagnostics, resetAuthDiagnosticsForTesting } from '../../../src/services/authDiagnostics';

function registeredAdapter() {
    registerZoteroSupabaseStorage();
    return mockSetSupabaseStorageAdapter.mock.calls[0][0];
}

describe('registerZoteroSupabaseStorage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        store.getItem.mockReset();
        store.setItem.mockReset();
        store.removeItem.mockReset();
        storageOptions.length = 0;
        resetAuthDiagnosticsForTesting();
    });

    it('registers an EncryptedStorage-backed adapter with the storage-adapter interface', () => {
        const adapter = registeredAdapter();

        expect(mockEncryptedStorageConstructed).toHaveBeenCalledTimes(1);
        expect(mockSetSupabaseStorageAdapter).toHaveBeenCalledTimes(1);
        expect(typeof adapter.getItem).toBe('function');
        expect(typeof adapter.setItem).toBe('function');
        expect(typeof adapter.removeItem).toBe('function');
    });

    describe('getItem', () => {
        it('returns null when nothing is stored', async () => {
            store.getItem.mockResolvedValue(null);

            await expect(registeredAdapter().getItem('session')).resolves.toBeNull();
        });

        it('returns a stored session unchanged', async () => {
            store.getItem.mockResolvedValue('{"access_token":"abc"}');

            await expect(registeredAdapter().getItem('session')).resolves.toBe('{"access_token":"abc"}');
            expect(store.setItem).not.toHaveBeenCalled();
        });

        it('unwraps and rewrites a double-encoded session', async () => {
            const inner = '{"access_token":"abc"}';
            store.getItem.mockResolvedValue(JSON.stringify(inner));
            store.setItem.mockResolvedValue(undefined);

            await expect(registeredAdapter().getItem('session')).resolves.toBe(inner);
            expect(store.setItem).toHaveBeenCalledWith('session', inner);
        });

        it('returns a quoted but unparsable value as-is', async () => {
            store.getItem.mockResolvedValue('"a"b"');

            await expect(registeredAdapter().getItem('session')).resolves.toBe('"a"b"');
            expect(store.setItem).not.toHaveBeenCalled();
        });

        it('returns null when the store throws', async () => {
            store.getItem.mockRejectedValue(new Error('decrypt failed'));

            await expect(registeredAdapter().getItem('session')).resolves.toBeNull();
        });
    });

    describe('setItem', () => {
        it('writes once when the store succeeds', async () => {
            store.setItem.mockResolvedValue(undefined);

            await registeredAdapter().setItem('session', 'token');

            expect(store.setItem).toHaveBeenCalledTimes(1);
        });

        // A dropped write leaves the server-invalidated refresh token on disk,
        // which logs the user out on the next restart.
        it('retries once when the first write fails', async () => {
            store.setItem
                .mockRejectedValueOnce(new Error('disk busy'))
                .mockResolvedValueOnce(undefined);

            await registeredAdapter().setItem('session', 'token');

            expect(store.setItem).toHaveBeenCalledTimes(2);
        });

        it('gives up after two failed writes without throwing', async () => {
            store.setItem.mockRejectedValue(new Error('disk full'));

            await expect(registeredAdapter().setItem('session', 'token')).resolves.toBeUndefined();
            expect(store.setItem).toHaveBeenCalledTimes(2);
        });
    });

    describe('removeItem', () => {
        it('clears the stored session', async () => {
            store.removeItem.mockResolvedValue(undefined);

            await registeredAdapter().removeItem('session');

            expect(store.removeItem).toHaveBeenCalledWith('session');
        });

        it('does not throw when the store fails', async () => {
            store.removeItem.mockRejectedValue(new Error('locked'));

            await expect(registeredAdapter().removeItem('session')).resolves.toBeUndefined();
        });
    });

    describe('diagnostics', () => {
        const SESSION_KEY = 'sb-project-auth-token';
        const events = () => getAuthDiagnostics().map((entry) => entry.event);

        it('records an empty read of the session, but not of its companion entries', async () => {
            store.getItem.mockResolvedValue(null);
            const adapter = registeredAdapter();

            await adapter.getItem(`${SESSION_KEY}-user`);
            await adapter.getItem(`${SESSION_KEY}-code-verifier`);
            expect(events()).toEqual([]);

            await adapter.getItem(SESSION_KEY);
            await adapter.getItem(SESSION_KEY);
            expect(getAuthDiagnostics()).toEqual([
                expect.objectContaining({ event: 'storage_read_empty', count: 2 }),
            ]);
        });

        it('records which code removed the session', async () => {
            store.removeItem.mockResolvedValue(undefined);

            await registeredAdapter().removeItem(SESSION_KEY);

            const [entry] = getAuthDiagnostics();
            expect(entry.event).toBe('storage_removed');
            expect(entry.detail).toContain('removeItem');
            expect(entry.detail).not.toMatch(/:\/\/|\/Users\/|\.ts\b/);
        });

        it('records a write that could not be persisted', async () => {
            store.setItem.mockRejectedValue(new Error('disk full'));

            await registeredAdapter().setItem(SESSION_KEY, 'token');

            expect(events()).toEqual(['storage_write_abandoned']);
        });

        it('records failures the encrypted store handles internally', () => {
            registeredAdapter();

            storageOptions[0].onFailure('decrypt', new Error('OperationError'));

            expect(getAuthDiagnostics()).toEqual([
                expect.objectContaining({ event: 'storage_decrypt_failed', detail: 'Error: OperationError' }),
            ]);
        });
    });
});
