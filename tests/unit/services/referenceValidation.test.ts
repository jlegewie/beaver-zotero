import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateZoteroItemReference } from '../../../src/services/documentExtraction/referenceValidation';

describe('validateZoteroItemReference', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Utilities.isValidObjectKey = vi.fn(
            (key: string) => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key),
        );
    });

    it('accepts an unresolved local library id when a valid portable group ref is present', () => {
        expect(validateZoteroItemReference({
            library_id: 0,
            library_ref: 'g123',
            zotero_key: '3RRUYX5J',
        })).toBeNull();
    });

    it('rejects an unresolved local library id without a valid portable ref', () => {
        expect(validateZoteroItemReference({
            library_id: 0,
            zotero_key: '3RRUYX5J',
        })).toContain('0 with a valid library_ref');

        expect(validateZoteroItemReference({
            library_id: 0,
            library_ref: 'not-a-library',
            zotero_key: '3RRUYX5J',
        })).toContain('0 with a valid library_ref');
    });

    it('continues accepting legacy references with a positive local library id', () => {
        expect(validateZoteroItemReference({
            library_id: 7,
            zotero_key: '3RRUYX5J',
        })).toBeNull();
    });
});
