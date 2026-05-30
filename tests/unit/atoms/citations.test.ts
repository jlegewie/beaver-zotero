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
import { getCitationBoundingBoxes, getCitationPages, isExternalCitation, isZoteroCitation, type CitationData } from '../../../react/types/citations';

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

    it('indexes raw tag range keys when backend refs carry only the first locator', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            library_id: 1,
            zotero_key: 'ATTACH',
            raw_tag: '<citation att_id="1-ATTACH" sid="s343-s345"/>',
            requested_ref: {
                kind: 'zotero',
                library_id: 1,
                zotero_key: 'ATTACH',
                loc: { kind: 'sentence', raw: 's343', value: '343' },
            },
            resolved_ref: {
                kind: 'zotero',
                library_id: 1,
                zotero_key: 'ATTACH',
                loc: { kind: 'sentence', raw: 's343', value: '343' },
            },
        });
        store.set(citationDataMapAtom, { c1: data });

        const byKey = store.get(citationDataByCitationKeyAtom);
        expect(byKey['zotero:1-ATTACH:s343-s345']).toBe(data);
        expect(byKey['zotero:1-ATTACH:s343']).toBe(data);
    });

    it('indexes structured-document sid locator keys from raw tags', () => {
        const store = createStore();
        const data = citation({
            citation_id: 'c1',
            library_id: 1,
            zotero_key: 'NLNMPWNQ',
            raw_tag: '<citation att_id="1-NLNMPWNQ" sid="heading3"/>',
        });
        store.set(citationDataMapAtom, { c1: data });

        const byKey = store.get(citationDataByCitationKeyAtom);
        expect(byKey['zotero:1-NLNMPWNQ:heading3']).toBe(data);
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

    it('uses future resolved_ref metadata for external citation data', async () => {
        const store = createStore();
        store.set(citationMetadataAtom, [citation({
            citation_id: 'c1',
            resolved_ref: { kind: 'external', source: 'openalex', external_id: 'W123' },
        })]);

        await store.set(updateCitationDataAtom);

        const data = store.get(citationDataMapAtom).c1;
        expect(data.type).toBe('external');
        expect(data.external_source).toBe('openalex');
        expect(data.external_source_id).toBe('W123');
    });
});

describe('citation type guards', () => {
    it('lets structured refs take precedence over stale legacy identity fields', () => {
        const data = citation({
            library_id: 1,
            zotero_key: 'ZOTERO',
            external_source: 'openalex',
            external_source_id: 'W123',
            resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ZOTERO' },
        });

        expect(isZoteroCitation(data)).toBe(true);
        expect(isExternalCitation(data)).toBe(false);
    });

    it('does not let stale Zotero fields override a structured external ref', () => {
        const data = citation({
            library_id: 1,
            zotero_key: 'STALE',
            external_source: 'openalex',
            external_source_id: 'W123',
            resolved_ref: { kind: 'external', source: 'openalex', external_id: 'W123' },
        });

        expect(isExternalCitation(data)).toBe(true);
        expect(isZoteroCitation(data)).toBe(false);
    });
});

describe('getCitationPages', () => {
    it('normalizes runtime string pages before navigation uses them', () => {
        const data = citation({
            parts: [
                {
                    part_id: 'p1',
                    locations: [
                        { page_idx: '2' as unknown as number },
                        { page_idx: 'bad' as unknown as number },
                    ],
                },
            ],
            pages: ['5', 3, 'bad'] as unknown as number[],
        });

        expect(getCitationPages(data)).toEqual([3, 5]);
    });
});

describe('getCitationBoundingBoxes', () => {
    it('carries per-location page labels for temporary citation highlights', () => {
        const data = citation({
            parts: [
                {
                    part_id: 'p1',
                    locations: [
                        {
                            page_idx: 1,
                            page_label: 'iv',
                            boxes: [{ l: 1, t: 2, r: 3, b: 4, coord_origin: 't' as any }],
                        },
                    ],
                },
            ],
        });

        expect(getCitationBoundingBoxes(data)).toEqual([
            {
                page: 2,
                pageLabel: 'iv',
                bboxes: [{ l: 1, t: 2, r: 3, b: 4, coord_origin: 't' }],
            },
        ]);
    });

    it('falls back to citation-level page labels when the location has none', () => {
        const data = citation({
            page_labels: { 2: '7' },
            parts: [
                {
                    part_id: 'p1',
                    locations: [
                        {
                            page_idx: 2,
                            boxes: [{ l: 1, t: 2, r: 3, b: 4, coord_origin: 't' as any }],
                        },
                    ],
                },
            ],
        });

        expect(getCitationBoundingBoxes(data)[0]).toMatchObject({
            page: 3,
            pageLabel: '7',
        });
    });
});
