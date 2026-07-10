import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => true),
    setPref: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import { readCitationProps } from '../../../react/components/citations/useCitationViewModel';

describe('readCitationProps', () => {
    it('accepts an unresolved portable group citation identity', () => {
        const result = readCitationProps({
            'data-library-id': '0',
            'data-library-ref': 'g42',
            'data-zotero-key': 'ABCD1234',
        });

        expect(result).toMatchObject({
            ok: true,
            ref: {
                kind: 'zotero',
                library_id: 0,
                library_ref: 'g42',
                zotero_key: 'ABCD1234',
            },
            requestedKey: 'zotero:g42-ABCD1234',
        });
    });

    it('still rejects library id zero without a portable reference', () => {
        expect(readCitationProps({
            'data-library-id': '0',
            'data-zotero-key': 'ABCD1234',
        })).toMatchObject({ ok: false, reason: 'missing_identity' });
    });
});
