import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getFileSignature,
    getRemoteFileVersion,
    isRemoteFilePath,
    makeRemoteFilePath,
} from '../../../src/services/documentFileIdentity';

describe('documentFileIdentity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('makeRemoteFilePath prefers synced hash', () => {
        const item = {
            libraryID: 1,
            key: 'ABCD1234',
            version: 7,
            attachmentSyncedHash: 'hash-value',
        } as unknown as Zotero.Item;

        expect(makeRemoteFilePath(item)).toBe('remote:h:hash-value');
    });

    it('makeRemoteFilePath falls back to library/key/version', () => {
        const item = {
            libraryID: 2,
            key: 'EFGH5678',
            version: 11,
            attachmentSyncedHash: '',
        } as unknown as Zotero.Item;

        expect(makeRemoteFilePath(item)).toBe('remote:k:2-EFGH5678-v11');
    });

    it('isRemoteFilePath detects synthetic paths', () => {
        expect(isRemoteFilePath('remote:h:abc')).toBe(true);
        expect(isRemoteFilePath('/tmp/file.pdf')).toBe(false);
    });

    it('getFileSignature uses IOUtils.stat for local files', async () => {
        vi.mocked(IOUtils.stat).mockResolvedValueOnce({ lastModified: 123, size: 456 } as any);

        await expect(getFileSignature('/tmp/file.pdf')).resolves.toEqual({
            mtime_ms: 123,
            size_bytes: 456,
        });
    });

    it('getFileSignature returns a zero signature for remote files', async () => {
        await expect(getFileSignature('remote:h:abc')).resolves.toEqual({
            mtime_ms: 0,
            size_bytes: 0,
        });
        expect(IOUtils.stat).not.toHaveBeenCalled();
    });

    describe('getRemoteFileVersion', () => {
        const item = (overrides: Record<string, unknown> = {}) => ({
            libraryID: 3,
            key: 'Q9B3FHDY',
            attachmentSyncedHash: null,
            attachmentSyncedModificationTime: null,
            ...overrides,
        }) as unknown as Zotero.Item;

        function stubSyncCache(data: Record<string, unknown> | null, version: number | null = 12) {
            const local = {
                getLatestCacheObjectVersion: vi.fn(async () => version),
                getCacheObject: vi.fn(async () => data ? { key: 'Q9B3FHDY', version, data } : false),
            };
            (Zotero as any).Sync = { Data: { Local: local } };
            return local;
        }

        it('reads the server md5 from the sync cache for a never-downloaded file', async () => {
            const local = stubSyncCache({ md5: 'b4119f76', mtime: 1700 });
            await expect(getRemoteFileVersion(item())).resolves.toEqual({ md5: 'b4119f76', mtime: 1700 });
            expect(local.getCacheObject).toHaveBeenCalledWith('item', 3, 'Q9B3FHDY', 12);
        });

        it('prefers the sync cache over stale synced-file fields', async () => {
            stubSyncCache({ md5: 'new-md5', mtime: 2 });
            await expect(getRemoteFileVersion(item({
                attachmentSyncedHash: 'old-md5', attachmentSyncedModificationTime: 1,
            }))).resolves.toEqual({ md5: 'new-md5', mtime: 2 });
        });

        it('falls back to the synced-file fields when the cache has no file values', async () => {
            stubSyncCache({ md5: null, mtime: null });
            await expect(getRemoteFileVersion(item({
                attachmentSyncedHash: 'synced', attachmentSyncedModificationTime: 5,
            }))).resolves.toEqual({ md5: 'synced', mtime: 5 });
            stubSyncCache(null, null);
            await expect(getRemoteFileVersion(item())).resolves.toEqual({ md5: null, mtime: null });
        });
    });
});
