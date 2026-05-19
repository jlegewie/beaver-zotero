import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));
import {
    citationKeyToMarkerAtom,
    citationMetadataAtom,
    citationDataByCitationKeyAtom,
    citationDataMapAtom,
    getOrAssignCitationMarkerAtom,
    updateCitationDataAtom,
} from '../../../react/atoms/citations';
import type { CitationData } from '../../../react/types/citations';

function citation(overrides: Partial<CitationData>): CitationData {
    return {
        citation_id: overrides.citation_id || 'c1',
        run_id: 'run1',
        parts: [],
        type: 'item',
        parentKey: null,
        icon: null,
        name: null,
        citation: null,
        formatted_citation: null,
        url: null,
        numericCitation: null,
        ...overrides,
    };
}

describe('citationDataByCitationKeyAtom', () => {
    it('indexes citation data by requested and resolved keys', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            library_id: 1,
            zotero_key: 'PARENT',
            raw_tag: '<citation att_id="1-ATTACH" loc="p3"/>',
        });
        store.set(citationDataMapAtom, { c1: data });

        const byKey = store.get(citationDataByCitationKeyAtom);
        expect(byKey['zotero:1-ATTACH:p3']).toBe(data);
        expect(byKey['zotero:1-PARENT:p3']).toBe(data);
        expect(byKey['zotero:1-PARENT']).toBe(data);
    });

    it('does not expose ambiguous base-key fallback', () => {
        const store = createStore();
        const first = citation({
            citation_id: 'c1',
            library_id: 1,
            zotero_key: 'ITEM',
            raw_tag: '<citation item_id="1-ITEM" page="5"/>',
        });
        const second = citation({
            citation_id: 'c2',
            library_id: 1,
            zotero_key: 'ITEM',
            raw_tag: '<citation item_id="1-ITEM" page="6"/>',
        });
        store.set(citationDataMapAtom, { c1: first, c2: second });

        const byKey = store.get(citationDataByCitationKeyAtom);
        expect(byKey['zotero:1-ITEM:5']).toBe(first);
        expect(byKey['zotero:1-ITEM:6']).toBe(second);
        expect(byKey['zotero:1-ITEM']).toBeUndefined();
    });

    it('indexes external references under source-qualified and compatibility keys', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            external_source: 'openalex',
            external_source_id: 'W1',
            citation_type: 'external_reference',
            raw_tag: '<citation external_id="W1" loc="p2"/>',
        });
        store.set(citationDataMapAtom, { c1: data });

        const byKey = store.get(citationDataByCitationKeyAtom);
        expect(byKey['external:W1:p2']).toBe(data);
        expect(byKey['external:openalex:W1:p2']).toBe(data);
    });

    it('indexes invalid citation fallback keys from normalized raw identity', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            invalid: true,
            raw_tag: '<citation id="bad"/>',
        });
        store.set(citationDataMapAtom, { c1: data });

        expect(store.get(citationDataByCitationKeyAtom)['invalid:bad']).toBe(data);
    });
});

describe('updateCitationDataAtom', () => {
    it('aliases requested and resolved marker keys when bases differ', async () => {
        const store = createStore();
        store.set(citationKeyToMarkerAtom, { 'zotero:1-ATTACH': '1' });
        store.set(citationMetadataAtom, [citation({
            citation_id: 'c1',
            invalid: true,
            library_id: 1,
            zotero_key: 'PARENT',
            raw_tag: '<citation att_id="1-ATTACH"/>',
        })]);

        await store.set(updateCitationDataAtom);

        const markers = store.get(citationKeyToMarkerAtom);
        expect(markers['zotero:1-ATTACH']).toBe('1');
        expect(markers['zotero:1-PARENT']).toBe('1');
    });

    it('allocates the next marker from existing marker values, not alias key count', async () => {
        const store = createStore();
        store.set(citationKeyToMarkerAtom, { 'zotero:1-ATTACH': '1' });
        store.set(citationMetadataAtom, [citation({
            citation_id: 'c1',
            invalid: true,
            library_id: 1,
            zotero_key: 'PARENT',
            raw_tag: '<citation att_id="1-ATTACH"/>',
        })]);

        await store.set(updateCitationDataAtom);

        expect(store.set(getOrAssignCitationMarkerAtom, 'zotero:1-NEXT')).toBe('2');
        expect(store.get(citationKeyToMarkerAtom)).toMatchObject({
            'zotero:1-ATTACH': '1',
            'zotero:1-PARENT': '1',
            'zotero:1-NEXT': '2',
        });
    });

    it('preserves the earliest existing marker when alias keys already have markers', async () => {
        const store = createStore();
        store.set(citationKeyToMarkerAtom, {
            'zotero:1-PARENT': '1',
            'zotero:1-ATTACH': '2',
        });
        store.set(citationMetadataAtom, [citation({
            citation_id: 'c1',
            invalid: true,
            library_id: 1,
            zotero_key: 'PARENT',
            raw_tag: '<citation att_id="1-ATTACH"/>',
        })]);

        await store.set(updateCitationDataAtom);

        expect(store.get(citationKeyToMarkerAtom)).toMatchObject({
            'zotero:1-PARENT': '1',
            'zotero:1-ATTACH': '1',
        });
    });
});
