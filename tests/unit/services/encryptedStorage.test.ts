import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { EncryptedStorage } from '../../../src/services/EncryptedStorage';

/** A store whose file holds a value that does not decrypt. */
function undecryptable(onFailure?: (operation: string, error: unknown) => void) {
    const storage = new EncryptedStorage({ onFailure });
    Object.assign(storage as any, {
        readEncryptedValue: async () => 'aa:bb',
        decrypt: async () => { throw new Error('OperationError'); },
    });
    return storage;
}

describe('EncryptedStorage failure reporting', () => {
    it('tells an unreadable value apart from a missing one', async () => {
        const onFailure = vi.fn();
        await expect(undecryptable(onFailure).getItem('session')).resolves.toBeNull();
        expect(onFailure).toHaveBeenCalledWith('decrypt', expect.any(Error));
    });

    it('returns the same result when the reporter throws', async () => {
        const storage = undecryptable(() => { throw new Error('reporter broke'); });
        await expect(storage.getItem('session')).resolves.toBeNull();
    });

    it('reports a failed write and still throws it to the caller', async () => {
        const onFailure = vi.fn();
        const storage = new EncryptedStorage({ onFailure });
        Object.assign(storage as any, {
            encrypt: async () => 'aa:bb',
            writeEncryptedValue: async () => { throw new Error('disk full'); },
        });
        await expect(storage.setItem('session', 'value')).rejects.toThrow('disk full');
        expect(onFailure).toHaveBeenCalledWith('write', expect.any(Error));
    });
});
