import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getFileSignature,
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
});
