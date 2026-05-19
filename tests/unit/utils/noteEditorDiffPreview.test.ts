import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => null) },
}));

vi.mock('../../../react/atoms/externalReferences', () => ({
    externalReferenceMappingAtom: Symbol('externalReferenceMappingAtom'),
    externalReferenceItemMappingAtom: Symbol('externalReferenceItemMappingAtom'),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));

vi.mock('../../../react/agents/agentActions', () => ({}));

import { constructMultiDiffHtml } from '../../../react/utils/noteEditorDiffPreview';

describe('constructMultiDiffHtml', () => {
    it('renders multiple append edits at the append point in edit order', () => {
        const html = '<div data-schema-version="9"><p>Existing</p></div>';
        const result = constructMultiDiffHtml(html, [
            { expandedOld: '', expandedNew: '<p>First append</p>', operation: 'append' },
            { expandedOld: '', expandedNew: '<p>Second append</p>', operation: 'append' },
        ]);

        expect(result).not.toBeNull();
        const firstIndex = result!.indexOf('First append');
        const secondIndex = result!.indexOf('Second append');
        expect(firstIndex).toBeGreaterThan(result!.indexOf('Existing'));
        expect(secondIndex).toBeGreaterThan(firstIndex);
        expect(result!.indexOf('</div>')).toBeGreaterThan(secondIndex);
    });
});
