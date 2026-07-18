import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => null) },
}));

vi.mock('../../../react/atoms/externalReferences', () => ({
    externalReferenceMappingAtom: Symbol('externalReferenceMappingAtom'),
    externalReferenceItemMappingAtom: Symbol('externalReferenceItemMappingAtom'),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({
        userID: undefined,
        localUserKey: 'test-user',
    })),
}));

vi.mock('../../../react/agents/agentActions', () => ({}));

import {
    constructMultiDiffHtml,
    expandPreviewEditForCurrentNote,
} from '../../../react/utils/noteEditorDiffPreview';

describe('literal-dollar diff preview matching', () => {
    it('uses the matcher retry expansion when constructing the approval preview', () => {
        const strippedHtml = '<p>Context: the value of $x+y$ in the model.</p>';
        const expanded = expandPreviewEditForCurrentNote(
            {
                oldString: 'the value of $x+y$ in the model',
                newString: 'the value of $x+z$ in the model',
            },
            'str_replace',
            { elements: new Map() } as any,
            strippedHtml,
            strippedHtml,
            {
                externalRefs: new Map(),
                externalItemMapping: new Map(),
            } as any,
            {},
        );

        expect(expanded).toMatchObject({
            expandedOld: 'the value of $x+y$ in the model',
            expandedNew: 'the value of $x+z$ in the model',
        });
        const preview = constructMultiDiffHtml(strippedHtml, [expanded!]);
        expect(preview).not.toBeNull();
        expect(preview).not.toContain('class="math"');
    });
});
